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
 * ILLM — seam de génération, openai-compatible et canal-agnostique (impl : `llm.mjs`,
 * C04). Route via api.ori3com.cloud ; `CascadeLLM` chaîne SLM local → cloud. Contrat
 * volontairement petit (chat non-streamé) ; le streaming reste du ressort du runtime
 * consommateur, qui peut re-résoudre `model` via son propre provider.
 *
 * @typedef {Object} ChatMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string} content
 *
 * @typedef {Object} ChatRequest
 * @property {ChatMessage[]} messages
 * @property {string} [model] Écrase le modèle par défaut du provider.
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {string[]} [stop]
 *
 * @typedef {Object} ChatUsage
 * @property {number} [promptTokens]
 * @property {number} [completionTokens]
 * @property {number} [totalTokens]
 *
 * @typedef {Object} ChatResult
 * @property {string} text Contenu du 1er choix (chaîne vide si aucun).
 * @property {string} model Modèle effectif renvoyé par le backend.
 * @property {string} [finishReason]
 * @property {ChatUsage} [usage]
 * @property {string} provider Identifiant du provider ayant répondu (utile en cascade).
 *
 * @typedef {Object} ILLM
 * @property {(req: ChatRequest) => Promise<ChatResult>} chat
 * @property {string} model modèle par défaut du provider
 * @property {string} name identifiant du provider (ex. 'litellm', 'slm-local')
 */

/**
 * ModelDescriptor — modèle LLM PORTABLE résolu par le seam (agent-factory C04).
 * `chat` est lié à `id` ; le consommateur peut aussi re-résoudre `id` via son runtime.
 * @typedef {Object} ModelDescriptor
 * @property {string} id
 * @property {string} provider
 * @property {(req: Omit<ChatRequest, 'model'>) => Promise<ChatResult>} chat
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
 * @property {string} [text] contenu du doc (extra de commodité au-delà du port strict)
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {Object} IVectorMemory
 * @property {(ns: string, docs: VectorDoc[]) => Promise<void>} upsert
 * @property {(ns: string, q: { text?: string, vector: number[], topK?: number }) => Promise<VectorHit[]>} query
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
 * IBrainMemory — mémoire consolidée + méta-agent, scope-isolée par tenantId. Contrat
 * riche (consolidate/recall/forget + policy) défini et implémenté en `brain-memory.mjs`
 * (C05) : impl in-memory pure-JS par défaut, backend durable (LanceDB, S3-stored)
 * substituable par injection. Re-référencé ici pour tenir le registre unique.
 * @typedef {import("./brain-memory.mjs").IBrainMemory} IBrainMemory
 */

/**
 * IGraphStore — magasin de graphe (GraphRAG), substituable derrière le port. Contrat
 * riche (upsert nœuds/arêtes + traversée BFS) défini et implémenté en `graph-store.mjs`
 * (C05) : impl in-memory pure-JS par défaut, backend durable (cognee-rs/Neo4j/KùzuDB)
 * substituable par injection. Re-référencé ici pour tenir le registre unique.
 * @typedef {import("./graph-store.mjs").IGraphStore} IGraphStore
 */

/**
 * IToolResolver — résout un RuntimeScope en tools natifs (Mastra) pour CE user.
 * Toute impl DOIT dégrader en `{}` quand non configurée (jamais de hard-fail).
 * @typedef {Object} IToolResolver
 * @property {(scope: RuntimeScope) => Promise<Record<string, unknown>>} resolveTools
 */

/**
 * IWorkflowRuntime — exécution/orchestration durable de workflows (Tâches : trigger
 * + steps ordonnés). Contrat riche (CRUD + trigger + getRun) défini et implémenté en
 * `workflow-runtime.mjs` (C05) : impl in-memory pure-JS par défaut, backend durable
 * (Inngest) substituable par injection. Re-référencé ici pour tenir le registre unique.
 * @typedef {import("./workflow-runtime.mjs").IWorkflowRuntime} IWorkflowRuntime
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
