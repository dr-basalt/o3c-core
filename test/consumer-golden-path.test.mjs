// C08 — golden path consommateur : le stack convergé ASSEMBLÉ bout-à-bout.
// Les parity ITs prouvent chaque symbole, la conformance kit prouve chaque port ; ce test
// prouve qu'ils s'ASSEMBLENT comme un consommateur convergé (o3c-code-cli) les utilise :
// mémoire cognitive inter-session (persistée via IStorageLayer injecté) → seed de prompt
// → ContextBuilder (slot brainMemories) → materializeAgent (seam LLM injecté). Tout passe
// par la surface PUBLIQUE (../src/index.mjs), rien de o3c-*-specific.
import { describe, it, expect } from "vitest";
import {
  createCognitiveMemory,
  buildMemorySeed,
  ContextBuilder,
  materializeAgent,
  MemoryStorageLayer,
} from "../src/index.mjs";

/** @type {import("../src/scope.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "proj", agentId: "a1", threadId: "th1" };

/** @type {import("../src/agent-spec.mjs").AgentSpec} */
const spec = {
  id: "a1",
  name: "Copilot",
  persona: "Pragmatic senior engineer.",
  systemPrompt: "Answer precisely and cite prior decisions.",
  defaultModel: "o3c-equilibre",
  temperature: 0.2,
  tenantId: "t1",
  projectId: "proj",
};

describe("consumer golden path — inter-session brain → seed → context → agent", () => {
  it("assembles the full converged stack a consumer wires end-to-end", async () => {
    // Storage partagé = persistance inter-session (le consommateur injecte fs/s3 ; ici mémoire).
    const storage = new MemoryStorageLayer();

    // ── Session 1 : l'agent retient des décisions, puis consolide. ──
    const s1 = await createCognitiveMemory({ prefer: "local", projectId: "proj", storage, key: "brain/proj.jsonl" });
    expect(s1.backend).toBe("local");
    await s1.memory.remember({ text: "we deploy with kubernetes helm charts on hetzner", kind: "decision" });
    await s1.memory.remember({ text: "vitest is the standard test runner", kind: "fact" });
    await s1.memory.cognify();

    // ── Session 2 : instance NEUVE, même storage → hydrate le cerveau des sessions passées. ──
    const s2 = await createCognitiveMemory({ prefer: "local", projectId: "proj", storage, key: "brain/proj.jsonl" });
    expect(await s2.memory.count()).toBe(2);

    // Seed de prompt = souvenirs récents rendus en bloc markdown.
    const seed = await buildMemorySeed({ memory: s2.memory, limit: 8 });
    expect(seed).toContain("## Memory from earlier sessions (local: 2 items)");
    expect(seed).toContain("kubernetes");

    // ── ContextBuilder : le seed alimente le slot brainMemories (injecté haut). ──
    const envelope = new ContextBuilder().build(spec, scope, { brainMemories: seed });
    expect(envelope.systemPrompt).toContain("## Persona\nPragmatic senior engineer.");
    expect(envelope.systemPrompt).toContain("## Instructions\nAnswer precisely");
    expect(envelope.systemPrompt).toContain("## Cerveau (mémoire consolidée)");
    expect(envelope.systemPrompt).toContain("kubernetes"); // le souvenir traverse jusqu'au prompt
    // Le Cerveau est injecté avant tout contexte conversationnel/documentaire.
    expect(envelope.systemPrompt.indexOf("## Instructions")).toBeLessThan(
      envelope.systemPrompt.indexOf("## Cerveau"),
    );

    // ── materializeAgent : blueprint reconstructible + seam LLM injecté (C04). ──
    const asked = [];
    const bp = materializeAgent(spec, envelope, {
      modelProvider: (id) => {
        asked.push(id);
        return { __model: id, provider: "litellm" };
      },
      tools: { search: () => {} },
    });
    expect(asked).toEqual(["o3c-equilibre"]);
    expect(bp.model).toEqual({ __model: "o3c-equilibre", provider: "litellm" });
    // L'agent matérialisé porte le prompt assemblé (donc le souvenir inter-session).
    expect(bp.instructions).toBe(envelope.systemPrompt);
    expect(bp.instructions).toContain("kubernetes");
    expect(Object.keys(bp.tools)).toEqual(["search"]);
    expect(bp.temperature).toBe(0.2);
  });

  it("recall surfaces the relevant prior decision on demand (not just the seed)", async () => {
    const storage = new MemoryStorageLayer();
    const { memory } = await createCognitiveMemory({ prefer: "local", projectId: "p", storage });
    await memory.remember({ text: "the auth flow uses short-lived JWTs rotated hourly", kind: "decision" });
    await memory.remember({ text: "the UI theme defaults to dark mode", kind: "preference" });

    const hits = await memory.recall("how does the auth flow work", 1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.text).toContain("JWT");
  });
});
