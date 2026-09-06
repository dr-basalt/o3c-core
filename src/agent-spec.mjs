// @ori3com/agent-core — AgentSpec (ADR-0001 C02).
// Extrait/refactoré depuis @ori3com/agent-runtime, DÉCOUPLÉ de tout o3c-chat :
// `fetchAgentSpec`/`invalidateAgentSpec` (drizzle/@ori3com/db + cache LRU) NE sont
// PAS portés — la matérialisation de l'AgentSpec depuis un état persistant est du
// ressort du CONSOMMATEUR (backend derrière un port, injecté via DI/`fromEnv`, C05).
// Ici : uniquement le CONTRAT typé de l'état déclaratif d'un agent (pur, portable).

/**
 * État déclaratif, persistant et reconstructible d'un agent (« 1 projet = 1 agent »).
 * Rien de résident : `materializeAgent` (C04) reconstruit l'agent Mastra par requête
 * depuis cet AgentSpec + le ContextEnvelope assemblé par le ContextBuilder.
 * @typedef {Object} AgentSpec
 * @property {string} id
 * @property {string} name
 * @property {string | null} persona Voix/rôle de l'agent (injecté haut du prompt).
 * @property {string | null} systemPrompt Instructions système déclaratives.
 * @property {string} defaultModel Modèle LLM par défaut (routé via api.ori3com.cloud).
 * @property {number} temperature Température de génération par défaut.
 * @property {string} tenantId Tenant propriétaire (guard d'isolation).
 * @property {string} projectId Projet propriétaire.
 */

export {};
