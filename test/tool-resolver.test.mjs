// C05 — IToolResolver (ADR §3, combinable). Contract-tests du seam de composition
// extrait/refactoré depuis o3c-chat/packages/agent-runtime, DÉCOUPLÉ de Mastra/
// Nango/DB : les tools sont OPAQUES. On vérifie la dégradation gracieuse ({}), le
// scoping per-user, la précédence first-registered-wins et l'ISOLATION des échecs
// (un backend qui throw ne prive pas des autres).
import { describe, it, expect } from "vitest";
import {
  StaticToolResolver,
  CombinedToolResolver,
  EmptyToolResolver,
  createToolResolver,
  toolResolverFromEnv,
  assertToolResolver,
  REQUIRED_METHODS,
} from "../src/tool-resolver.mjs";

/** @type {import("../src/scope.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "p1" };

describe("StaticToolResolver", () => {
  it("satisfies the IToolResolver port contract", () => {
    const r = new StaticToolResolver();
    expect(() => assertToolResolver(r)).not.toThrow();
    for (const m of REQUIRED_METHODS) expect(typeof r[m]).toBe("function");
  });

  it("resolves a fixed record of opaque tools (copy, not the same ref)", async () => {
    const tools = { alpha: { run: 1 }, beta: { run: 2 } };
    const r = new StaticToolResolver(tools);
    const got = await r.resolveTools(scope);
    expect(got).toEqual(tools);
    expect(got).not.toBe(tools);
  });

  it("degrades gracefully to {} when unconfigured", async () => {
    expect(await new StaticToolResolver().resolveTools(scope)).toEqual({});
  });

  it("applies a scope filter for per-user/-project scoping", async () => {
    const r = new StaticToolResolver(
      { pub: 1, priv: 2 },
      (s, id) => id === "pub" || s.userId === "admin",
    );
    expect(Object.keys(await r.resolveTools(scope))).toEqual(["pub"]);
    expect(Object.keys(await r.resolveTools({ tenantId: "t1", userId: "admin" }))).toEqual([
      "pub",
      "priv",
    ]);
  });
});

describe("CombinedToolResolver", () => {
  it("merges tools across backends", async () => {
    const r = new CombinedToolResolver([
      new StaticToolResolver({ a: 1 }),
      new StaticToolResolver({ b: 2 }),
    ]);
    expect(await r.resolveTools(scope)).toEqual({ a: 1, b: 2 });
  });

  it("resolves collisions first-registered-wins (deterministic)", async () => {
    const r = new CombinedToolResolver([
      new StaticToolResolver({ dup: "first" }),
      new StaticToolResolver({ dup: "second", extra: "x" }),
    ]);
    expect(await r.resolveTools(scope)).toEqual({ dup: "first", extra: "x" });
  });

  it("isolates a throwing backend (never deprives the others)", async () => {
    const boom = {
      async resolveTools() {
        throw new Error("backend down");
      },
    };
    const r = new CombinedToolResolver([boom, new StaticToolResolver({ ok: 1 })]);
    expect(await r.resolveTools(scope)).toEqual({ ok: 1 });
  });

  it("rejects a non-conforming backend at construction (fails loudly)", () => {
    expect(() => new CombinedToolResolver([{}])).toThrow(/resolveTools/);
  });

  it("empty composition degrades to {}", async () => {
    expect(await new CombinedToolResolver().resolveTools(scope)).toEqual({});
  });
});

describe("EmptyToolResolver", () => {
  it("always resolves {}", async () => {
    expect(await new EmptyToolResolver().resolveTools(scope)).toEqual({});
  });
});

describe("createToolResolver / toolResolverFromEnv (composition seam)", () => {
  it("createToolResolver composes injected backends", async () => {
    const r = createToolResolver([new StaticToolResolver({ a: 1 })]);
    expect(await r.resolveTools(scope)).toEqual({ a: 1 });
  });

  it("createToolResolver with no backends degrades to {} (no hard-fail)", async () => {
    expect(await createToolResolver().resolveTools(scope)).toEqual({});
  });

  it("toolResolverFromEnv reports backend count and stays graceful", async () => {
    const empty = await toolResolverFromEnv();
    expect(empty.backends).toBe(0);
    expect(await empty.resolver.resolveTools(scope)).toEqual({});

    const wired = await toolResolverFromEnv({ backends: [new StaticToolResolver({ a: 1 })] });
    expect(wired.backends).toBe(1);
    expect(await wired.resolver.resolveTools(scope)).toEqual({ a: 1 });
  });

  it("toolResolverFromEnv rejects a non-conforming backend", async () => {
    await expect(toolResolverFromEnv({ backends: [{}] })).rejects.toThrow(/resolveTools/);
  });
});
