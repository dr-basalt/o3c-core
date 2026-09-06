// @ori3com/agent-core — IVectorMemory unifié (ADR-0001 C05).
// La mémoire vectorielle edge derrière UN port substituable, extraite/refactorée
// depuis o3c-chat/packages/agent-runtime (vector-memory.ts + adapters/zvec) et
// DÉCOUPLÉE de tout o3c-chat-specific (pas de ProjectRag, pas de S3 SDK direct) :
//   • LocalVectorMemory — fallback pur-JS, cosinus dense in-memory, WASM-clean
//     (aucun import node:fs) ; persistance OPTIONNELLE injectée via IStorageLayer.
//   • ZvecVectorMemory — adapter natif @ori3com/zvec, chargé en dynamic-import +
//     probe runtime : jamais une hard-dep (ADR §3, binding .node/glibc).
//   • createVectorMemory() — seam `fromEnv`/DI : zvec si dispo, sinon fallback
//     pur-JS (dégradation RÉVERSIBLE, même contrat).
// Le port ne connaît QUE `ns` comme partition (= projectId) : aucune fuite du
// backend (zvec/S3/Cozo) dans les signatures. Les vecteurs sont fournis par
// l'appelant (embedder-agnostique) — le port ne calcule pas d'embedding.

/**
 * @typedef {import("./ports.mjs").IStorageLayer} IStorageLayer
 * @typedef {import("./ports.mjs").IVectorMemory} IVectorMemory
 * @typedef {import("./ports.mjs").VectorDoc} VectorDoc
 * @typedef {import("./ports.mjs").VectorHit} VectorHit
 */

/** Méthodes que tout adapter IVectorMemory DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze(["upsert", "query", "delete"]);

/**
 * Vérifie structurellement qu'un objet satisfait le port IVectorMemory. Lève une
 * Error descriptive listant ce qui manque — pour qu'un adapter cassé échoue
 * bruyamment au lieu de corrompre silencieusement le recall vectoriel.
 * @param {any} adapter
 * @returns {IVectorMemory} le même adapter, quand valide
 */
export function assertVectorMemory(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("IVectorMemory: adapter must be an object");
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new Error(`IVectorMemory: adapter missing method(s): ${missing.join(", ")}`);
  }
  return /** @type {IVectorMemory} */ (adapter);
}

// ── Cosinus dense pur (aucun I/O, aucune dépendance) ───────────────────────────

/**
 * Similarité cosinus entre deux vecteurs denses, dans [-1, 1]. Renvoie 0 si l'un
 * est nul ou si les dimensions diffèrent (tolérant : jamais de throw en query).
 * @param {number[] | undefined} a
 * @param {number[] | undefined} b
 * @returns {number}
 */
function denseCosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── LocalVectorMemory — fallback pur-JS, WASM-clean ────────────────────────────

/**
 * Fallback toujours disponible quand zvec est absent. Ce N'EST PAS un stub : il
 * classe la query par vraie similarité cosinus sur les vecteurs denses fournis
 * (déterministe, aucun réseau, aucun binding natif). Le cœur est in-memory et sans
 * I/O (WASM-clean) ; la persistance est OPTIONNELLE et passe par le port
 * IStorageLayer injecté (un snapshot JSON par ns), jamais par un import de node:fs.
 * @implements {IVectorMemory}
 */
export class LocalVectorMemory {
  /**
   * @param {object} [opts]
   * @param {IStorageLayer} [opts.storage] couche de stockage pour la persistance JSON
   * @param {string} [opts.keyPrefix] préfixe de clé de stockage (défaut 'vector/')
   */
  constructor(opts = {}) {
    /** @type {IStorageLayer | undefined} */
    this._storage = opts.storage;
    /** @type {string} */
    this._keyPrefix = opts.keyPrefix || "vector/";
    /** @type {Map<string, Map<string, VectorDoc>>} ns → (id → doc) */
    this._ns = new Map();
    /** @type {Set<string>} namespaces déjà hydratés depuis le storage. */
    this._hydrated = new Set();
  }

  /** Capacités du backend (miroir de ICognitiveMemory.capabilities). */
  get capabilities() {
    return {
      backend: "local",
      persistent: Boolean(this._storage),
      semantic: true,
      native: false,
    };
  }

  /**
   * Clé de stockage d'un namespace (sanitize pour un chemin de storage sûr).
   * @param {string} ns
   * @returns {string}
   */
  _key(ns) {
    const safe = String(ns || "default").replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
    return `${this._keyPrefix}${safe}.json`;
  }

  /**
   * Retourne la partition d'un ns, en l'hydratant depuis le storage au 1er accès.
   * @param {string} ns
   * @returns {Promise<Map<string, VectorDoc>>}
   */
  async _partition(ns) {
    let part = this._ns.get(ns);
    if (part) return part;
    part = new Map();
    this._ns.set(ns, part);
    if (this._storage && !this._hydrated.has(ns)) {
      this._hydrated.add(ns);
      try {
        const bytes = await this._storage.get(this._key(ns));
        if (bytes) {
          const arr = JSON.parse(new TextDecoder().decode(bytes));
          if (Array.isArray(arr)) {
            for (const d of arr) {
              if (d && typeof d.id === "string" && Array.isArray(d.vector)) part.set(d.id, d);
            }
          }
        }
      } catch {
        /* snapshot corrompu ou storage indispo → partition vide, best-effort */
      }
    }
    return part;
  }

  /**
   * Écrit un snapshot JSON complet du ns via le storage. Best-effort.
   * @param {string} ns
   * @param {Map<string, VectorDoc>} part
   */
  async _persist(ns, part) {
    if (!this._storage) return;
    try {
      const body = JSON.stringify([...part.values()]);
      await this._storage.put(this._key(ns), new TextEncoder().encode(body));
    } catch {
      /* la persistance est best-effort */
    }
  }

  /**
   * @param {string} ns
   * @param {VectorDoc[]} docs
   * @returns {Promise<void>}
   */
  async upsert(ns, docs) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    const part = await this._partition(ns);
    for (const d of docs) {
      if (!d || typeof d.id !== "string" || !d.id) {
        throw new Error("upsert: each doc requires a non-empty string `id`");
      }
      if (!Array.isArray(d.vector) || d.vector.length === 0) {
        throw new Error(`upsert: doc ${d.id} requires a non-empty numeric vector`);
      }
      part.set(d.id, {
        id: d.id,
        text: typeof d.text === "string" ? d.text : "",
        vector: d.vector.slice(),
        metadata: d.metadata ? { ...d.metadata } : undefined,
      });
    }
    await this._persist(ns, part);
  }

  /**
   * Top-k par similarité cosinus (desc). Renvoie {id, score, metadata, text} — `text`
   * est un extra de commodité au-delà du port (les consommateurs veulent le contenu).
   * @param {string} ns
   * @param {{ text?: string, vector: number[], topK?: number }} q
   * @returns {Promise<VectorHit[]>}
   */
  async query(ns, q) {
    const part = await this._partition(ns);
    if (!q || !Array.isArray(q.vector) || part.size === 0) return [];
    const k = q.topK ?? 5;
    /** @type {VectorHit[]} */
    const hits = [];
    for (const d of part.values()) {
      hits.push({
        id: d.id,
        score: denseCosine(q.vector, d.vector),
        metadata: d.metadata,
        text: d.text,
      });
    }
    return hits
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }

  /**
   * @param {string} ns
   * @param {string[]} ids
   * @returns {Promise<void>}
   */
  async delete(ns, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const part = await this._partition(ns);
    let changed = false;
    for (const id of ids) changed = part.delete(id) || changed;
    if (changed) await this._persist(ns, part);
  }

  /**
   * Nombre de vecteurs dans un ns (commodité hors-port, utile aux tests).
   * @param {string} ns
   * @returns {Promise<number>}
   */
  async count(ns) {
    return (await this._partition(ns)).size;
  }

  /**
   * Vide un ns (ou tous si omis). Supprime aussi le snapshot persisté.
   * @param {string} [ns]
   * @returns {Promise<void>}
   */
  async clear(ns) {
    if (ns === undefined) {
      const names = [...this._ns.keys()];
      this._ns.clear();
      if (this._storage) {
        for (const n of names) {
          try {
            await this._storage.delete(this._key(n));
          } catch {
            /* best-effort */
          }
        }
      }
      return;
    }
    this._ns.delete(ns);
    if (this._storage) {
      try {
        await this._storage.delete(this._key(ns));
      } catch {
        /* best-effort */
      }
    }
  }
}

// ── ZvecVectorMemory — adapter natif, dynamic-import + probe ────────────────────

/** Le package upstream fournissant l'engine vectoriel natif. */
export const ZVEC_PACKAGE = "@ori3com/zvec";

/**
 * Sonde si l'engine natif zvec peut être chargé sur cet hôte. Importer le wrapper
 * JS ne suffit pas : le binding `.node` charge un binaire prébuilt qui peut échouer
 * au runtime (glibc/libstdc++ obsolète — ADR §3), donc on traite tout échec comme
 * "indisponible", jamais un crash. Miroir de `loadCognee`.
 * @returns {Promise<{ available: boolean, module?: any, error?: string }>}
 */
export async function loadZvec() {
  try {
    const imported = await import(/* @vite-ignore */ ZVEC_PACKAGE);
    const mod = imported.default || imported;
    if (typeof mod?.createZvecStore !== "function") {
      return { available: false, error: "module does not expose createZvecStore" };
    }
    return { available: true, module: mod };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Probe booléen de commodité. */
export async function isZvecAvailable() {
  return (await loadZvec()).available;
}

/**
 * Backend zvec pour le port IVectorMemory. Encapsule 100% de @ori3com/zvec — c'est
 * le SEUL endroit qui connaît l'engine. `ns` (= projectId) → partition PHYSIQUE via
 * createZvecStore(ns). zvec possède son propre storage S3 interne (axe embarqué vs
 * déporté, hors du port) : aucun accès S3 SDK direct ici (contrainte cardinale).
 * @implements {IVectorMemory}
 */
export class ZvecVectorMemory {
  /**
   * @param {any} mod module `@ori3com/zvec` résolu (expose `createZvecStore`)
   * @param {object} [opts]
   * @param {string} [opts.collection] collection zvec (défaut 'knowledge')
   */
  constructor(mod, opts = {}) {
    if (!mod || typeof mod.createZvecStore !== "function") {
      throw new Error(
        "ZvecVectorMemory: a resolved @ori3com/zvec module (exposing createZvecStore) is required",
      );
    }
    this._mod = mod;
    this._collection = opts.collection || "knowledge";
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "zvec", persistent: true, semantic: true, native: true };
  }

  /**
   * @param {string} ns
   * @returns {Promise<any>}
   */
  async _store(ns) {
    return this._mod.createZvecStore(ns);
  }

  /**
   * @param {string} ns
   * @param {VectorDoc[]} docs
   * @returns {Promise<void>}
   */
  async upsert(ns, docs) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    const store = await this._store(ns);
    await store.insert(
      this._collection,
      docs.map((d) => ({
        id: d.id,
        content: typeof d.text === "string" ? d.text : "",
        embedding: d.vector,
        fields: { ...(d.metadata ?? {}), project_id: ns },
      })),
    );
  }

  /**
   * @param {string} ns
   * @param {{ text?: string, vector: number[], topK?: number }} q
   * @returns {Promise<VectorHit[]>}
   */
  async query(ns, q) {
    const store = await this._store(ns);
    const hits = await store.hybridQuery(this._collection, {
      text: q.text ?? "",
      vector: q.vector,
      topK: q.topK ?? 5,
    });
    return (Array.isArray(hits) ? hits : []).map((/** @type {any} */ h) => ({
      id: h.id,
      score: typeof h.score === "number" ? h.score : 0,
      text: typeof h.content === "string" ? h.content : undefined,
      metadata: h.fields,
    }));
  }

  /**
   * zvec n'expose pas (encore) de delete par id au niveau store → no-op best-effort
   * documenté (le contrat du port interdit de throw ici).
   * @param {string} _ns
   * @param {string[]} _ids
   * @returns {Promise<void>}
   */
  async delete(_ns, _ids) {
    /* no-op best-effort : ne jamais throw (contrat du port) */
  }
}

// ── Seam fromEnv/DI ────────────────────────────────────────────────────────────

/**
 * @typedef {object} CreateVectorMemoryResult
 * @property {IVectorMemory} memory
 * @property {string} backend
 * @property {boolean} nativeAvailable
 */

/**
 * Construit une mémoire vectorielle derrière le port IVectorMemory. Préfère zvec
 * quand son engine natif est présent+chargeable, sinon fallback pur-JS toujours
 * dispo (dégradation RÉVERSIBLE, même contrat). Le chemin natif est sondé en
 * dynamic-import et n'est JAMAIS tiré quand non utilisé (ADR §1/§3). `prefer` peut
 * venir de l'env VECTOR_MEMORY_PROVIDER.
 * @param {object} [opts]
 * @param {'auto'|'zvec'|'local'} [opts.prefer] préférence backend (défaut env ou 'auto')
 * @param {IStorageLayer} [opts.storage] persistance JSON du fallback local (optionnel)
 * @param {string} [opts.keyPrefix] préfixe de clé du fallback local (optionnel)
 * @param {string} [opts.collection] collection zvec (optionnel)
 * @returns {Promise<CreateVectorMemoryResult>}
 */
export async function createVectorMemory(opts = {}) {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const prefer = opts.prefer || envPrefer(env["VECTOR_MEMORY_PROVIDER"]);
  const probe = prefer === "local" ? { available: false } : await loadZvec();
  const nativeAvailable = probe.available;

  /** @type {IVectorMemory} */
  let memory;
  if (nativeAvailable && probe.module && (prefer === "auto" || prefer === "zvec")) {
    memory = new ZvecVectorMemory(probe.module, { collection: opts.collection });
  } else {
    memory = new LocalVectorMemory({ storage: opts.storage, keyPrefix: opts.keyPrefix });
  }

  assertVectorMemory(memory);
  return {
    memory,
    backend: /** @type {any} */ (memory).capabilities?.backend ?? "local",
    nativeAvailable,
  };
}

/** Alias fromEnv explicite (cohérent avec llmFromEnv/modelProviderFromEnv). */
export const vectorMemoryFromEnv = createVectorMemory;

/**
 * Normalise une valeur d'env en préférence backend valide.
 * @param {string | undefined} v
 * @returns {'auto'|'zvec'|'local'}
 */
function envPrefer(v) {
  return v === "zvec" || v === "local" ? v : "auto";
}
