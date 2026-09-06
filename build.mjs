// Build multi-cible de @ori3com/agent-core (ADR-0001 C01/C06).
// Deux chemins depuis la MÊME source pur-TS/JS : (1) node natif, (2) neutral
// "wasm-friendly" (aucun builtin node forcé) → pod k8s ⇄ worker ⇄ navigateur.
// Les deps (natives ou non) restent EXTERNES : le cœur ne bundle jamais
// cognee-rs/zvec/lancedb (optionalDependencies + dynamic-import, ADR §1/§4).
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const common = {
  entryPoints: ["src/index.mjs"],
  bundle: true,
  format: "esm",
  sourcemap: true,
  packages: "external",
  logLevel: "info",
};

/**
 * Cibles de build. La cible WASM-friendly utilise platform "neutral" → aucun builtin
 * node injecté ; le code doit rester pur, les seams natifs derrière dynamic-import.
 * @type {ReadonlyArray<{ name: string, platform: 'node'|'neutral', target: string, outfile: string }>}
 */
export const BUILD_TARGETS = Object.freeze([
  { name: "node", platform: "node", target: "node20", outfile: "dist/node/index.mjs" },
  { name: "wasm", platform: "neutral", target: "es2022", outfile: "dist/wasm/index.mjs" },
]);

/**
 * Construit une cible et renvoie son outfile.
 * @param {(typeof BUILD_TARGETS)[number]} t
 * @returns {Promise<string>}
 */
export async function buildTarget(t) {
  await esbuild.build({ ...common, platform: t.platform, target: t.target, outfile: t.outfile });
  return t.outfile;
}

/** Construit toutes les cibles (utilisé par la CLI et les contract-tests C06). */
export async function buildAll() {
  for (const t of BUILD_TARGETS) {
    await buildTarget(t);
    console.log(`✓ built ${t.name} → ${t.outfile}`);
  }
}

// Exécution CLI directe uniquement (importer ce module ne déclenche pas de build).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildAll();
}
