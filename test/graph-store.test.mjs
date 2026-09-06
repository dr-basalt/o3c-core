// C05 — IGraphStore (GraphRAG). Contract-tests de l'impl in-memory pure-JS : aucune
// impl n'existait dans o3c-chat/packages/agent-runtime (graphe = cognee-rs natif) —
// on fournit ici un GraphRAG portable RÉEL (upsert idempotent + traversée BFS bornée
// par profondeur/type/direction, scope-isolée par tenantId, WASM-clean) et le seam
// `graphStoreFromEnv` (backend durable injecté, jamais bundlé dans le cœur).
import { describe, it, expect } from "vitest";
import {
  InMemoryGraphStore,
  createGraphStore,
  graphStoreFromEnv,
  assertGraphStore,
  REQUIRED_METHODS,
} from "../src/graph-store.mjs";

/** @type {import("../src/ports.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "p1" };

/** Petit graphe : a→b→c, a→c (type 'link'), plus d isolé. */
async function seed(g) {
  await g.upsert(
    [
      { id: "a", type: "doc", props: { title: "A" } },
      { id: "b", type: "doc" },
      { id: "c", type: "doc" },
      { id: "d", type: "doc" },
    ],
    [
      { from: "a", to: "b", type: "link" },
      { from: "b", to: "c", type: "link" },
      { from: "a", to: "c", type: "mentions" },
    ],
    scope,
  );
}

describe("InMemoryGraphStore", () => {
  it("satisfies the IGraphStore port contract", () => {
    const g = new InMemoryGraphStore();
    expect(() => assertGraphStore(g)).not.toThrow();
    for (const m of REQUIRED_METHODS) expect(typeof g[m]).toBe("function");
    expect(g.capabilities).toMatchObject({ backend: "memory", native: false });
  });

  it("upserts nodes idempotently, merging props", async () => {
    const g = new InMemoryGraphStore();
    await g.upsert([{ id: "a", type: "doc", props: { x: 1 } }], [], scope);
    await g.upsert([{ id: "a", props: { y: 2 } }], [], scope);
    const res = await g.query({ node: "a" }, scope);
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]).toMatchObject({ id: "a", type: "doc", props: { x: 1, y: 2 } });
  });

  it("dedups edges by from|type|to and materializes missing endpoints", async () => {
    const g = new InMemoryGraphStore();
    await g.upsert([], [{ from: "x", to: "y", type: "r" }], scope);
    await g.upsert([], [{ from: "x", to: "y", type: "r", props: { w: 9 } }], scope);
    const all = await g.query({}, scope);
    expect(all.edges).toHaveLength(1);
    expect(all.edges[0].props).toEqual({ w: 9 });
    expect(all.nodes.map((n) => n.id).sort()).toEqual(["x", "y"]); // endpoints materialized
  });

  it("returns a node with its incident edges", async () => {
    const g = new InMemoryGraphStore();
    await seed(g);
    const res = await g.query({ node: "a" }, scope);
    expect(res.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(res.edges).toHaveLength(2); // a→b, a→c
  });

  it("traverses neighbors via BFS bounded by depth", async () => {
    const g = new InMemoryGraphStore();
    await seed(g);
    const d1 = await g.query({ neighbors: "a", depth: 1 }, scope);
    expect(d1.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    // depth 1 from a reaches b and c directly (a→b, a→c)
    const d2 = await g.query({ neighbors: "a", depth: 2 }, scope);
    expect(d2.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("filters traversal by edge type and direction", async () => {
    const g = new InMemoryGraphStore();
    await seed(g);
    const links = await g.query({ neighbors: "a", depth: 5, edgeType: "link" }, scope);
    // only 'link' edges: a→b→c
    expect(links.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(links.edges.every((e) => e.type === "link")).toBe(true);
    const outOfB = await g.query({ node: "b", direction: "out" }, scope);
    expect(outOfB.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["b>c"]);
    const inToC = await g.query({ node: "c", direction: "in" }, scope);
    expect(inToC.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["a>c", "b>c"]);
  });

  it("bounds results by limit with coherent edges", async () => {
    const g = new InMemoryGraphStore();
    await seed(g);
    const res = await g.query({ limit: 2 }, scope);
    expect(res.nodes).toHaveLength(2);
    // edges kept only if both endpoints survive the bound
    expect(res.edges.every((e) => {
      const ids = new Set(res.nodes.map((n) => n.id));
      return ids.has(e.from) && ids.has(e.to);
    })).toBe(true);
  });

  it("isolates graphs by tenantId", async () => {
    const g = new InMemoryGraphStore();
    await seed(g);
    const other = await g.query({}, { tenantId: "t2", userId: "u9" });
    expect(other.nodes).toEqual([]);
    expect(other.edges).toEqual([]);
  });

  it("returns empty for unknown node/neighbors", async () => {
    const g = new InMemoryGraphStore();
    await seed(g);
    expect(await g.query({ node: "zzz" }, scope)).toEqual({ nodes: [], edges: [] });
    expect(await g.query({ neighbors: "zzz" }, scope)).toEqual({ nodes: [], edges: [] });
  });

  it("rejects malformed nodes/edges (fails loudly)", async () => {
    const g = new InMemoryGraphStore();
    await expect(g.upsert([{ id: "" }], [], scope)).rejects.toThrow(/node/);
    await expect(g.upsert([], [{ from: "a", to: "" }], scope)).rejects.toThrow(/edge/);
  });
});

describe("createGraphStore / graphStoreFromEnv (seam)", () => {
  it("createGraphStore defaults to the in-memory impl", () => {
    expect(createGraphStore()).toBeInstanceOf(InMemoryGraphStore);
  });

  it("createGraphStore validates an injected impl (fails loudly)", () => {
    expect(() => createGraphStore(/** @type {any} */ ({}))).toThrow(/missing method/);
  });

  it("fromEnv defaults to in-memory (deterministic, WASM-clean)", async () => {
    const { store, backend, durable } = await graphStoreFromEnv({ env: {} });
    expect(() => assertGraphStore(store)).not.toThrow();
    expect(backend).toBe("memory");
    expect(durable).toBe(false);
  });

  it("fromEnv requires an injected durableFactory for a durable provider", async () => {
    await expect(
      graphStoreFromEnv({ env: { GRAPH_STORE_PROVIDER: "cognee" } }),
    ).rejects.toThrow(/durableFactory/);
  });

  it("fromEnv uses the injected durableFactory for a durable provider", async () => {
    const fake = new InMemoryGraphStore();
    const { store, backend, durable } = await graphStoreFromEnv({
      env: { GRAPH_STORE_PROVIDER: "neo4j" },
      durableFactory: async (provider) => {
        expect(provider).toBe("neo4j");
        return fake;
      },
    });
    expect(store).toBe(fake);
    expect(backend).toBe("neo4j");
    expect(durable).toBe(true);
  });
});
