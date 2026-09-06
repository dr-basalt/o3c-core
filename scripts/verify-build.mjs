// C06 — Gate de build : "build targets verts" prouvé, pas seulement "esbuild n'a pas
// planté". Construit les 2 cibles (node + WASM-friendly) puis VÉRIFIE chaque artefact :
// fichier non vide, importable, expose VERSION + les 8 ports ; et la cible WASM ne tire
// aucun builtin node statiquement (seams natifs en dynamic-import). Sort non-zéro au
// moindre défaut → hard-gate CI. Aucune dépendance runtime (node builtins only).
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_TARGETS, buildAll } from "../build.mjs";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

/** @param {string} msg */
function fail(msg) {
  console.error(`✗ verify-build: ${msg}`);
  process.exitCode = 1;
}

await buildAll();

for (const t of BUILD_TARGETS) {
  const abs = resolve(root, t.outfile);
  let size = 0;
  try {
    size = (await stat(abs)).size;
  } catch {
    fail(`${t.name}: artifact missing at ${t.outfile}`);
    continue;
  }
  if (size <= 0) {
    fail(`${t.name}: artifact is empty (${t.outfile})`);
    continue;
  }

  /** @type {any} */
  let mod;
  try {
    mod = await import(abs);
  } catch (err) {
    fail(`${t.name}: bundle failed to import — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (typeof mod.VERSION !== "string") fail(`${t.name}: missing VERSION export`);
  if (!Array.isArray(mod.PORT_NAMES) || mod.PORT_NAMES.length !== 8) {
    fail(`${t.name}: expected 8 canonical ports, got ${mod.PORT_NAMES?.length}`);
  }

  if (t.name === "wasm") {
    const code = await readFile(abs, "utf8");
    // Un import statique `from "node:…"` coupterait le bundle à un runtime node ;
    // seul le dynamic `import("node:…")` (fs/path du seam FsStorageLayer) est toléré.
    if (/(?:^|[^(])\bfrom\s*["']node:/m.test(code)) {
      fail("wasm: bundle contains a STATIC node: import (must be dynamic-only)");
    }
    if (!code.includes('import("node:fs/promises")')) {
      fail("wasm: expected the dynamic node:fs seam to be present (bundle sanity)");
    }
  }

  if (!process.exitCode) console.log(`✓ verified ${t.name} → ${t.outfile} (${size} bytes)`);
}

if (process.exitCode) {
  console.error("verify-build: FAILED");
} else {
  console.log("verify-build: both build targets green ✓");
}
