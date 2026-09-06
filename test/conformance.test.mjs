// C08 — kit de conformité des ports (réutilisable côté consommateurs).
// Prouve que le vérificateur comportemental exporté par @ori3com/agent-core/conformance
// (1) valide les adapters de référence du core (MemoryStorageLayer, FsStorageLayer), et
// (2) ÉCHOUE précisément sur un adapter cassé — sans jamais throw. C'est l'outil qu'un
// consommateur (o3c-chat object-store/S3, LanceDB…) enveloppe dans son propre runner pour
// prouver la non-régression de SON backend injecté contre le contrat du port.
import { describe, it, expect, afterEach } from "vitest";
import {
  checkStorageLayerConformance,
  checkCognitiveMemoryConformance,
} from "../src/conformance.mjs";
import { MemoryStorageLayer, FsStorageLayer, LocalCognitiveMemory } from "../src/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("checkStorageLayerConformance", () => {
  it("passes the pure-JS MemoryStorageLayer reference adapter", async () => {
    const report = await checkStorageLayerConformance(() => new MemoryStorageLayer());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(7);
  });

  it("passes the node FsStorageLayer reference adapter", async () => {
    const report = await checkStorageLayerConformance(() => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-"));
      tmpDirs.push(root);
      return new FsStorageLayer(root);
    });
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
  });

  it("reports precise failures for a broken adapter without throwing", async () => {
    // Adapter qui ment : get() renvoie toujours null (perd les écritures).
    const broken = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async list() {
        return [];
      },
    };
    const report = await checkStorageLayerConformance(() => broken);
    expect(report.ok).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    const roundtrip = report.checks.find((c) => c.name.includes("round-trips"));
    expect(roundtrip?.ok).toBe(false);
    expect(roundtrip?.error).toMatch(/mismatch/);
    // Le contrat de forme reste satisfait (les 4 méthodes existent).
    expect(report.checks.find((c) => c.name.includes("method surface"))?.ok).toBe(true);
  });

  it("flags a missing method (incomplete adapter) in the surface check", async () => {
    const partial = { async get() { return null; }, async put() {}, async list() { return []; } };
    const report = await checkStorageLayerConformance(() => /** @type {any} */ (partial));
    const surface = report.checks.find((c) => c.name.includes("method surface"));
    expect(surface?.ok).toBe(false);
    expect(surface?.error).toMatch(/delete/);
  });
});

describe("checkCognitiveMemoryConformance", () => {
  it("passes the pure-JS LocalCognitiveMemory reference adapter", async () => {
    const report = await checkCognitiveMemoryConformance(() => new LocalCognitiveMemory());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(8);
  });

  it("fails an adapter that ignores relevance (recency-only recall)", async () => {
    // Backend « stub » : mémorise mais recall renvoie tout avec un score fixe → ne classe
    // pas par pertinence, et le hit de tête n'est pas la mémoire attendue.
    function makeRecencyOnly() {
      const items = [];
      return {
        capabilities: { backend: "stub", persistent: false, semantic: false, native: false },
        async remember(i) {
          const it = { id: `s${items.length}`, text: i.text, kind: "fact", meta: {}, ts: items.length };
          items.push(it);
          return it;
        },
        async recall() {
          // Renvoie les items les PLUS RÉCENTS d'abord, score constant — ignore la query.
          return items.slice().reverse().map((item) => ({ item, score: 1 }));
        },
        async cognify() {
          return { items: items.length };
        },
        async count() {
          return items.length;
        },
        async clear() {
          items.length = 0;
        },
      };
    }
    const report = await checkCognitiveMemoryConformance(makeRecencyOnly);
    expect(report.ok).toBe(false);
    const relevance = report.checks.find((c) => c.name.includes("ranks the relevant"));
    expect(relevance?.ok).toBe(false);
    expect(relevance?.error).toMatch(/relevant memory|topK/i);
  });

  it("flags a broken remember() (no validation, wrong count) without throwing", async () => {
    const broken = {
      capabilities: { backend: "broken" },
      async remember() {
        return { id: "x", text: "ignored" };
      },
      async recall() {
        return [];
      },
      async cognify() {
        return { items: 0 };
      },
      async count() {
        return 0;
      }, // count ne bouge jamais
      async clear() {},
    };
    const report = await checkCognitiveMemoryConformance(() => broken);
    expect(report.ok).toBe(false);
    const remember = report.checks.find((c) => c.name.includes("count() reflects it"));
    expect(remember?.ok).toBe(false);
    const rejectEmpty = report.checks.find((c) => c.name.includes("rejects empty"));
    expect(rejectEmpty?.ok).toBe(false);
  });
});
