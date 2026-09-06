// C07 — Leakscan pré-publication : refuse-vite si un secret fuiterait dans le tarball
// npm. Scanne EXACTEMENT le fileset que `npm publish` enverrait (résolu via
// `npm pack --dry-run --json`, donc immunisé aux dérives de l'allowlist `files`), et
// cherche des SECRETS À FORTE CERTITUDE — préfixes connus (clés OpenAI/npm/AWS/GitHub/
// Slack, blocs PEM) et URLs à credentials inline. Volontairement PAS de heuristique
// "secret"/"token" (les identifiants/noms d'env légitimes du code — secretAccessKey,
// S3_SECRET_ACCESS_KEY, signingKey — ne sont PAS des valeurs) → zéro faux positif.
// Sort non-zéro au moindre hit → hard-gate publish. Aucune dépendance runtime.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Motifs de secrets à forte certitude (valeurs, pas noms). */
export const PATTERNS = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "URL with inline credentials", re: /:\/\/[^/\s:@"'`]+:[^/\s:@"'`]+@/ },
];

/**
 * Scanne un texte et renvoie les hits {name, line} des motifs de secret rencontrés.
 * Cœur pur (testable) partagé par le CLI.
 * @param {string} text
 * @returns {{ name: string, line: number }[]}
 */
export function scanText(text) {
  /** @type {{ name: string, line: number }[]} */
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (re.test(lines[i])) found.push({ name, line: i + 1 });
    }
  }
  return found;
}

/**
 * Liste les fichiers que `npm publish` publierait (résolution officielle de l'allowlist).
 * @returns {string[]}
 */
function publishedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = entry?.files ?? [];
  return files.map((/** @type {{ path: string }} */ f) => f.path);
}

/** Scanne le fileset publié et sort non-zéro au moindre hit (hard-gate CLI). */
async function main() {
  let hits = 0;
  const files = publishedFiles();
  if (files.length === 0) {
    console.error("✗ leakscan: npm pack reported zero files (unexpected)");
    process.exit(1);
  }
  for (const rel of files) {
    let text;
    try {
      text = await readFile(resolve(root, rel), "utf8");
    } catch {
      continue; // binaire/illisible : rien à scanner en texte
    }
    for (const { name, line } of scanText(text)) {
      hits++;
      console.error(`✗ leakscan: ${name} in ${rel}:${line}`);
    }
  }
  if (hits > 0) {
    console.error(`leakscan: FAILED — ${hits} potential secret(s) in the publish set`);
    process.exit(1);
  }
  console.log(`leakscan: clean ✓ (${files.length} published files scanned)`);
}

// Exécution CLI directe uniquement (importer ce module pour tester ne scanne pas).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
