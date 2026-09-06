// C09 — conformité du RuntimeBroker (capstone boîte-noire + handoff par checkpoint).
// Prouve que le vérificateur comportemental exporté par @ori3com/agent-core/conformance
// (1) valide le broker de référence (LocalRuntimeBroker câblé cognitive+storage), (2)
// SAUTE gracieusement les vérifs checkpoint/restore quand le broker ne les expose pas, et
// (3) ÉCHOUE précisément sur un broker qui viole le contrat — sans jamais throw. C'est
// l'outil qu'un consommateur enveloppe pour prouver SON broker distribué (handoff réel
// wasm/edge/cloud) contre le contrat que l'IHM appelle en boîte-noire.
import { describe, it, expect } from "vitest";
import { checkRuntimeBrokerConformance } from "../src/conformance.mjs";
import { LocalRuntimeBroker } from "../src/runtime-broker.mjs";
import { LocalCognitiveMemory } from "../src/cognitive-memory.mjs";
import { MemoryStorageLayer } from "../src/storage.mjs";

/** Broker de référence câblé avec le jeu minimal (cognitive + storage). */
function makeRefBroker() {
  return new LocalRuntimeBroker({
    cognitive: new LocalCognitiveMemory(),
    storage: new MemoryStorageLayer(),
    placement: "local",
  });
}

describe("checkRuntimeBrokerConformance", () => {
  it("passes for the reference LocalRuntimeBroker (invoke + checkpoint handoff)", async () => {
    const report = await checkRuntimeBrokerConformance(makeRefBroker);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    // Les 8 vérifs (validation + routage + 3 de handoff) doivent avoir tourné.
    expect(report.passed).toBe(8);
  });

  it("skips checkpoint/restore checks gracefully when the broker omits them", async () => {
    // Broker minimal : seulement invoke (pas de handoff). Les vérifs optionnelles passent
    // en no-op — le contrat de base reste vérifié.
    const makeInvokeOnly = () => {
      const ref = makeRefBroker();
      return { invoke: (w, c) => ref.invoke(w, c) }; // pas de checkpoint/restore
    };
    const report = await checkRuntimeBrokerConformance(makeInvokeOnly);
    expect(report.ok).toBe(true);
  });

  it("fails precisely (never throws) on a broker that skips input validation", async () => {
    // Un broker cassé qui ne valide RIEN et renvoie une enveloppe malformée.
    const makeBad = () => ({
      invoke: async () => ({ nope: true }), // pas de placement/kind, accepte tout
    });
    const report = await checkRuntimeBrokerConformance(makeBad);
    expect(report.ok).toBe(false);
    const names = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(names).toContain("invoke() rejects a workload without a kind");
    expect(names).toContain("invoke() rejects an unknown workload kind");
    expect(names).toContain(
      "invoke() routes memory.* and returns a {placement, kind, output} envelope"
    );
  });

  it("fails when checkpoint isolation across tenants is violated", async () => {
    // Broker dont le checkpoint IGNORE le tenant (fuite cross-account).
    const makeLeaky = () => {
      const store = new Map();
      const ref = makeRefBroker();
      return {
        invoke: (w, c) => ref.invoke(w, c),
        checkpoint: async (c, state) => {
          store.set(c.stateKey, { state }); // clé sans tenant → fuite
          return { key: c.stateKey, envelope: { state } };
        },
        restore: async (c) => store.get(c.stateKey) ?? null,
      };
    };
    const report = await checkRuntimeBrokerConformance(makeLeaky);
    expect(report.ok).toBe(false);
    const names = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(names).toContain("checkpoints are isolated per account (tenant)");
  });
});
