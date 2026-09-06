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

/**
 * @typedef {import("./agent-spec.mjs").AgentSpec} AgentSpec
 * @typedef {import("./scope.mjs").RuntimeScope} RuntimeScope
 * @typedef {import("./context-builder.mjs").ContextEnvelope} ContextEnvelope
 * @typedef {import("./context-builder.mjs").ContextBuilderOptions} ContextBuilderOptions
 */
