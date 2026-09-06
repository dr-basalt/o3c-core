// C08 — carte de convergence consommateurs, VÉRIFIÉE (anti-dérive du guide).
// docs/consumer-convergence.md dit à chaque consommateur quels symboles dupliqués
// supprimer et par quel export de @ori3com/agent-core les remplacer. Un guide de
// migration qui ment est pire que pas de guide : ce test épingle la carte comme une
// STRUCTURE DE DONNÉES et prouve que CHAQUE symbole de remplacement existe réellement
// sur la surface publique du package. Si un export du core disparaît/est renommé, la
// convergence documentée casse ICI, pas dans le repo consommateur.
import { describe, it, expect } from "vitest";
import * as core from "../src/index.mjs";
import { PORT_CONFORMANCE } from "../src/conformance.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/consumer-convergence.md"),
  "utf-8",
);

/**
 * Carte de convergence : par consommateur, chaque impl dupliquée → le symbole
 * @ori3com/agent-core qui la remplace à l'identique (prouvé par les parity ITs).
 * `keep` = ce que le consommateur GARDE (spécifique canal, rebâti SUR le core).
 */
const CONVERGENCE = {
  "o3c-code-cli": {
    // src/agent-core/memory/* (impl bespoke P02) → @ori3com/agent-core
    replaces: [
      "REQUIRED_METHODS", // memory/ICognitiveMemory.mjs
      "assertCognitiveMemory", // memory/ICognitiveMemory.mjs
      "LocalCognitiveMemory", // memory/adapters/local.mjs (+ FsStorageLayer injecté pour ~/.o3c/brain)
      "CogneeCognitiveMemory", // memory/adapters/cognee.mjs
      "loadCognee", // memory/adapters/cognee.mjs
      "isCogneeAvailable", // memory/adapters/cognee.mjs
      "createCognitiveMemory", // memory/index.mjs
      "buildMemorySeed", // memory/index.mjs
      "FsStorageLayer", // remplace le node:fs direct de adapters/local.mjs (persistance injectée)
    ],
    // Spécifique CLI (historique de session, sync brain) — reste, rebâti sur le core.
    keep: ["memory/hydrate.mjs", "memory/lifecycle.mjs", "memory/sync.mjs"],
  },
  "chat2-agent-runtime": {
    // src/{context-builder,scope,agent-factory}.ts → @ori3com/agent-core
    replaces: [
      "ContextBuilder", // context-builder.ts
      "S3PathBuilder", // scope.ts
      "RequestContext", // agent-factory.ts
      "buildRequestContext", // agent-factory.ts
      "materializeAgent", // agent-factory.ts (AgentBlueprint + wrapper Mastra `new Agent(bp)`)
    ],
    // Seams DB (drizzle/@ori3com/db) + construction Mastra concrète — restent chez chat2.
    keep: ["scope.ts:buildRuntimeScope", "scope.ts:listUserProjects", "agent-factory.ts:litellm()"],
  },
};

describe("consumer convergence map (docs/consumer-convergence.md)", () => {
  for (const [consumer, { replaces }] of Object.entries(CONVERGENCE)) {
    it(`${consumer}: every replacement symbol is a real @ori3com/agent-core export`, () => {
      for (const sym of replaces) {
        expect(core[sym], `${consumer}: core is missing replacement export '${sym}'`).toBeDefined();
      }
    });
  }

  it("the map covers both C08 consumers named in ADR-0001 §4", () => {
    expect(Object.keys(CONVERGENCE).sort()).toEqual(["chat2-agent-runtime", "o3c-code-cli"]);
  });
});

describe("conformance kit section stays in sync with PORT_CONFORMANCE", () => {
  it("the guide documents every port + its checker (no drift)", () => {
    for (const [port, checker] of Object.entries(PORT_CONFORMANCE)) {
      expect(GUIDE.includes(port), `guide missing port '${port}'`).toBe(true);
      expect(GUIDE.includes(checker.name), `guide missing checker '${checker.name}'`).toBe(true);
    }
  });

  it("documents the checkPortConformance dispatcher entrypoint", () => {
    expect(GUIDE).toContain("checkPortConformance");
    expect(GUIDE).toContain("@ori3com/agent-core/conformance");
  });
});
