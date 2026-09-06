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
