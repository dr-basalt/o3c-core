// C08 — kit de conformité des ports (réutilisable côté consommateurs).
// Prouve que le vérificateur comportemental exporté par @ori3com/agent-core/conformance
// (1) valide les adapters de référence du core (MemoryStorageLayer, FsStorageLayer), et
// (2) ÉCHOUE précisément sur un adapter cassé — sans jamais throw. C'est l'outil qu'un
// consommateur (o3c-chat object-store/S3, LanceDB…) enveloppe dans son propre runner pour
// prouver la non-régression de SON backend injecté contre le contrat du port.
import { describe, it, expect, afterEach } from "vitest";
import {
  checkStorageLayerConformance,
  checkCognitiveMemoryConformance,
  checkVectorMemoryConformance,
  checkGraphStoreConformance,
  checkWorkflowRuntimeConformance,
  checkBrainMemoryConformance,
} from "../src/conformance.mjs";
import {
  MemoryStorageLayer,
  FsStorageLayer,
  LocalCognitiveMemory,
  LocalVectorMemory,
  InMemoryGraphStore,
  InMemoryWorkflowRuntime,
  InMemoryBrainMemory,
} from "../src/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("checkStorageLayerConformance", () => {
  it("passes the pure-JS MemoryStorageLayer reference adapter", async () => {
    const report = await checkStorageLayerConformance(() => new MemoryStorageLayer());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(7);
  });

  it("passes the node FsStorageLayer reference adapter", async () => {
    const report = await checkStorageLayerConformance(() => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-"));
      tmpDirs.push(root);
      return new FsStorageLayer(root);
    });
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
  });

  it("reports precise failures for a broken adapter without throwing", async () => {
    // Adapter qui ment : get() renvoie toujours null (perd les écritures).
    const broken = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async list() {
        return [];
      },
    };
    const report = await checkStorageLayerConformance(() => broken);
    expect(report.ok).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    const roundtrip = report.checks.find((c) => c.name.includes("round-trips"));
    expect(roundtrip?.ok).toBe(false);
    expect(roundtrip?.error).toMatch(/mismatch/);
    // Le contrat de forme reste satisfait (les 4 méthodes existent).
    expect(report.checks.find((c) => c.name.includes("method surface"))?.ok).toBe(true);
  });

  it("flags a missing method (incomplete adapter) in the surface check", async () => {
    const partial = { async get() { return null; }, async put() {}, async list() { return []; } };
    const report = await checkStorageLayerConformance(() => /** @type {any} */ (partial));
    const surface = report.checks.find((c) => c.name.includes("method surface"));
    expect(surface?.ok).toBe(false);
    expect(surface?.error).toMatch(/delete/);
  });
});

describe("checkCognitiveMemoryConformance", () => {
  it("passes the pure-JS LocalCognitiveMemory reference adapter", async () => {
    const report = await checkCognitiveMemoryConformance(() => new LocalCognitiveMemory());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(8);
  });

  it("fails an adapter that ignores relevance (recency-only recall)", async () => {
    // Backend « stub » : mémorise mais recall renvoie tout avec un score fixe → ne classe
    // pas par pertinence, et le hit de tête n'est pas la mémoire attendue.
    function makeRecencyOnly() {
      const items = [];
      return {
        capabilities: { backend: "stub", persistent: false, semantic: false, native: false },
        async remember(i) {
          const it = { id: `s${items.length}`, text: i.text, kind: "fact", meta: {}, ts: items.length };
          items.push(it);
          return it;
        },
        async recall() {
          // Renvoie les items les PLUS RÉCENTS d'abord, score constant — ignore la query.
          return items.slice().reverse().map((item) => ({ item, score: 1 }));
        },
        async cognify() {
          return { items: items.length };
        },
        async count() {
          return items.length;
        },
        async clear() {
          items.length = 0;
        },
      };
    }
    const report = await checkCognitiveMemoryConformance(makeRecencyOnly);
    expect(report.ok).toBe(false);
    const relevance = report.checks.find((c) => c.name.includes("ranks the relevant"));
    expect(relevance?.ok).toBe(false);
    expect(relevance?.error).toMatch(/relevant memory|topK/i);
  });

  it("flags a broken remember() (no validation, wrong count) without throwing", async () => {
    const broken = {
      capabilities: { backend: "broken" },
      async remember() {
        return { id: "x", text: "ignored" };
      },
      async recall() {
        return [];
      },
      async cognify() {
        return { items: 0 };
      },
      async count() {
        return 0;
      }, // count ne bouge jamais
      async clear() {},
    };
    const report = await checkCognitiveMemoryConformance(() => broken);
    expect(report.ok).toBe(false);
    const remember = report.checks.find((c) => c.name.includes("count() reflects it"));
    expect(remember?.ok).toBe(false);
    const rejectEmpty = report.checks.find((c) => c.name.includes("rejects empty"));
    expect(rejectEmpty?.ok).toBe(false);
  });
});

describe("checkVectorMemoryConformance", () => {
  it("passes the pure-JS LocalVectorMemory reference adapter", async () => {
    const report = await checkVectorMemoryConformance(() => new LocalVectorMemory());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(7);
  });

  it("fails an adapter that leaks across namespaces and never deletes", async () => {
    // Backend « global » : ignore le ns (une seule partition) et delete no-op.
    function makeGlobal() {
      const docs = new Map();
      return {
        capabilities: { backend: "global-stub", persistent: false, semantic: true, native: false },
        async upsert(_ns, ds) {
          for (const d of ds) {
            if (!d?.id || !Array.isArray(d.vector) || d.vector.length === 0) {
              throw new Error("bad doc");
            }
            docs.set(d.id, d);
          }
        },
        async query(_ns, q) {
          // Ignore le ns → fuite entre namespaces ; classe quand même par cosinus.
          const out = [];
          for (const d of docs.values()) {
            let dot = 0, na = 0, nb = 0;
            for (let i = 0; i < q.vector.length; i++) {
              dot += q.vector[i] * d.vector[i]; na += q.vector[i] ** 2; nb += d.vector[i] ** 2;
            }
            const score = na && nb ? dot / Math.sqrt(na * nb) : 0;
            if (score > 0) out.push({ id: d.id, score, text: d.text });
          }
          return out.sort((a, b) => b.score - a.score).slice(0, q.topK ?? 5);
        },
        async delete() {}, // no-op → non conforme
      };
    }
    const report = await checkVectorMemoryConformance(makeGlobal);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("namespaces are isolated"))?.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("delete() removes"))?.ok).toBe(false);
    // La query/ranking de base reste conforme sur ce stub.
    expect(report.checks.find((c) => c.name.includes("ranks the nearest"))?.ok).toBe(true);
  });
});

describe("checkGraphStoreConformance", () => {
  it("passes the pure-JS InMemoryGraphStore reference adapter", async () => {
    const report = await checkGraphStoreConformance(() => new InMemoryGraphStore());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(7);
  });

  it("fails an adapter that ignores tenant scope and depth (leaks + unbounded BFS)", async () => {
    // Backend « plat » : un seul graphe global (ignore le scope) et voisins non bornés.
    function makeFlat() {
      const nodes = new Map();
      const edges = [];
      return {
        capabilities: { backend: "flat-stub", persistent: false, native: false },
        async upsert(ns, es) {
          for (const n of ns || []) {
            if (!n?.id) throw new Error("node needs id");
            nodes.set(n.id, n);
          }
          for (const e of es || []) {
            if (!e?.from || !e?.to) throw new Error("edge needs from/to");
            if (!nodes.has(e.from)) nodes.set(e.from, { id: e.from });
            if (!nodes.has(e.to)) nodes.set(e.to, { id: e.to });
            edges.push(e);
          }
        },
        async query(q) {
          // Ignore scope (fuite) ; pour {neighbors} renvoie TOUT (BFS non borné).
          if (q?.node !== undefined) {
            const inc = edges.filter((e) => e.from === q.node || e.to === q.node);
            const ids = new Set([q.node, ...inc.flatMap((e) => [e.from, e.to])]);
            return { nodes: [...ids].map((id) => nodes.get(id)).filter(Boolean), edges: inc };
          }
          return { nodes: [...nodes.values()], edges: [...edges] };
        },
      };
    }
    const report = await checkGraphStoreConformance(makeFlat);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("tenants are isolated"))?.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("BFS depth bound"))?.ok).toBe(false);
    // Le mode complet et la validation restent conformes.
    expect(report.checks.find((c) => c.name.includes("full mode"))?.ok).toBe(true);
    expect(report.checks.find((c) => c.name.includes("validates node ids"))?.ok).toBe(true);
  });
});

describe("checkWorkflowRuntimeConformance", () => {
  it("passes the pure-JS InMemoryWorkflowRuntime reference adapter", async () => {
    const report = await checkWorkflowRuntimeConformance(() => new InMemoryWorkflowRuntime());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(8);
  });

  it("fails an adapter that ignores tenant scope and never runs triggers", async () => {
    // Backend « global » : registre unique (ignore le scope → fuite) et trigger no-op.
    function makeGlobal() {
      const defs = new Map();
      return {
        async register(def) {
          defs.set(def.id, def);
          return def;
        },
        async read(id) {
          return defs.get(id) ?? null;
        },
        async update(id, patch) {
          const next = { ...defs.get(id), ...patch, id };
          defs.set(id, next);
          return next;
        },
        async delete(id) {
          defs.delete(id);
        },
        async search(q) {
          const text = q?.text?.toLowerCase();
          const tags = q?.tags ?? [];
          return [...defs.values()].filter((d) => {
            if (text && !`${d.name} ${d.description ?? ""}`.toLowerCase().includes(text)) return false;
            if (tags.length && !tags.every((t) => (d.tags ?? []).includes(t))) return false;
            return true;
          });
        },
        async trigger() {
          return [];
        }, // no-op → non conforme
        async getRun() {
          return null;
        },
      };
    }
    const report = await checkWorkflowRuntimeConformance(makeGlobal);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("trigger() runs matched"))?.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("tenants are isolated"))?.ok).toBe(false);
    // CRUD/search de base restent conformes sur ce stub.
    expect(report.checks.find((c) => c.name.includes("round-trips"))?.ok).toBe(true);
    expect(report.checks.find((c) => c.name.includes("filters by text"))?.ok).toBe(true);
  });
});

describe("checkBrainMemoryConformance", () => {
  it("passes the pure-JS InMemoryBrainMemory reference adapter", async () => {
    const report = await checkBrainMemoryConformance(() => new InMemoryBrainMemory());
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(7);
  });

  it("fails an adapter that ignores the salience threshold and tenant scope", async () => {
    // Backend « naïf » : accepte TOUT (ignore le seuil) et ignore le scope (fuite).
    function makeNaive() {
      const recs = new Map();
      let policy = { consolidationThreshold: 0, recallTopK: 8 };
      return {
        async getPolicy() {
          return { ...policy };
        },
        async setPolicy(patch) {
          policy = { ...policy, ...patch };
          return { ...policy };
        },
        async consolidate(records) {
          // Ignore le seuil → tout est accepté.
          const accepted = [];
          for (const r of records) {
            recs.set(r.id, r);
            accepted.push(r.id);
          }
          return { accepted, rejected: [] };
        },
        async recall(query) {
          // Ignore le scope (fuite) ; filtre texte/kinds/topK.
          const text = query?.text?.toLowerCase();
          const kinds = query?.kinds ? new Set(query.kinds) : undefined;
          let hits = [...recs.values()].filter((r) => {
            if (kinds && !kinds.has(r.kind)) return false;
            if (text && !String(r.content).toLowerCase().includes(text)) return false;
            return true;
          });
          return hits.slice(0, query?.topK ?? policy.recallTopK).map((r) => ({ id: r.id, content: r.content, kind: r.kind, salience: r.salience ?? 1, score: 1 }));
        },
        async forget(ids) {
          for (const id of ids) recs.delete(id);
        },
      };
    }
    const report = await checkBrainMemoryConformance(makeNaive);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("salience threshold"))?.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("tenants are isolated"))?.ok).toBe(false);
    // policy round-trip, recall filtre + forget restent conformes.
    expect(report.checks.find((c) => c.name.includes("setPolicy() merges"))?.ok).toBe(true);
    expect(report.checks.find((c) => c.name.includes("filters by kind"))?.ok).toBe(true);
  });
});
