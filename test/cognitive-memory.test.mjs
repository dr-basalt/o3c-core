// C03 — ICognitiveMemory unifié. Contract-tests convergés depuis l'impl P02 de
// o3c-code-cli : le fallback pur-JS classe le recall par pertinence TF·IDF (pas la
// récence), persiste de façon RÉVERSIBLE via un IStorageLayer injecté (WASM-clean,
// aucun node:fs), et le seam `createCognitiveMemory` dégrade vers le local quand
// cognee-rs est absent. `assertCognitiveMemory` fait échouer bruyamment un adapter cassé.
import { describe, it, expect } from "vitest";
import {
  LocalCognitiveMemory,
  createCognitiveMemory,
  assertCognitiveMemory,
  isCogneeAvailable,
  REQUIRED_METHODS,
} from "../src/cognitive-memory.mjs";

/** IStorageLayer in-memory pour tester le roundtrip de persistance (JSONL bytes). */
function memStorage() {
  /** @type {Map<string, Uint8Array>} */
  const m = new Map();
  return {
    store: m,
    async get(k) {
      return m.get(k) ?? null;
    },
    async put(k, data) {
      m.set(k, data);
    },
    async delete(k) {
      m.delete(k);
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

describe("LocalCognitiveMemory (pure-JS TF·IDF fallback)", () => {
  it("satisfies the ICognitiveMemory port contract", () => {
    const mem = new LocalCognitiveMemory();
    expect(() => assertCognitiveMemory(mem)).not.toThrow();
    for (const m of REQUIRED_METHODS) {
      expect(typeof (/** @type {any} */ (mem)[m])).toBe("function");
    }
    expect(mem.capabilities.backend).toBe("local");
    expect(mem.capabilities.semantic).toBe(true);
    expect(mem.capabilities.native).toBe(false);
  });

  it("ranks recall by TF·IDF relevance, not recency", async () => {
    const mem = new LocalCognitiveMemory();
    await mem.remember({ text: "the deployment uses kubernetes helm charts on hetzner" });
    await mem.remember({ text: "the team prefers vitest for unit testing" });
    // Ajouté EN DERNIER mais non pertinent pour la query → ne doit pas gagner par récence.
    await mem.remember({ text: "lunch is usually around noon" });

    const hits = await mem.recall("how do we deploy to kubernetes", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.text).toContain("kubernetes");
    expect(hits[0].score).toBeGreaterThan(0);
    // Chaque hit strictement plus pertinent ou égal au suivant.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it("count / recent / clear behave", async () => {
    const mem = new LocalCognitiveMemory();
    await mem.remember({ text: "alpha one" });
    await mem.remember({ text: "beta two" });
    expect(await mem.count()).toBe(2);
    const recent = await mem.recent(1);
    expect(recent[0].text).toBe("beta two");
    await mem.clear();
    expect(await mem.count()).toBe(0);
  });

  it("rejects empty remember and empty query recall", async () => {
    const mem = new LocalCognitiveMemory();
    await expect(mem.remember(/** @type {any} */ ({ text: "  " }))).rejects.toThrow(/text/);
    expect(await mem.recall("")).toEqual([]);
  });

  it("persists reversibly through an injected IStorageLayer (JSONL roundtrip)", async () => {
    const storage = memStorage();
    const a = new LocalCognitiveMemory({ projectId: "proj-x", storage });
    expect(a.capabilities.persistent).toBe(true);
    await a.remember({ text: "canal-agnostic core lives in agent-core", kind: "decision" });
    await a.remember({ text: "cognee-rs stays behind the port" });

    // Nouvelle instance, même clé de stockage → hydrate le corpus persisté.
    const b = new LocalCognitiveMemory({ projectId: "proj-x", storage });
    await b.hydrate();
    expect(await b.count()).toBe(2);
    const hits = await b.recall("where does the core live", 2);
    expect(hits[0].item.text).toContain("agent-core");

    // clear() efface aussi le storage (réversibilité complète).
    await b.clear();
    const c = new LocalCognitiveMemory({ projectId: "proj-x", storage });
    await c.hydrate();
    expect(await c.count()).toBe(0);
  });

  it("continues ids past a hydrated corpus (no collision)", async () => {
    const storage = memStorage();
    const a = new LocalCognitiveMemory({ projectId: "seq", storage });
    await a.remember({ text: "first memory here" });
    await a.remember({ text: "second memory here" });

    const b = new LocalCognitiveMemory({ projectId: "seq", storage });
    await b.hydrate();
    const added = await b.remember({ text: "third memory here" });
    const ids = new Set(b._items.map((i) => i.id));
    expect(ids.size).toBe(3);
    expect(ids.has(added.id)).toBe(true);
  });
});

describe("createCognitiveMemory (fromEnv/DI seam)", () => {
  it("falls back to local when cognee-rs is unavailable", async () => {
    // @cognee/cognee-ts n'est pas installé dans ce repo → probe indisponible.
    expect(await isCogneeAvailable()).toBe(false);
    const { memory, backend, nativeAvailable } = await createCognitiveMemory({ prefer: "auto" });
    expect(backend).toBe("local");
    expect(nativeAvailable).toBe(false);
    expect(() => assertCognitiveMemory(memory)).not.toThrow();
  });

  it("prefer:'local' skips the native probe entirely and hydrates from storage", async () => {
    const storage = memStorage();
    const seed = new LocalCognitiveMemory({ projectId: "p", storage });
    await seed.remember({ text: "seeded via storage" });

    const { memory, backend } = await createCognitiveMemory({
      prefer: "local",
      projectId: "p",
      storage,
    });
    expect(backend).toBe("local");
    expect(await memory.count()).toBe(1);
  });
});

describe("assertCognitiveMemory", () => {
  it("throws listing the missing methods for a broken adapter", () => {
    const broken = { capabilities: { backend: "x" }, remember() {} };
    expect(() => assertCognitiveMemory(broken)).toThrow(/missing method/);
  });

  it("throws when capabilities.backend is absent", () => {
    const noCaps = {
      remember() {},
      recall() {},
      cognify() {},
      count() {},
      clear() {},
    };
    expect(() => assertCognitiveMemory(noCaps)).toThrow(/capabilities\.backend/);
  });
});
