// C08 — IT de consommation empaquetée (le contrat « npm i @ori3com/agent-core »).
// Les parity ITs épinglent les CONTRATS que les consommateurs attendent ; ce test
// prouve l'étape d'AVANT côté consommateur : qu'un `npm i @ori3com/agent-core` réel
// obtient un artefact FONCTIONNEL. On empaquette le vrai tarball (`npm pack` → exact
// fileset de `files`), on l'installe dans un consommateur jetable, et on l'importe
// PAR SON NOM DE PACKAGE via les deux sous-chemins du champ `exports` (`.` et `./ports`),
// puis on exerce le core (mémoire cognitive + ContextBuilder + S3PathBuilder) dans un
// process node séparé. Si la map `exports`/l'allowlist `files` régresse, ce test casse
// AVANT que les consommateurs (o3c-code-cli, chat2) ne le découvrent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Consumer script exercising the package strictly through its public `exports` map. */
const CONSUMER = `
import { VERSION, LocalCognitiveMemory, ContextBuilder, S3PathBuilder, MemoryStorageLayer } from "@ori3com/agent-core";
import { PORT_NAMES } from "@ori3com/agent-core/ports";
import { checkStorageLayerConformance } from "@ori3com/agent-core/conformance";

const mem = new LocalCognitiveMemory();
await mem.remember({ text: "the core is consumed identically by every channel" });
await mem.remember({ text: "unrelated note about lunch" });
const hits = await mem.recall("how is the core consumed", 1);

const env = new ContextBuilder().build(
  { persona: null, systemPrompt: "SYS" },
  { tenantId: "t", userId: "u", projectId: "p", agentId: "a", threadId: "th" }
);
const key = new S3PathBuilder({
  tenantId: "t", userId: "u", projectId: "p", agentId: "a", threadId: "th",
}).message(3);

const conformance = await checkStorageLayerConformance(() => new MemoryStorageLayer());

process.stdout.write(JSON.stringify({
  version: VERSION,
  portCount: PORT_NAMES.length,
  topHit: hits[0]?.item.text ?? null,
  systemPrompt: env.systemPrompt,
  messageKey: key,
  conformanceOk: conformance.ok,
}));
`;

let tmp;
let consumerOut;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-pack-"));
  // 1. Pack the REAL publish tarball (honours package.json `files`).
  const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  const tarball = path.join(tmp, JSON.parse(packed)[0].filename);

  // 2. Install it into a throwaway consumer's node_modules, like a downstream `npm i`.
  const dest = path.join(tmp, "consumer", "node_modules", "@ori3com", "agent-core");
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);

  // 3. Run a consumer that imports the package by name via its `exports` subpaths.
  const consumerFile = path.join(tmp, "consumer", "use.mjs");
  fs.writeFileSync(consumerFile, CONSUMER);
  const raw = execFileSync("node", [consumerFile], {
    cwd: path.join(tmp, "consumer"),
    encoding: "utf-8",
  });
  consumerOut = JSON.parse(raw);
}, 60_000);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("packaged consumption — npm i @ori3com/agent-core", () => {
  it("resolves the '.' export and runs the cognitive memory + context core", () => {
    expect(consumerOut.version).toBe("0.0.0");
    // TF·IDF recall surfaces the relevant memory, not the unrelated one.
    expect(consumerOut.topHit).toContain("consumed identically");
    expect(consumerOut.systemPrompt).toBe("## Instructions\nSYS");
    expect(consumerOut.messageKey).toBe(
      "tenants/t/projects/p/threads/th/messages/000003.json"
    );
  });

  it("resolves the './ports' export (all 8 substitutable ports present)", () => {
    expect(consumerOut.portCount).toBe(8);
  });

  it("resolves the './conformance' export (consumer port-conformance kit)", () => {
    expect(consumerOut.conformanceOk).toBe(true);
  });

  it("ships src/ in the `files` allowlist so the exports targets actually exist", () => {
    // The tarball only contains what `files` allows; if src/index.mjs or src/ports.mjs
    // were dropped, the consumer import above would have thrown in beforeAll.
    const files = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")
    ).files;
    expect(files).toContain("src");
  });
});
