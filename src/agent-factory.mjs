// @ori3com/agent-core — agent-factory (ADR-0001 C02, seam LLM C04).
// Extrait/refactoré depuis @ori3com/agent-runtime (agent-factory.ts), DÉCOUPLÉ :
// le core reste pur/WASM-friendly (ADR §1) → on NE hard-dépend PAS de @mastra/core
// ni de @ai-sdk/openai. Le provider LLM est INJECTÉ (seam C04) et `materializeAgent`
// produit un AgentBlueprint reconstructible (« 1 projet = 1 agent », rien de résident)
// que le CONSOMMATEUR passe à Mastra (`new Agent(blueprint)`) ou à un autre runtime.

/**
 * @typedef {import("./agent-spec.mjs").AgentSpec} AgentSpec
 * @typedef {import("./context-builder.mjs").ContextEnvelope} ContextEnvelope
 * @typedef {import("./scope.mjs").RuntimeScope} RuntimeScope
 */

/**
 * Contexte de requête portant le RuntimeScope, propagé aux tools (ex. Nango lit
 * `userId`/`projectId`). Volontairement minimal et framework-agnostique (get/set/has),
 * API-compatible avec le RequestContext de Mastra sans en dépendre.
 */
export class RequestContext {
  constructor() {
    /** @type {Map<string, unknown>} */
    this._store = new Map();
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @returns {this}
   */
  set(key, value) {
    this._store.set(key, value);
    return this;
  }

  /**
   * @param {string} key
   * @returns {unknown}
   */
  get(key) {
    return this._store.get(key);
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._store.has(key);
  }
}

/**
 * Construit un RequestContext portant le RuntimeScope (isolation propagée aux tools).
 * @param {RuntimeScope} scope
 * @returns {RequestContext}
 */
export function buildRequestContext(scope) {
  return new RequestContext()
    .set("tenantId", scope.tenantId)
    .set("projectId", scope.projectId)
    .set("userId", scope.userId)
    .set("agentId", scope.agentId)
    .set("threadId", scope.threadId);
}

/**
 * Descripteur d'agent reconstructible, canal-agnostique — le consommateur le
 * matérialise dans son runtime (Mastra `new Agent(...)`, etc.).
 * @typedef {Object} AgentBlueprint
 * @property {string} id
 * @property {string} name
 * @property {string} instructions Prompt système assemblé (ContextEnvelope.systemPrompt).
 * @property {unknown} model Modèle LLM résolu (via provider injecté) ou l'id brut.
 * @property {number} temperature
 * @property {Record<string, unknown>} tools Tools natifs injectés (défaut : {}).
 */

/**
 * Résout un id de modèle en objet-modèle du runtime (seam LLM, C04).
 * @callback ModelProvider
 * @param {string} modelId
 * @returns {unknown}
 */

/**
 * @typedef {Object} MaterializeAgentOptions
 * @property {ModelProvider} [modelProvider] Résout `spec.defaultModel` (seam C04) ;
 *   à défaut, l'id de modèle brut est conservé (résolu plus tard par le consommateur).
 * @property {Record<string, unknown>} [tools] Tools natifs injectés (IToolResolver).
 */

/**
 * Matérialise un AgentBlueprint par requête depuis l'état persistant (AgentSpec) et
 * le contexte assemblé (ContextEnvelope). Rien de résident : tout est reconstruit.
 * @param {AgentSpec} spec
 * @param {ContextEnvelope} envelope
 * @param {MaterializeAgentOptions} [opts]
 * @returns {AgentBlueprint}
 */
export function materializeAgent(spec, envelope, opts = {}) {
  const model = opts.modelProvider ? opts.modelProvider(spec.defaultModel) : spec.defaultModel;
  return {
    id: spec.id,
    name: spec.name,
    instructions: envelope.systemPrompt,
    model,
    temperature: spec.temperature,
    tools: opts.tools ?? {},
  };
}
