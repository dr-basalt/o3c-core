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
import { createCognitiveMemory, runtimeBrokerFromEnv, LocalRuntimeBroker, MemoryStorageLayer, LiteLLMChat, VERSION } from 'agent-core';
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

    // 3) Handoff par checkpoint DANS le runtime WASM (codec UTF-8 pur-JS, sans
    // TextEncoder/TextDecoder absents de QuickJS). Un broker écrit l'état sur un
    // storage account-keyed, un AUTRE broker (placement distinct, MÊME storage) le
    // restaure — le handoff traverse la frontière runtime, opaque à l'appelant.
    const storage = new MemoryStorageLayer();
    const cpCtx = { scope: { tenantId: 'acct', projectId: 'wasm-smoke' }, stateKey: 'conv-1' };
    const writer = new LocalRuntimeBroker({ storage, placement: 'wasm' });
    const cp = await writer.checkpoint(cpCtx, { lbug: { pc: 7 }, draft: 'résumé ✅ élève' });
    const reader = new LocalRuntimeBroker({ storage, placement: 'edge' });
    const restored = await reader.restore(cpCtx);

    // 4) Portabilité CROSS-RUNTIME : exporte les octets bruts du checkpoint (écrits DANS
    // WASM) + sa clé account-keyed, pour que le harnais NATIF (Node) les restaure hors WASM.
    // Prouve que le format de checkpoint franchit la frontière WASM↔natif, pas seulement
    // deux brokers partageant une mémoire à l'intérieur du même runtime.
    const cpBytes = await storage.get(cp.key);

    // 5) Seam LLM VIA FETCH dans le runtime WASM (clause C09 « LLM via fetch
    // api.ori3com.cloud »). Un fetchImpl injecté (openai-compatible) évite le réseau ;
    // on prouve que le client POSTe bien sur baseURL + /chat/completions et décode la
    // réponse — le MÊME code frapperait api.ori3com.cloud sur un vrai runtime WASM.
    let llmUrl = null;
    const fetchStub = async (url) => {
      llmUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'o3c-equilibre',
          choices: [{ message: { content: 'pong from wasm' }, finish_reason: 'stop' }],
          usage: { total_tokens: 3 },
        }),
      };
    };
    const llm = new LiteLLMChat({ baseURL: 'https://api.ori3com.cloud/v1', apiKey: 'k', model: 'o3c-equilibre', fetchImpl: fetchStub });
    const llmBroker = new LocalRuntimeBroker({ llm, placement: 'wasm' });
    const chat = await llmBroker.invoke({ kind: 'llm.chat', request: { messages: [{ role: 'user', content: 'ping' }] } }, ctx);

    globalThis.__result = JSON.stringify({
      version: VERSION,
      backend,
      directTop: direct[0] && direct[0].item.text,
      brokerPlacement: via.placement,
      brokerTop: via.output[0] && via.output[0].item.text,
      checkpointDraft: restored && restored.state && restored.state.draft,
      checkpointPc: restored && restored.state && restored.state.lbug && restored.state.lbug.pc,
      checkpointKey: cp.key,
      checkpointBytes: Array.from(cpBytes),
      llmText: chat.output && chat.output.text,
      llmProvider: chat.output && chat.output.provider,
      llmUrl,
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
    // Le handoff par checkpoint (avec codec UTF-8 pur-JS) a franchi la frontière WASM
    // sans perte, y compris sur des caractères multi-octets / emoji.
    if (result.checkpointDraft !== "résumé ✅ élève" || result.checkpointPc !== 7) {
      throw new Error(`unexpected checkpoint restore: ${JSON.stringify(result)}`);
    }
    // Les octets bruts du checkpoint (écrits DANS WASM) sont exportés → restaurables en natif.
    if (!result.checkpointKey || !Array.isArray(result.checkpointBytes) || !result.checkpointBytes.length) {
      throw new Error("WASM smoke: checkpoint bytes not exported for cross-runtime handoff");
    }
    // Le seam LLM (fetch openai-compatible) a tourné DANS WASM et a POSTé sur api.ori3com.cloud.
    if (result.llmText !== "pong from wasm" || result.llmUrl !== "https://api.ori3com.cloud/v1/chat/completions") {
      throw new Error(`WASM smoke: LLM seam did not run via fetch — ${JSON.stringify(result)}`);
    }
    console.log(`wasm-smoke: import + remember/recall + checkpoint handoff ran in ${engine} ✓`);
    console.log(`  version=${result.version} backend=${result.backend} placement=${result.brokerPlacement}`);
    console.log(`  direct="${result.directTop}"`);
    console.log(`  broker="${result.brokerTop}"`);
    console.log(`  checkpoint(restored across WASM)="${result.checkpointDraft}" pc=${result.checkpointPc}`);
  } catch (err) {
    console.error(`wasm-smoke: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
