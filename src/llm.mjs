// @ori3com/agent-core — seam LLM (ADR-0001 C04).
// Le seam de génération, canal-agnostique et WASM-friendly : on NE hard-dépend PAS
// de @ai-sdk/openai ni de @mastra/core — un simple client `fetch` openai-compatible
// (`/chat/completions`) route TOUJOURS via api.ori3com.cloud (AGENT_LITELLM_BASE_URL).
// `CascadeLLM` modélise la « cascade SLM local » (ADR §1) : un petit modèle local
// (ollama/llama.cpp/vllm, lui aussi openai-compatible) est tenté d'abord, puis
// bascule vers le cloud en cas d'échec (dégradation réversible, jamais de hard-fail
// silencieux). `llmFromEnv()` = seam `fromEnv` ; `createModelProvider` branche le
// tout sur `materializeAgent` (agent-factory) sans coupler le cœur à un runtime.

/**
 * @typedef {import("./ports.mjs").ChatMessage} ChatMessage
 * @typedef {import("./ports.mjs").ChatRequest} ChatRequest
 * @typedef {import("./ports.mjs").ChatResult} ChatResult
 * @typedef {import("./ports.mjs").ILLM} ILLM
 * @typedef {import("./ports.mjs").ModelDescriptor} ModelDescriptor
 */

/** @typedef {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }} OpenAIUsage */
/** @typedef {{ model?: string, usage?: OpenAIUsage, choices?: Array<{ message?: { content?: string }, finish_reason?: string }> }} ChatCompletionResponse */

/**
 * Client de chat openai-compatible (`POST /chat/completions`). Sert AUSSI BIEN le
 * cloud api.ori3com.cloud que n'importe quel SLM local exposant la même API — seuls
 * `baseURL`/`apiKey`/`name` changent. `fetchImpl` est injectable (tests hors réseau).
 * @implements {ILLM}
 */
export class LiteLLMChat {
  /**
   * @param {{ baseURL?: string, apiKey?: string, model?: string, name?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.baseURL =
      opts.baseURL ?? process.env["AGENT_LITELLM_BASE_URL"] ?? "https://api.ori3com.cloud/v1";
    /** @type {string | undefined} */
    this.apiKey = opts.apiKey ?? process.env["AGENT_LITELLM_API_KEY"];
    /** @type {string} */
    this.model = opts.model ?? process.env["AGENT_LLM_MODEL"] ?? "o3c-equilibre";
    /** @type {string} */
    this.name = opts.name ?? "litellm";
    /** @type {number} */
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    /** @type {typeof fetch} */
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * @param {ChatRequest} req
   * @returns {Promise<ChatResult>}
   */
  async chat(req) {
    if (!req.messages || req.messages.length === 0) {
      throw new Error(`LiteLLMChat.chat: at least one message is required (${this.name})`);
    }
    const model = req.model ?? this.model;
    /** @type {Record<string, unknown>} */
    const body = { model, messages: req.messages };
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
    if (req.stop !== undefined) body["stop"] = req.stop;

    // Timeout best-effort : AbortSignal.timeout est un standard web (node20 + browser
    // + worker). Absent d'un runtime exotique → on n'arme simplement pas de deadline.
    const signal =
      this.timeoutMs > 0 && typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;

    const res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`LiteLLMChat chat failed: ${res.status} (${this.name})`);
    }
    const json = /** @type {ChatCompletionResponse} */ (await res.json());
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      model: json.model ?? model,
      finishReason: choice?.finish_reason,
      usage: mapUsage(json.usage),
      provider: this.name,
    };
  }
}

/**
 * @param {OpenAIUsage | undefined} u
 * @returns {ChatResult["usage"]}
 */
function mapUsage(u) {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  };
}

/**
 * Cascade de providers ILLM : tente chacun dans l'ordre, bascule au suivant sur
 * échec (« cascade SLM local » puis cloud, ADR §1). Ne masque jamais un succès —
 * la 1re réponse gagne ; si TOUS échouent, lève une erreur agrégée (avec `cause`).
 * @implements {ILLM}
 */
export class CascadeLLM {
  /**
   * @param {ILLM[]} providers Ordre = ordre de tentative (index 0 tenté en premier).
   */
  constructor(providers) {
    if (!providers || providers.length === 0) {
      throw new Error("CascadeLLM requires at least one provider");
    }
    /** @type {ILLM[]} */
    this.providers = providers;
    /** @type {string} */
    this.name = `cascade(${providers.map((p) => p.name).join("→")})`;
    /** @type {string} */
    this.model = providers[0].model;
  }

  /**
   * @param {ChatRequest} req
   * @returns {Promise<ChatResult>}
   */
  async chat(req) {
    /** @type {unknown} */
    let lastErr;
    for (const p of this.providers) {
      try {
        return await p.chat(req);
      } catch (err) {
        lastErr = err;
      }
    }
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `CascadeLLM: all ${this.providers.length} providers failed (last: ${detail})`,
      { cause: lastErr },
    );
  }
}

/**
 * @typedef {Object} LLMFromEnvOptions
 * @property {"slm-first" | "cloud-first"} [order] Ordre de cascade (défaut : env
 *   `AGENT_LLM_CASCADE`, sinon `slm-first` — le SLM local est privilégié quand présent).
 * @property {typeof fetch} [fetchImpl] Injecté pour les tests (propagé aux providers).
 */

/**
 * Seam `fromEnv` : assemble le provider LLM depuis l'environnement.
 *   • cloud api.ori3com.cloud  → dès que `AGENT_LITELLM_API_KEY` est présent.
 *   • SLM local (openai-compatible) → dès que `AGENT_SLM_BASE_URL` est présent.
 * Deux présents → `CascadeLLM` (ordre configurable). Un seul → ce provider nu.
 * Aucun → erreur explicite (le consommateur doit configurer un backend).
 * @param {LLMFromEnvOptions} [opts]
 * @returns {ILLM}
 */
export function llmFromEnv(opts = {}) {
  const order = opts.order ?? asOrder(process.env["AGENT_LLM_CASCADE"]) ?? "slm-first";
  const slmBase = process.env["AGENT_SLM_BASE_URL"];
  const cloudKey = process.env["AGENT_LITELLM_API_KEY"];

  const slm = slmBase
    ? new LiteLLMChat({
        baseURL: slmBase,
        apiKey: process.env["AGENT_SLM_API_KEY"] ?? "",
        model: process.env["AGENT_SLM_MODEL"] ?? "local",
        name: "slm-local",
        fetchImpl: opts.fetchImpl,
      })
    : null;
  const cloud = cloudKey
    ? new LiteLLMChat({ apiKey: cloudKey, name: "litellm", fetchImpl: opts.fetchImpl })
    : null;

  /** @type {ILLM[]} */
  const providers =
    order === "cloud-first" ? compact([cloud, slm]) : compact([slm, cloud]);

  if (providers.length === 0) {
    throw new Error(
      "llmFromEnv: no LLM provider configured (set AGENT_LITELLM_API_KEY and/or AGENT_SLM_BASE_URL)",
    );
  }
  return providers.length === 1 ? providers[0] : new CascadeLLM(providers);
}

/**
 * @param {string | undefined} v
 * @returns {"slm-first" | "cloud-first" | undefined}
 */
function asOrder(v) {
  return v === "slm-first" || v === "cloud-first" ? v : undefined;
}

/**
 * @param {Array<ILLM | null>} xs
 * @returns {ILLM[]}
 */
function compact(xs) {
  /** @type {ILLM[]} */
  const out = [];
  for (const x of xs) if (x) out.push(x);
  return out;
}

/**
 * Fabrique un `ModelProvider` (seam de `materializeAgent`) à partir d'un ILLM : un
 * id de modèle est résolu en `ModelDescriptor` PORTABLE `{ id, provider, chat }` —
 * `chat` est lié à ce modèle. Le cœur reste pur ; le consommateur qui veut Mastra
 * peut ignorer le descriptor et re-résoudre l'id via son propre runtime.
 * @param {ILLM} llm
 * @returns {(modelId: string) => ModelDescriptor}
 */
export function createModelProvider(llm) {
  return (modelId) => ({
    id: modelId,
    provider: llm.name,
    chat: (req) => llm.chat({ ...req, model: modelId }),
  });
}

/**
 * Raccourci `fromEnv` : `createModelProvider(llmFromEnv(opts))`.
 * @param {LLMFromEnvOptions} [opts]
 * @returns {(modelId: string) => ModelDescriptor}
 */
export function modelProviderFromEnv(opts = {}) {
  return createModelProvider(llmFromEnv(opts));
}
