// @ori3com/agent-core — contrats de ports (ADR-0001 §1/§3).
// Surface TYPÉE, canal-agnostique : les 8 ports substituables que tout canal
// consomme à l'identique. Ici seuls les CONTRATS (JSDoc @typedef) + la liste
// canonique des noms de ports. Les impls (fallback pur-JS, adapters natifs
// cognee-rs/zvec/lancedb en dynamic-import) et les seams `fromEnv` arrivent en
// C02→C05 — extraits/refactorés depuis @ori3com/agent-runtime, découplés.

/**
 * Scope d'exécution propagé à chaque opération de port (isolation multi-tenant).
 * @typedef {Object} RuntimeScope
 * @property {string} tenantId Actif d'org (clé d'isolation du cerveau).
 * @property {string} [userId] Utilisateur courant (isolation per-user des tools).
 * @property {string} [projectId] Namespace de partition mémoire/vecteur.
 */

/**
 * Embedder — produit des vecteurs denses pour la mémoire vectorielle.
 * @typedef {Object} Embedder
 * @property {(texts: string[]) => Promise<number[][]>} embed
 * @property {number} dims Dimension des vecteurs produits.
 */

/**
 * IVectorMemory — mémoire vectorielle edge, partitionnée par namespace (projectId).
 * @typedef {Object} VectorDoc
 * @property {string} id
 * @property {string} text
 * @property {number[]} [vector]
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {Object} VectorHit
 * @property {string} id
 * @property {number} score
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {Object} IVectorMemory
 * @property {(ns: string, docs: VectorDoc[]) => Promise<void>} upsert
 * @property {(ns: string, q: { text: string, vector: number[], topK?: number }) => Promise<VectorHit[]>} query
 * @property {(ns: string, ids: string[]) => Promise<void>} delete
 */

/**
 * ICognitiveMemory — mémoire cognitive unifiée = le « cerveau » inter-session
 * (cognee-rs + fallback pur-JS TF·IDF). Contrat volontairement petit et async-first
 * (impl : `cognitive-memory.mjs`, C03), convergé depuis l'impl P02 de o3c-code-cli.
 *
 * @typedef {Object} MemoryItem
 * @property {string} id identifiant stable (assigné par l'adapter si omis)
 * @property {string} text le contenu retenu
 * @property {string} [kind] catégorie, ex. 'fact' | 'decision' | 'episode'
 * @property {Record<string, unknown>} [meta] métadonnées structurées arbitraires
 * @property {number} [ts] horloge (logique ou epoch ms) — assignée par l'adapter
 *
 * @typedef {Object} RecallHit
 * @property {MemoryItem} item la mémoire rappelée
 * @property {number} score pertinence dans [0, 1], plus haut = plus pertinent
 *
 * @typedef {Object} MemoryCapabilities
 * @property {string} backend 'cognee' | 'local' | string
 * @property {boolean} persistent survit entre process
 * @property {boolean} semantic recall classé par sens/similarité, pas juste récence
 * @property {boolean} native backé par un addon natif / moteur externe
 *
 * @typedef {Object} ICognitiveMemory
 * @property {MemoryCapabilities} capabilities
 * @property {(item: { text: string, id?: string, kind?: string, meta?: Record<string, unknown> }) => Promise<MemoryItem>} remember
 * @property {(query: string, k?: number) => Promise<RecallHit[]>} recall
 * @property {() => Promise<{ items: number }>} cognify consolide/indexe la mémoire retenue
 * @property {() => Promise<number>} count
 * @property {() => Promise<void>} clear
 */

/**
 * IBrainMemory — mémoire consolidée + méta-agent, scope-isolée par tenantId.
 * @typedef {Object} IBrainMemory
 * @property {(records: unknown[], scope: RuntimeScope) => Promise<unknown>} consolidate
 * @property {(query: unknown, scope: RuntimeScope) => Promise<unknown[]>} recall
 * @property {(ids: string[], scope: RuntimeScope) => Promise<void>} forget
 * @property {(scope: RuntimeScope) => Promise<unknown>} getPolicy
 * @property {(patch: unknown, scope: RuntimeScope) => Promise<unknown>} setPolicy
 */

/**
 * IGraphStore — magasin de graphe (GraphRAG), substituable derrière le port.
 * @typedef {Object} IGraphStore
 * @property {(nodes: unknown[], edges: unknown[], scope: RuntimeScope) => Promise<void>} upsert
 * @property {(query: unknown, scope: RuntimeScope) => Promise<unknown>} query
 */

/**
 * IToolResolver — résout un RuntimeScope en tools natifs (Mastra) pour CE user.
 * Toute impl DOIT dégrader en `{}` quand non configurée (jamais de hard-fail).
 * @typedef {Object} IToolResolver
 * @property {(scope: RuntimeScope) => Promise<Record<string, unknown>>} resolveTools
 */

/**
 * IWorkflowRuntime — exécution/orchestration de workflows (inngest & co, substituable).
 * @typedef {Object} IWorkflowRuntime
 * @property {(name: string, input: unknown, scope: RuntimeScope) => Promise<unknown>} run
 * @property {(name: string, cron: string, input: unknown, scope: RuntimeScope) => Promise<void>} [schedule]
 */

/**
 * IStorageLayer — couche de stockage objet (fs/s3…), substituable derrière le port.
 * @typedef {Object} IStorageLayer
 * @property {(key: string) => Promise<Uint8Array | null>} get
 * @property {(key: string, data: Uint8Array) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(prefix: string) => Promise<string[]>} list
 */

/**
 * Liste canonique des ports substituables de @ori3com/agent-core (ADR-0001 §1).
 * Ordre stable : sert de registre pour la sélection `fromEnv` (C05).
 * @type {ReadonlyArray<string>}
 */
export const PORT_NAMES = Object.freeze([
  "ICognitiveMemory",
  "IVectorMemory",
  "IBrainMemory",
  "IGraphStore",
  "IToolResolver",
  "IWorkflowRuntime",
  "Embedder",
  "IStorageLayer",
]);
