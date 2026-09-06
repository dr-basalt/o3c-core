// @ori3com/agent-core — IGraphStore seam (ADR-0001 C05).
// Magasin de graphe (GraphRAG) derrière UN port substituable. Aucune impl n'existait
// dans o3c-chat/packages/agent-runtime (le graphe y vit dans cognee-rs, natif) : on
// fournit ici l'impl in-memory pure-JS RÉELLE (pas un stub — upsert idempotent +
// traversée BFS scope-isolée), qui donne à tout canal un GraphRAG portable et
// WASM-clean par défaut. Le backend DURABLE (cognee-rs / Neo4j / KùzuDB) dépend de
// libs natives et reste INJECTÉ par le consommateur (jamais tiré par le cœur — parité
// IWorkflowRuntime/IBrainMemory). Isolation par `tenantId` (cohérent avec les autres ports).

/**
 * @typedef {import("./ports.mjs").RuntimeScope} RuntimeScope
 */

/**
 * @typedef {Object} GraphNode
 * @property {string} id identifiant stable du nœud
 * @property {string} [type] type/label du nœud (ex. 'person', 'doc')
 * @property {Record<string, unknown>} [props] propriétés arbitraires
 *
 * @typedef {Object} GraphEdge
 * @property {string} from id du nœud source
 * @property {string} to id du nœud cible
 * @property {string} [type] type de relation (ex. 'mentions', 'authored')
 * @property {Record<string, unknown>} [props] propriétés arbitraires
 *
 * @typedef {Object} GraphQuery
 * @property {string} [node] retourne ce nœud + ses arêtes incidentes
 * @property {string} [neighbors] BFS depuis ce nœud (nœuds+arêtes atteignables)
 * @property {number} [depth] profondeur max du BFS (défaut 1)
 * @property {string} [edgeType] ne suivre/retourner que les arêtes de ce type
 * @property {'out' | 'in' | 'both'} [direction] sens de traversée (défaut 'both')
 * @property {number} [limit] borne le nb de nœuds retournés
 *
 * @typedef {Object} GraphResult
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 *
 * @typedef {Object} IGraphStore
 * @property {(nodes: GraphNode[], edges: GraphEdge[], scope: RuntimeScope) => Promise<void>} upsert
 * @property {(query: GraphQuery, scope: RuntimeScope) => Promise<GraphResult>} query
 */

/** Méthodes que tout adapter IGraphStore DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze(["upsert", "query"]);

/**
 * Vérifie structurellement qu'un objet satisfait le port IGraphStore.
 * @param {any} adapter
 * @returns {IGraphStore} le même adapter, quand valide
 */
export function assertGraphStore(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("IGraphStore: adapter must be an object");
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new Error(`IGraphStore: adapter missing method(s): ${missing.join(", ")}`);
  }
  return /** @type {IGraphStore} */ (adapter);
}

/**
 * Clé stable d'une arête (dédup upsert) : `from|type|to`.
 * @param {GraphEdge} e
 * @returns {string}
 */
function edgeKey(e) {
  return `${e.from}${e.type ?? ""}${e.to}`;
}

// ── InMemoryGraphStore — impl par défaut, scope-isolée, WASM-clean ─────────────

/**
 * @typedef {Object} TenantGraph
 * @property {Map<string, GraphNode>} nodes
 * @property {Map<string, GraphEdge>} edges
 */

/**
 * GraphRAG in-memory : nœuds upsertés par `id`, arêtes dédupliquées par `from|type|to`.
 * Ce N'EST PAS un stub — `query` fait une vraie traversée BFS bornée par profondeur,
 * type et direction, scope-isolée par `tenantId`. Aucune dépendance native (WASM-clean).
 * @implements {IGraphStore}
 */
export class InMemoryGraphStore {
  constructor() {
    /** @type {Map<string, TenantGraph>} */
    this._byTenant = new Map();
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "memory", persistent: false, native: false };
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {TenantGraph}
   */
  _graph(scope) {
    let g = this._byTenant.get(scope.tenantId);
    if (!g) {
      g = { nodes: new Map(), edges: new Map() };
      this._byTenant.set(scope.tenantId, g);
    }
    return g;
  }

  /**
   * Upsert idempotent : les nœuds re-upsertés fusionnent leurs props ; les arêtes de
   * même `from|type|to` sont dédupliquées (props écrasées par la dernière). Les nœuds
   * référencés par une arête sont matérialisés à la volée s'ils n'existent pas encore.
   * @param {GraphNode[]} nodes
   * @param {GraphEdge[]} edges
   * @param {RuntimeScope} scope
   * @returns {Promise<void>}
   */
  async upsert(nodes, edges, scope) {
    const g = this._graph(scope);
    for (const n of nodes || []) {
      if (!n || typeof n.id !== "string" || !n.id) {
        throw new Error("upsert: each node requires a non-empty string `id`");
      }
      const prev = g.nodes.get(n.id);
      g.nodes.set(n.id, {
        id: n.id,
        type: n.type ?? prev?.type,
        props: { ...(prev?.props ?? {}), ...(n.props ?? {}) },
      });
    }
    for (const e of edges || []) {
      if (!e || typeof e.from !== "string" || typeof e.to !== "string" || !e.from || !e.to) {
        throw new Error("upsert: each edge requires non-empty string `from` and `to`");
      }
      // Matérialise les extrémités absentes (le graphe reste cohérent).
      if (!g.nodes.has(e.from)) g.nodes.set(e.from, { id: e.from, props: {} });
      if (!g.nodes.has(e.to)) g.nodes.set(e.to, { id: e.to, props: {} });
      g.edges.set(edgeKey(e), {
        from: e.from,
        to: e.to,
        type: e.type,
        props: e.props ? { ...e.props } : undefined,
      });
    }
  }

  /**
   * @param {GraphQuery} query
   * @param {RuntimeScope} scope
   * @returns {Promise<GraphResult>}
   */
  async query(query, scope) {
    const g = this._graph(scope);
    const q = query || {};
    const edgeType = q.edgeType;
    const direction = q.direction ?? "both";

    // Arêtes incidentes à un nœud, filtrées par type + direction.
    /** @param {string} id */
    const incident = (id) =>
      [...g.edges.values()].filter((e) => {
        if (edgeType && e.type !== edgeType) return false;
        if (direction === "out") return e.from === id;
        if (direction === "in") return e.to === id;
        return e.from === id || e.to === id;
      });

    // Mode nœud unique : le nœud + ses arêtes incidentes.
    if (q.node !== undefined) {
      const n = g.nodes.get(q.node);
      if (!n) return { nodes: [], edges: [] };
      const edges = incident(q.node);
      const nodes = collectNodes(g, [q.node], edges);
      return bound(nodes, edges, q.limit);
    }

    // Mode voisinage : BFS borné par profondeur.
    if (q.neighbors !== undefined) {
      if (!g.nodes.has(q.neighbors)) return { nodes: [], edges: [] };
      const depth = q.depth ?? 1;
      const seen = new Set([q.neighbors]);
      /** @type {Map<string, GraphEdge>} */
      const resEdges = new Map();
      let frontier = [q.neighbors];
      for (let d = 0; d < depth && frontier.length; d++) {
        /** @type {string[]} */
        const next = [];
        for (const id of frontier) {
          for (const e of incident(id)) {
            resEdges.set(edgeKey(e), e);
            const other = e.from === id ? e.to : e.from;
            if (!seen.has(other)) {
              seen.add(other);
              next.push(other);
            }
          }
        }
        frontier = next;
      }
      const nodes = [...seen].map((id) => g.nodes.get(id)).filter(Boolean);
      return bound(/** @type {GraphNode[]} */ (nodes), [...resEdges.values()], q.limit);
    }

    // Mode complet : tout le graphe du tenant (borné).
    const edges = edgeType
      ? [...g.edges.values()].filter((e) => e.type === edgeType)
      : [...g.edges.values()];
    return bound([...g.nodes.values()], edges, q.limit);
  }
}

/**
 * Rassemble les nœuds d'un ensemble d'ids + les extrémités d'un ensemble d'arêtes.
 * @param {TenantGraph} g
 * @param {string[]} ids
 * @param {GraphEdge[]} edges
 * @returns {GraphNode[]}
 */
function collectNodes(g, ids, edges) {
  const set = new Set(ids);
  for (const e of edges) {
    set.add(e.from);
    set.add(e.to);
  }
  /** @type {GraphNode[]} */
  const out = [];
  for (const id of set) {
    const n = g.nodes.get(id);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Borne le nb de nœuds retournés et restreint les arêtes à celles dont les deux
 * extrémités survivent au bornage (résultat cohérent).
 * @param {GraphNode[]} nodes
 * @param {GraphEdge[]} edges
 * @param {number} [limit]
 * @returns {GraphResult}
 */
function bound(nodes, edges, limit) {
  if (limit === undefined || nodes.length <= limit) return { nodes, edges };
  const kept = nodes.slice(0, Math.max(0, limit));
  const ids = new Set(kept.map((n) => n.id));
  return { nodes: kept, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

// ── Seam de composition/DI ─────────────────────────────────────────────────────

/**
 * Seam de composition du port ADR §3. Défaut = in-memory ; un backend durable
 * (cognee-rs / Neo4j / KùzuDB) s'y substitue par injection sans toucher les appelants.
 * @param {IGraphStore} [impl] impl injectée (défaut in-memory)
 * @returns {IGraphStore}
 */
export function createGraphStore(impl = new InMemoryGraphStore()) {
  return assertGraphStore(impl);
}

/**
 * @typedef {object} CreateGraphStoreResult
 * @property {IGraphStore} store
 * @property {string} backend
 * @property {boolean} durable
 */

/**
 * Sélection d'impl `IGraphStore` par ENV. Défaut = in-memory (déterministe, WASM-clean).
 * `GRAPH_STORE_PROVIDER=<durable>` demande un backend durable (cognee-rs/Neo4j/KùzuDB)
 * — mais ces backends dépendent de libs natives et ne sont PAS bundlés dans le cœur
 * (parité IWorkflowRuntime/IBrainMemory) : ils sont fournis via `opts.durableFactory`
 * (injection consommateur). Sélection réversible ; provider durable sans factory →
 * erreur explicite (doctrine §2 : dégradation explicite, pas de piège caché).
 * @param {object} [opts]
 * @param {string} [opts.prefer] préférence ('memory' ou nom de backend durable ; défaut env ou 'memory')
 * @param {(provider: string, env: Record<string, string | undefined>) => Promise<IGraphStore>} [opts.durableFactory] fabrique du backend durable (consommateur)
 * @param {Record<string, string | undefined>} [opts.env] env (défaut process.env)
 * @returns {Promise<CreateGraphStoreResult>}
 */
export async function graphStoreFromEnv(opts = {}) {
  const env = opts.env || (typeof process !== "undefined" && process.env ? process.env : {});
  const provider = opts.prefer || env["GRAPH_STORE_PROVIDER"] || "memory";

  if (provider === "memory") {
    const store = new InMemoryGraphStore();
    return { store: assertGraphStore(store), backend: "memory", durable: false };
  }
  if (typeof opts.durableFactory !== "function") {
    throw new Error(
      `graphStoreFromEnv: provider='${provider}' requires an injected \`durableFactory\` ` +
        "(durable graph backends depend on native libs and are not bundled in the core)",
    );
  }
  const store = await opts.durableFactory(provider, env);
  return { store: assertGraphStore(store), backend: provider, durable: true };
}
