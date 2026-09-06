// C09 — RuntimeBroker. Le point d'entrée boîte-noire `invoke(workload, ctx)` que
// l'IHM appelle : on vérifie qu'il route chaque workload vers le bon port, que le
// placement est opaque/indicatif, qu'un port absent lève PORT_UNAVAILABLE (pas de
// piège silencieux), et que `runtimeBrokerFromEnv` (capstone des seams C05) assemble
// un broker RÉELLEMENT fonctionnel (import + remember/recall) sans que l'appelant
// connaisse un seul backend — la surface exacte que le smoke WASM C09 pilotera.
import { describe, it, expect } from "vitest";
import {
  LocalRuntimeBroker,
  createRuntimeBroker,
  runtimeBrokerFromEnv,
  assertRuntimeBroker,
  WORKLOAD_KINDS,
} from "../src/runtime-broker.mjs";

/** @type {import("../src/ports.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "p1" };
const ctx = { scope };

describe("LocalRuntimeBroker dispatch", () => {
  it("satisfies the RuntimeBroker contract", () => {
    expect(() => assertRuntimeBroker(new LocalRuntimeBroker())).not.toThrow();
    expect(() => assertRuntimeBroker({})).toThrow(/invoke/);
  });

  it("validates workload.kind and ctx.scope", async () => {
    const b = new LocalRuntimeBroker();
    await expect(b.invoke(/** @type {any} */ ({}), ctx)).rejects.toThrow(/workload.kind/);
    await expect(b.invoke({ kind: "tools.resolve" }, /** @type {any} */ ({}))).rejects.toThrow(
      /ctx.scope/,
    );
  });

  it("routes each workload to its injected port and echoes an opaque placement", async () => {
    /** @type {any} */
    const calls = [];
    const rec = (name) => (...args) => (calls.push([name, args]), name);
    const b = new LocalRuntimeBroker({
      placement: "edge", // placement is opaque/indicative — the UI never depends on it
      cognitive: { remember: rec("remember"), recall: rec("recall") },
      vector: { upsert: rec("v.upsert"), query: rec("v.query") },
      brain: { consolidate: rec("b.consolidate"), recall: rec("b.recall") },
      graph: { upsert: rec("g.upsert"), query: rec("g.query") },
      tools: { resolveTools: rec("tools") },
      workflow: { trigger: rec("wf") },
      llm: { chat: rec("chat") },
    });

    const r = await b.invoke({ kind: "memory.recall", query: "q", k: 3 }, ctx);
    expect(r).toEqual({ placement: "edge", kind: "memory.recall", output: "recall" });
    expect(calls.at(-1)).toEqual(["recall", ["q", 3]]);

    await b.invoke({ kind: "vector.query", ns: "nsX", q: { vector: [1] } }, ctx);
    expect(calls.at(-1)).toEqual(["v.query", ["nsX", { vector: [1] }]]);

    await b.invoke({ kind: "graph.query", query: { node: "a" } }, ctx);
    expect(calls.at(-1)).toEqual(["g.query", [{ node: "a" }, scope]]);

    await b.invoke({ kind: "workflow.trigger", event: "go", payload: { x: 1 } }, ctx);
    expect(calls.at(-1)).toEqual(["wf", ["go", { x: 1 }, scope]]);

    await b.invoke({ kind: "tools.resolve" }, ctx);
    expect(calls.at(-1)).toEqual(["tools", [scope]]);

    await b.invoke({ kind: "llm.chat", request: { messages: [] } }, ctx);
    expect(calls.at(-1)).toEqual(["chat", [{ messages: [] }]]);
  });

  it("defaults vector/memory ns to scope.projectId", async () => {
    /** @type {any} */
    let seen;
    const b = new LocalRuntimeBroker({ vector: { upsert: (ns) => ((seen = ns), undefined) } });
    await b.invoke({ kind: "vector.upsert", docs: [] }, ctx);
    expect(seen).toBe("p1");
  });

  it("raises PORT_UNAVAILABLE for a missing port (explicit degradation)", async () => {
    const b = new LocalRuntimeBroker({});
    await expect(b.invoke({ kind: "llm.chat", messages: [] }, ctx)).rejects.toThrow(
      /PORT_UNAVAILABLE:llm/,
    );
  });

  it("raises for an unknown workload kind", async () => {
    const b = new LocalRuntimeBroker({});
    await expect(b.invoke({ kind: "does.not.exist" }, ctx)).rejects.toThrow(/UNKNOWN_WORKLOAD_KIND/);
  });

  it("createRuntimeBroker validates the assembled broker", () => {
    expect(createRuntimeBroker({}).invoke).toBeTypeOf("function");
  });

  it("exposes a stable workload-kind registry", () => {
    expect(WORKLOAD_KINDS).toContain("memory.remember");
    expect(WORKLOAD_KINDS.length).toBeGreaterThanOrEqual(11);
  });
});

describe("runtimeBrokerFromEnv (capstone — black-box, no backend knowledge)", () => {
  it("assembles a working broker over the default local seams", async () => {
    const { broker, backends } = await runtimeBrokerFromEnv({ env: {}, projectId: "demo" });
    expect(() => assertRuntimeBroker(broker)).not.toThrow();
    // all backends degrade to their pure-JS defaults with an empty env
    expect(backends.cognitive).toBe("local");
    expect(backends.vector).toBe("local");
    expect(backends.brain).toBe("memory");
    expect(backends.graph).toBe("memory");
    expect(backends.workflow).toBe("memory");
    expect(backends.storage).toBe("memory");
    expect(backends.llm).toBe("none");
  });

  it("runs a real import → remember → recall round-trip through invoke()", async () => {
    const { broker } = await runtimeBrokerFromEnv({ env: {}, projectId: "demo" });
    await broker.invoke(
      { kind: "memory.remember", item: { text: "the runtime broker routes workloads to ports" } },
      ctx,
    );
    await broker.invoke({ kind: "memory.remember", item: { text: "an unrelated memory" } }, ctx);
    const res = await broker.invoke({ kind: "memory.recall", query: "broker workloads", k: 1 }, ctx);
    expect(res.placement).toBe("local");
    expect(res.output[0].item.text).toMatch(/routes workloads/);
  });

  it("wires vector + graph + brain end-to-end through the black box", async () => {
    const { broker } = await runtimeBrokerFromEnv({ env: {}, projectId: "demo" });
    await broker.invoke(
      { kind: "vector.upsert", docs: [{ id: "a", text: "x", vector: [1, 0] }] },
      ctx,
    );
    const v = await broker.invoke({ kind: "vector.query", q: { vector: [1, 0], topK: 1 } }, ctx);
    expect(v.output[0].id).toBe("a");

    await broker.invoke(
      { kind: "graph.upsert", nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] },
      ctx,
    );
    const g = await broker.invoke({ kind: "graph.query", query: { node: "a" } }, ctx);
    expect(g.output.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);

    await broker.invoke(
      { kind: "brain.consolidate", records: [{ id: "m", content: "likes tea", kind: "preference" }] },
      ctx,
    );
    const br = await broker.invoke({ kind: "brain.recall", query: { text: "tea" } }, ctx);
    expect(br.output[0].id).toBe("m");
  });
});
