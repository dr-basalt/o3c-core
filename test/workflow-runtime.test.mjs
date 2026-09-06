// C05 — IWorkflowRuntime (Tâches). Contract-tests de l'impl in-memory pure-JS
// extraite/refactorée depuis o3c-chat/packages/agent-runtime, DÉCOUPLÉE de tout
// backend serveur : exécution déterministe des steps (chaînés via `previous`),
// isolation par tenantId, échec de step → run `failed` inspectable, index de
// planification, dispatcher de steps (seam Mastra injecté), planif pure `isCronDue`,
// et le seam `workflowRuntimeFromEnv` (durable injecté, jamais bundlé dans le cœur).
import { describe, it, expect } from "vitest";
import {
  InMemoryWorkflowRuntime,
  createWorkflowStepHandler,
  createWorkflowRuntime,
  workflowRuntimeFromEnv,
  assertWorkflowRuntime,
  isCronDue,
  isWorkflowStepKind,
  WORKFLOW_STEP_KINDS,
  REQUIRED_METHODS,
} from "../src/workflow-runtime.mjs";

/** @type {import("../src/ports.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "p1" };

/**
 * @param {string} id
 * @param {import("../src/workflow-runtime.mjs").WorkflowTrigger} trigger
 * @param {import("../src/workflow-runtime.mjs").WorkflowStep[]} steps
 * @returns {import("../src/workflow-runtime.mjs").WorkflowDefinition}
 */
function wf(id, trigger, steps = []) {
  return { id, name: id, trigger, steps };
}

describe("InMemoryWorkflowRuntime", () => {
  it("satisfies the IWorkflowRuntime port contract", () => {
    const rt = new InMemoryWorkflowRuntime();
    expect(() => assertWorkflowRuntime(rt)).not.toThrow();
    for (const m of REQUIRED_METHODS) expect(typeof rt[m]).toBe("function");
    expect(rt.capabilities).toMatchObject({ backend: "memory", durable: false });
  });

  it("registers, reads, searches and rejects duplicate ids", async () => {
    const rt = new InMemoryWorkflowRuntime();
    await rt.register(wf("a", { type: "event", event: "e" }), scope);
    expect((await rt.read("a", scope))?.id).toBe("a");
    await expect(rt.register(wf("a", { type: "event", event: "e" }), scope)).rejects.toThrow(
      /WORKFLOW_EXISTS/,
    );
    expect((await rt.search({}, scope)).map((d) => d.id)).toEqual(["a"]);
  });

  it("isolates definitions by tenantId", async () => {
    const rt = new InMemoryWorkflowRuntime();
    await rt.register(wf("a", { type: "event", event: "e" }), scope);
    const other = { tenantId: "t2", userId: "u1" };
    expect(await rt.read("a", other)).toBeNull();
    expect(await rt.search({}, other)).toEqual([]);
  });

  it("triggers matching event workflows and chains step outputs (previous)", async () => {
    const handler = async (ctx) => `${ctx.previous ?? "seed"}>${ctx.step.ref}`;
    const rt = new InMemoryWorkflowRuntime(handler);
    await rt.register(
      wf("w", { type: "event", event: "go" }, [
        { id: "s1", kind: "tool", ref: "one" },
        { id: "s2", kind: "tool", ref: "two" },
      ]),
      scope,
    );
    const [run] = await rt.trigger("go", { x: 1 }, scope);
    expect(run.status).toBe("completed");
    expect(run.output).toBe("seed>one>two");
    expect(run.steps.map((s) => s.output)).toEqual(["seed>one", "seed>one>two"]);
    // run durable inspectable
    expect((await rt.getRun(run.id, scope))?.output).toBe("seed>one>two");
  });

  it("stops at the first failing step and records a failed run", async () => {
    const handler = async (ctx) => {
      if (ctx.step.ref === "boom") throw new Error("kaboom");
      return "ok";
    };
    const rt = new InMemoryWorkflowRuntime(handler);
    await rt.register(
      wf("w", { type: "event", event: "go" }, [
        { id: "s1", kind: "tool", ref: "fine" },
        { id: "s2", kind: "tool", ref: "boom" },
        { id: "s3", kind: "tool", ref: "never" },
      ]),
      scope,
    );
    const [run] = await rt.trigger("go", {}, scope);
    expect(run.status).toBe("failed");
    expect(run.steps).toHaveLength(2);
    expect(run.steps[1]).toMatchObject({ stepId: "s2", error: "kaboom" });
    expect(run.output).toBeUndefined();
  });

  it("returns [] when no event workflow matches", async () => {
    const rt = new InMemoryWorkflowRuntime();
    expect(await rt.trigger("nothing", {}, scope)).toEqual([]);
  });

  it("indexes schedule triggers cross-tenant but does not fire them", async () => {
    const rt = new InMemoryWorkflowRuntime();
    await rt.register(wf("cron1", { type: "schedule", cron: "* * * * *" }), scope);
    await rt.register(wf("cron2", { type: "schedule", cron: "0 0 * * *" }), {
      tenantId: "t2",
      userId: "u2",
    });
    const schedules = await rt.listSchedules();
    expect(schedules.map((s) => s.workflowId).sort()).toEqual(["cron1", "cron2"]);
    // schedule workflows are not event-triggered
    expect(await rt.trigger("* * * * *", {}, scope)).toEqual([]);
  });

  it("update patches a def and re-indexes its schedule", async () => {
    const rt = new InMemoryWorkflowRuntime();
    await rt.register(wf("w", { type: "schedule", cron: "* * * * *" }), scope);
    await rt.update("w", { trigger: { type: "event", event: "e" } }, scope);
    expect(await rt.listSchedules()).toEqual([]);
    await expect(rt.update("missing", {}, scope)).rejects.toThrow(/WORKFLOW_NOT_FOUND/);
  });

  it("delete removes the def and its schedule index", async () => {
    const rt = new InMemoryWorkflowRuntime();
    await rt.register(wf("w", { type: "schedule", cron: "* * * * *" }), scope);
    await rt.delete("w", scope);
    expect(await rt.read("w", scope)).toBeNull();
    expect(await rt.listSchedules()).toEqual([]);
  });
});

describe("createWorkflowStepHandler (Mastra step seam)", () => {
  it("dispatches by kind to injected executors", async () => {
    const handler = createWorkflowStepHandler({
      agent: async () => "from-agent",
      tool: async (ctx) => `tool:${ctx.step.ref}`,
    });
    expect(await handler({ step: { id: "s", kind: "agent", ref: "x" }, scope, event: {}, previous: null })).toBe(
      "from-agent",
    );
    expect(await handler({ step: { id: "s", kind: "tool", ref: "y" }, scope, event: {}, previous: null })).toBe(
      "tool:y",
    );
  });

  it("throws STEP_EXECUTOR_MISSING for an unwired kind", async () => {
    const handler = createWorkflowStepHandler({});
    await expect(
      handler({ step: { id: "s", kind: "skill", ref: "z" }, scope, event: {}, previous: null }),
    ).rejects.toThrow(/STEP_EXECUTOR_MISSING:skill/);
  });
});

describe("isCronDue (pure UTC scheduler)", () => {
  const at = (iso) => new Date(iso);
  it("matches wildcard every minute", () => {
    expect(isCronDue("* * * * *", at("2026-09-06T10:30:00Z"))).toBe(true);
  });
  it("matches exact minute/hour", () => {
    expect(isCronDue("30 10 * * *", at("2026-09-06T10:30:00Z"))).toBe(true);
    expect(isCronDue("30 10 * * *", at("2026-09-06T10:31:00Z"))).toBe(false);
  });
  it("supports lists, ranges and steps", () => {
    expect(isCronDue("0,30 * * * *", at("2026-09-06T10:30:00Z"))).toBe(true);
    expect(isCronDue("*/15 * * * *", at("2026-09-06T10:45:00Z"))).toBe(true);
    expect(isCronDue("*/15 * * * *", at("2026-09-06T10:46:00Z"))).toBe(false);
    expect(isCronDue("0 9-17 * * *", at("2026-09-06T12:00:00Z"))).toBe(true);
  });
  it("rejects malformed expressions", () => {
    expect(isCronDue("* * *", at("2026-09-06T10:30:00Z"))).toBe(false);
  });
});

describe("kind guard", () => {
  it("validates known kinds only", () => {
    for (const k of WORKFLOW_STEP_KINDS) expect(isWorkflowStepKind(k)).toBe(true);
    expect(isWorkflowStepKind("nope")).toBe(false);
    expect(isWorkflowStepKind(42)).toBe(false);
  });
});

describe("createWorkflowRuntime / workflowRuntimeFromEnv (seam)", () => {
  it("createWorkflowRuntime defaults to the in-memory impl", async () => {
    const rt = createWorkflowRuntime();
    expect(rt).toBeInstanceOf(InMemoryWorkflowRuntime);
  });

  it("createWorkflowRuntime validates an injected impl (fails loudly)", () => {
    expect(() => createWorkflowRuntime(/** @type {any} */ ({}))).toThrow(/missing method/);
  });

  it("fromEnv defaults to in-memory (deterministic, no server dep)", async () => {
    const { runtime, backend, durable } = await workflowRuntimeFromEnv({ env: {} });
    expect(() => assertWorkflowRuntime(runtime)).not.toThrow();
    expect(backend).toBe("memory");
    expect(durable).toBe(false);
  });

  it("fromEnv requires an injected durableFactory for provider=inngest", async () => {
    await expect(
      workflowRuntimeFromEnv({ env: { WORKFLOW_RUNTIME_PROVIDER: "inngest" } }),
    ).rejects.toThrow(/durableFactory/);
  });

  it("fromEnv uses the injected durableFactory when provider=inngest", async () => {
    const fake = new InMemoryWorkflowRuntime();
    const { runtime, backend, durable } = await workflowRuntimeFromEnv({
      env: { INNGEST_BASE_URL: "https://inngest" },
      durableFactory: async () => fake,
    });
    expect(runtime).toBe(fake);
    expect(backend).toBe("inngest");
    expect(durable).toBe(true);
  });
});
