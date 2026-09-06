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

/**
 * @typedef {import("./agent-spec.mjs").AgentSpec} AgentSpec
 * @typedef {import("./scope.mjs").RuntimeScope} RuntimeScope
 * @typedef {import("./context-builder.mjs").ContextEnvelope} ContextEnvelope
 * @typedef {import("./context-builder.mjs").ContextBuilderOptions} ContextBuilderOptions
 * @typedef {import("./ports.mjs").ICognitiveMemory} ICognitiveMemory
 * @typedef {import("./ports.mjs").MemoryItem} MemoryItem
 * @typedef {import("./ports.mjs").RecallHit} RecallHit
 */
