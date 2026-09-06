// @ori3com/agent-core — ICognitiveMemory unifié (ADR-0001 C03).
// Converge l'impl P02 de o3c-code-cli (src/agent-core/memory/*) DÉCOUPLÉE de tout
// o3c-code-cli-specific : le "cerveau" inter-session derrière UN port substituable.
//   • LocalCognitiveMemory — fallback pur-JS TF·IDF, in-memory, WASM-clean (aucun
//     import node:fs) ; persistance OPTIONNELLE injectée via le port IStorageLayer.
//   • CogneeCognitiveMemory — adapter cognee-rs (@cognee/cognee-ts), chargé en
//     dynamic-import + probe runtime : jamais une hard-dep (ADR §3, cognee early-stage).
//   • createCognitiveMemory() — seam `fromEnv`/DI : cognee si dispo, sinon fallback
//     pur-JS (dégradation RÉVERSIBLE, même contrat).
// Le contrat (remember/recall/cognify/count/clear + capabilities) est délibérément
// petit et async-first pour qu'un addon natif, un service distant ou un fichier local
// le satisfasse à l'identique.

/**
 * @typedef {import("./ports.mjs").IStorageLayer} IStorageLayer
 * @typedef {import("./ports.mjs").MemoryItem} MemoryItem
 * @typedef {import("./ports.mjs").RecallHit} RecallHit
 * @typedef {import("./ports.mjs").MemoryCapabilities} MemoryCapabilities
 * @typedef {import("./ports.mjs").ICognitiveMemory} ICognitiveMemory
 */

/** Méthodes que tout adapter ICognitiveMemory DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze([
  "remember",
  "recall",
  "cognify",
  "count",
  "clear",
]);

/**
 * Vérifie structurellement qu'un objet satisfait le port ICognitiveMemory. Lève une
 * Error descriptive listant ce qui manque — utilisé par la factory et les tests pour
 * qu'un adapter cassé échoue bruyamment au lieu de corrompre silencieusement le recall.
 * @param {any} adapter
 * @returns {ICognitiveMemory} le même adapter, quand valide
 */
export function assertCognitiveMemory(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("ICognitiveMemory: adapter must be an object");
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new Error(`ICognitiveMemory: adapter missing method(s): ${missing.join(", ")}`);
  }
  const caps = adapter.capabilities;
  if (!caps || typeof caps.backend !== "string") {
    throw new Error("ICognitiveMemory: adapter must expose capabilities.backend (string)");
  }
  return /** @type {ICognitiveMemory} */ (adapter);
}

// ── TF·IDF pur (aucun I/O, aucune dépendance) ──────────────────────────────────

/**
 * Tokenise en stems minuscules, en découpant le camelCase pour que les identifiants
 * de code (ex. "ClerkAuth") se rappellent par leurs parties ("clerk", "auth").
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFreq(tokens) {
  /** @type {Map<string, number>} */
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/** TF cachée par item (clé Symbol → jamais sérialisée par JSON.stringify). */
const ITEM_TF = Symbol("tf");
/**
 * @param {any} item
 * @returns {Map<string, number>}
 */
function tfOf(item) {
  let tf = item[ITEM_TF];
  if (!tf) {
    tf = termFreq(tokenize(item.text));
    item[ITEM_TF] = tf;
  }
  return tf;
}

/**
 * Fréquence documentaire : terme → nombre d'items le contenant (une fois chacun).
 * @param {MemoryItem[]} items
 * @returns {Map<string, number>}
 */
function docFreq(items) {
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const it of items) {
    for (const t of tfOf(it).keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

/**
 * IDF lissée pour un terme sur un corpus de N items.
 * @param {Map<string, number>} df
 * @param {number} n
 * @param {string} term
 * @returns {number}
 */
function idfOf(df, n, term) {
  return Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
}

/**
 * Pondère une TF en vecteur TF·IDF (les termes discriminants dominent).
 * @param {Map<string, number>} tf
 * @param {Map<string, number>} df
 * @param {number} n
 * @returns {Map<string, number>}
 */
function weighted(tf, df, n) {
  /** @type {Map<string, number>} */
  const w = new Map();
  for (const [t, f] of tf) w.set(t, f * idfOf(df, n, t));
  return w;
}

/**
 * Similarité cosinus entre deux vecteurs (Map), dans [0, 1].
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number}
 */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w) dot += v * w;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── LocalCognitiveMemory — fallback pur-JS, WASM-clean ─────────────────────────

/**
 * Fallback toujours disponible quand cognee-rs est absent. Ce N'EST PAS un stub :
 * il classe le recall par vraie similarité sémantique (TF·IDF cosinus déterministe,
 * aucun service d'embedding ni réseau). Le cœur est in-memory et sans I/O (WASM-clean) ;
 * la persistance est OPTIONNELLE et passe par le port IStorageLayer injecté (JSONL),
 * jamais par un import direct de node:fs.
 * @implements {ICognitiveMemory}
 */
export class LocalCognitiveMemory {
  /**
   * @param {object} [opts]
   * @param {string} [opts.projectId] namespace du cerveau (défaut 'default')
   * @param {IStorageLayer} [opts.storage] couche de stockage pour la persistance JSONL
   * @param {string} [opts.key] clé de stockage (défaut `brain/<projectId>.jsonl`)
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.projectId = opts.projectId || "default";
    /** @type {IStorageLayer | undefined} */
    this._storage = opts.storage;
    const safe = String(this.projectId).replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
    /** @type {string} */
    this._key = opts.key || `brain/${safe}.jsonl`;
    /** @type {MemoryItem[]} */
    this._items = [];
    /** @type {number} Compteur d'ids monotone (repris au-delà du corpus hydraté). */
    this._seq = 0;
  }

  /** @returns {MemoryCapabilities} */
  get capabilities() {
    return {
      backend: "local",
      persistent: Boolean(this._storage),
      semantic: true,
      native: false,
    };
  }

  /** Id monotone, sans dépendance à Date.now()/random (reproductible, WASM-clean). */
  _nextId() {
    this._seq += 1;
    return `mem_${this._seq.toString(36)}`;
  }

  /**
   * Charge le corpus persisté depuis le storage injecté (JSONL, tolérant aux lignes
   * corrompues). No-op quand aucun storage n'est configuré. À appeler après construction.
   * @returns {Promise<this>}
   */
  async hydrate() {
    if (!this._storage) return this;
    let bytes;
    try {
      bytes = await this._storage.get(this._key);
    } catch {
      return this;
    }
    if (!bytes) return this;
    const raw = new TextDecoder().decode(bytes);
    /** @type {MemoryItem[]} */
    const out = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj.text === "string" && obj.text.trim()) out.push(obj);
      } catch {
        /* ligne corrompue ignorée */
      }
    }
    this._items = out;
    // Reprend la séquence au-delà du corpus chargé pour éviter les collisions d'id.
    this._seq = out.length;
    return this;
  }

  /** Écrit un snapshot JSONL complet via le storage. Best-effort : n'entrave jamais l'appelant. */
  async _persist() {
    if (!this._storage) return;
    try {
      const body = this._items.map((i) => JSON.stringify(i)).join("\n");
      const bytes = new TextEncoder().encode(body ? body + "\n" : "");
      await this._storage.put(this._key, bytes);
    } catch {
      /* la persistance est best-effort */
    }
  }

  /**
   * @param {{ text: string, id?: string, kind?: string, meta?: Record<string, unknown> }} input
   * @returns {Promise<MemoryItem>}
   */
  async remember(input) {
    if (!input || typeof input.text !== "string" || !input.text.trim()) {
      throw new Error("remember: `text` (non-empty string) is required");
    }
    /** @type {MemoryItem} */
    const item = {
      id: input.id || this._nextId(),
      text: input.text,
      kind: input.kind || "fact",
      meta: input.meta || {},
      ts: this._items.length, // horloge logique = index d'insertion
    };
    this._items.push(item);
    await this._persist();
    return item;
  }

  /**
   * Top-k par similarité TF·IDF cosinus (desc), puis récence. L'IDF est calculée sur
   * le corpus courant : un terme partagé par beaucoup de mémoires pèse moins qu'un
   * terme rare et discriminant → le recall surface la mémoire la plus PERTINENTE.
   * @param {string} query
   * @param {number} [k]
   * @returns {Promise<RecallHit[]>}
   */
  async recall(query, k = 5) {
    const qtokens = tokenize(query);
    if (qtokens.length === 0) return [];
    const n = this._items.length;
    const df = docFreq(this._items);
    const qv = weighted(termFreq(qtokens), df, n);
    const hits = this._items.map((item) => ({
      item,
      score: cosine(qv, weighted(tfOf(item), df, n)),
    }));
    return hits
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || (b.item.ts ?? 0) - (a.item.ts ?? 0))
      .slice(0, Math.max(0, k));
  }

  /**
   * Consolide la mémoire retenue. Le backend local n'a pas d'index séparé (le recall
   * est calculé à la lecture) : reporte la taille du corpus et compacte le snapshot.
   * @returns {Promise<{ items: number }>}
   */
  async cognify() {
    await this._persist();
    return { items: this._items.length };
  }

  /** @returns {Promise<number>} */
  async count() {
    return this._items.length;
  }

  /**
   * Les items retenus les plus récents (plus récent d'abord) — seed de prompt sans query.
   * @param {number} [k]
   * @returns {Promise<MemoryItem[]>}
   */
  async recent(k = 8) {
    return this._items
      .slice()
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, Math.max(0, k));
  }

  /** @returns {Promise<void>} */
  async clear() {
    this._items = [];
    this._seq = 0;
    if (this._storage) {
      try {
        await this._storage.delete(this._key);
      } catch {
        /* best-effort */
      }
    }
  }
}

// ── CogneeCognitiveMemory — adapter natif, dynamic-import + probe ───────────────

/** Le package upstream fournissant les bindings natifs cognee-rs. */
export const COGNEE_PACKAGE = "@cognee/cognee-ts";

/** Modules dont l'init() natif one-shot a déjà tourné (évite les re-init throws). */
const _inited = new WeakSet();

/**
 * @param {any} mod
 * @returns {any}
 */
function resolveCognee(mod) {
  return mod?.Cognee || mod?.default?.Cognee || null;
}

/**
 * Exécute l'init() runtime one-shot de l'addon au plus une fois par module. Peut throw.
 * @param {any} mod
 */
function initOnce(mod) {
  if (mod && typeof mod.init === "function" && !_inited.has(mod)) {
    mod.init();
    _inited.add(mod);
  }
}

/**
 * Sonde si l'addon natif cognee-rs peut être chargé ET initialisé sur cet hôte.
 * Importer le wrapper JS ne suffit pas : le binaire prébuilt `.node` n'échoue qu'au
 * premier contact runtime (ex. libstdc++ obsolète, glibc 2.36<2.38 — ADR §3), donc on
 * exécute init() ici et on traite tout échec comme "indisponible", jamais un crash.
 * @returns {Promise<{ available: boolean, module?: any, error?: string }>}
 */
export async function loadCognee() {
  try {
    const imported = await import(/* @vite-ignore */ COGNEE_PACKAGE);
    const mod = imported.default || imported;
    if (typeof resolveCognee(mod) !== "function") {
      return { available: false, error: "module does not expose a Cognee class" };
    }
    initOnce(mod);
    return { available: true, module: mod };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Probe booléen de commodité. */
export async function isCogneeAvailable() {
  return (await loadCognee()).available;
}

/**
 * Backend cognee-rs pour le port ICognitiveMemory. Mappe le contrat sur la surface
 * `@cognee/cognee-ts` v0.2 : `add({type:'text',text}, dataset)`, `cognify(dataset)`,
 * `search(query, {searchType, datasets, topK})`, et le sous-objet `datasets`.
 * @implements {ICognitiveMemory}
 */
export class CogneeCognitiveMemory {
  /**
   * @param {any} mod module `@cognee/cognee-ts` résolu (expose `Cognee`, `init`)
   * @param {object} [opts]
   * @param {string} [opts.projectId] namespace dataset passé à cognee-rs
   * @param {object|string} [opts.settings] settings/config cognee optionnels
   */
  constructor(mod, opts = {}) {
    if (!mod) throw new Error("CogneeCognitiveMemory: a resolved cognee module is required");
    const Cognee = resolveCognee(mod);
    if (typeof Cognee !== "function") {
      throw new Error("CogneeCognitiveMemory: module does not expose the Cognee class");
    }
    initOnce(mod);
    this._mod = mod;
    this._c = new Cognee(opts.settings);
    this.projectId = opts.projectId || "default";
    this._dataset = `o3c_${String(this.projectId).replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  /** @returns {MemoryCapabilities} */
  get capabilities() {
    return { backend: "cognee", persistent: true, semantic: true, native: true };
  }

  /**
   * @param {{ text: string, id?: string, kind?: string, meta?: Record<string, unknown> }} input
   * @returns {Promise<MemoryItem>}
   */
  async remember(input) {
    if (!input || typeof input.text !== "string" || !input.text.trim()) {
      throw new Error("remember: `text` (non-empty string) is required");
    }
    const res = await this._c.add({ type: "text", text: input.text }, this._dataset);
    const rec = Array.isArray(res?.added) ? res.added[0] : null;
    return {
      id: input.id || rec?.id || this._dataset,
      text: input.text,
      kind: input.kind || "fact",
      meta: input.meta || {},
      ts: 0,
    };
  }

  /**
   * @param {string} query
   * @param {number} [k]
   * @returns {Promise<RecallHit[]>}
   */
  async recall(query, k = 5) {
    const resp = await this._c.search(query, {
      searchType: "CHUNKS",
      datasets: [this._dataset],
      topK: k,
    });
    const out = resp?.result;
    const rows = out && out.kind === "Items" && Array.isArray(out.data) ? out.data : [];
    return rows.slice(0, k).map((/** @type {any} */ it) => {
      const payload = it?.payload || {};
      return {
        item: {
          id: it?.id ?? this._dataset,
          text: String(payload.text ?? payload.content ?? ""),
          kind: payload.kind || "fact",
          meta: payload,
          ts: 0,
        },
        score: typeof it?.score === "number" ? it.score : 0,
      };
    });
  }

  /** @returns {Promise<{ items: number }>} */
  async cognify() {
    const res = await this._c.cognify(this._dataset);
    const items =
      typeof res?.entities === "number"
        ? res.entities
        : typeof res?.chunks === "number"
          ? res.chunks
          : 0;
    return { items };
  }

  /** @returns {Promise<number>} */
  async count() {
    const ds = await this._findDataset();
    if (!ds) return 0;
    const data = await this._c.datasets.listData(ds.id);
    return Array.isArray(data) ? data.length : 0;
  }

  /** @returns {Promise<void>} */
  async clear() {
    const ds = await this._findDataset();
    if (ds) await this._c.datasets.empty(ds.id);
  }

  /** @returns {Promise<{ id: string, name: string } | null>} */
  async _findDataset() {
    const all = await this._c.datasets.list();
    return Array.isArray(all)
      ? all.find((/** @type {any} */ d) => d.name === this._dataset) || null
      : null;
  }
}

// ── Seam fromEnv/DI ────────────────────────────────────────────────────────────

/**
 * @typedef {object} CreateCognitiveMemoryResult
 * @property {ICognitiveMemory} memory
 * @property {string} backend
 * @property {boolean} nativeAvailable
 */

/**
 * Construit une mémoire cognitive derrière le port ICognitiveMemory. Préfère cognee-rs
 * quand son addon natif est présent+chargeable, sinon fallback pur-JS toujours dispo
 * (dégradation RÉVERSIBLE, même contrat). Le chemin natif est sondé en dynamic-import
 * et n'est jamais une hard-dep (ADR §3). `prefer` peut venir de l'env COGNITIVE_MEMORY_PROVIDER.
 * @param {object} [opts]
 * @param {string} [opts.projectId] namespace du cerveau (défaut 'default')
 * @param {'auto'|'cognee'|'local'} [opts.prefer] préférence backend (défaut env ou 'auto')
 * @param {IStorageLayer} [opts.storage] persistance JSONL du fallback local (optionnel)
 * @param {string} [opts.key] clé de stockage du fallback local (optionnel)
 * @returns {Promise<CreateCognitiveMemoryResult>}
 */
export async function createCognitiveMemory(opts = {}) {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const prefer = opts.prefer || envPrefer(env["COGNITIVE_MEMORY_PROVIDER"]);
  const probe = prefer === "local" ? { available: false } : await loadCognee();
  const nativeAvailable = probe.available;

  /** @type {ICognitiveMemory} */
  let memory;
  if (nativeAvailable && probe.module && (prefer === "auto" || prefer === "cognee")) {
    memory = new CogneeCognitiveMemory(probe.module, { projectId: opts.projectId });
  } else {
    const local = new LocalCognitiveMemory({
      projectId: opts.projectId,
      storage: opts.storage,
      key: opts.key,
    });
    await local.hydrate();
    memory = local;
  }

  assertCognitiveMemory(memory);
  return { memory, backend: memory.capabilities.backend, nativeAvailable };
}

/**
 * Normalise une valeur d'env en préférence backend valide.
 * @param {string | undefined} v
 * @returns {'auto'|'cognee'|'local'}
 */
function envPrefer(v) {
  return v === "cognee" || v === "local" ? v : "auto";
}

// ── buildMemorySeed — seed de prompt inter-session (C08, convergence consommateurs) ─

/**
 * Rendu une-ligne d'un item retenu pour le seed de prompt.
 * @param {MemoryItem} item
 * @returns {string}
 */
function renderSeedItem(item) {
  const kind = item.kind || "fact";
  const text = String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `- [${kind}] ${text}`;
}

/**
 * Construit un bloc « recall » pour le prompt système d'un agent : les items les plus
 * récents que le cerveau cognitif a retenus des sessions précédentes. Surface la mémoire
 * inter-session dans le prompt, en complément du chemin recall à la demande. Canal-agnostique
 * et DI-first : accepte un `memory` déjà construit, sinon en construit un via
 * `createCognitiveMemory` (même seam/env). Best-effort — retourne '' quand le cerveau est
 * vide, indisponible, ou que le backend ne sait pas énumérer les items récents (ex. cognee-rs
 * n'expose pas `recent`). Extrait de l'impl P02 de o3c-code-cli, découplé de tout CLI-specific.
 * @param {object} [opts]
 * @param {ICognitiveMemory} [opts.memory] mémoire déjà construite (DI) ; sinon construite via createCognitiveMemory
 * @param {string} [opts.projectId] namespace du cerveau (défaut 'default')
 * @param {'auto'|'cognee'|'local'} [opts.prefer] préférence backend
 * @param {IStorageLayer} [opts.storage] persistance JSONL du fallback local (optionnel)
 * @param {string} [opts.key] clé de stockage du fallback local (optionnel)
 * @param {number} [opts.limit] nombre max d'items listés (défaut 8)
 * @returns {Promise<string>} un bloc markdown, ou '' quand vide/indisponible
 */
export async function buildMemorySeed(opts = {}) {
  const limit = typeof opts.limit === "number" ? opts.limit : 8;

  /** @type {ICognitiveMemory | undefined} */
  let memory = opts.memory;
  let backend = memory ? memory.capabilities?.backend || "unknown" : "";
  if (!memory) {
    try {
      const built = await createCognitiveMemory({
        projectId: opts.projectId,
        prefer: opts.prefer,
        storage: opts.storage,
        key: opts.key,
      });
      memory = built.memory;
      backend = built.backend;
    } catch {
      return "";
    }
  }

  // `recent` n'est pas dans REQUIRED_METHODS : certains backends (cognee-rs) ne l'exposent pas.
  if (typeof (/** @type {any} */ (memory).recent) !== "function") return "";

  /** @type {MemoryItem[] | undefined} */
  let items;
  try {
    items = await (/** @type {any} */ (memory).recent(limit));
  } catch {
    return "";
  }
  if (!items || !items.length) return "";

  return (
    `## Memory from earlier sessions (${backend}: ${items.length} items)\n` +
    "What prior sessions on this project retained (use recall for details):\n" +
    items.map(renderSeedItem).join("\n")
  );
}
