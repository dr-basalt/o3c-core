// C09 — Preuve d'exécutabilité WASM RÉELLE (DoD : « import + remember/recall tourne
// DANS un runtime WASM », pas « ne casse pas »). On construit le bundle WASM-friendly
// puis on le charge dans QuickJS compilé en WebAssembly (quickjs-emscripten) et on y
// exécute le scénario : le port ICognitiveMemory ET le RuntimeBroker boîte-noire
// tournent réellement en WebAssembly, avec un recall TF·IDF correct.
import { describe, it, expect, beforeAll } from "vitest";
import { buildTarget, BUILD_TARGETS } from "../build.mjs";
import { runWasmSmoke } from "../scripts/wasm-smoke.mjs";

beforeAll(async () => {
  const wasm = BUILD_TARGETS.find((t) => t.name === "wasm");
  await buildTarget(wasm);
}, 60_000);

describe("C09 — core executes inside a real WASM runtime", () => {
  it("runs import + remember/recall via ICognitiveMemory inside QuickJS-WASM", async () => {
    const { ranInWasm, engine, result } = await runWasmSmoke();
    expect(ranInWasm).toBe(true);
    expect(engine).toBe("quickjs-wasm");
    expect(result.backend).toBe("local");
    expect(result.directTop).toBe("blue-green deploy rollout strategy");
  }, 60_000);

  it("runs the RuntimeBroker black box (invoke) inside the WASM runtime", async () => {
    const { result } = await runWasmSmoke();
    expect(result.brokerPlacement).toBe("local");
    expect(result.brokerTop).toMatch(/webassembly/);
  }, 60_000);

  it("performs a checkpoint handoff across placements inside WASM (pure-JS UTF-8, no TextEncoder)", async () => {
    const { result } = await runWasmSmoke();
    // État écrit par un broker 'wasm', restauré par un broker 'edge' via le même
    // storage account-keyed — multi-octets/emoji préservés par le codec pur-JS.
    expect(result.checkpointDraft).toBe("résumé ✅ élève");
    expect(result.checkpointPc).toBe(7);
  }, 60_000);
});
