// @ori3com/agent-core — IBrainMemory seam (ADR-0001 C05).
// Le « cerveau » = mémoire consolidée + méta-agent. Extrait/refactoré depuis
// o3c-chat/packages/agent-runtime (brain-memory.ts) et DÉCOUPLÉ de tout
// o3c-chat-specific : le cœur ne contient QUE l'impl in-memory pure-JS (rappel
// déterministe, scope-isolé, aucune dépendance embedder/serveur), les helpers purs
// (policy, formatage du bloc Cerveau) et le seam de composition. Le backend DURABLE
// (LanceDB embarqué, S3-stored) dépend du package `@lancedb/lancedb` et reste
// INJECTÉ par le consommateur (jamais tiré par le cœur — parité IWorkflowRuntime).
//
// Deux responsabilités, un port :
//  1. Mémoire consolidée — `consolidate` ingère des souvenirs edge (Zvec/IVectorMemory)
//     dans un cerveau durable ; `recall`/`forget` l'exploitent.
//  2. Méta-agent — `getPolicy`/`setPolicy` : les paramètres qui dictent COMMENT
//     exploiter le cerveau (profondeur de rappel, seuil de consolidation, directive).

/**
 * @typedef {import("./ports.mjs").RuntimeScope} RuntimeScope
 */

/**
 * Nature d'un souvenir consolidé.
 * @typedef {'episodic' | 'semantic' | 'preference'} BrainMemoryKind
 */

/** Liste canonique des natures de souvenir (ordre stable). */
export const BRAIN_MEMORY_KINDS = Object.freeze(["episodic", "semantic", "preference"]);

/**
 * Garde de validité du `kind` (entrée réseau non fiable).
 * @param {unknown} value
 * @returns {value is BrainMemoryKind}
 */
export function isBrainMemoryKind(value) {
  return typeof value === "string" && BRAIN_MEMORY_KINDS.includes(value);
}

/**
 * @typedef {Object} BrainRecord
 * @property {string} id
 * @property {string} content
 * @property {BrainMemoryKind} kind
 * @property {number} [salience] importance perçue côté edge (0..1). Absente ⇒ 1 (max).
 * @property {number[]} [vector] vecteur pré-calculé (exploité par le backend durable)
 * @property {string} [sourceNs] namespace edge d'origine = projectId (traçabilité)
 * @property {Record<string, string | number | boolean>} [metadata]
 *
 * @typedef {Object} BrainQuery
 * @property {string} [text] sous-chaîne insensible à la casse cherchée dans `content`
 * @property {number[]} [vector] hint vectoriel (ANN côté backend durable ; ignoré in-memory)
 * @property {BrainMemoryKind[]} [kinds] ne remonter que ces natures (OR)
 * @property {number} [minSalience] saillance minimale des souvenirs remontés
 * @property {number} [topK] nb max remonté (défaut = `recallTopK` de la policy)
 *
 * @typedef {Object} BrainHit
 * @property {string} id
 * @property {string} content
 * @property {BrainMemoryKind} kind
 * @property {number} salience
 * @property {number} score pertinence (déterministe ici, vectorielle avec le backend durable)
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {Object} BrainConsolidationResult
 * @property {string[]} accepted
 * @property {string[]} rejected rejetés car sous le seuil `consolidationThreshold`
 *
 * @typedef {Object} MetaAgentPolicy
 * @property {string} directive directive système injectée au méta-agent
 * @property {number} recallTopK nb max remonté par `recall` quand `query.topK` absent
 * @property {number} consolidationThreshold ne consolider que si `salience` ≥ ce seuil
 *
 * @typedef {Object} IBrainMemory
 * @property {(records: BrainRecord[], scope: RuntimeScope) => Promise<BrainConsolidationResult>} consolidate
 * @property {(query: BrainQuery, scope: RuntimeScope) => Promise<BrainHit[]>} recall
 * @property {(ids: string[], scope: RuntimeScope) => Promise<void>} forget
 * @property {(scope: RuntimeScope) => Promise<MetaAgentPolicy>} getPolicy
 * @property {(patch: Partial<MetaAgentPolicy>, scope: RuntimeScope) => Promise<MetaAgentPolicy>} setPolicy
 */

/** Policy par défaut (méta-agent neutre : consolide tout, rappelle large). */
export const DEFAULT_META_AGENT_POLICY = Object.freeze({
  directive: "Exploite le cerveau consolidé pour refléter la façon de penser de l'utilisateur.",
  recallTopK: 8,
  consolidationThreshold: 0,
});

/** Méthodes que tout adapter IBrainMemory DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze([
  "consolidate",
  "recall",
  "forget",
  "getPolicy",
  "setPolicy",
]);

/**
 * Vérifie structurellement qu'un objet satisfait le port IBrainMemory.
 * @param {any} adapter
 * @returns {IBrainMemory} le même adapter, quand valide
 */
export function assertBrainMemory(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("IBrainMemory: adapter must be an object");
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new Error(`IBrainMemory: adapter missing method(s): ${missing.join(", ")}`);
  }
  return /** @type {IBrainMemory} */ (adapter);
}

// ── Helpers purs — rendu du bloc Cerveau injecté au system prompt ──────────────

/**
 * Rend une liste de BrainHit en bloc texte (un souvenir par ligne, préfixé de sa
 * nature) — c'est ainsi que l'agent « exploite le cerveau » (slot `brainMemories`).
 * @param {BrainHit[]} hits
 * @returns {string}
 */
export function formatBrainRecall(hits) {
  return hits.map((h) => `- [${h.kind}] ${h.content}`).join("\n");
}

/**
 * Assemble le bloc Cerveau : la `directive` du méta-agent en tête, puis les souvenirs.
 * Aucun souvenir ⇒ `undefined` (le slot n'est pas rendu, même si une directive existe).
 * @param {string} directive
 * @param {BrainHit[]} hits
 * @returns {string | undefined}
 */
export function composeBrainContext(directive, hits) {
  if (hits.length === 0) return undefined;
  const body = formatBrainRecall(hits);
  return directive ? `${directive}\n\n${body}` : body;
}

// ── InMemoryBrainMemory — impl par défaut, scope-isolée ────────────────────────

/**
 * Impl par défaut, scope-isolée par `tenantId` (le cerveau est un actif d'org).
 * Rappel déterministe (sous-chaîne + tri saillance puis récence), aucune dépendance
 * embedder/serveur. Ce N'EST PAS un stub — la consolidation upserte par `id`
 * (idempotence des cycles edge→cerveau), applique le seuil du méta-agent à l'ingest,
 * et le rappel est réellement borné/filtré par la policy.
 * @implements {IBrainMemory}
 */
export class InMemoryBrainMemory {
  constructor() {
    /** @type {Map<string, Map<string, BrainRecord>>} */
    this._byTenant = new Map();
    /** @type {Map<string, Map<string, number>>} ordre d'insertion (récence) par tenant */
    this._seqByTenant = new Map();
    /** @type {Map<string, MetaAgentPolicy>} */
    this._policyByTenant = new Map();
    /** @type {number} */
    this._seq = 0;
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "memory", persistent: false, durable: false, native: false };
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Map<string, BrainRecord>}
   */
  _store(scope) {
    let b = this._byTenant.get(scope.tenantId);
    if (!b) {
      b = new Map();
      this._byTenant.set(scope.tenantId, b);
    }
    return b;
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Map<string, number>}
   */
  _seqs(scope) {
    let b = this._seqByTenant.get(scope.tenantId);
    if (!b) {
      b = new Map();
      this._seqByTenant.set(scope.tenantId, b);
    }
    return b;
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Promise<MetaAgentPolicy>}
   */
  async getPolicy(scope) {
    return this._policyByTenant.get(scope.tenantId) ?? { ...DEFAULT_META_AGENT_POLICY };
  }

  /**
   * @param {Partial<MetaAgentPolicy>} patch
   * @param {RuntimeScope} scope
   * @returns {Promise<MetaAgentPolicy>}
   */
  async setPolicy(patch, scope) {
    /** @type {MetaAgentPolicy} */
    const next = { ...(await this.getPolicy(scope)), ...patch };
    this._policyByTenant.set(scope.tenantId, next);
    return next;
  }

  /**
   * @param {BrainRecord[]} records
   * @param {RuntimeScope} scope
   * @returns {Promise<BrainConsolidationResult>}
   */
  async consolidate(records, scope) {
    const { consolidationThreshold } = await this.getPolicy(scope);
    const store = this._store(scope);
    const seqs = this._seqs(scope);
    /** @type {string[]} */
    const accepted = [];
    /** @type {string[]} */
    const rejected = [];
    for (const rec of records) {
      const salience = rec.salience ?? 1;
      if (salience < consolidationThreshold) {
        rejected.push(rec.id);
        continue;
      }
      store.set(rec.id, { ...rec, salience });
      if (!seqs.has(rec.id)) seqs.set(rec.id, ++this._seq);
      accepted.push(rec.id);
    }
    return { accepted, rejected };
  }

  /**
   * @param {BrainQuery} query
   * @param {RuntimeScope} scope
   * @returns {Promise<BrainHit[]>}
   */
  async recall(query, scope) {
    const policy = await this.getPolicy(scope);
    const text = query.text?.toLowerCase();
    const kinds = query.kinds ? new Set(query.kinds) : undefined;
    const seqs = this._seqs(scope);
    /** @type {(BrainHit & { seq: number })[]} */
    const hits = [];
    for (const rec of this._store(scope).values()) {
      const salience = rec.salience ?? 1;
      if (kinds && !kinds.has(rec.kind)) continue;
      if (query.minSalience !== undefined && salience < query.minSalience) continue;
      let score = 1;
      if (text) {
        const hay = rec.content.toLowerCase();
        if (!hay.includes(text)) continue;
        score = text.length / hay.length; // densité de la sous-chaîne
      }
      hits.push({
        id: rec.id,
        content: rec.content,
        kind: rec.kind,
        salience,
        score,
        metadata: rec.metadata,
        seq: seqs.get(rec.id) ?? 0,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.salience - a.salience || b.seq - a.seq);
    const topK = query.topK ?? policy.recallTopK;
    return hits.slice(0, Math.max(0, topK)).map(({ seq: _seq, ...hit }) => hit);
  }

  /**
   * @param {string[]} ids
   * @param {RuntimeScope} scope
   * @returns {Promise<void>}
   */
  async forget(ids, scope) {
    const store = this._store(scope);
    const seqs = this._seqs(scope);
    for (const id of ids) {
      store.delete(id);
      seqs.delete(id);
    }
  }
}

// ── Seam de composition/DI ─────────────────────────────────────────────────────

/**
 * Seam de composition du port ADR §3. Point unique où l'on câble l'impl
 * `IBrainMemory`. Défaut = in-memory ; le backend durable (LanceDB, S3-stored) s'y
 * substitue par injection sans toucher les appelants.
 * @param {IBrainMemory} [impl] impl injectée (défaut in-memory)
 * @returns {IBrainMemory}
 */
export function createBrainMemory(impl = new InMemoryBrainMemory()) {
  return assertBrainMemory(impl);
}

/**
 * @typedef {object} CreateBrainMemoryResult
 * @property {IBrainMemory} memory
 * @property {string} backend
 * @property {boolean} durable
 */

/**
 * Sélection d'impl `IBrainMemory` par ENV (le mode de stockage est un choix
 * d'adapter, PAS du port : parité createVectorMemory). Défaut = in-memory
 * (déterministe, sans dépendance). `BRAIN_MEMORY_PROVIDER=lancedb` demande le backend
 * DURABLE LanceDB embarqué (S3-stored via `BRAIN_LANCEDB_URI`, chemin local ou
 * `s3://…`) — mais celui-ci dépend du package `@lancedb/lancedb` et n'est PAS bundlé
 * dans le cœur (parité IWorkflowRuntime/Inngest) : il est fourni via
 * `opts.durableFactory` (injection consommateur). Sélection réversible ; provider=lancedb
 * sans factory → erreur explicite (doctrine §2 : dégradation explicite, pas de piège).
 * @param {object} [opts]
 * @param {'auto'|'memory'|'lancedb'} [opts.prefer] préférence (défaut env ou 'auto')
 * @param {(env: Record<string, string | undefined>) => Promise<IBrainMemory>} [opts.durableFactory] fabrique du backend durable (consommateur)
 * @param {Record<string, string | undefined>} [opts.env] env (défaut process.env)
 * @returns {Promise<CreateBrainMemoryResult>}
 */
export async function brainMemoryFromEnv(opts = {}) {
  const env = opts.env || (typeof process !== "undefined" && process.env ? process.env : {});
  const provider =
    opts.prefer && opts.prefer !== "auto"
      ? opts.prefer
      : env["BRAIN_MEMORY_PROVIDER"] ?? "memory";

  if (provider === "memory") {
    const memory = new InMemoryBrainMemory();
    return { memory: assertBrainMemory(memory), backend: "memory", durable: false };
  }
  if (provider === "lancedb") {
    if (typeof opts.durableFactory !== "function") {
      throw new Error(
        "brainMemoryFromEnv: provider='lancedb' requires an injected `durableFactory` " +
          "(the durable backend depends on the `@lancedb/lancedb` package and is not bundled in the core)",
      );
    }
    const memory = await opts.durableFactory(env);
    return { memory: assertBrainMemory(memory), backend: "lancedb", durable: true };
  }
  throw new Error(`Unknown BRAIN_MEMORY_PROVIDER: ${provider}`);
}
