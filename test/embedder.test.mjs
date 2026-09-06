// C02 — Embedder seam. Le fallback pur-JS (HashingEmbedder) est déterministe,
// normalisé L2 et hors réseau ; LiteLLMEmbedder route vers api.ori3com.cloud
// (openai-compatible) et court-circuite l'input vide sans I/O ; createEmbedder
// choisit le fallback quand aucune clé n'est configurée (dégradation réversible).
import { describe, it, expect } from "vitest";
import { HashingEmbedder, LiteLLMEmbedder, createEmbedder } from "../src/embedder.mjs";

describe("HashingEmbedder (pure-JS fallback)", () => {
  it("produces dims-sized, deterministic vectors", async () => {
    const e = new HashingEmbedder({ dims: 64 });
    const [a] = await e.embed(["bonjour le monde"]);
    const [b] = await e.embed(["bonjour le monde"]);
    expect(a).toHaveLength(64);
    expect(a).toEqual(b);
  });

  it("L2-normalizes non-empty text (unit length)", async () => {
    const e = new HashingEmbedder({ dims: 128 });
    const [v] = await e.embed(["ori3com agent core"]);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("distinguishes different texts and handles empty batch", async () => {
    const e = new HashingEmbedder({ dims: 128 });
    const [a, b] = await e.embed(["chat", "chien"]);
    expect(a).not.toEqual(b);
    expect(await e.embed([])).toEqual([]);
    const [zero] = await e.embed([""]);
    expect(zero.every((x) => x === 0)).toBe(true);
  });
});

describe("LiteLLMEmbedder (api.ori3com.cloud seam)", () => {
  it("short-circuits empty input without any fetch", async () => {
    let called = false;
    const e = new LiteLLMEmbedder({
      apiKey: "k",
      fetchImpl: /** @type {any} */ (async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      }),
    });
    expect(await e.embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("posts a batched openai-compatible request and maps embeddings", async () => {
    /** @type {any} */
    let captured;
    const e = new LiteLLMEmbedder({
      baseURL: "https://api.ori3com.cloud/v1",
      apiKey: "secret",
      model: "text-embedding-3-small",
      fetchImpl: /** @type {any} */ (async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
        };
      }),
    });
    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(captured.url).toBe("https://api.ori3com.cloud/v1/embeddings");
    expect(captured.init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(captured.init.body)).toEqual({
      model: "text-embedding-3-small",
      input: ["a", "b"],
    });
  });

  it("throws on a non-ok response", async () => {
    const e = new LiteLLMEmbedder({
      apiKey: "k",
      fetchImpl: /** @type {any} */ (async () => ({ ok: false, status: 429 })),
    });
    await expect(e.embed(["x"])).rejects.toThrow(/429/);
  });
});

describe("createEmbedder (fromEnv)", () => {
  it("falls back to HashingEmbedder when no key is configured", () => {
    const prevKey = process.env["AGENT_LITELLM_API_KEY"];
    const prevProvider = process.env["EMBEDDER_PROVIDER"];
    delete process.env["AGENT_LITELLM_API_KEY"];
    delete process.env["EMBEDDER_PROVIDER"];
    try {
      expect(createEmbedder()).toBeInstanceOf(HashingEmbedder);
    } finally {
      if (prevKey !== undefined) process.env["AGENT_LITELLM_API_KEY"] = prevKey;
      if (prevProvider !== undefined) process.env["EMBEDDER_PROVIDER"] = prevProvider;
    }
  });

  it("selects LiteLLMEmbedder when a key is present", () => {
    const prevKey = process.env["AGENT_LITELLM_API_KEY"];
    const prevProvider = process.env["EMBEDDER_PROVIDER"];
    delete process.env["EMBEDDER_PROVIDER"];
    process.env["AGENT_LITELLM_API_KEY"] = "k";
    try {
      expect(createEmbedder()).toBeInstanceOf(LiteLLMEmbedder);
    } finally {
      if (prevKey !== undefined) process.env["AGENT_LITELLM_API_KEY"] = prevKey;
      else delete process.env["AGENT_LITELLM_API_KEY"];
      if (prevProvider !== undefined) process.env["EMBEDDER_PROVIDER"] = prevProvider;
    }
  });
});
