// C08 — IT de non-régression côté consommateurs (convergence).
// Épingle EXACTEMENT la surface ICognitiveMemory que o3c-code-cli expose aujourd'hui
// via son impl bespoke `src/agent-core/memory/*` (P02), et prouve que la surface
// PUBLIQUE de `@ori3com/agent-core` (../src/index.mjs) est un drop-in fidèle : mêmes
// exports, mêmes signatures, même sémantique de recall/seed. Objectif : o3c-code-cli
// peut converger `memory/index.mjs` vers un pur ré-export de @ori3com/agent-core sans
// régression. On teste l'entrée publique (pas les modules internes) car c'est ce que
// le consommateur importera.
import { describe, it, expect } from "vitest";
import * as core from "../src/index.mjs";

/** IStorageLayer in-memory (roundtrip JSONL) — le consommateur injecte sa propre couche. */
function memStorage() {
  /** @type {Map<string, Uint8Array>} */
  const m = new Map();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async put(k, data) {
      m.set(k, data);
    },
    async delete(k) {
      m.delete(k);
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

describe("consumer parity — @ori3com/agent-core ICognitiveMemory surface", () => {
  it("re-exports every symbol o3c-code-cli's memory/index.mjs depends on", () => {
    // Ré-exports directs de l'impl bespoke (ICognitiveMemory.mjs + adapters + factory).
    for (const sym of [
      "LocalCognitiveMemory",
      "CogneeCognitiveMemory",
      "createCognitiveMemory",
      "buildMemorySeed",
      "assertCognitiveMemory",
      "isCogneeAvailable",
      "REQUIRED_METHODS",
    ]) {
      expect(core[sym], `missing public export: ${sym}`).toBeDefined();
    }
    expect(typeof core.createCognitiveMemory).toBe("function");
    expect(typeof core.buildMemorySeed).toBe("function");
    expect(typeof core.assertCognitiveMemory).toBe("function");
  });

  it("pins REQUIRED_METHODS to the exact bespoke contract", () => {
    // o3c-code-cli/src/agent-core/memory/ICognitiveMemory.mjs
    expect([...core.REQUIRED_METHODS]).toEqual([
      "remember",
      "recall",
      "cognify",
      "count",
      "clear",
    ]);
  });

  it("LocalCognitiveMemory matches the bespoke capabilities + recent() surface", async () => {
    const mem = new core.LocalCognitiveMemory();
    expect(() => core.assertCognitiveMemory(mem)).not.toThrow();
    // capabilities.backend/semantic/native identiques à l'impl locale P02.
    expect(mem.capabilities.backend).toBe("local");
    expect(mem.capabilities.semantic).toBe(true);
    expect(mem.capabilities.native).toBe(false);
    // `recent` (hors REQUIRED_METHODS) est requis par buildMemorySeed du consommateur.
    expect(typeof mem.recent).toBe("function");
  });

  it("createCognitiveMemory returns the same {memory,backend,nativeAvailable} shape", async () => {
    const built = await core.createCognitiveMemory({ prefer: "local", projectId: "parity" });
    expect(built).toHaveProperty("memory");
    expect(built).toHaveProperty("backend");
    expect(built).toHaveProperty("nativeAvailable");
    expect(built.backend).toBe("local");
    expect(built.nativeAvailable).toBe(false);
    expect(() => core.assertCognitiveMemory(built.memory)).not.toThrow();
  });

  it("buildMemorySeed emits the exact markdown block the consumer relies on", async () => {
    const storage = memStorage();
    const built = await core.createCognitiveMemory({
      prefer: "local",
      projectId: "seed",
      storage,
    });
    await built.memory.remember({ text: "we deploy with helm on hetzner", kind: "decision" });
    await built.memory.remember({ text: "vitest is the test runner" });

    const seed = await core.buildMemorySeed({ memory: built.memory, limit: 8 });
    // En-tête + backend + count, puis une ligne "- [kind] text" par item (plus récent d'abord).
    expect(seed).toContain("## Memory from earlier sessions (local: 2 items)");
    expect(seed).toContain("What prior sessions on this project retained");
    expect(seed).toContain("- [fact] vitest is the test runner");
    expect(seed).toContain("- [decision] we deploy with helm on hetzner");
    // Plus récent en premier (parité recent()).
    const lines = seed.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines[0]).toContain("vitest is the test runner");
  });

  it("buildMemorySeed collapses whitespace and truncates long text to 200 chars", async () => {
    const built = await core.createCognitiveMemory({ prefer: "local", projectId: "trunc" });
    const long = "x".repeat(500);
    await built.memory.remember({ text: `line one\n\n   line   two   ${long}` });
    const seed = await core.buildMemorySeed({ memory: built.memory });
    const line = seed.split("\n").find((l) => l.startsWith("- ["));
    expect(line).toBeDefined();
    // Espaces collapsés, pas de retour à la ligne dans l'item.
    expect(line).not.toMatch(/\n/);
    expect(line).toContain("line one line two");
    // Payload tronqué à 200 chars → beaucoup moins que 500 x.
    expect(line.length).toBeLessThan(230);
  });

  it("buildMemorySeed returns '' for an empty brain (best-effort, no throw)", async () => {
    const built = await core.createCognitiveMemory({ prefer: "local", projectId: "empty" });
    expect(await core.buildMemorySeed({ memory: built.memory })).toBe("");
  });

  it("buildMemorySeed returns '' when the backend cannot enumerate recent items", async () => {
    // Adapter valide (5 méthodes + capabilities) MAIS sans `recent` — comme cognee-rs.
    const noRecent = {
      capabilities: { backend: "cognee", persistent: true, semantic: true, native: true },
      async remember(i) {
        return { id: "x", text: i.text, kind: "fact", meta: {}, ts: 0 };
      },
      async recall() {
        return [];
      },
      async cognify() {
        return { items: 0 };
      },
      async count() {
        return 1;
      },
      async clear() {},
    };
    expect(() => core.assertCognitiveMemory(noRecent)).not.toThrow();
    expect(await core.buildMemorySeed({ memory: noRecent })).toBe("");
  });
});
