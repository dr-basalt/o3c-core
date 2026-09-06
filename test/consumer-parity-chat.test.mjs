// C08 — IT de non-régression côté consommateurs (2/2 : chat2 `agent-runtime`).
// Le premier consommateur (o3c-code-cli) est couvert par consumer-parity.test.mjs
// pour la surface ICognitiveMemory. Ici on épingle l'AUTRE consommateur : chat2
// `@ori3com/agent-runtime` (la source d'extraction), pour sa surface canal-agnostique
// = ContextBuilder + S3PathBuilder + agent-factory (scope.ts/context-builder.ts/
// agent-factory.ts). On prouve que la surface PUBLIQUE de `@ori3com/agent-core`
// (../src/index.mjs) reproduit À L'IDENTIQUE le contrat que chat2 consomme, pour qu'il
// puisse retirer ces impls dupliquées et dépendre du core sans régression :
//   • ContextBuilder : même ordre de sections, placement du Cerveau, prompt par défaut,
//     et enveloppe (projectId/agentId/threadId + slots injectés).
//   • S3PathBuilder : même layout de clés objet (dérivé du scope serveur uniquement),
//     padding du seq message, snapshot chatindex, instructions agent, anti-traversée.
import { describe, it, expect } from "vitest";
import * as core from "../src/index.mjs";

/** RuntimeScope minimal (contrat chat2 : tenant/user/project/agent/thread). */
const scope = {
  tenantId: "t1",
  userId: "u1",
  projectId: "p1",
  agentId: "a1",
  threadId: "th1",
};

describe("consumer parity — chat2 agent-runtime canal-agnostic core", () => {
  it("re-exports the ContextBuilder / S3PathBuilder / agent-factory surface", () => {
    for (const sym of [
      "ContextBuilder",
      "S3PathBuilder",
      "RequestContext",
      "buildRequestContext",
      "materializeAgent",
    ]) {
      expect(core[sym], `missing public export: ${sym}`).toBeDefined();
    }
    expect(typeof core.ContextBuilder).toBe("function");
    expect(typeof core.S3PathBuilder).toBe("function");
    expect(typeof core.materializeAgent).toBe("function");
  });

  it("ContextBuilder falls back to the default prompt with an empty spec", () => {
    const env = new core.ContextBuilder().build({ persona: null, systemPrompt: "" }, scope);
    expect(env.systemPrompt).toBe("You are a helpful assistant.");
    expect(env.persona).toBeNull();
    expect(env.projectId).toBe("p1");
    expect(env.agentId).toBe("a1");
    expect(env.threadId).toBe("th1");
  });

  it("ContextBuilder assembles sections in the exact chat2 order (persona → instructions → cerveau → conversation → docs)", () => {
    const env = new core.ContextBuilder().build(
      { persona: "PERSONA", systemPrompt: "SYS" },
      scope,
      {
        brainMemories: "BRAIN",
        conversationSummary: "CONV",
        projectDocs: "DOCS",
      }
    );
    // Ordre canonique = ordre d'apparition dans le prompt (chat2 context-builder.ts).
    expect(env.systemPrompt).toBe(
      "## Persona\nPERSONA\n\n" +
        "## Instructions\nSYS\n\n" +
        "## Cerveau (mémoire consolidée)\nBRAIN\n\n" +
        "## Contexte de la conversation\nCONV\n\n" +
        "## Documents du projet\nDOCS"
    );
    // Le Cerveau est injecté HAUT (juste après les instructions), avant conversation/docs.
    expect(env.systemPrompt.indexOf("## Cerveau")).toBeLessThan(
      env.systemPrompt.indexOf("## Contexte de la conversation")
    );
    // L'enveloppe re-expose les slots injectés.
    expect(env.brainMemories).toBe("BRAIN");
    expect(env.conversationSummary).toBe("CONV");
    expect(env.projectDocs).toBe("DOCS");
    expect(env.persona).toBe("PERSONA");
  });

  it("ContextBuilder omits absent slots (no empty headers)", () => {
    const env = new core.ContextBuilder().build(
      { persona: null, systemPrompt: "SYS" },
      scope,
      { projectDocs: "DOCS" }
    );
    expect(env.systemPrompt).toBe("## Instructions\nSYS\n\n## Documents du projet\nDOCS");
    expect(env.systemPrompt).not.toContain("## Persona");
    expect(env.systemPrompt).not.toContain("## Cerveau");
  });

  it("S3PathBuilder derives the exact multi-tenant key layout from the scope", () => {
    const p = new core.S3PathBuilder(scope);
    expect(p.tenantRoot()).toBe("tenants/t1");
    expect(p.projectRoot()).toBe("tenants/t1/projects/p1");
    expect(p.agentRoot()).toBe("tenants/t1/projects/p1/agents/a1");
    expect(p.threadRoot()).toBe("tenants/t1/projects/p1/threads/th1");
    // seq zero-padded à 6 (ordre lexicographique = ordre chronologique).
    expect(p.message(7)).toBe("tenants/t1/projects/p1/threads/th1/messages/000007.json");
    expect(p.chatindexSnapshot()).toBe(
      "tenants/t1/projects/p1/threads/th1/derived/chatindex/current.json"
    );
    expect(p.agentInstructions("persona.md")).toBe(
      "tenants/t1/projects/p1/agents/a1/instructions/persona.md"
    );
    expect(p.fileRaw("doc.pdf")).toBe("tenants/t1/projects/p1/files/raw/doc.pdf");
    expect(p.fileNormalized("doc.pdf")).toBe(
      "tenants/t1/projects/p1/files/normalized/doc.pdf"
    );
  });

  it("S3PathBuilder defends against path traversal in client filenames", () => {
    const p = new core.S3PathBuilder(scope);
    // Séparateurs et `..` sont strippés → basename only, jamais d'échappée de tenant.
    expect(p.fileRaw("../../etc/passwd")).toBe("tenants/t1/projects/p1/files/raw/etcpasswd");
    expect(p.fileRaw("a/b/c.txt")).toBe("tenants/t1/projects/p1/files/raw/abc.txt");
    // Un nom qui se réduit à vide est rejeté bruyamment.
    expect(() => p.fileRaw("../")).toThrow(/Invalid filename/);
  });
});

describe("consumer parity — chat2 agent-factory (Mastra Agent construction seam)", () => {
  /** @type {import("../src/agent-spec.mjs").AgentSpec} */
  const spec = {
    id: "a1",
    name: "Copilot",
    persona: "Helpful copilot.",
    systemPrompt: "Answer precisely.",
    defaultModel: "o3c-equilibre",
    temperature: 0.3,
    tenantId: "t1",
    projectId: "p1",
  };
  const envelope = { systemPrompt: "## Instructions\nAnswer precisely.", persona: null };

  it("buildRequestContext propagates EXACTLY the 5 scope keys chat2 tools read", () => {
    const ctx = core.buildRequestContext(scope);
    // chat2 agent-factory.ts : tenantId/projectId/userId/agentId/threadId (Nango tools).
    for (const [k, v] of Object.entries(scope)) {
      expect(ctx.get(k)).toBe(v);
      expect(ctx.has(k)).toBe(true);
    }
    // Rien d'autre n'est propagé (isolation) : pas de fuite de clés surnuméraires.
    expect(ctx._store.size).toBe(5);
    expect(ctx.has("secret")).toBe(false);
  });

  it("materializeAgent blueprint carries the exact fields chat2 passes to new Agent({...})", () => {
    // chat2 litellm() est INJECTÉ ici via le seam modelProvider (C04) — le core ne
    // hard-dépend jamais de @ai-sdk/@mastra ; le consommateur garde ces deps chez lui.
    const litellm = (id) => ({ __model: id, provider: "litellm" });
    const tools = { search: () => {}, fetchUrl: () => {} };
    const bp = core.materializeAgent(spec, envelope, { modelProvider: litellm, tools });

    // Reconstitue l'objet EXACT que chat2 fournit à `new Agent(...)` depuis le blueprint.
    const agentInput = {
      id: bp.id,
      name: bp.name,
      instructions: bp.instructions,
      model: bp.model,
      tools: bp.tools,
    };
    expect(agentInput).toEqual({
      id: "a1",
      name: "Copilot",
      instructions: "## Instructions\nAnswer precisely.",
      model: { __model: "o3c-equilibre", provider: "litellm" },
      tools,
    });
    // Le blueprint est un SUR-ensemble (porte aussi temperature, appliquée au stream côté run).
    expect(bp.temperature).toBe(0.3);
  });

  it("materializeAgent defaults tools to {} and keeps the raw model id without a provider", () => {
    const bp = core.materializeAgent(spec, envelope);
    expect(bp.tools).toEqual({});
    expect(bp.model).toBe("o3c-equilibre");
  });
});
