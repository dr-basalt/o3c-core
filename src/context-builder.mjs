// @ori3com/agent-core — ContextBuilder (ADR-0001 C02).
// Extrait/refactoré depuis @ori3com/agent-runtime, DÉCOUPLÉ de tout o3c-chat :
// assemble le prompt système d'une requête à partir de l'AgentSpec (persona +
// instructions) et des slots de contexte injectés par le CONSOMMATEUR (résumé de
// conversation, docs projet via RAG, souvenirs consolidés du Cerveau). Pur : aucune
// dépendance runtime — le builder ne fait AUCUN I/O, chaque slot est fourni prêt.

/**
 * @typedef {import("./agent-spec.mjs").AgentSpec} AgentSpec
 * @typedef {import("./scope.mjs").RuntimeScope} RuntimeScope
 */

/**
 * Enveloppe de contexte matérialisée pour une requête.
 * @typedef {Object} ContextEnvelope
 * @property {string} systemPrompt Prompt système final (persona + instructions + slots).
 * @property {string | null} persona
 * @property {string} projectId
 * @property {string} agentId
 * @property {string} threadId
 * @property {string} [conversationSummary] Résumé conversationnel (sidecar ChatIndex).
 * @property {string} [projectDocs] Top-k documents projet remontés par le RAG.
 * @property {string} [brainMemories] Souvenirs consolidés (IBrainMemory.recall).
 */

/**
 * Slots de contexte optionnels injectés par le consommateur au moment du build.
 * @typedef {Object} ContextBuilderOptions
 * @property {string} [conversationSummary]
 * @property {string} [projectDocs]
 * @property {string} [brainMemories]
 */

export class ContextBuilder {
  /**
   * Assemble l'enveloppe de contexte d'une requête.
   * @param {AgentSpec} spec
   * @param {RuntimeScope} scope
   * @param {ContextBuilderOptions} [options]
   * @returns {ContextEnvelope}
   */
  build(spec, scope, options = {}) {
    /** @type {string[]} */
    const parts = [];

    if (spec.persona) {
      parts.push(`## Persona\n${spec.persona}`);
    }

    if (spec.systemPrompt) {
      parts.push(`## Instructions\n${spec.systemPrompt}`);
    }

    // Cerveau : la mémoire consolidée « reproduit la façon de penser de
    // l'utilisateur » → injectée haut, juste après les instructions, pour teinter
    // le raisonnement avant le contexte conversationnel/documentaire.
    if (options.brainMemories) {
      parts.push(`## Cerveau (mémoire consolidée)\n${options.brainMemories}`);
    }

    if (options.conversationSummary) {
      parts.push(`## Contexte de la conversation\n${options.conversationSummary}`);
    }

    if (options.projectDocs) {
      parts.push(`## Documents du projet\n${options.projectDocs}`);
    }

    const systemPrompt =
      parts.length > 0 ? parts.join("\n\n") : "You are a helpful assistant.";

    return {
      systemPrompt,
      persona: spec.persona,
      projectId: scope.projectId,
      agentId: scope.agentId,
      threadId: scope.threadId,
      conversationSummary: options.conversationSummary,
      projectDocs: options.projectDocs,
      brainMemories: options.brainMemories,
    };
  }
}
