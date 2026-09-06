// C05 — IBrainMemory (cerveau consolidé + méta-agent). Contract-tests de l'impl
// in-memory pure-JS extraite/refactorée depuis o3c-chat/packages/agent-runtime,
// DÉCOUPLÉE de tout backend serveur : consolidation idempotente bornée par le seuil
// du méta-agent, rappel déterministe filtré/borné par la policy, isolation par
// tenantId, droit à l'oubli, helpers de rendu du bloc Cerveau, et le seam
// `brainMemoryFromEnv` (backend durable LanceDB injecté, jamais bundlé dans le cœur).
import { describe, it, expect } from "vitest";
import {
  InMemoryBrainMemory,
  createBrainMemory,
  brainMemoryFromEnv,
  assertBrainMemory,
  formatBrainRecall,
  composeBrainContext,
  isBrainMemoryKind,
  BRAIN_MEMORY_KINDS,
  DEFAULT_META_AGENT_POLICY,
  REQUIRED_METHODS,
} from "../src/brain-memory.mjs";

/** @type {import("../src/ports.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "p1" };

/**
 * @param {string} id
 * @param {string} content
 * @param {Partial<import("../src/brain-memory.mjs").BrainRecord>} [extra]
 * @returns {import("../src/brain-memory.mjs").BrainRecord}
 */
function rec(id, content, extra = {}) {
  return { id, content, kind: "semantic", ...extra };
}

describe("InMemoryBrainMemory", () => {
  it("satisfies the IBrainMemory port contract", () => {
    const b = new InMemoryBrainMemory();
    expect(() => assertBrainMemory(b)).not.toThrow();
    for (const m of REQUIRED_METHODS) expect(typeof b[m]).toBe("function");
    expect(b.capabilities).toMatchObject({ backend: "memory", durable: false });
  });

  it("consolidates and recalls by substring, ranked by density", async () => {
    const b = new InMemoryBrainMemory();
    await b.consolidate(
      [rec("a", "the user prefers dark mode"), rec("b", "dark chocolate is nice")],
      scope,
    );
    const hits = await b.recall({ text: "dark" }, scope);
    expect(hits.map((h) => h.id)).toEqual(["b", "a"]); // "dark" denser in shorter "b"
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("upserts by id (idempotent edge→brain cycles)", async () => {
    const b = new InMemoryBrainMemory();
    await b.consolidate([rec("a", "v1 content")], scope);
    const r = await b.consolidate([rec("a", "v2 content")], scope);
    expect(r.accepted).toEqual(["a"]);
    const [hit] = await b.recall({ text: "content" }, scope);
    expect(hit.content).toBe("v2 content");
  });

  it("applies the meta-agent consolidation threshold at ingest", async () => {
    const b = new InMemoryBrainMemory();
    await b.setPolicy({ consolidationThreshold: 0.5 }, scope);
    const r = await b.consolidate(
      [rec("hi", "keep", { salience: 0.9 }), rec("lo", "drop", { salience: 0.1 })],
      scope,
    );
    expect(r.accepted).toEqual(["hi"]);
    expect(r.rejected).toEqual(["lo"]);
    expect((await b.recall({}, scope)).map((h) => h.id)).toEqual(["hi"]);
  });

  it("filters recall by kind and minSalience, bounded by topK", async () => {
    const b = new InMemoryBrainMemory();
    await b.consolidate(
      [
        rec("e", "episodic one", { kind: "episodic", salience: 0.9 }),
        rec("s", "semantic one", { kind: "semantic", salience: 0.2 }),
        rec("p", "preference one", { kind: "preference", salience: 0.8 }),
      ],
      scope,
    );
    const kinds = await b.recall({ kinds: ["episodic", "preference"] }, scope);
    expect(kinds.map((h) => h.id).sort()).toEqual(["e", "p"]);
    const salient = await b.recall({ minSalience: 0.5 }, scope);
    expect(salient.map((h) => h.id).sort()).toEqual(["e", "p"]);
    const capped = await b.recall({ topK: 1 }, scope);
    expect(capped).toHaveLength(1);
  });

  it("isolates the brain by tenantId (org asset)", async () => {
    const b = new InMemoryBrainMemory();
    await b.consolidate([rec("a", "tenant one secret")], scope);
    expect(await b.recall({ text: "secret" }, { tenantId: "t2", userId: "u9" })).toEqual([]);
  });

  it("forgets consolidated memories (right to erasure)", async () => {
    const b = new InMemoryBrainMemory();
    await b.consolidate([rec("a", "forget me")], scope);
    await b.forget(["a"], scope);
    expect(await b.recall({ text: "forget" }, scope)).toEqual([]);
  });

  it("merges policy patches over the default and isolates by tenant", async () => {
    const b = new InMemoryBrainMemory();
    expect(await b.getPolicy(scope)).toEqual(DEFAULT_META_AGENT_POLICY);
    const next = await b.setPolicy({ recallTopK: 3 }, scope);
    expect(next.recallTopK).toBe(3);
    expect(next.directive).toBe(DEFAULT_META_AGENT_POLICY.directive);
    expect(await b.getPolicy({ tenantId: "t2", userId: "u9" })).toEqual(DEFAULT_META_AGENT_POLICY);
  });
});

describe("brain context helpers", () => {
  it("formats hits one per line, prefixed by kind", () => {
    const block = formatBrainRecall([
      { id: "a", content: "likes tea", kind: "preference", salience: 1, score: 1 },
    ]);
    expect(block).toBe("- [preference] likes tea");
  });

  it("composeBrainContext returns undefined when there are no hits", () => {
    expect(composeBrainContext("directive", [])).toBeUndefined();
  });

  it("composeBrainContext prepends the directive when hits exist", () => {
    const out = composeBrainContext("USE THE BRAIN", [
      { id: "a", content: "x", kind: "semantic", salience: 1, score: 1 },
    ]);
    expect(out).toBe("USE THE BRAIN\n\n- [semantic] x");
  });

  it("validates known kinds only", () => {
    for (const k of BRAIN_MEMORY_KINDS) expect(isBrainMemoryKind(k)).toBe(true);
    expect(isBrainMemoryKind("nope")).toBe(false);
  });
});

describe("createBrainMemory / brainMemoryFromEnv (seam)", () => {
  it("createBrainMemory defaults to the in-memory impl", () => {
    expect(createBrainMemory()).toBeInstanceOf(InMemoryBrainMemory);
  });

  it("createBrainMemory validates an injected impl (fails loudly)", () => {
    expect(() => createBrainMemory(/** @type {any} */ ({}))).toThrow(/missing method/);
  });

  it("fromEnv defaults to in-memory (deterministic, no dependency)", async () => {
    const { memory, backend, durable } = await brainMemoryFromEnv({ env: {} });
    expect(() => assertBrainMemory(memory)).not.toThrow();
    expect(backend).toBe("memory");
    expect(durable).toBe(false);
  });

  it("fromEnv requires an injected durableFactory for provider=lancedb", async () => {
    await expect(
      brainMemoryFromEnv({ env: { BRAIN_MEMORY_PROVIDER: "lancedb" } }),
    ).rejects.toThrow(/durableFactory/);
  });

  it("fromEnv uses the injected durableFactory when provider=lancedb", async () => {
    const fake = new InMemoryBrainMemory();
    const { memory, backend, durable } = await brainMemoryFromEnv({
      env: { BRAIN_MEMORY_PROVIDER: "lancedb" },
      durableFactory: async () => fake,
    });
    expect(memory).toBe(fake);
    expect(backend).toBe("lancedb");
    expect(durable).toBe(true);
  });
});
