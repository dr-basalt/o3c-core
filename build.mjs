// Build multi-cible de @ori3com/agent-core (ADR-0001 C01/C06).
// Deux chemins depuis la MÊME source pur-TS/JS : (1) node natif, (2) neutral
// "wasm-friendly" (aucun builtin node forcé) → pod k8s ⇄ worker ⇄ navigateur.
// Les deps (natives ou non) restent EXTERNES : le cœur ne bundle jamais
// cognee-rs/zvec/lancedb (optionalDependencies + dynamic-import, ADR §1/§4).
import esbuild from "esbuild";

const common = {
  entryPoints: ["src/index.mjs"],
  bundle: true,
  format: "esm",
  sourcemap: true,
  packages: "external",
  logLevel: "info",
};

const targets = [
  { name: "node", platform: "node", target: "node20", outfile: "dist/node/index.mjs" },
  // Cible WASM-friendly : platform "neutral" → aucun builtin node injecté, le
  // code doit rester pur ; les seams natifs sont derrière dynamic-import.
  { name: "wasm", platform: "neutral", target: "es2022", outfile: "dist/wasm/index.mjs" },
];

for (const t of targets) {
  await esbuild.build({ ...common, platform: t.platform, target: t.target, outfile: t.outfile });
  console.log(`✓ built ${t.name} → ${t.outfile}`);
}
