// @ori3com/agent-core — IStorageLayer unifié (ADR-0001 C05).
// La couche de stockage objet derrière UN port substituable, extraite/refactorée
// depuis o3c-chat/packages/agent-runtime (object-store + fs/s3 adapters) et
// DÉCOUPLÉE de tout o3c-chat-specific (pas de registres skills/prompts/tools) :
//   • MemoryStorageLayer — pur-JS in-memory, WASM-clean (aucun import node:*),
//     défaut sûr + base des tests et de la persistance mémoire/vecteur injectée.
//   • FsStorageLayer — adapter système de fichiers, node:fs chargé en DYNAMIC-import
//     (jamais statique → le cœur reste WASM-clean) ; anti-traversal sous `root`.
//   • S3StorageLayer — adapter S3 (Hetzner/R2/MinIO…), @aws-sdk/client-s3 chargé en
//     dynamic-import + probe : jamais une hard-dep (optionalDependencies).
//   • createStorageLayer() — seam `fromEnv`/DI : s3 si configuré+dispo, sinon fs si
//     un root est fourni, sinon in-memory (dégradation RÉVERSIBLE, même contrat).
// Le port est volontairement petit (get/put/delete/list) pour qu'un fs, un bucket
// S3 ou un KV edge le satisfasse à l'identique ; `list(prefix)` renvoie des clés.

/**
 * @typedef {import("./ports.mjs").IStorageLayer} IStorageLayer
 */

/** Méthodes que tout adapter IStorageLayer DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze(["get", "put", "delete", "list"]);

/**
 * Vérifie structurellement qu'un objet satisfait le port IStorageLayer. Lève une
 * Error descriptive listant ce qui manque — pour qu'un adapter cassé échoue
 * bruyamment au lieu de corrompre silencieusement la persistance injectée.
 * @param {any} adapter
 * @returns {IStorageLayer} le même adapter, quand valide
 */
export function assertStorageLayer(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("IStorageLayer: adapter must be an object");
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new Error(`IStorageLayer: adapter missing method(s): ${missing.join(", ")}`);
  }
  return /** @type {IStorageLayer} */ (adapter);
}

/**
 * Normalise l'entrée de `put` en Uint8Array (accepte string par commodité).
 * @param {Uint8Array | string} data
 * @returns {Uint8Array}
 */
function toBytes(data) {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

// ── MemoryStorageLayer — pur-JS, WASM-clean, défaut sûr ────────────────────────

/**
 * Stockage in-memory : ce N'EST PAS un stub jetable — c'est le backend par défaut
 * WASM-clean (aucun node:*), et la base testable de la persistance injectée dans
 * LocalCognitiveMemory / LocalVectorMemory. Non-persistant entre process (le port
 * l'annonce via `capabilities.persistent = false`).
 * @implements {IStorageLayer}
 */
export class MemoryStorageLayer {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._m = new Map();
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "memory", persistent: false, native: false };
  }

  /**
   * @param {string} key
   * @returns {Promise<Uint8Array | null>}
   */
  async get(key) {
    const v = this._m.get(key);
    return v ? v.slice() : null;
  }

  /**
   * @param {string} key
   * @param {Uint8Array | string} data
   * @returns {Promise<void>}
   */
  async put(key, data) {
    this._m.set(key, toBytes(data));
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    this._m.delete(key);
  }

  /**
   * @param {string} prefix
   * @returns {Promise<string[]>}
   */
  async list(prefix) {
    return [...this._m.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

// ── FsStorageLayer — adapter fs, node:fs en dynamic-import ──────────────────────

/**
 * Stockage objet durable sur le système de fichiers local (edge/device). node:fs
 * est chargé en DYNAMIC-import à l'usage (jamais au chargement du module) → le cœur
 * reste WASM-clean : une cible sans fs ne tire jamais ces bindings. Une clé logique
 * (`a/b/c.json`) est mappée sous `root` ; toute clé sortant de `root` (`..`) est
 * rejetée (anti-traversal). Reprend l'impl P11 de o3c-chat, découplée des registres.
 * @implements {IStorageLayer}
 */
export class FsStorageLayer {
  /**
   * @param {string} root racine du magasin (créée à la volée)
   */
  constructor(root) {
    if (!root) throw new Error("FsStorageLayer: `root` is required");
    /** @type {string} */
    this._root = root;
    /** @type {any} module node:fs/promises résolu (lazy) */
    this._fs = null;
    /** @type {any} module node:path résolu (lazy) */
    this._path = null;
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "fs", persistent: true, native: false };
  }

  /** Charge node:fs + node:path une seule fois (dynamic-import, WASM-safe). */
  async _mods() {
    if (!this._fs) {
      this._fs = await import("node:fs/promises");
      this._path = await import("node:path");
      this._root = this._path.resolve(this._root);
    }
    return { fs: this._fs, path: this._path };
  }

  /**
   * Résout une clé logique en chemin absolu confiné sous `root` (anti-traversal).
   * @param {any} path module node:path
   * @param {string} key
   * @returns {string}
   */
  _pathFor(path, key) {
    const abs = path.resolve(this._root, key);
    if (abs !== this._root && !abs.startsWith(this._root + path.sep)) {
      throw new Error(`FsStorageLayer: key escapes root: ${key}`);
    }
    return abs;
  }

  /**
   * @param {string} key
   * @returns {Promise<Uint8Array | null>}
   */
  async get(key) {
    const { fs, path } = await this._mods();
    try {
      const buf = await fs.readFile(this._pathFor(path, key));
      return new Uint8Array(buf);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /**
   * @param {string} key
   * @param {Uint8Array | string} data
   * @returns {Promise<void>}
   */
  async put(key, data) {
    const { fs, path } = await this._mods();
    const p = this._pathFor(path, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, toBytes(data));
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    const { fs, path } = await this._mods();
    await fs.rm(this._pathFor(path, key), { force: true });
  }

  /**
   * @param {string} prefix
   * @returns {Promise<string[]>}
   */
  async list(prefix) {
    const { fs, path } = await this._mods();
    /** @type {string[]} */
    const out = [];
    await this._walk(fs, path, this._root, out);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  /**
   * Parcours récursif : émet une clé POSIX relative par fichier.
   * @param {any} fs
   * @param {any} path
   * @param {string} dir
   * @param {string[]} out
   * @returns {Promise<void>}
   */
  async _walk(fs, path, dir, out) {
    /** @type {any[]} */
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._walk(fs, path, abs, out);
      } else if (entry.isFile()) {
        out.push(abs.slice(this._root.length + 1).split(path.sep).join("/"));
      }
    }
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isEnoent(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    /** @type {{ code?: string }} */ (err).code === "ENOENT"
  );
}

// ── S3StorageLayer — adapter natif, dynamic-import + probe ──────────────────────

/** Les packages upstream (SDK AWS S3) — optionalDependencies, jamais hard-deps. */
export const S3_PACKAGE = "@aws-sdk/client-s3";

/**
 * @typedef {object} S3StorageConfig
 * @property {string} endpoint
 * @property {string} bucket
 * @property {string} [region] défaut 'auto'
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 */

/**
 * Sonde si le SDK S3 peut être chargé sur cet hôte (dynamic-import). Tout échec →
 * "indisponible", jamais un crash. Miroir de `loadCognee`/`loadZvec`.
 * @returns {Promise<{ available: boolean, module?: any, error?: string }>}
 */
export async function loadS3() {
  try {
    const mod = await import(/* @vite-ignore */ S3_PACKAGE);
    if (typeof mod?.S3Client !== "function") {
      return { available: false, error: "module does not expose S3Client" };
    }
    return { available: true, module: mod };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Probe booléen de commodité. */
export async function isS3Available() {
  return (await loadS3()).available;
}

/**
 * Backend S3 pour le port IStorageLayer. Encapsule 100% de @aws-sdk/client-s3 —
 * seul endroit qui connaît le SDK. Construit via `S3StorageLayer.create(config)`
 * (async : charge le SDK en dynamic-import) plutôt qu'un constructeur bloquant.
 * @implements {IStorageLayer}
 */
export class S3StorageLayer {
  /**
   * @param {any} mod module @aws-sdk/client-s3 résolu
   * @param {S3StorageConfig} config
   */
  constructor(mod, config) {
    if (!mod || typeof mod.S3Client !== "function") {
      throw new Error("S3StorageLayer: a resolved @aws-sdk/client-s3 module is required");
    }
    if (!config?.endpoint) throw new Error("S3StorageLayer: config.endpoint is required");
    if (!config?.bucket) throw new Error("S3StorageLayer: config.bucket is required");
    this._mod = mod;
    this._bucket = config.bucket;
    this._client = new mod.S3Client({
      endpoint: config.endpoint,
      region: config.region ?? "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Fabrique async : charge le SDK en dynamic-import puis instancie l'adapter.
   * @param {S3StorageConfig} config
   * @returns {Promise<S3StorageLayer>}
   */
  static async create(config) {
    const probe = await loadS3();
    if (!probe.available || !probe.module) {
      throw new Error(`S3StorageLayer: ${S3_PACKAGE} unavailable: ${probe.error ?? "unknown"}`);
    }
    return new S3StorageLayer(probe.module, config);
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "s3", persistent: true, native: true };
  }

  /**
   * @param {string} key
   * @returns {Promise<Uint8Array | null>}
   */
  async get(key) {
    try {
      const res = await this._client.send(
        new this._mod.GetObjectCommand({ Bucket: this._bucket, Key: key }),
      );
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  /**
   * @param {string} key
   * @param {Uint8Array | string} data
   * @returns {Promise<void>}
   */
  async put(key, data) {
    await this._client.send(
      new this._mod.PutObjectCommand({
        Bucket: this._bucket,
        Key: key,
        Body: toBytes(data),
        ContentType: "application/octet-stream",
      }),
    );
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    await this._client.send(
      new this._mod.DeleteObjectCommand({ Bucket: this._bucket, Key: key }),
    );
  }

  /**
   * @param {string} prefix
   * @returns {Promise<string[]>}
   */
  async list(prefix) {
    /** @type {string[]} */
    const out = [];
    /** @type {string | undefined} */
    let token;
    do {
      const res = await this._client.send(
        new this._mod.ListObjectsV2Command({
          Bucket: this._bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) out.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNoSuchKey(err) {
  if (err == null || typeof err !== "object") return false;
  const e = /** @type {Record<string, any>} */ (err);
  return (
    e["name"] === "NoSuchKey" ||
    e["Code"] === "NoSuchKey" ||
    e["$metadata"]?.["httpStatusCode"] === 404
  );
}

// ── Seam fromEnv/DI ────────────────────────────────────────────────────────────

/**
 * @typedef {object} CreateStorageLayerResult
 * @property {IStorageLayer} storage
 * @property {string} backend
 * @property {boolean} nativeAvailable
 */

/**
 * Construit une couche de stockage derrière le port IStorageLayer. Sélection :
 *   • s3   — si un endpoint S3 est configuré ET le SDK chargeable (dynamic-import).
 *   • fs   — sinon, si un root fs est fourni (opt/env STORAGE_FS_ROOT).
 *   • memory — sinon, fallback WASM-clean toujours dispo.
 * Le S3 SDK n'est JAMAIS tiré quand non utilisé (ADR §1). `prefer` peut venir de
 * l'env STORAGE_PROVIDER. Dégradation RÉVERSIBLE, même contrat.
 * @param {object} [opts]
 * @param {'auto'|'s3'|'fs'|'memory'} [opts.prefer] préférence backend (défaut env ou 'auto')
 * @param {string} [opts.root] racine fs (défaut env STORAGE_FS_ROOT)
 * @param {S3StorageConfig} [opts.s3] config S3 explicite (défaut lue depuis l'env)
 * @param {Record<string, string | undefined>} [opts.env] env (défaut process.env)
 * @returns {Promise<CreateStorageLayerResult>}
 */
export async function createStorageLayer(opts = {}) {
  const env = opts.env || (typeof process !== "undefined" && process.env ? process.env : {});
  const prefer = opts.prefer || envPrefer(env["STORAGE_PROVIDER"]);
  const s3Config = opts.s3 || s3ConfigFromEnv(env);
  const root = opts.root || env["STORAGE_FS_ROOT"];

  // s3 : demandé explicitement OU auto avec une config présente.
  if (prefer === "s3" || (prefer === "auto" && s3Config)) {
    if (!s3Config) throw new Error("createStorageLayer: prefer='s3' but no S3 config/env found");
    const probe = await loadS3();
    if (probe.available && probe.module) {
      const storage = new S3StorageLayer(probe.module, s3Config);
      assertStorageLayer(storage);
      return { storage, backend: "s3", nativeAvailable: true };
    }
    if (prefer === "s3") {
      throw new Error(`createStorageLayer: ${S3_PACKAGE} unavailable: ${probe.error ?? "unknown"}`);
    }
    // auto + SDK absent → dégrade vers fs/memory ci-dessous.
  }

  if (prefer === "fs" || (prefer === "auto" && root)) {
    if (!root) throw new Error("createStorageLayer: prefer='fs' but no root/STORAGE_FS_ROOT found");
    const storage = new FsStorageLayer(root);
    assertStorageLayer(storage);
    return { storage, backend: "fs", nativeAvailable: false };
  }

  const storage = new MemoryStorageLayer();
  assertStorageLayer(storage);
  return { storage, backend: "memory", nativeAvailable: false };
}

/** Alias fromEnv explicite (cohérent avec les autres seams). */
export const storageFromEnv = createStorageLayer;

/**
 * Lit une config S3 depuis l'env, ou null si l'endpoint/bucket ne sont pas posés.
 * @param {Record<string, string | undefined>} env
 * @returns {S3StorageConfig | null}
 */
function s3ConfigFromEnv(env) {
  const endpoint = env["S3_ENDPOINT"];
  const bucket = env["S3_BUCKET"];
  if (!endpoint || !bucket) return null;
  return {
    endpoint,
    bucket,
    region: env["S3_REGION"] ?? "auto",
    accessKeyId: env["S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: env["S3_SECRET_ACCESS_KEY"] ?? "",
  };
}

/**
 * Normalise une valeur d'env en préférence backend valide.
 * @param {string | undefined} v
 * @returns {'auto'|'s3'|'fs'|'memory'}
 */
function envPrefer(v) {
  return v === "s3" || v === "fs" || v === "memory" ? v : "auto";
}
