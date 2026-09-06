// C02 — ContextBuilder : assemblage du prompt système à partir de l'AgentSpec et
// des slots de contexte injectés. Vérifie l'ordre des sections (Cerveau juste après
// Instructions), l'écho sur l'enveloppe, et l'omission propre des slots absents.
import { describe, it, expect } from "vitest";
import { ContextBuilder } from "../src/context-builder.mjs";

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
  temperature: 0.7,
  tenantId: "t1",
  projectId: "p1",
};

describe("ContextBuilder", () => {
  it("injects the Cerveau section right after Instructions", () => {
    const env = new ContextBuilder().build(SPEC, SCOPE, {
      brainMemories: "- [preference] Prefers concise answers.",
    });
    expect(env.systemPrompt).toMatch(/## Cerveau \(mémoire consolidée\)/);
    expect(env.systemPrompt).toMatch(/Prefers concise answers\./);
    expect(env.systemPrompt.indexOf("## Instructions")).toBeLessThan(
      env.systemPrompt.indexOf("## Cerveau"),
    );
    expect(env.brainMemories).toBe("- [preference] Prefers concise answers.");
  });

  it("orders slots: persona → instructions → cerveau → conversation → docs", () => {
    const env = new ContextBuilder().build(SPEC, SCOPE, {
      brainMemories: "MEM",
      conversationSummary: "CONV",
      projectDocs: "DOCS",
    });
    const order = ["## Persona", "## Instructions", "## Cerveau", "## Contexte", "## Documents"];
    const positions = order.map((h) => env.systemPrompt.indexOf(h));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => p >= 0)).toBe(true);
  });

  it("echoes scope + slots on the envelope", () => {
    const env = new ContextBuilder().build(SPEC, SCOPE, { projectDocs: "DOCS" });
    expect(env.projectId).toBe("p1");
    expect(env.agentId).toBe("a1");
    expect(env.threadId).toBe("th1");
    expect(env.persona).toBe("Helpful copilot.");
    expect(env.projectDocs).toBe("DOCS");
  });

  it("omits absent slots and falls back when spec is empty", () => {
    const env = new ContextBuilder().build(SPEC, SCOPE, {});
    expect(env.systemPrompt).not.toMatch(/## Cerveau/);
    expect(env.conversationSummary).toBeUndefined();
    expect(env.projectDocs).toBeUndefined();
    expect(env.brainMemories).toBeUndefined();

    const bare = /** @type {import("../src/agent-spec.mjs").AgentSpec} */ ({
      ...SPEC,
      persona: null,
      systemPrompt: null,
    });
    const fallback = new ContextBuilder().build(bare, SCOPE, {});
    expect(fallback.systemPrompt).toBe("You are a helpful assistant.");
    expect(fallback.persona).toBeNull();
  });
});
