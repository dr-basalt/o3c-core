// @ori3com/agent-core — SessionCheckpoint (ADR-0001 C09, cf. ADR-o3c-portability-handoff).
// Réalise le « handoff par checkpoint » : l'état d'une session (.lbug + session) est
// SÉRIALISÉ sur l'IStorageLayer (C05) sous une clé ACCOUNT-KEYED déterministe. Comme la
// clé ne dépend QUE du scope (compte = tenantId) + `stateKey`, un broker sur N'IMPORTE
// quel placement (local / wasm / webvm / edge / cloud) lit le MÊME checkpoint → le
// handoff est transparent pour l'IHM (elle ne connaît ni le backend, ni le placement).
//
// Pur-TS, WASM-clean : TextEncoder/TextDecoder (globals web), aucun import `node:`.
// L'état est OPAQUE au core (arbitraire sérialisable-JSON) — le core ne fait que le
// persister/restaurer, jamais l'interpréter (doctrine §2 : pas de logique canal).

/**
 * @typedef {import("./ports.mjs").RuntimeScope} RuntimeScope
 * @typedef {import("./ports.mjs").IStorageLayer} IStorageLayer
 */

/** Version du format d'enveloppe (checkpoint-compat). */
export const CHECKPOINT_VERSION = 1;

/** Préfixe racine des checkpoints dans le storage. */
export const CHECKPOINT_PREFIX = "checkpoints";

/**
 * Contexte d'un checkpoint : scope d'isolation + pointeur d'état portable.
 * @typedef {Object} CheckpointContext
 * @property {RuntimeScope} scope
 * @property {string} [stateKey] pointeur d'état (défaut 'default') — id de session/.lbug
 */

/**
 * Enveloppe persistée : porte le scope (traçabilité/handoff) + l'état opaque.
 * @typedef {Object} CheckpointEnvelope
 * @property {number} v version de format
 * @property {RuntimeScope} scope
 * @property {string} stateKey
 * @property {unknown} state l'état opaque (.lbug + session), tel que fourni par l'IHM
 */

/**
 * Assainit un segment de chemin : garde alnum/-/_/., remplace le reste par '_'. Empêche
 * la traversée (pas de '/', pas de '..') et garde des clés portables entre backends.
 * @param {unknown} seg
 * @param {string} fallback
 * @returns {string}
 */
function safeSeg(seg, fallback) {
  const s = typeof seg === "string" ? seg : "";
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
  return cleaned.length ? cleaned : fallback;
}

/**
 * Dérive la clé de storage ACCOUNT-KEYED d'un checkpoint. Déterministe : même
 * (scope, stateKey) → même clé, sur tout placement → handoff transparent.
 * Forme : `checkpoints/<tenantId>/<projectId>/<userId>/<stateKey>.json`.
 * @param {RuntimeScope} scope
 * @param {string} [stateKey]
 * @returns {string}
 */
export function checkpointKey(scope, stateKey) {
  if (!scope || typeof scope.tenantId !== "string" || !scope.tenantId) {
    throw new Error("SessionCheckpoint: scope.tenantId (string) is required (account key)");
  }
  const tenant = safeSeg(scope.tenantId, "_tenant");
  const project = safeSeg(scope.projectId, "_");
  const user = safeSeg(scope.userId, "_");
  const key = safeSeg(stateKey, "default");
  return `${CHECKPOINT_PREFIX}/${tenant}/${project}/${user}/${key}.json`;
}

/**
 * Persiste un état de session sous forme de checkpoint account-keyed.
 * @param {IStorageLayer} storage
 * @param {CheckpointContext} ctx
 * @param {unknown} state état opaque (.lbug + session), doit être JSON-sérialisable
 * @returns {Promise<{ key: string, envelope: CheckpointEnvelope }>}
 */
export async function saveCheckpoint(storage, ctx, state) {
  if (!storage || typeof storage.put !== "function") {
    throw new Error("SessionCheckpoint.save: a valid IStorageLayer is required");
  }
  if (!ctx || !ctx.scope) {
    throw new Error("SessionCheckpoint.save: ctx.scope is required");
  }
  const stateKey = ctx.stateKey || "default";
  const key = checkpointKey(ctx.scope, stateKey);
  /** @type {CheckpointEnvelope} */
  const envelope = {
    v: CHECKPOINT_VERSION,
    scope: ctx.scope,
    stateKey,
    state,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await storage.put(key, bytes);
  return { key, envelope };
}

/**
 * Restaure un checkpoint (null si absent). Rejette une enveloppe de version inconnue
 * (dégradation explicite, jamais un état silencieusement mal interprété).
 * @param {IStorageLayer} storage
 * @param {CheckpointContext} ctx
 * @returns {Promise<CheckpointEnvelope | null>}
 */
export async function loadCheckpoint(storage, ctx) {
  if (!storage || typeof storage.get !== "function") {
    throw new Error("SessionCheckpoint.load: a valid IStorageLayer is required");
  }
  if (!ctx || !ctx.scope) {
    throw new Error("SessionCheckpoint.load: ctx.scope is required");
  }
  const key = checkpointKey(ctx.scope, ctx.stateKey || "default");
  const bytes = await storage.get(key);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  /** @type {CheckpointEnvelope} */
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error(`SessionCheckpoint.load: corrupt checkpoint at ${key}`);
  }
  if (!env || env.v !== CHECKPOINT_VERSION) {
    throw new Error(
      `SessionCheckpoint.load: unsupported checkpoint version ${env && env.v} at ${key}`
    );
  }
  return env;
}

/**
 * Supprime un checkpoint (idempotent — no-op si absent, selon le backend).
 * @param {IStorageLayer} storage
 * @param {CheckpointContext} ctx
 * @returns {Promise<void>}
 */
export async function deleteCheckpoint(storage, ctx) {
  if (!storage || typeof storage.delete !== "function") {
    throw new Error("SessionCheckpoint.delete: a valid IStorageLayer is required");
  }
  if (!ctx || !ctx.scope) {
    throw new Error("SessionCheckpoint.delete: ctx.scope is required");
  }
  const key = checkpointKey(ctx.scope, ctx.stateKey || "default");
  await storage.delete(key);
}

/**
 * Liste les `stateKey` de tous les checkpoints d'un compte (tenant). Utile pour reprendre
 * une session après handoff sans connaître son id a priori.
 * @param {IStorageLayer} storage
 * @param {RuntimeScope} scope
 * @returns {Promise<string[]>}
 */
export async function listCheckpoints(storage, scope) {
  if (!storage || typeof storage.list !== "function") {
    throw new Error("SessionCheckpoint.list: a valid IStorageLayer is required");
  }
  if (!scope || typeof scope.tenantId !== "string" || !scope.tenantId) {
    throw new Error("SessionCheckpoint.list: scope.tenantId (string) is required");
  }
  const prefix = `${CHECKPOINT_PREFIX}/${safeSeg(scope.tenantId, "_tenant")}/`;
  const keys = await storage.list(prefix);
  return keys
    .filter((k) => k.endsWith(".json"))
    .map((k) => {
      const base = k.slice(k.lastIndexOf("/") + 1);
      return base.slice(0, -".json".length);
    });
}
