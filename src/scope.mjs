// @ori3com/agent-core — RuntimeScope + S3PathBuilder (ADR-0001 C02).
// Extrait/refactoré depuis @ori3com/agent-runtime, DÉCOUPLÉ de tout o3c-chat :
// les seams DB (`buildRuntimeScope`/`listUserProjects` sur drizzle/@ori3com/db)
// NE sont PAS portés — la résolution du scope est fournie par le CONSOMMATEUR
// (via `fromEnv`/DI, C05). Ici : le contrat de scope + le builder de clés objet,
// tous deux purs (aucune dépendance runtime → WASM-friendly).

/**
 * Scope d'exécution d'un agent, propagé à chaque requête (isolation multi-tenant).
 * @typedef {Object} RuntimeScope
 * @property {string} tenantId Actif d'org (clé racine d'isolation).
 * @property {string} [organizationId] Org logique (optionnelle) au-dessus du tenant.
 * @property {string} userId Utilisateur courant (isolation per-user des tools).
 * @property {string} projectId Namespace projet (partition mémoire/vecteur/fichiers).
 * @property {string} agentId Agent matérialisé pour ce projet.
 * @property {string} threadId Fil de conversation courant.
 */

/**
 * Sécurise un nom de fichier fourni côté client : basename only, pas de traversée.
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  const base = filename.replace(/[/\\]/g, "").replace(/\.\./g, "");
  if (!base) throw new Error("Invalid filename");
  return base;
}

/**
 * Builder de clés de stockage objet, dérivées EXCLUSIVEMENT du scope serveur —
 * jamais de chemin fourni par le client (défense en profondeur multi-tenant).
 * Pur : consommé derrière le port `IStorageLayer` (C05), quel que soit le backend.
 */
export class S3PathBuilder {
  /** @param {RuntimeScope} scope */
  constructor(scope) {
    /** @type {RuntimeScope} */
    this.scope = scope;
  }

  /** @returns {string} */
  tenantRoot() {
    return `tenants/${this.scope.tenantId}`;
  }

  /** @returns {string} */
  projectRoot() {
    return `${this.tenantRoot()}/projects/${this.scope.projectId}`;
  }

  /** @returns {string} */
  agentRoot() {
    return `${this.projectRoot()}/agents/${this.scope.agentId}`;
  }

  /** @returns {string} */
  threadRoot() {
    return `${this.projectRoot()}/threads/${this.scope.threadId}`;
  }

  /**
   * @param {number} seq
   * @returns {string}
   */
  message(seq) {
    return `${this.threadRoot()}/messages/${String(seq).padStart(6, "0")}.json`;
  }

  /** @returns {string} */
  chatindexSnapshot() {
    return `${this.threadRoot()}/derived/chatindex/current.json`;
  }

  /**
   * @param {"persona.md" | "system.md"} file
   * @returns {string}
   */
  agentInstructions(file) {
    return `${this.agentRoot()}/instructions/${file}`;
  }

  /**
   * @param {string} filename
   * @returns {string}
   */
  fileRaw(filename) {
    return `${this.projectRoot()}/files/raw/${sanitizeFilename(filename)}`;
  }

  /**
   * @param {string} filename
   * @returns {string}
   */
  fileNormalized(filename) {
    return `${this.projectRoot()}/files/normalized/${sanitizeFilename(filename)}`;
  }
}
