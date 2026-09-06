// @ori3com/agent-core — Embedder seam (ADR-0001 C02, seam LLM C04).
// Extrait/refactoré depuis @ori3com/agent-runtime (adapters/litellm-embedder.ts),
// DÉCOUPLÉ de tout o3c-chat : deux impls du port `Embedder` derrière le MÊME contrat.
//   • LiteLLMEmbedder — embeddings distants via api.ori3com.cloud (openai-compatible).
//   • HashingEmbedder — fallback pur-JS déterministe (offline/edge/WASM, aucun I/O).
// `createEmbedder()` = seam `fromEnv` : dégradation RÉVERSIBLE vers le fallback quand
// aucune clé n'est configurée (ADR §3 : natif bloqué/creds absents → fallback pur-JS).

/**
 * @typedef {import("./ports.mjs").Embedder} Embedder
 */

/** @typedef {{ data?: Array<{ embedding: number[] }> }} EmbeddingResponse */

/**
 * Embeddings distants, routés EXCLUSIVEMENT via api.ori3com.cloud (openai-compatible
 * `/embeddings`, `input` en batch). dims=1536 (aligné text-embedding-3-small).
 * @implements {Embedder}
 */
export class LiteLLMEmbedder {
  /**
   * @param {{ baseURL?: string, apiKey?: string, model?: string, dims?: number, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.baseURL =
      opts.baseURL ?? process.env["AGENT_LITELLM_BASE_URL"] ?? "https://api.ori3com.cloud/v1";
    /** @type {string | undefined} */
    this.apiKey = opts.apiKey ?? process.env["AGENT_LITELLM_API_KEY"];
    /** @type {string} */
    this.model = opts.model ?? process.env["AGENT_EMBED_MODEL"] ?? "text-embedding-3-small";
    /** @type {number} */
    this.dims = opts.dims ?? 1536;
    /** @type {typeof fetch} */
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`LiteLLM embeddings failed: ${res.status}`);
    }
    const json = /** @type {EmbeddingResponse} */ (await res.json());
    return (json.data ?? []).map((d) => d.embedding);
  }
}

/**
 * Fallback pur-JS déterministe : hashing des tokens dans `dims` buckets signés,
 * puis normalisation L2 (vecteurs prêts pour la similarité cosinus). Aucun I/O →
 * WASM-friendly, offline, reproductible. Qualité < embeddings neuronaux mais suffit
 * pour la dégradation réversible et les contract-tests hors réseau.
 * @implements {Embedder}
 */
export class HashingEmbedder {
  /** @param {{ dims?: number }} [opts] */
  constructor(opts = {}) {
    /** @type {number} */
    this.dims = opts.dims ?? 256;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    return texts.map((t) => this.#embedOne(t));
  }

  /**
   * @param {string} text
   * @returns {number[]}
   */
  #embedOne(text) {
    const vec = new Array(this.dims).fill(0);
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const bucket = h % this.dims;
      // Signe dérivé d'un bit de hash → réduit les collisions systématiques.
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

/**
 * Hash FNV-1a 32-bit, non signé.
 * @param {string} str
 * @returns {number}
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // Multiplication FNV en arithmétique 32-bit (>>> 0 pour rester non signé).
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seam `fromEnv` : LiteLLMEmbedder si une clé est configurée, sinon fallback
 * pur-JS déterministe (dégradation réversible, ADR §3).
 * @returns {Embedder}
 */
export function createEmbedder() {
  const provider = process.env["EMBEDDER_PROVIDER"];
  if (provider === "hashing") return new HashingEmbedder();
  if (provider === "litellm" || process.env["AGENT_LITELLM_API_KEY"]) {
    return new LiteLLMEmbedder();
  }
  return new HashingEmbedder();
}
