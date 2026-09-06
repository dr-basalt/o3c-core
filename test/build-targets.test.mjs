// C06 — Build targets verts + contract-tests sur les DEUX chemins. On construit
// réellement les 2 bundles (node natif + WASM-friendly neutral) depuis la MÊME
// source, puis on exécute le MÊME contrat de ports pur-JS (WASM-clean) sur CHAQUE
// artefact bâti. Prouve que le cœur tourne à l'identique sur les 2 cibles et que la
// cible WASM ne tire aucun builtin node statiquement (seams natifs en dynamic-import).
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BUILD_TARGETS, buildAll } from "../build.mjs";

const root = resolve(import.meta.dirname, "..");

beforeAll(async () => {
  await buildAll();
}, 60_000);

/** @type {import("../src/ports.mjs").RuntimeScope} */
const scope = { tenantId: "t1", userId: "u1", projectId: "p1" };

for (const t of BUILD_TARGETS) {
  describe(`built ${t.name} bundle (${t.outfile})`, () => {
    /** @type {any} */
    let mod;
    beforeAll(async () => {
      mod = await import(resolve(root, t.outfile));
    });

    it("exposes VERSION and the 8 canonical ports", () => {
      expect(typeof mod.VERSION).toBe("string");
      expect(mod.PORT_NAMES).toHaveLength(8);
    });

    it("runs the ICognitiveMemory contract (pure-JS fallback)", async () => {
      const { memory, backend } = await mod.createCognitiveMemory({ prefer: "local" });
      expect(backend).toBe("local");
      await memory.remember({ text: "the deploy uses blue-green rollout" });
      await memory.remember({ text: "unrelated note about cats" });
      const hits = await memory.recall("deploy rollout", 1);
      expect(hits[0].item.text).toMatch(/blue-green/);
    });

    it("runs the IVectorMemory contract (dense cosine)", async () => {
      const { memory } = await mod.createVectorMemory({ prefer: "local" });
      await memory.upsert("p", [
        { id: "a", text: "north", vector: [1, 0, 0] },
        { id: "b", text: "east", vector: [0, 1, 0] },
      ]);
      const hits = await memory.query("p", { vector: [1, 0, 0], topK: 1 });
      expect(hits[0].id).toBe("a");
    });

    it("runs the IStorageLayer contract (in-memory)", async () => {
      const { storage } = await mod.createStorageLayer({ prefer: "memory" });
      await storage.put("k", "value");
      const got = await storage.get("k");
      expect(new TextDecoder().decode(got)).toBe("value");
    });

    it("runs the IGraphStore contract (BFS traversal)", async () => {
      const g = mod.createGraphStore();
      await g.upsert([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b", type: "link" }], scope);
      const res = await g.query({ neighbors: "a", depth: 1 }, scope);
      expect(res.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    });

    it("runs the IBrainMemory contract (consolidate + recall)", async () => {
      const b = mod.createBrainMemory();
      await b.consolidate([{ id: "m", content: "prefers dark mode", kind: "preference" }], scope);
      const hits = await b.recall({ text: "dark" }, scope);
      expect(hits[0].id).toBe("m");
    });

    it("runs the IWorkflowRuntime contract (trigger + chain)", async () => {
      const rt = mod.createWorkflowRuntime();
      await rt.register(
        {
          id: "w",
          name: "w",
          trigger: { type: "event", event: "go" },
          steps: [{ id: "s1", kind: "tool", ref: "one" }],
        },
        scope,
      );
      const [run] = await rt.trigger("go", { seed: 1 }, scope);
      expect(run.status).toBe("completed");
    });

    it("runs the IToolResolver contract (compose + degrade)", async () => {
      const r = mod.createToolResolver([new mod.StaticToolResolver({ alpha: 1 })]);
      expect(await r.resolveTools(scope)).toEqual({ alpha: 1 });
      expect(await mod.createToolResolver().resolveTools(scope)).toEqual({});
    });
  });
}

describe("WASM-friendly bundle stays node-builtin-clean", () => {
  it("has no STATIC `node:` imports (natives only via dynamic import())", async () => {
    const wasm = BUILD_TARGETS.find((t) => t.name === "wasm");
    const code = await readFile(resolve(root, wasm.outfile), "utf8");
    // Static imports would couple the bundle to a node runtime; dynamic `import("node:…")`
    // (fs/path in FsStorageLayer) is allowed — it only resolves when that seam is used.
    const staticNodeImport = /(?:^|[^(])\bfrom\s*["']node:/m;
    expect(staticNodeImport.test(code)).toBe(false);
    // Sanity: the dynamic seam IS present (so we're actually testing the real bundle).
    expect(code).toContain('import("node:fs/promises")');
  });
});
