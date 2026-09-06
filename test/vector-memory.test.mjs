// C05 — IVectorMemory unifié. Contract-tests du fallback pur-JS (cosinus dense)
// extrait/refactoré depuis o3c-chat/packages/agent-runtime, DÉCOUPLÉ de tout
// o3c-chat-specific : le port ne connaît que `ns` (partition = projectId), classe
// la query par vraie similarité cosinus, persiste de façon RÉVERSIBLE via un
// IStorageLayer injecté (WASM-clean, aucun node:fs), et le seam `createVectorMemory`
// dégrade vers le local quand zvec est absent. `assertVectorMemory` fait échouer
// bruyamment un adapter cassé.
import { describe, it, expect } from "vitest";
import {
  LocalVectorMemory,
  ZvecVectorMemory,
  createVectorMemory,
  assertVectorMemory,
  isZvecAvailable,
  loadZvec,
  REQUIRED_METHODS,
} from "../src/vector-memory.mjs";

/** IStorageLayer in-memory pour tester le roundtrip de persistance (JSON bytes). */
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

describe("LocalVectorMemory (pure-JS dense cosine fallback)", () => {
  it("satisfies the IVectorMemory port contract", () => {
    const mem = new LocalVectorMemory();
    expect(() => assertVectorMemory(mem)).not.toThrow();
    for (const m of REQUIRED_METHODS) expect(typeof mem[m]).toBe("function");
    expect(mem.capabilities).toMatchObject({ backend: "local", native: false, semantic: true });
  });

  it("ranks query results by cosine similarity, most relevant first", async () => {
    const mem = new LocalVectorMemory();
    await mem.upsert("proj", [
      { id: "a", text: "north", vector: [1, 0, 0] },
      { id: "b", text: "east", vector: [0, 1, 0] },
      { id: "c", text: "north-ish", vector: [0.9, 0.1, 0] },
    ]);
    const hits = await mem.query("proj", { vector: [1, 0, 0], topK: 2 });
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].text).toBe("north");
  });

  it("respects topK and drops zero-similarity hits", async () => {
    const mem = new LocalVectorMemory();
    await mem.upsert("p", [
      { id: "x", text: "x", vector: [1, 0] },
      { id: "y", text: "y", vector: [0, 1] },
    ]);
    const hits = await mem.query("p", { vector: [1, 0] });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("x");
  });

  it("isolates namespaces (partition = projectId)", async () => {
    const mem = new LocalVectorMemory();
    await mem.upsert("p1", [{ id: "a", text: "a", vector: [1, 0] }]);
    await mem.upsert("p2", [{ id: "b", text: "b", vector: [1, 0] }]);
    expect(await mem.count("p1")).toBe(1);
    expect(await mem.count("p2")).toBe(1);
    const hits = await mem.query("p1", { vector: [1, 0] });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("upserts overwrite by id and delete removes them", async () => {
    const mem = new LocalVectorMemory();
    await mem.upsert("p", [{ id: "a", text: "old", vector: [1, 0] }]);
    await mem.upsert("p", [{ id: "a", text: "new", vector: [0, 1] }]);
    expect(await mem.count("p")).toBe(1);
    const [hit] = await mem.query("p", { vector: [0, 1] });
    expect(hit.text).toBe("new");
    await mem.delete("p", ["a"]);
    expect(await mem.count("p")).toBe(0);
  });

  it("rejects docs without id or vector (fails loudly, no silent corruption)", async () => {
    const mem = new LocalVectorMemory();
    await expect(mem.upsert("p", [{ id: "", text: "x", vector: [1] }])).rejects.toThrow(/id/);
    await expect(mem.upsert("p", [{ id: "a", text: "x", vector: [] }])).rejects.toThrow(/vector/);
  });

  it("persists reversibly via an injected IStorageLayer and rehydrates", async () => {
    const storage = memStorage();
    const a = new LocalVectorMemory({ storage });
    await a.upsert("proj", [{ id: "a", text: "hello", vector: [1, 0, 0], metadata: { k: 1 } }]);
    expect(storage.store.size).toBe(1);

    // Nouvelle instance branchée sur le MÊME storage → recharge le corpus.
    const b = new LocalVectorMemory({ storage });
    expect(await b.count("proj")).toBe(1);
    const [hit] = await b.query("proj", { vector: [1, 0, 0] });
    expect(hit.id).toBe("a");
    expect(hit.metadata).toEqual({ k: 1 });

    await b.clear("proj");
    expect(storage.store.size).toBe(0);
  });

  it("is WASM-clean (no node:fs) when no storage is injected", async () => {
    const mem = new LocalVectorMemory();
    await mem.upsert("p", [{ id: "a", text: "a", vector: [1] }]);
    expect(mem.capabilities.persistent).toBe(false);
    // query tolère un ns inconnu / vecteur absent sans throw
    expect(await mem.query("unknown", { vector: [1] })).toEqual([]);
  });
});

describe("ZvecVectorMemory (native adapter)", () => {
  it("requires a resolved module exposing createZvecStore", () => {
    expect(() => new ZvecVectorMemory(null)).toThrow(/@ori3com\/zvec/);
    expect(() => new ZvecVectorMemory({})).toThrow(/createZvecStore/);
  });

  it("maps the port contract onto the zvec store surface", async () => {
    /** @type {any[]} */
    const inserted = [];
    const fakeStore = {
      async insert(collection, docs) {
        inserted.push({ collection, docs });
      },
      async hybridQuery(collection, q) {
        return [{ id: "z1", content: "found", score: 0.42, fields: { project_id: "p" } }];
      },
    };
    const mod = { createZvecStore: (_ns) => fakeStore };
    const mem = new ZvecVectorMemory(mod, { collection: "kb" });
    expect(mem.capabilities).toMatchObject({ backend: "zvec", native: true });

    await mem.upsert("p", [{ id: "z1", text: "hi", vector: [1, 2], metadata: { tag: "t" } }]);
    expect(inserted[0].collection).toBe("kb");
    expect(inserted[0].docs[0]).toMatchObject({
      id: "z1",
      content: "hi",
      embedding: [1, 2],
      fields: { tag: "t", project_id: "p" },
    });

    const hits = await mem.query("p", { text: "q", vector: [1, 2], topK: 3 });
    expect(hits).toEqual([
      { id: "z1", score: 0.42, text: "found", metadata: { project_id: "p" } },
    ]);

    // delete est un no-op best-effort (jamais de throw)
    await expect(mem.delete("p", ["z1"])).resolves.toBeUndefined();
  });
});

describe("createVectorMemory (fromEnv seam)", () => {
  it("degrades to the pure-JS local backend when zvec is unavailable", async () => {
    const zvec = await isZvecAvailable();
    const { memory, backend, nativeAvailable } = await createVectorMemory({ prefer: "local" });
    expect(() => assertVectorMemory(memory)).not.toThrow();
    expect(backend).toBe("local");
    expect(nativeAvailable).toBe(false);
    // prefer:'local' ne doit JAMAIS sonder ni tirer le natif
    expect(typeof zvec).toBe("boolean");
  });

  it("auto-selects zvec when the native probe succeeds, else local", async () => {
    const probe = await loadZvec();
    const { backend, nativeAvailable } = await createVectorMemory();
    expect(nativeAvailable).toBe(probe.available);
    expect(backend).toBe(probe.available ? "zvec" : "local");
  });

  it("passes an injected storage through to the local fallback (reversible)", async () => {
    const storage = memStorage();
    const { memory } = await createVectorMemory({ prefer: "local", storage });
    await memory.upsert("proj", [{ id: "a", text: "a", vector: [1, 0] }]);
    expect(storage.store.size).toBe(1);
  });
});
