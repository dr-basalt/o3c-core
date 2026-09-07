// C07 — garde anti-dérive de la SURFACE de publication npm (secret-free, complète le
// leakscan qui, lui, scanne le CONTENU). On résout le fileset EXACT que `npm publish`
// enverrait (`npm pack --dry-run --json`, résolution officielle de l'allowlist `files`)
// et on épingle deux invariants : (1) tout ce qui est REQUIS est là — package.json,
// README, LICENSE, et les cibles de CHAQUE subpath `exports` ; (2) RIEN d'autre que
// l'allowlist ne fuite — pas de test/, scripts/, dist/, docs/, .env, tsconfig, build.mjs.
// Si la surface publiée régresse (fichier de dev qui fuite, cible d'export droppée), la
// publication C07 casse ICI, avant de partir sur le registre — pas besoin de NPM_TOKEN.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));

/** Cibles concrètes de tous les subpaths `exports` (ce que les consommateurs importent). */
function exportTargets() {
  const out = [];
  for (const v of Object.values(pkg.exports)) {
    const rel = (typeof v === "string" ? v : v.default ?? v.import).replace(/^\.\//, "");
    out.push(rel);
  }
  return out;
}

/** Racines autorisées : entrées littérales de `files` + les métadonnées toujours publiées. */
const ALLOWED_ROOTS = [...pkg.files, "package.json"];

/** Un chemin publié est-il couvert par l'allowlist (fichier exact ou sous un répertoire) ? */
function underAllowlist(rel) {
  return ALLOWED_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

describe("C07 — npm publish fileset guard", () => {
  /** @type {string[]} */
  let published;

  beforeAll(() => {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    published = JSON.parse(raw)[0].files.map((/** @type {{path:string}} */ f) => f.path);
  }, 60_000);

  it("publishes a non-empty fileset", () => {
    expect(published.length).toBeGreaterThan(0);
  });

  it("includes the required metadata (package.json, README, LICENSE)", () => {
    for (const req of ["package.json", "README.md", "LICENSE"]) {
      expect(published, `publish surface is missing ${req}`).toContain(req);
    }
  });

  it("includes the concrete target of every `exports` subpath", () => {
    for (const target of exportTargets()) {
      expect(published, `publish surface is missing export target ${target}`).toContain(target);
    }
  });

  it("leaks nothing outside the `files` allowlist (no tests/scripts/dist/docs/dotfiles)", () => {
    const strays = published.filter((rel) => !underAllowlist(rel));
    expect(strays, `unexpected files in publish surface: ${strays.join(", ")}`).toEqual([]);
    // Ceinture + bretelles : aucun répertoire de dev connu, quelle que soit l'allowlist.
    const forbidden = published.filter((rel) =>
      /^(test|tests|scripts|dist|docs|node_modules|\.github)\//.test(rel) ||
      /^\.(env|git)/.test(rel) ||
      /^(tsconfig\.json|build\.mjs|vitest\.config)/.test(rel)
    );
    expect(forbidden, `dev artefacts leaked into publish: ${forbidden.join(", ")}`).toEqual([]);
  });
});
