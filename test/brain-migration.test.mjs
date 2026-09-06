// C08 — migration sans perte du cerveau existant (dé-dup o3c-code-cli côté données).
// La carte de convergence dit à o3c-code-cli de remplacer son adapter local bespoke
// (node:fs → ~/.o3c/brain/<id>.jsonl) par le core `LocalCognitiveMemory` + `FsStorageLayer`.
// Un swap qui perd les cerveaux DÉJÀ écrits sur disque serait une régression consommateur.
// Ce test écrit un fichier au FORMAT ON-DISK EXACT de l'impl bespoke P02 (une mémoire
// {id,text,kind,meta,ts} par ligne, lignes vides/corrompues/sans-texte tolérées) puis
// prouve que le core l'hydrate à l'identique : count, recall pertinent, recent() récent
// d'abord, ids préservés, et qu'un nouveau remember() reprend la séquence sans collision
// et ré-écrit un JSONL toujours lisible (round-trip).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalCognitiveMemory, FsStorageLayer } from "../src/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "o3c-brain-"));
});
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** Écrit un cerveau au format on-disk exact de o3c-code-cli/memory/adapters/local.mjs. */
function seedBespokeBrain(file, lines) {
  fs.writeFileSync(file, lines.join("\n"));
}

describe("brain migration — core reads an existing bespoke o3c-code-cli brain", () => {
  it("hydrates a bespoke JSONL brain without loss (count, recall, recent, ids)", async () => {
    const file = path.join(root, "myproj.jsonl");
    seedBespokeBrain(file, [
      JSON.stringify({ id: "mem_1_ab", text: "we deploy with helm on hetzner", kind: "decision", meta: { by: "cli" }, ts: 0 }),
      JSON.stringify({ id: "mem_2_ab", text: "vitest is the unit test runner", kind: "fact", meta: {}, ts: 1 }),
      "", // ligne vide tolérée
      "{ this is not json", // ligne corrompue tolérée (skip)
      JSON.stringify({ id: "mem_3_ab", text: "", kind: "fact" }), // parse OK mais sans texte → ignorée
      JSON.stringify({ id: "mem_4_ab", text: "the brain lives under ~/.o3c/brain", kind: "note", meta: {}, ts: 2 }),
    ]);

    const mem = new LocalCognitiveMemory({
      projectId: "myproj",
      storage: new FsStorageLayer(root),
      key: "myproj.jsonl",
    });
    await mem.hydrate();

    // 3 items valides (les lignes vide/corrompue/sans-texte sont écartées, comme l'impl bespoke).
    expect(await mem.count()).toBe(3);

    // Recall TF·IDF surface la mémoire pertinente, ids d'origine préservés.
    const hits = await mem.recall("how do we deploy to hetzner", 1);
    expect(hits[0].item.text).toContain("hetzner");
    expect(hits[0].item.id).toBe("mem_1_ab");
    expect(hits[0].item.kind).toBe("decision");
    expect(hits[0].item.meta).toEqual({ by: "cli" });

    // recent() = plus récent d'abord (par ts logique préservé).
    const recent = await mem.recent(3);
    expect(recent.map((i) => i.id)).toEqual(["mem_4_ab", "mem_2_ab", "mem_1_ab"]);
  });

  it("appends new memories past the hydrated corpus (no id collision) and round-trips", async () => {
    const file = path.join(root, "p.jsonl");
    seedBespokeBrain(file, [
      JSON.stringify({ id: "mem_1_x", text: "first retained memory", kind: "fact", meta: {}, ts: 0 }),
      JSON.stringify({ id: "mem_2_x", text: "second retained memory", kind: "fact", meta: {}, ts: 1 }),
    ]);

    const a = new LocalCognitiveMemory({ projectId: "p", storage: new FsStorageLayer(root), key: "p.jsonl" });
    await a.hydrate();
    const added = await a.remember({ text: "third memory added after migration" });
    expect(await a.count()).toBe(3);
    // L'id généré ne collisionne avec aucun id hydraté.
    const ids = new Set([...(await a.recent(10)).map((i) => i.id)]);
    expect(ids.size).toBe(3);
    expect(ids.has(added.id)).toBe(true);

    // Round-trip : une instance neuve relit le fichier ré-écrit par le core.
    const b = new LocalCognitiveMemory({ projectId: "p", storage: new FsStorageLayer(root), key: "p.jsonl" });
    await b.hydrate();
    expect(await b.count()).toBe(3);

    // Le fichier persisté reste un JSONL bespoke-compatible : 1 objet {text,...} par ligne.
    const persisted = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(persisted.length).toBe(3);
    for (const line of persisted) {
      const obj = JSON.parse(line);
      expect(typeof obj.text).toBe("string");
      expect(obj.text.trim().length).toBeGreaterThan(0);
    }
  });
});
