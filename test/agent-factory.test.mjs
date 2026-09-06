// C02 — agent-factory : matérialisation canal-agnostique. buildRequestContext
// propage le RuntimeScope ; materializeAgent reconstruit un AgentBlueprint par
// requête (rien de résident), avec le provider LLM injecté (seam C04) ou l'id brut.
import { describe, it, expect } from "vitest";
import { buildRequestContext, materializeAgent, RequestContext } from "../src/agent-factory.mjs";

/** @type {import("../src/scope.mjs").RuntimeScope} */
const SCOPE = {
  tenantId: "t1",
  userId: "u1",
  projectId: "p1",
  agentId: "a1",
  threadId: "th1",
};

/** @type {import("../src/agent-spec.mjs").AgentSpec} */
const SPEC = {
  id: "a1",
  name: "Copilot",
  persona: "Helpful copilot.",
  systemPrompt: "Answer precisely.",
  defaultModel: "o3c-equilibre",
  temperature: 0.3,
  tenantId: "t1",
  projectId: "p1",
};

/** @type {import("../src/context-builder.mjs").ContextEnvelope} */
const ENVELOPE = {
  systemPrompt: "## Instructions\nAnswer precisely.",
  persona: "Helpful copilot.",
  projectId: "p1",
  agentId: "a1",
  threadId: "th1",
};

describe("buildRequestContext", () => {
  it("propagates the full scope for tool isolation", () => {
    const ctx = buildRequestContext(SCOPE);
    expect(ctx).toBeInstanceOf(RequestContext);
    expect(ctx.get("tenantId")).toBe("t1");
    expect(ctx.get("projectId")).toBe("p1");
    expect(ctx.get("userId")).toBe("u1");
    expect(ctx.get("agentId")).toBe("a1");
    expect(ctx.get("threadId")).toBe("th1");
    expect(ctx.has("tenantId")).toBe(true);
    expect(ctx.has("missing")).toBe(false);
  });
});

describe("materializeAgent", () => {
  it("keeps the raw model id when no provider is injected", () => {
    const bp = materializeAgent(SPEC, ENVELOPE);
    expect(bp).toEqual({
      id: "a1",
      name: "Copilot",
      instructions: "## Instructions\nAnswer precisely.",
      model: "o3c-equilibre",
      temperature: 0.3,
      tools: {},
    });
  });

  it("resolves the model via the injected provider (LLM seam C04)", () => {
    /** @type {string[]} */
    const asked = [];
    const bp = materializeAgent(SPEC, ENVELOPE, {
      modelProvider: (id) => {
        asked.push(id);
        return { __model: id };
      },
      tools: { search: () => {} },
    });
    expect(asked).toEqual(["o3c-equilibre"]);
    expect(bp.model).toEqual({ __model: "o3c-equilibre" });
    expect(Object.keys(bp.tools)).toEqual(["search"]);
  });

  it("carries the assembled systemPrompt as instructions", () => {
    const bp = materializeAgent(SPEC, { ...ENVELOPE, systemPrompt: "CUSTOM" });
    expect(bp.instructions).toBe("CUSTOM");
  });
});
