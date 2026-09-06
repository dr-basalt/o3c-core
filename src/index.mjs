// @ori3com/agent-core — surface publique, canal-agnostique (ADR-0001, C01→C08).
// Le socle agent partagé : ports substituables + ContextBuilder + agent-factory,
// extraits/refactorés depuis @ori3com/agent-runtime, découplés de tout o3c-chat.
// C01 = skeleton (build multi-cible + contrats de ports typés) ; les impls et
// seams `fromEnv` arrivent en C02→C05.
export const VERSION = "0.0.0";

export { PORT_NAMES } from "./ports.mjs";
