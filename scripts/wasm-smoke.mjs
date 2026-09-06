// C09 — Smoke WASM EXÉCUTABLE (au-delà du « wasm-friendly » de C06). Charge le bundle
// WASM-friendly (dist/wasm/index.mjs) DANS un vrai runtime WASM — QuickJS compilé en
// WebAssembly (quickjs-emscripten), exécuté in-process, aucune infra externe — et y
// fait tourner un scénario réel « import + remember/recall », d'abord via
// createCognitiveMemory puis via le RuntimeBroker boîte-noire (invoke(workload, ctx)).
// Prouve que le cœur (ports + broker) s'exécute réellement en WebAssembly, pas juste
// « ne casse pas ». Un runtime WASM plus complet (navigateur/WebVM/Worker) exécutera
// le MÊME bundle ; QuickJS est le harnais WASM minimal, portable et déterministe.
import { newQuickJSAsyncWASMModule } from "quickjs-emscripten";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

// Scénario exécuté À L'INTÉRIEUR du runtime WASM. Écrit son verdict JSON dans
// globalThis.__result (ou l'erreur dans __err). N'utilise que des builtins ECMAScript
// (le chemin local des ports est pur : ni node:, ni fetch, ni TextEncoder requis).
const SCENARIO = `
import { createCognitiveMemory, runtimeBrokerFromEnv, VERSION } from 'agent-core';
globalThis.__result = null; globalThis.__err = null;
(async () => {
  try {
    // 1) Port ICognitiveMemory directement dans le runtime WASM.
    const { memory, backend } = await createCognitiveMemory({ prefer: 'local' });
    await memory.remember({ text: 'blue-green deploy rollout strategy' });
    await memory.remember({ text: 'cats are pleasant animals' });
    const direct = await memory.recall('deploy rollout', 1);

    // 2) RuntimeBroker boîte-noire (capstone C09) dans le MÊME runtime WASM.
    const { broker } = await runtimeBrokerFromEnv({ env: {}, projectId: 'wasm-smoke' });
    const ctx = { scope: { tenantId: 't', userId: 'u', projectId: 'wasm-smoke' } };
    await broker.invoke({ kind: 'memory.remember', item: { text: 'the broker runs inside webassembly' } }, ctx);
    await broker.invoke({ kind: 'memory.remember', item: { text: 'noise about the weather' } }, ctx);
    const via = await broker.invoke({ kind: 'memory.recall', query: 'broker webassembly', k: 1 }, ctx);

    globalThis.__result = JSON.stringify({
      version: VERSION,
      backend,
      directTop: direct[0] && direct[0].item.text,
      brokerPlacement: via.placement,
      brokerTop: via.output[0] && via.output[0].item.text,
    });
  } catch (e) { globalThis.__err = String((e && e.message) || e); }
})();
`;

/**
 * Exécute le smoke dans un runtime WASM et renvoie le verdict.
 * @param {object} [opts]
 * @param {string} [opts.bundlePath] chemin du bundle WASM-friendly (défaut dist/wasm/index.mjs)
 * @returns {Promise<{ ranInWasm: true, engine: string, result: any }>}
 */
export async function runWasmSmoke(opts = {}) {
  const bundlePath = opts.bundlePath || resolve(root, "dist/wasm/index.mjs");
  const bundle = await readFile(bundlePath, "utf8");

  const QuickJS = await newQuickJSAsyncWASMModule();
  const runtime = QuickJS.newRuntime();
  runtime.setModuleLoader((name) =>
    name === "agent-core" ? bundle : { error: new Error(`WASM smoke: unknown module ${name}`) },
  );
  const ctx = runtime.newContext();
  try {
    const evalRes = await ctx.evalCodeAsync(SCENARIO, "wasm-smoke.mjs", { type: "module" });
    if (evalRes.error) {
      const e = ctx.dump(evalRes.error);
      evalRes.error.dispose();
      throw new Error(`WASM smoke: module eval failed — ${JSON.stringify(e)}`);
    }
    evalRes.value.dispose();

    // Draine les jobs (microtasks) du runtime WASM jusqu'à quiescence.
    let guard = 0;
    while (runtime.hasPendingJob() && guard++ < 100000) runtime.executePendingJobs();

    const errH = ctx.getProp(ctx.global, "__err");
    const err = ctx.dump(errH);
    errH.dispose();
    if (err) throw new Error(`WASM smoke: scenario threw inside WASM — ${err}`);

    const resH = ctx.getProp(ctx.global, "__result");
    const raw = ctx.dump(resH);
    resH.dispose();
    if (!raw) throw new Error("WASM smoke: scenario produced no result (never settled)");
    return { ranInWasm: true, engine: "quickjs-wasm", result: JSON.parse(raw) };
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

// Exécution CLI directe : build implicite non fait ici (lancer `npm run build` avant,
// ou via prépa CI). Sort non-zéro si le scénario échoue dans le runtime WASM.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { engine, result } = await runWasmSmoke();
    if (result.directTop !== "blue-green deploy rollout strategy") {
      throw new Error(`unexpected direct recall: ${result.directTop}`);
    }
    if (!/webassembly/.test(result.brokerTop || "")) {
      throw new Error(`unexpected broker recall: ${result.brokerTop}`);
    }
    console.log(`wasm-smoke: import + remember/recall ran in ${engine} ✓`);
    console.log(`  version=${result.version} backend=${result.backend} placement=${result.brokerPlacement}`);
    console.log(`  direct="${result.directTop}"`);
    console.log(`  broker="${result.brokerTop}"`);
  } catch (err) {
    console.error(`wasm-smoke: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
