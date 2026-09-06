// C04 — seam LLM. Client openai-compatible routé vers api.ori3com.cloud, cascade
// SLM local → cloud (dégradation réversible), seam `fromEnv` + `modelProvider`.
// Unités hors réseau via `fetchImpl` injecté ; un IT live (skipIf sans creds) frappe
// le vrai endpoint quand `AGENT_LITELLM_API_KEY` est présent (ex. ~/.o3c-it.env).
import { describe, it, expect } from "vitest";
import {
  LiteLLMChat,
  CascadeLLM,
  llmFromEnv,
  createModelProvider,
  modelProviderFromEnv,
} from "../src/llm.mjs";
import { materializeAgent } from "../src/agent-factory.mjs";

/**
 * Fabrique un faux `fetch` renvoyant une completion openai-compatible et capturant
 * la requête. `fail` force un !ok (test de cascade/erreur).
 * @param {{ content?: string, model?: string, status?: number }} [opt]
 */
function fakeChatFetch(opt = {}) {
  const calls = /** @type {Array<{ url: string, init: any }>} */ ([]);
  const impl = /** @type {any} */ (async (url, init) => {
    calls.push({ url, init });
    if (opt.status && opt.status >= 400) {
      return { ok: false, status: opt.status, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: opt.model ?? "o3c-equilibre",
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        choices: [
          { message: { role: "assistant", content: opt.content ?? "pong" }, finish_reason: "stop" },
        ],
      }),
    };
  });
  return { impl, calls };
}

describe("LiteLLMChat (api.ori3com.cloud seam)", () => {
  it("posts an openai-compatible chat request and maps the result", async () => {
    const { impl, calls } = fakeChatFetch({ content: "hello", model: "o3c-equilibre" });
    const llm = new LiteLLMChat({
      baseURL: "https://api.ori3com.cloud/v1",
      apiKey: "secret",
      model: "o3c-equilibre",
      fetchImpl: impl,
    });
    const out = await llm.chat({
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.2,
      maxTokens: 64,
      stop: ["\n\n"],
    });
    expect(out.text).toBe("hello");
    expect(out.model).toBe("o3c-equilibre");
    expect(out.finishReason).toBe("stop");
    expect(out.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
    expect(out.provider).toBe("litellm");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.ori3com.cloud/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: "o3c-equilibre",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.2,
      max_tokens: 64,
      stop: ["\n\n"],
    });
  });

  it("omits optional params and lets req.model override the default", async () => {
    const { impl, calls } = fakeChatFetch();
    const llm = new LiteLLMChat({ apiKey: "k", model: "default-m", fetchImpl: impl });
    await llm.chat({ messages: [{ role: "user", content: "x" }], model: "override-m" });
    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({ model: "override-m", messages: [{ role: "user", content: "x" }] });
    expect("temperature" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
  });

  it("rejects an empty message list without any fetch", async () => {
    let called = false;
    const llm = new LiteLLMChat({
      apiKey: "k",
      fetchImpl: /** @type {any} */ (async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      }),
    });
    await expect(llm.chat({ messages: [] })).rejects.toThrow(/at least one message/);
    expect(called).toBe(false);
  });

  it("throws on a non-ok response, tagging the provider name", async () => {
    const { impl } = fakeChatFetch({ status: 503 });
    const llm = new LiteLLMChat({ apiKey: "k", name: "litellm", fetchImpl: impl });
    await expect(llm.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /503 \(litellm\)/,
    );
  });
});

describe("CascadeLLM (SLM local → cloud fallback)", () => {
  it("returns the first provider's response without trying the rest", async () => {
    const slm = new LiteLLMChat({ apiKey: "", name: "slm-local", fetchImpl: fakeChatFetch({ content: "local" }).impl });
    let cloudTried = false;
    const cloud = new LiteLLMChat({
      apiKey: "k",
      name: "litellm",
      fetchImpl: /** @type {any} */ (async () => {
        cloudTried = true;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "cloud" } }] }) };
      }),
    });
    const cascade = new CascadeLLM([slm, cloud]);
    const out = await cascade.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("local");
    expect(out.provider).toBe("slm-local");
    expect(cloudTried).toBe(false);
    expect(cascade.name).toBe("cascade(slm-local→litellm)");
  });

  it("falls back to the next provider when the first fails", async () => {
    const slm = new LiteLLMChat({ apiKey: "", name: "slm-local", fetchImpl: fakeChatFetch({ status: 500 }).impl });
    const cloud = new LiteLLMChat({ apiKey: "k", name: "litellm", fetchImpl: fakeChatFetch({ content: "cloud" }).impl });
    const cascade = new CascadeLLM([slm, cloud]);
    const out = await cascade.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("cloud");
    expect(out.provider).toBe("litellm");
  });

  it("aggregates the failure when all providers fail", async () => {
    const a = new LiteLLMChat({ apiKey: "", name: "slm-local", fetchImpl: fakeChatFetch({ status: 500 }).impl });
    const b = new LiteLLMChat({ apiKey: "k", name: "litellm", fetchImpl: fakeChatFetch({ status: 502 }).impl });
    const cascade = new CascadeLLM([a, b]);
    await expect(cascade.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /all 2 providers failed/,
    );
  });

  it("requires at least one provider", () => {
    expect(() => new CascadeLLM([])).toThrow(/at least one provider/);
  });
});

/**
 * Restaure les env vars LLM autour d'un cas (isolation des tests `fromEnv`).
 * @param {() => void} fn
 */
function withCleanLlmEnv(fn) {
  const keys = ["AGENT_LITELLM_API_KEY", "AGENT_SLM_BASE_URL", "AGENT_SLM_MODEL", "AGENT_LLM_CASCADE"];
  const prev = /** @type {Record<string, string | undefined>} */ ({});
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] !== undefined) process.env[k] = /** @type {string} */ (prev[k]);
      else delete process.env[k];
    }
  }
}

describe("llmFromEnv (fromEnv seam)", () => {
  it("throws when no provider is configured", () => {
    withCleanLlmEnv(() => {
      expect(() => llmFromEnv()).toThrow(/no LLM provider configured/);
    });
  });

  it("returns a bare LiteLLMChat when only the cloud key is set", () => {
    withCleanLlmEnv(() => {
      process.env["AGENT_LITELLM_API_KEY"] = "k";
      const llm = llmFromEnv();
      expect(llm).toBeInstanceOf(LiteLLMChat);
      expect(llm.name).toBe("litellm");
    });
  });

  it("cascades SLM-first by default when both are configured", () => {
    withCleanLlmEnv(() => {
      process.env["AGENT_LITELLM_API_KEY"] = "k";
      process.env["AGENT_SLM_BASE_URL"] = "http://localhost:11434/v1";
      const llm = llmFromEnv();
      expect(llm).toBeInstanceOf(CascadeLLM);
      expect(llm.name).toBe("cascade(slm-local→litellm)");
    });
  });

  it("honors cloud-first order via option and env", () => {
    withCleanLlmEnv(() => {
      process.env["AGENT_LITELLM_API_KEY"] = "k";
      process.env["AGENT_SLM_BASE_URL"] = "http://localhost:11434/v1";
      expect(llmFromEnv({ order: "cloud-first" }).name).toBe("cascade(litellm→slm-local)");
      process.env["AGENT_LLM_CASCADE"] = "cloud-first";
      expect(llmFromEnv().name).toBe("cascade(litellm→slm-local)");
    });
  });
});

describe("createModelProvider (agent-factory seam)", () => {
  it("resolves a portable ModelDescriptor bound to the model id", async () => {
    const { impl, calls } = fakeChatFetch({ content: "ok" });
    const llm = new LiteLLMChat({ apiKey: "k", name: "litellm", fetchImpl: impl });
    const provider = createModelProvider(llm);
    const model = provider("o3c-rapide");
    expect(model.id).toBe("o3c-rapide");
    expect(model.provider).toBe("litellm");
    const out = await model.chat({ messages: [{ role: "user", content: "q" }] });
    expect(out.text).toBe("ok");
    expect(JSON.parse(calls[0].init.body).model).toBe("o3c-rapide");
  });

  it("plugs into materializeAgent so the blueprint carries a live model", async () => {
    const { impl } = fakeChatFetch({ content: "generated" });
    const llm = new LiteLLMChat({ apiKey: "k", fetchImpl: impl });
    /** @type {import("../src/agent-spec.mjs").AgentSpec} */
    const spec = {
      id: "a1", name: "Copilot", persona: null, systemPrompt: null,
      defaultModel: "o3c-equilibre", temperature: 0.3, tenantId: "t1", projectId: "p1",
    };
    /** @type {import("../src/context-builder.mjs").ContextEnvelope} */
    const envelope = { systemPrompt: "SYS", persona: null, projectId: "p1", agentId: "a1", threadId: "th1" };
    const bp = materializeAgent(spec, envelope, { modelProvider: createModelProvider(llm) });
    const model = /** @type {import("../src/ports.mjs").ModelDescriptor} */ (bp.model);
    expect(model.id).toBe("o3c-equilibre");
    const out = await model.chat({ messages: [{ role: "user", content: "go" }] });
    expect(out.text).toBe("generated");
  });
});

// IT live — frappe api.ori3com.cloud pour de vrai. Skippé quand AGENT_LITELLM_API_KEY
// est absent (pas de creds → pas d'échec ; charger via `set -a; . ~/.o3c-it.env`).
const LIVE = Boolean(process.env["AGENT_LITELLM_API_KEY"]);
describe.skipIf(!LIVE)("llmFromEnv IT live (api.ori3com.cloud)", () => {
  it("completes a real chat round-trip", async () => {
    const llm = modelProviderFromEnv();
    const model = llm(process.env["AGENT_LLM_MODEL"] ?? "o3c-equilibre");
    const out = await model.chat({
      messages: [{ role: "user", content: "Reply with the single word: pong." }],
      maxTokens: 8,
      temperature: 0,
    });
    expect(typeof out.text).toBe("string");
    expect(out.text.length).toBeGreaterThan(0);
  });
});
