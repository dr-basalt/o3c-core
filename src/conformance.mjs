// @ori3com/agent-core/conformance — kit de conformité des ports, RÉUTILISABLE par les
// consommateurs (ADR-0001 C08 : « IT de non-régression côté consommateurs »).
//
// La promesse « ports substituables » (ADR §1) n'a de valeur que si un consommateur peut
// PROUVER que SON backend injecté (S3 réel, object-store o3c-chat, LanceDB…) satisfait le
// contrat COMPORTEMENTAL du port — pas seulement sa forme (ça, c'est `assert*`). Ce module
// exporte des vérificateurs framework-agnostiques (aucune dépendance à vitest/jest) : le
// consommateur les enveloppe dans son propre runner. Chaque vérif est isolée, nettoie ses
// clés, et ne throw jamais — elle rapporte {name, ok, error?} pour un diagnostic précis.
//
// WASM-clean : aucun import node ; tout I/O passe par l'adapter fourni.

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * @typedef {import("./ports.mjs").IStorageLayer} IStorageLayer
 * @typedef {Object} ConformanceCheck
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [error]
 * @typedef {Object} ConformanceReport
 * @property {boolean} ok Toutes les vérifs passent.
 * @property {number} passed
 * @property {number} failed
 * @property {ConformanceCheck[]} checks
 */

/**
 * @param {Uint8Array | null} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function bytesEqual(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Vérifie qu'un IStorageLayer respecte le contrat COMPORTEMENTAL du port (au-delà de la
 * forme vérifiée par `assertStorageLayer`) : null sur clé absente, round-trip d'octets
 * exact, overwrite, delete effaçant + idempotent, et `list(prefix)` inclusif/exclusif.
 *
 * @param {() => (IStorageLayer | Promise<IStorageLayer>)} makeStorage Fabrique un adapter
 *   FRAIS et isolé (le kit écrit/efface sous `opts.prefix`). Peut être async (backend distant).
 * @param {object} [opts]
 * @param {string} [opts.prefix] Namespace des clés de test (défaut `__conformance__/`).
 * @returns {Promise<ConformanceReport>}
 */
export async function checkStorageLayerConformance(makeStorage, opts = {}) {
  const prefix = opts.prefix ?? "__conformance__/";
  /** @type {ConformanceCheck[]} */
  const checks = [];

  /**
   * @param {string} name
   * @param {(s: IStorageLayer) => Promise<void>} fn
   */
  const run = async (name, fn) => {
    let storage;
    try {
      storage = await makeStorage();
    } catch (err) {
      checks.push({ name, ok: false, error: `makeStorage threw: ${errMsg(err)}` });
      return;
    }
    try {
      await fn(storage);
      checks.push({ name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, error: errMsg(err) });
    }
  };

  await run("exposes the IStorageLayer method surface", async (s) => {
    for (const m of ["get", "put", "delete", "list"]) {
      if (typeof (/** @type {any} */ (s)[m]) !== "function") {
        throw new Error(`missing method: ${m}`);
      }
    }
  });

  await run("get() returns null for an absent key", async (s) => {
    const v = await s.get(`${prefix}absent`);
    if (v !== null) throw new Error(`expected null, got ${describe(v)}`);
  });

  await run("put() then get() round-trips the exact bytes", async (s) => {
    const key = `${prefix}roundtrip`;
    const data = enc.encode("canal-agnostic ✓ bytes");
    try {
      await s.put(key, data);
      const got = await s.get(key);
      if (!bytesEqual(got, data)) {
        throw new Error(`round-trip mismatch: got ${got ? dec.decode(got) : "null"}`);
      }
    } finally {
      await s.delete(key).catch(() => {});
    }
  });

  await run("put() overwrites an existing key with the latest value", async (s) => {
    const key = `${prefix}overwrite`;
    try {
      await s.put(key, enc.encode("v1"));
      await s.put(key, enc.encode("v2-final"));
      const got = await s.get(key);
      if (!got || dec.decode(got) !== "v2-final") {
        throw new Error(`expected 'v2-final', got ${got ? dec.decode(got) : "null"}`);
      }
    } finally {
      await s.delete(key).catch(() => {});
    }
  });

  await run("delete() removes the key (get() then null)", async (s) => {
    const key = `${prefix}deleteme`;
    await s.put(key, enc.encode("x"));
    await s.delete(key);
    const got = await s.get(key);
    if (got !== null) throw new Error(`expected null after delete, got ${describe(got)}`);
  });

  await run("delete() is idempotent on an absent key (no throw)", async (s) => {
    await s.delete(`${prefix}never-existed`);
  });

  await run("list(prefix) includes matching keys and excludes others", async (s) => {
    const inA = `${prefix}list/a`;
    const inB = `${prefix}list/b`;
    const out = `${prefix}other/c`;
    try {
      await s.put(inA, enc.encode("a"));
      await s.put(inB, enc.encode("b"));
      await s.put(out, enc.encode("c"));
      const keys = await s.list(`${prefix}list/`);
      if (!Array.isArray(keys)) throw new Error("list() did not return an array");
      const set = new Set(keys);
      if (!set.has(inA) || !set.has(inB)) {
        throw new Error(`list() missing matching keys: ${JSON.stringify(keys)}`);
      }
      if (set.has(out)) {
        throw new Error(`list() leaked a non-matching key: ${out}`);
      }
    } finally {
      await Promise.all([inA, inB, out].map((k) => s.delete(k).catch(() => {})));
    }
  });

  const failed = checks.filter((c) => !c.ok).length;
  return { ok: failed === 0, passed: checks.length - failed, failed, checks };
}

/**
 * @typedef {import("./ports.mjs").ICognitiveMemory} ICognitiveMemory
 */

/**
 * Vérifie qu'un ICognitiveMemory respecte le contrat COMPORTEMENTAL du port — le port sur
 * lequel les DEUX consommateurs C08 convergent (o3c-code-cli, chat2). Au-delà de la forme
 * (`assertCognitiveMemory`) : remember valide/persiste + incrémente count, rejette un texte
 * vide, recall("") = [], recall classe la mémoire PERTINENTE en tête (sémantique) avec un
 * score dans (0,1], respecte topK, cognify renvoie {items:number}, clear vide. Un backend
 * distant/async (cognee-rs) est normalisé par un `clear()` + `cognify()` avant recall.
 *
 * @param {() => (ICognitiveMemory | Promise<ICognitiveMemory>)} makeMemory Fabrique un adapter
 *   FRAIS et isolé (le kit écrit/efface ; passer un namespace/projectId dédié pour un backend partagé).
 * @param {object} [_opts] réservé (parité de signature avec les autres vérificateurs).
 * @returns {Promise<ConformanceReport>}
 */
export async function checkCognitiveMemoryConformance(makeMemory, _opts = {}) {
  /** @type {ConformanceCheck[]} */
  const checks = [];

  /**
   * @param {string} name
   * @param {(m: ICognitiveMemory) => Promise<void>} fn
   */
  const run = async (name, fn) => {
    let mem;
    try {
      mem = await makeMemory();
    } catch (err) {
      checks.push({ name, ok: false, error: `makeMemory threw: ${errMsg(err)}` });
      return;
    }
    try {
      if (typeof (/** @type {any} */ (mem)?.clear) === "function") await mem.clear();
      await fn(mem);
      checks.push({ name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, error: errMsg(err) });
    } finally {
      try {
        await (/** @type {any} */ (mem)?.clear?.());
      } catch {
        /* nettoyage best-effort */
      }
    }
  };

  await run("exposes the ICognitiveMemory surface + capabilities.backend", async (m) => {
    for (const method of ["remember", "recall", "cognify", "count", "clear"]) {
      if (typeof (/** @type {any} */ (m)[method]) !== "function") {
        throw new Error(`missing method: ${method}`);
      }
    }
    if (!m.capabilities || typeof m.capabilities.backend !== "string") {
      throw new Error("capabilities.backend must be a string");
    }
  });

  await run("remember() persists an item and count() reflects it", async (m) => {
    const before = await m.count();
    const item = await m.remember({ text: "the shared core is @ori3com/agent-core" });
    if (!item || typeof item.id !== "string" || !item.id) throw new Error("remember() must return an item with a string id");
    if (item.text !== "the shared core is @ori3com/agent-core") throw new Error("remember() must echo the stored text");
    const after = await m.count();
    if (after !== before + 1) throw new Error(`count() expected ${before + 1}, got ${after}`);
  });

  await run("remember() rejects empty text", async (m) => {
    let threw = false;
    try {
      await m.remember(/** @type {any} */ ({ text: "   " }));
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("remember() must reject empty/whitespace text");
  });

  await run("recall('') returns an empty array", async (m) => {
    const hits = await m.recall("");
    if (!Array.isArray(hits) || hits.length !== 0) throw new Error(`expected [], got ${JSON.stringify(hits)}`);
  });

  await run("recall() ranks the relevant memory first with a score in (0,1]", async (m) => {
    await m.remember({ text: "we deploy with kubernetes helm charts on hetzner" });
    await m.remember({ text: "lunch is usually served around noon each day" });
    await m.cognify();
    const hits = await m.recall("how do we deploy to kubernetes", 3);
    if (!Array.isArray(hits) || hits.length === 0) throw new Error("recall() returned no hits for a matching query");
    const top = hits[0];
    if (!top.item || typeof top.item.text !== "string") throw new Error("recall() hit must carry item.text");
    if (!top.item.text.toLowerCase().includes("kubernetes")) {
      throw new Error(`top hit not the relevant memory: ${top.item.text}`);
    }
    if (!(top.score > 0 && top.score <= 1)) throw new Error(`score out of (0,1]: ${top.score}`);
  });

  await run("recall() respects the topK limit", async (m) => {
    await m.remember({ text: "alpha config for the shared runtime" });
    await m.remember({ text: "beta config for the shared runtime" });
    await m.remember({ text: "gamma config for the shared runtime" });
    await m.cognify();
    const hits = await m.recall("shared runtime config", 1);
    if (hits.length > 1) throw new Error(`topK=1 but got ${hits.length} hits`);
  });

  await run("cognify() reports { items: number }", async (m) => {
    await m.remember({ text: "one consolidated memory" });
    const res = await m.cognify();
    if (!res || typeof res.items !== "number") throw new Error(`cognify() must return { items: number }, got ${JSON.stringify(res)}`);
  });

  await run("clear() empties the corpus", async (m) => {
    await m.remember({ text: "temporary memory to be cleared" });
    await m.clear();
    if ((await m.count()) !== 0) throw new Error("count() must be 0 after clear()");
  });

  const failed = checks.filter((c) => !c.ok).length;
  return { ok: failed === 0, passed: checks.length - failed, failed, checks };
}

/**
 * @typedef {import("./ports.mjs").IVectorMemory} IVectorMemory
 */

/**
 * Vérifie qu'un IVectorMemory respecte le contrat COMPORTEMENTAL du port (upsert/query/
 * delete, partitionné par namespace) : upsert valide les docs (id + vecteur non vide),
 * query classe le doc le PLUS PROCHE en tête (cosinus) avec un score dans (0,1] et respecte
 * topK, les namespaces sont ISOLÉS, une query sur un ns vide/inconnu = [], et delete retire
 * le doc des résultats. Chaque vérif utilise un namespace dédié (isolation même sur backend
 * partagé) et nettoie derrière elle. Cible les consommateurs injectant cozo/zvec/etc.
 *
 * @param {() => (IVectorMemory | Promise<IVectorMemory>)} makeVectorMemory Fabrique un adapter frais.
 * @param {object} [opts]
 * @param {string} [opts.namespace] Base des namespaces de test (défaut `__conformance__`).
 * @returns {Promise<ConformanceReport>}
 */
export async function checkVectorMemoryConformance(makeVectorMemory, opts = {}) {
  const base = opts.namespace ?? "__conformance__";
  /** @type {ConformanceCheck[]} */
  const checks = [];
  let seq = 0;

  /**
   * @param {string} name
   * @param {(m: IVectorMemory, ns: string) => Promise<void>} fn
   */
  const run = async (name, fn) => {
    const ns = `${base}/${seq++}`;
    let mem;
    try {
      mem = await makeVectorMemory();
    } catch (err) {
      checks.push({ name, ok: false, error: `makeVectorMemory threw: ${errMsg(err)}` });
      return;
    }
    try {
      await fn(mem, ns);
      checks.push({ name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, error: errMsg(err) });
    } finally {
      try {
        const anyMem = /** @type {any} */ (mem);
        if (typeof anyMem?.clear === "function") await anyMem.clear(ns);
      } catch {
        /* nettoyage best-effort */
      }
    }
  };

  await run("exposes the IVectorMemory method surface", async (m) => {
    for (const method of ["upsert", "query", "delete"]) {
      if (typeof (/** @type {any} */ (m)[method]) !== "function") {
        throw new Error(`missing method: ${method}`);
      }
    }
  });

  await run("upsert() rejects a doc without a vector", async (m, ns) => {
    let threw = false;
    try {
      await m.upsert(ns, [/** @type {any} */ ({ id: "novec", text: "no vector here" })]);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("upsert() must reject a doc missing its vector");
  });

  await run("query() ranks the nearest vector first with a score in (0,1]", async (m, ns) => {
    await m.upsert(ns, [
      { id: "near", text: "the near document", vector: [1, 0, 0] },
      { id: "far", text: "the far document", vector: [0, 1, 0] },
    ]);
    const hits = await m.query(ns, { vector: [1, 0, 0], topK: 3 });
    if (!Array.isArray(hits) || hits.length === 0) throw new Error("query() returned no hits");
    if (hits[0].id !== "near") throw new Error(`nearest doc not ranked first: got ${hits[0].id}`);
    if (!(hits[0].score > 0 && hits[0].score <= 1)) throw new Error(`score out of (0,1]: ${hits[0].score}`);
  });

  await run("query() respects the topK limit", async (m, ns) => {
    await m.upsert(ns, [
      { id: "a", text: "a", vector: [1, 0, 0] },
      { id: "b", text: "b", vector: [0.9, 0.1, 0] },
      { id: "c", text: "c", vector: [0.8, 0.2, 0] },
    ]);
    const hits = await m.query(ns, { vector: [1, 0, 0], topK: 1 });
    if (hits.length > 1) throw new Error(`topK=1 but got ${hits.length} hits`);
  });

  await run("query() returns [] for an empty/unknown namespace", async (m, ns) => {
    const hits = await m.query(`${ns}/never-written`, { vector: [1, 0, 0], topK: 5 });
    if (!Array.isArray(hits) || hits.length !== 0) throw new Error(`expected [], got ${JSON.stringify(hits)}`);
  });

  await run("namespaces are isolated (a doc in ns A is invisible from ns B)", async (m, ns) => {
    const nsA = `${ns}/A`;
    const nsB = `${ns}/B`;
    try {
      await m.upsert(nsA, [{ id: "only-in-a", text: "scoped", vector: [1, 0, 0] }]);
      const hits = await m.query(nsB, { vector: [1, 0, 0], topK: 5 });
      if (hits.some((h) => h.id === "only-in-a")) throw new Error("ns B leaked a doc from ns A");
    } finally {
      const anyM = /** @type {any} */ (m);
      if (typeof anyM?.clear === "function") {
        await anyM.clear(nsA).catch(() => {});
        await anyM.clear(nsB).catch(() => {});
      }
    }
  });

  await run("delete() removes a doc from subsequent query results", async (m, ns) => {
    await m.upsert(ns, [{ id: "gone", text: "to be deleted", vector: [1, 0, 0] }]);
    const before = await m.query(ns, { vector: [1, 0, 0], topK: 5 });
    if (!before.some((h) => h.id === "gone")) throw new Error("doc not present before delete");
    await m.delete(ns, ["gone"]);
    const after = await m.query(ns, { vector: [1, 0, 0], topK: 5 });
    if (after.some((h) => h.id === "gone")) throw new Error("delete() did not remove the doc");
  });

  const failed = checks.filter((c) => !c.ok).length;
  return { ok: failed === 0, passed: checks.length - failed, failed, checks };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function describe(v) {
  if (v === null) return "null";
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  return typeof v;
}
