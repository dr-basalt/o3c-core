// C08 — golden path consommateur 2/2 : le flux d'assemblage de chat2 `agent-runtime`.
// Le golden path o3c-code-cli (mémoire→seed→context→agent) est couvert ailleurs ; chat2
// assemble différemment (run.ts) : clés objet dérivées du scope (S3PathBuilder), isolation
// des tools via buildRequestContext, puis ContextBuilder avec TOUS les slots (résumé de
// conversation + docs projet RAG + cerveau) et materializeAgent (seam LLM injecté). Ce test
// prouve que ces pièces s'assemblent bout-à-bout via la surface PUBLIQUE, découplées de la DB.
import { describe, it, expect } from "vitest";
import {
  S3PathBuilder,
  buildRequestContext,
  RequestContext,
  ContextBuilder,
  materializeAgent,
} from "../src/index.mjs";

/** @type {import("../src/scope.mjs").RuntimeScope} */
const scope = { tenantId: "acme", userId: "u42", projectId: "proj7", agentId: "ag3", threadId: "th9" };

/** @type {import("../src/agent-spec.mjs").AgentSpec} */
const spec = {
  id: "ag3",
  name: "Support Copilot",
  persona: "Empathetic support agent.",
  systemPrompt: "Resolve the ticket using project docs.",
  defaultModel: "o3c-equilibre",
  temperature: 0.4,
  tenantId: "acme",
  projectId: "proj7",
};

describe("consumer golden path — chat2 agent-runtime request assembly", () => {
  it("derives scope-only storage keys, isolates tools, assembles context + agent", () => {
    // ── Clés objet : dérivées EXCLUSIVEMENT du scope serveur (jamais du client). ──
    const paths = new S3PathBuilder(scope);
    expect(paths.message(12)).toBe("tenants/acme/projects/proj7/threads/th9/messages/000012.json");
    expect(paths.agentInstructions("system.md")).toBe(
      "tenants/acme/projects/proj7/agents/ag3/instructions/system.md",
    );
    expect(paths.chatindexSnapshot()).toBe(
      "tenants/acme/projects/proj7/threads/th9/derived/chatindex/current.json",
    );

    // ── RequestContext : propage le scope aux tools (isolation Nango per-user). ──
    const ctx = buildRequestContext(scope);
    expect(ctx).toBeInstanceOf(RequestContext);
    expect(ctx.get("userId")).toBe("u42");
    expect(ctx.get("tenantId")).toBe("acme");
    expect(ctx._store.size).toBe(5);

    // ── ContextBuilder : chat2 remplit TOUS les slots (sidecar ChatIndex + RAG + cerveau). ──
    const envelope = new ContextBuilder().build(spec, scope, {
      conversationSummary: "User reported a failed payment.",
      projectDocs: "Refund policy: refunds within 30 days.",
      brainMemories: "User prefers concise answers.",
    });
    expect(envelope.systemPrompt).toBe(
      "## Persona\nEmpathetic support agent.\n\n" +
        "## Instructions\nResolve the ticket using project docs.\n\n" +
        "## Cerveau (mémoire consolidée)\nUser prefers concise answers.\n\n" +
        "## Contexte de la conversation\nUser reported a failed payment.\n\n" +
        "## Documents du projet\nRefund policy: refunds within 30 days.",
    );
    expect(envelope.projectId).toBe("proj7");
    expect(envelope.threadId).toBe("th9");

    // ── materializeAgent : blueprint pour Mastra, provider LLM injecté (deps hors core). ──
    const bp = materializeAgent(spec, envelope, {
      modelProvider: (id) => ({ __model: id }),
      tools: { refundLookup: () => {}, ticketUpdate: () => {} },
    });
    // Objet EXACT que chat2 passe à `new Agent({...})`.
    expect({ id: bp.id, name: bp.name, instructions: bp.instructions, model: bp.model, tools: bp.tools }).toEqual({
      id: "ag3",
      name: "Support Copilot",
      instructions: envelope.systemPrompt,
      model: { __model: "o3c-equilibre" },
      tools: { refundLookup: bp.tools.refundLookup, ticketUpdate: bp.tools.ticketUpdate },
    });
    expect(Object.keys(bp.tools)).toEqual(["refundLookup", "ticketUpdate"]);
  });

  it("keeps client-supplied filenames confined to the project (traversal defense)", () => {
    const paths = new S3PathBuilder(scope);
    expect(paths.fileRaw("../../secret.env")).toBe("tenants/acme/projects/proj7/files/raw/secret.env");
    expect(() => paths.fileRaw("..")).toThrow(/Invalid filename/);
  });
});
