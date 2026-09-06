// @ori3com/agent-core — RuntimeBroker (ADR-0001 C09, cf. ADR-o3c-portability-handoff).
// LE point d'entrée boîte-noire que l'IHM appelle : `invoke(workload, ctx)`. Le
// PLACEMENT / handoff (local / wasm / webvm / edge / cloud) est OPAQUE au frontend —
// l'IHM décrit un *workload* (quoi faire) et un *contexte* (scope + clé d'état
// account-keyed portable), le broker route vers les ports substituables (C05) et
// renvoie une enveloppe portant seulement `placement` (indicatif) + `output`. L'état
// (.lbug + session) reste portable sur storage account-keyed → handoff par checkpoint.
//
// Ce module est le CAPSTONE des seams : `runtimeBrokerFromEnv()` assemble les 8 ports
// via leurs `fromEnv` (dégradation réversible, natives en dynamic-import) et expose
// UN broker prêt à l'emploi — l'IHM n'a AUCUNE connaissance des backends.

import { createCognitiveMemory } from "./cognitive-memory.mjs";
import { createVectorMemory } from "./vector-memory.mjs";
import { brainMemoryFromEnv } from "./brain-memory.mjs";
import { graphStoreFromEnv } from "./graph-store.mjs";
import { toolResolverFromEnv } from "./tool-resolver.mjs";
import { workflowRuntimeFromEnv } from "./workflow-runtime.mjs";
import { createStorageLayer } from "./storage.mjs";
import { llmFromEnv } from "./llm.mjs";
import { saveCheckpoint, loadCheckpoint } from "./session-checkpoint.mjs";

/**
 * @typedef {import("./ports.mjs").RuntimeScope} RuntimeScope
 * @typedef {import("./ports.mjs").ICognitiveMemory} ICognitiveMemory
 * @typedef {import("./ports.mjs").IVectorMemory} IVectorMemory
 * @typedef {import("./ports.mjs").IBrainMemory} IBrainMemory
 * @typedef {import("./ports.mjs").IGraphStore} IGraphStore
 * @typedef {import("./ports.mjs").IToolResolver} IToolResolver
 * @typedef {import("./ports.mjs").IWorkflowRuntime} IWorkflowRuntime
 * @typedef {import("./ports.mjs").IStorageLayer} IStorageLayer
 * @typedef {import("./ports.mjs").ILLM} ILLM
 */

/**
 * Un workload = une intention typée que l'IHM soumet au broker. `kind` route vers un
 * port ; le reste des champs est l'entrée de l'op. Volontairement plat/sérialisable
 * (checkpoint-friendly, portable à travers les runtimes).
 * @typedef {{ kind: string } & Record<string, any>} Workload
 *
 * Contexte d'invocation : scope d'isolation + clé d'état portable (account-keyed).
 * @typedef {Object} InvocationContext
 * @property {RuntimeScope} scope
 * @property {string} [stateKey] pointeur d'état portable (.lbug/session) pour le handoff
 *
 * Enveloppe de résultat : `placement` est INDICATIF (observabilité), jamais requis par
 * l'IHM ; `output` est le résultat de l'op du port.
 * @typedef {Object} InvocationResult
 * @property {string} placement où le workload a été exécuté (local/wasm/edge/cloud…)
 * @property {string} kind kind du workload traité (echo, pour corrélation)
 * @property {unknown} output
 *
 * @typedef {Object} RuntimeBroker
 * @property {(workload: Workload, ctx: InvocationContext) => Promise<InvocationResult>} invoke
 * @property {(ctx: InvocationContext, state: unknown) => Promise<{ key: string, envelope: any }>} [checkpoint] persiste l'état portable (handoff)
 * @property {(ctx: InvocationContext) => Promise<any>} [restore] restaure l'état portable (reprise après handoff)
 */

/** Kinds de workload reconnus (registre stable ; routé vers les ports C05). */
export const WORKLOAD_KINDS = Object.freeze([
  "memory.remember",
  "memory.recall",
  "vector.upsert",
  "vector.query",
  "brain.consolidate",
  "brain.recall",
  "graph.upsert",
  "graph.query",
  "workflow.trigger",
  "tools.resolve",
  "llm.chat",
]);

/**
 * Vérifie qu'un objet satisfait le contrat RuntimeBroker.
 * @param {any} broker
 * @returns {RuntimeBroker}
 */
export function assertRuntimeBroker(broker) {
  if (!broker || typeof broker.invoke !== "function") {
    throw new Error("RuntimeBroker: must expose an invoke(workload, ctx) method");
  }
  return /** @type {RuntimeBroker} */ (broker);
}

/**
 * `LocalRuntimeBroker` — broker in-process : route chaque workload vers le port injecté
 * correspondant et exécute LOCALEMENT (placement='local'). C'est l'impl de référence ;
 * un broker distribué (handoff wasm/edge/cloud) implémentera le MÊME `invoke` en
 * choisissant un autre placement, transparent pour l'IHM. Un port requis absent → erreur
 * explicite `PORT_UNAVAILABLE:<port>` (dégradation explicite, pas de piège silencieux).
 * @implements {RuntimeBroker}
 */
export class LocalRuntimeBroker {
  /**
   * @param {object} [ports]
   * @param {ICognitiveMemory} [ports.cognitive]
   * @param {IVectorMemory} [ports.vector]
   * @param {IBrainMemory} [ports.brain]
   * @param {IGraphStore} [ports.graph]
   * @param {IToolResolver} [ports.tools]
   * @param {IWorkflowRuntime} [ports.workflow]
   * @param {IStorageLayer} [ports.storage]
   * @param {ILLM} [ports.llm]
   * @param {string} [ports.placement] étiquette de placement (défaut 'local')
   */
  constructor(ports = {}) {
    this._p = ports;
    /** @type {string} */
    this.placement = ports.placement || "local";
  }

  /**
   * @param {keyof typeof this._p} name
   * @returns {any}
   */
  _require(name) {
    const port = /** @type {any} */ (this._p)[name];
    if (!port) throw new Error(`PORT_UNAVAILABLE:${String(name)}`);
    return port;
  }

  /**
   * Point d'entrée boîte-noire. Le placement est décidé ICI (opaque à l'appelant).
   * @param {Workload} workload
   * @param {InvocationContext} ctx
   * @returns {Promise<InvocationResult>}
   */
  async invoke(workload, ctx) {
    if (!workload || typeof workload.kind !== "string") {
      throw new Error("RuntimeBroker.invoke: workload.kind (string) is required");
    }
    if (!ctx || !ctx.scope || typeof ctx.scope.tenantId !== "string") {
      throw new Error("RuntimeBroker.invoke: ctx.scope.tenantId (string) is required");
    }
    const scope = ctx.scope;
    // ns par défaut = projectId (partition mémoire/vecteur), surchargée par le workload.
    const ns = workload.ns ?? scope.projectId ?? "default";
    /** @type {unknown} */
    let output;
    switch (workload.kind) {
      case "memory.remember":
        output = await this._require("cognitive").remember(workload.item ?? { text: workload.text });
        break;
      case "memory.recall":
        output = await this._require("cognitive").recall(workload.query, workload.k);
        break;
      case "vector.upsert":
        output = await this._require("vector").upsert(ns, workload.docs ?? []);
        break;
      case "vector.query":
        output = await this._require("vector").query(ns, workload.q ?? workload);
        break;
      case "brain.consolidate":
        output = await this._require("brain").consolidate(workload.records ?? [], scope);
        break;
      case "brain.recall":
        output = await this._require("brain").recall(workload.query ?? {}, scope);
        break;
      case "graph.upsert":
        output = await this._require("graph").upsert(workload.nodes ?? [], workload.edges ?? [], scope);
        break;
      case "graph.query":
        output = await this._require("graph").query(workload.query ?? {}, scope);
        break;
      case "workflow.trigger":
        output = await this._require("workflow").trigger(workload.event, workload.payload ?? {}, scope);
        break;
      case "tools.resolve":
        output = await this._require("tools").resolveTools(scope);
        break;
      case "llm.chat":
        output = await this._require("llm").chat(workload.request ?? { messages: workload.messages });
        break;
      default:
        throw new Error(`UNKNOWN_WORKLOAD_KIND:${workload.kind}`);
    }
    return { placement: this.placement, kind: workload.kind, output };
  }

  /**
   * Persiste l'état de session (.lbug + session) sur le storage account-keyed → le
   * handoff est un simple checkpoint : un broker sur un AUTRE placement (wasm/edge/
   * cloud) restaurera le MÊME état via `restore(ctx)`. Le storage est requis.
   * @param {InvocationContext} ctx
   * @param {unknown} state état opaque JSON-sérialisable
   * @returns {Promise<{ key: string, envelope: import("./session-checkpoint.mjs").CheckpointEnvelope }>}
   */
  async checkpoint(ctx, state) {
    return saveCheckpoint(this._require("storage"), ctx, state);
  }

  /**
   * Restaure l'état de session depuis le checkpoint account-keyed (null si absent).
   * Pendant du `checkpoint` : réalise la reprise après handoff.
   * @param {InvocationContext} ctx
   * @returns {Promise<import("./session-checkpoint.mjs").CheckpointEnvelope | null>}
   */
  async restore(ctx) {
    return loadCheckpoint(this._require("storage"), ctx);
  }
}

/**
 * Assemble un broker depuis des ports déjà construits (DI). Valide le contrat.
 * @param {ConstructorParameters<typeof LocalRuntimeBroker>[0]} ports
 * @returns {RuntimeBroker}
 */
export function createRuntimeBroker(ports = {}) {
  return assertRuntimeBroker(new LocalRuntimeBroker(ports));
}

/**
 * @typedef {object} RuntimeBrokerFromEnvResult
 * @property {RuntimeBroker} broker
 * @property {Record<string, string>} backends backend effectif retenu par port (observabilité)
 */

/**
 * CAPSTONE des seams C05 : construit les 8 ports via leurs `fromEnv` (natives en
 * dynamic-import, dégradation réversible) et renvoie UN broker boîte-noire prêt à
 * l'emploi. L'IHM appelle `broker.invoke(...)` sans jamais connaître les backends.
 * Le seam LLM est OPTIONNEL (absent si non configuré) : `llm.chat` lèvera alors
 * `PORT_UNAVAILABLE:llm` plutôt que d'échouer au démarrage (doctrine §2).
 * @param {object} [opts]
 * @param {string} [opts.placement] étiquette de placement (défaut 'local')
 * @param {string} [opts.projectId] namespace mémoire/vecteur par défaut
 * @param {IStorageLayer} [opts.storage] storage explicite (sinon fromEnv)
 * @param {Record<string, string | undefined>} [opts.env] env (défaut process.env)
 * @returns {Promise<RuntimeBrokerFromEnvResult>}
 */
export async function runtimeBrokerFromEnv(opts = {}) {
  const env = opts.env || (typeof process !== "undefined" && process.env ? process.env : {});
  const storageRes = opts.storage
    ? { storage: opts.storage, backend: "injected" }
    : await createStorageLayer({ env });
  const storage = storageRes.storage;

  const [cog, vec, brain, graph, tools, workflow] = await Promise.all([
    createCognitiveMemory({ projectId: opts.projectId, storage }),
    createVectorMemory({ storage }),
    brainMemoryFromEnv({ env }),
    graphStoreFromEnv({ env }),
    toolResolverFromEnv({}),
    workflowRuntimeFromEnv({ env }),
  ]);

  /** @type {ILLM | undefined} */
  let llm;
  let llmBackend = "none";
  try {
    llm = llmFromEnv();
    llmBackend = /** @type {any} */ (llm).name ?? "llm";
  } catch {
    // Aucun provider LLM configuré → laissé absent (llm.chat → PORT_UNAVAILABLE:llm).
  }

  const broker = new LocalRuntimeBroker({
    cognitive: cog.memory,
    vector: vec.memory,
    brain: brain.memory,
    graph: graph.store,
    tools: tools.resolver,
    workflow: workflow.runtime,
    storage,
    llm,
    placement: opts.placement,
  });

  return {
    broker: assertRuntimeBroker(broker),
    backends: {
      cognitive: cog.backend,
      vector: vec.backend,
      brain: brain.backend,
      graph: graph.backend,
      workflow: workflow.backend,
      storage: storageRes.backend,
      llm: llmBackend,
    },
  };
}
