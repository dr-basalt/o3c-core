// @ori3com/agent-core — surface publique, canal-agnostique (ADR-0001, C01→C08).
// Le socle agent partagé : ports substituables + ContextBuilder + agent-factory,
// extraits/refactorés depuis @ori3com/agent-runtime, découplés de tout o3c-chat.
// C01 = skeleton (build multi-cible + contrats de ports typés) ; les impls et
// seams `fromEnv` arrivent en C02→C05.
export const VERSION = "0.0.0";

export { PORT_NAMES } from "./ports.mjs";

// C02 — couche domaine pure, découplée de tout o3c-chat (pas de DB, pas d'I/O).
export { ContextBuilder } from "./context-builder.mjs";
export { S3PathBuilder } from "./scope.mjs";
export { LiteLLMEmbedder, HashingEmbedder, createEmbedder } from "./embedder.mjs";
export { RequestContext, buildRequestContext, materializeAgent } from "./agent-factory.mjs";

// C03 — ICognitiveMemory unifié : fallback pur-JS TF·IDF + adapter cognee-rs (probe
// dynamic-import) + seam `fromEnv`/DI (dégradation réversible, même contrat).
export {
  LocalCognitiveMemory,
  CogneeCognitiveMemory,
  createCognitiveMemory,
  assertCognitiveMemory,
  loadCognee,
  isCogneeAvailable,
  REQUIRED_METHODS,
  COGNEE_PACKAGE,
} from "./cognitive-memory.mjs";

// C04 — seam LLM : client openai-compatible (api.ori3com.cloud) + cascade SLM local
// + seam `fromEnv`/`modelProvider` branché sur materializeAgent (WASM-friendly, pas
// de dépendance @ai-sdk/@mastra dans le cœur).
export {
  LiteLLMChat,
  CascadeLLM,
  llmFromEnv,
  createModelProvider,
  modelProviderFromEnv,
} from "./llm.mjs";

// C05 — seams `fromEnv` des backends substituables (memory/vector/graph/storage),
// natives en dynamic-import (jamais tirées quand non utilisées). IVectorMemory :
// fallback pur-JS cosinus dense + adapter natif zvec (probe) + createVectorMemory.
export {
  LocalVectorMemory,
  ZvecVectorMemory,
  createVectorMemory,
  vectorMemoryFromEnv,
  assertVectorMemory,
  loadZvec,
  isZvecAvailable,
  ZVEC_PACKAGE,
} from "./vector-memory.mjs";

// C05 — IStorageLayer : in-memory WASM-clean + fs (node:fs dynamic-import) + s3
// (@aws-sdk/client-s3 probe) + createStorageLayer fromEnv (s3→fs→memory, réversible).
export {
  MemoryStorageLayer,
  FsStorageLayer,
  S3StorageLayer,
  createStorageLayer,
  storageFromEnv,
  assertStorageLayer,
  loadS3,
  isS3Available,
  S3_PACKAGE,
} from "./storage.mjs";

// C05 — IToolResolver (ADR §3, combinable) : tools OPAQUES, découplés de Mastra/
// Nango/DB. StaticToolResolver + CombinedToolResolver (first-registered wins, échecs
// isolés) + createToolResolver/toolResolverFromEnv (backends injectés, gracieux).
export {
  StaticToolResolver,
  CombinedToolResolver,
  EmptyToolResolver,
  createToolResolver,
  toolResolverFromEnv,
  assertToolResolver,
} from "./tool-resolver.mjs";

// C05 — IWorkflowRuntime (Tâches = trigger + steps) : InMemoryWorkflowRuntime pur-JS
// (scope-isolé, durable-en-mémoire) + dispatcher de steps (seam Mastra, exécuteurs
// injectés) + isCronDue (planif pure) + createWorkflowRuntime/fromEnv (durable injecté).
export {
  InMemoryWorkflowRuntime,
  createWorkflowStepHandler,
  createWorkflowRuntime,
  workflowRuntimeFromEnv,
  assertWorkflowRuntime,
  isCronDue,
  isWorkflowStepKind,
  WORKFLOW_STEP_KINDS,
} from "./workflow-runtime.mjs";

// C05 — IBrainMemory (mémoire consolidée + méta-agent) : InMemoryBrainMemory pur-JS
// (scope-isolé, rappel déterministe, policy) + helpers de contexte + createBrainMemory/
// fromEnv (backend durable LanceDB injecté, non bundlé — parité IWorkflowRuntime).
export {
  InMemoryBrainMemory,
  createBrainMemory,
  brainMemoryFromEnv,
  assertBrainMemory,
  formatBrainRecall,
  composeBrainContext,
  isBrainMemoryKind,
  BRAIN_MEMORY_KINDS,
  DEFAULT_META_AGENT_POLICY,
} from "./brain-memory.mjs";

/**
 * @typedef {import("./agent-spec.mjs").AgentSpec} AgentSpec
 * @typedef {import("./scope.mjs").RuntimeScope} RuntimeScope
 * @typedef {import("./context-builder.mjs").ContextEnvelope} ContextEnvelope
 * @typedef {import("./context-builder.mjs").ContextBuilderOptions} ContextBuilderOptions
 * @typedef {import("./ports.mjs").ICognitiveMemory} ICognitiveMemory
 * @typedef {import("./ports.mjs").MemoryItem} MemoryItem
 * @typedef {import("./ports.mjs").RecallHit} RecallHit
 * @typedef {import("./ports.mjs").ILLM} ILLM
 * @typedef {import("./ports.mjs").ChatRequest} ChatRequest
 * @typedef {import("./ports.mjs").ChatResult} ChatResult
 * @typedef {import("./ports.mjs").ModelDescriptor} ModelDescriptor
 */
