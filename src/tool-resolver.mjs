// @ori3com/agent-core — IToolResolver seam (ADR-0001 C05).
// Le port `IToolResolver` (ADR §3, COMBINABLE) résout un RuntimeScope en tools
// natifs pour CE user. Extrait/refactoré depuis o3c-chat/packages/agent-runtime
// (tool-resolver.ts) et DÉCOUPLÉ de tout o3c-chat-specific : ici les tools sont
// OPAQUES (`unknown`) — le cœur ne connaît ni Mastra (`createTool`), ni Nango, ni
// zod, ni la DB. Les backends concrets (Nango/open-connector/obot-mcp) sont des
// impls substituables INJECTÉES par le consommateur ; le cœur ne fournit que :
//   • StaticToolResolver — résout un Record de tools fixe (optionnellement filtré
//     par scope) ; base testable + injection triviale.
//   • CombinedToolResolver — compose N résolveurs (first-registered wins) et ISOLE
//     les échecs (un backend HS ne prive pas des autres — ADR §4 inv.).
//   • createToolResolver()/toolResolverFromEnv() — seam de composition/DI. Défaut =
//     résolveur vide (dégradation gracieuse en {}), JAMAIS de hard-fail au démarrage.

/**
 * @typedef {import("./ports.mjs").RuntimeScope} RuntimeScope
 * @typedef {import("./ports.mjs").IToolResolver} IToolResolver
 */

/** Méthodes que tout adapter IToolResolver DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze(["resolveTools"]);

/**
 * Vérifie structurellement qu'un objet satisfait le port IToolResolver.
 * @param {any} adapter
 * @returns {IToolResolver} le même adapter, quand valide
 */
export function assertToolResolver(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("IToolResolver: adapter must be an object");
  }
  if (typeof adapter.resolveTools !== "function") {
    throw new Error("IToolResolver: adapter missing method(s): resolveTools");
  }
  return /** @type {IToolResolver} */ (adapter);
}

// ── StaticToolResolver — Record de tools fixe, filtrable par scope ─────────────

/**
 * Résout un Record de tools fixe. Les tools sont OPAQUES (le cœur ne les
 * introspecte pas) : le consommateur y met ses tools Mastra natifs. Un `filter`
 * optionnel (scope, toolId) → boolean permet un scoping per-user/-project sans que
 * le cœur connaisse la sémantique du tool. Dégrade en {} si non configuré.
 * @implements {IToolResolver}
 */
export class StaticToolResolver {
  /**
   * @param {Record<string, unknown>} [tools] registre toolId → tool opaque
   * @param {(scope: RuntimeScope, toolId: string) => boolean} [filter] prédicat de scoping
   */
  constructor(tools = {}, filter) {
    /** @type {Record<string, unknown>} */
    this._tools = tools || {};
    /** @type {((scope: RuntimeScope, toolId: string) => boolean) | undefined} */
    this._filter = filter;
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Promise<Record<string, unknown>>}
   */
  async resolveTools(scope) {
    if (!this._filter) return { ...this._tools };
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [id, tool] of Object.entries(this._tools)) {
      if (this._filter(scope, id)) out[id] = tool;
    }
    return out;
  }
}

// ── CombinedToolResolver — composition, first-registered wins, échecs isolés ───

/**
 * Compose N `IToolResolver` et merge leurs tools. Aucune fusion in-process : chaque
 * backend reste isolé, résolu séquentiellement. Arbitrage (doctrine ADR §2) :
 *   • Collision de toolId → FIRST-REGISTERED WINS (l'ordre du tableau fige la
 *     précédence ; les doublons ultérieurs sont ignorés) — déterministe, réversible.
 *   • Backend qui throw → échec ISOLÉ (avalé) : un backend HS ne prive pas le user
 *     des tools des autres. Cohérent avec la dégradation gracieuse du port.
 * @implements {IToolResolver}
 */
export class CombinedToolResolver {
  /**
   * @param {IToolResolver[]} [resolvers]
   */
  constructor(resolvers = []) {
    /** @type {IToolResolver[]} */
    this._resolvers = (resolvers || []).map((r) => assertToolResolver(r));
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Promise<Record<string, unknown>>}
   */
  async resolveTools(scope) {
    /** @type {Record<string, unknown>} */
    const merged = {};
    for (const resolver of this._resolvers) {
      /** @type {Record<string, unknown>} */
      let tools;
      try {
        tools = await resolver.resolveTools(scope);
      } catch {
        continue; // isolation : un backend en échec ne prive pas des autres
      }
      for (const [toolId, tool] of Object.entries(tools || {})) {
        if (toolId in merged) continue; // first-registered wins
        merged[toolId] = tool;
      }
    }
    return merged;
  }
}

// ── EmptyToolResolver — défaut gracieux ────────────────────────────────────────

/**
 * Résout toujours {} — le défaut sûr quand aucun backend n'est configuré (jamais de
 * hard-fail au démarrage, ADR §3). Équivaut à `new StaticToolResolver()`, nommé pour
 * l'intention.
 * @implements {IToolResolver}
 */
export class EmptyToolResolver {
  /**
   * @param {RuntimeScope} _scope
   * @returns {Promise<Record<string, unknown>>}
   */
  async resolveTools(_scope) {
    return {};
  }
}

// ── Seam de composition/DI ─────────────────────────────────────────────────────

/**
 * Seam de composition du port ADR §3 : point unique où l'on décide quels backends
 * `IToolResolver` sont combinés au runtime. Les backends concrets (Nango, obot-mcp…)
 * sont Mastra/DB-couplés → INJECTÉS par le consommateur, jamais tirés par le cœur.
 * Défaut = liste vide → résolveur combiné qui dégrade en {} (gracieux). Réversible :
 * ajouter/réordonner une impl dans le tableau suffit (first-registered wins).
 * @param {IToolResolver[]} [backends]
 * @returns {IToolResolver}
 */
export function createToolResolver(backends = []) {
  return new CombinedToolResolver(backends);
}

/**
 * @typedef {object} CreateToolResolverResult
 * @property {IToolResolver} resolver
 * @property {number} backends nombre de backends injectés effectivement composés
 */

/**
 * Variante `fromEnv`/DI cohérente avec les autres seams (llmFromEnv, storageFromEnv).
 * Le cœur n'a AUCUN backend natif env-sélectionnable (Nango/MCP sont consommateur-
 * spécifiques) : on compose donc les `backends` injectés, sinon on dégrade vers un
 * résolveur vide. Reporte le nombre de backends pour l'observabilité.
 * @param {object} [opts]
 * @param {IToolResolver[]} [opts.backends] backends à composer (défaut [])
 * @returns {Promise<CreateToolResolverResult>}
 */
export async function toolResolverFromEnv(opts = {}) {
  const backends = (opts.backends || []).map((r) => assertToolResolver(r));
  const resolver = backends.length ? new CombinedToolResolver(backends) : new EmptyToolResolver();
  assertToolResolver(resolver);
  return { resolver, backends: backends.length };
}
