// @ori3com/agent-core — IWorkflowRuntime seam (ADR-0001 C05).
// Une *Tâche* = un workflow : un déclencheur (`trigger`) + une suite ordonnée de
// steps (agent / skill / tool / connector / openclaw). Extrait/refactoré depuis
// o3c-chat/packages/agent-runtime (workflow-runtime.ts) et DÉCOUPLÉ de tout
// o3c-chat-specific : le cœur ne contient QUE l'impl in-memory pure-JS (déterministe,
// WASM-clean, aucune dépendance serveur), le dispatcher de steps (seam Mastra — les
// exécuteurs sont INJECTÉS), le planificateur pur `isCronDue`, et le seam de
// composition. Le backend DURABLE (Inngest self-hosted) dépend du package `inngest`
// et reste INJECTÉ par le consommateur (jamais tiré par le cœur — parité IToolResolver).

/**
 * @typedef {import("./ports.mjs").RuntimeScope} RuntimeScope
 */

/**
 * Nature d'un step = quel exécuteur le prend en charge (ADR §5).
 * @typedef {'agent' | 'skill' | 'tool' | 'connector' | 'openclaw'} WorkflowStepKind
 */

/** Liste canonique des kinds de step (ordre stable). */
export const WORKFLOW_STEP_KINDS = Object.freeze([
  "agent",
  "skill",
  "tool",
  "connector",
  "openclaw",
]);

/**
 * Garde de validité du `kind` (entrée réseau non fiable).
 * @param {unknown} value
 * @returns {value is WorkflowStepKind}
 */
export function isWorkflowStepKind(value) {
  return typeof value === "string" && WORKFLOW_STEP_KINDS.includes(value);
}

/**
 * @typedef {Object} WorkflowStep
 * @property {string} id
 * @property {WorkflowStepKind} kind
 * @property {string} ref référence résolue par le handler (id d'agent/skill/tool…)
 * @property {Record<string, unknown>} [input] entrée statique (fusionnée avec `previous`)
 *
 * @typedef {{ type: 'event', event: string } | { type: 'schedule', cron: string }} WorkflowTrigger
 *
 * @typedef {Object} WorkflowDefinition
 * @property {string} id
 * @property {string} name
 * @property {WorkflowTrigger} trigger
 * @property {WorkflowStep[]} steps
 * @property {string} [description]
 * @property {string[]} [tags]
 *
 * @typedef {Object} WorkflowQuery
 * @property {string} [text] sous-chaîne insensible à la casse (name + description)
 * @property {string[]} [tags] le workflow doit porter TOUS ces tags (AND)
 *
 * @typedef {'completed' | 'failed'} WorkflowRunStatus
 *
 * @typedef {Object} WorkflowStepResult
 * @property {string} stepId
 * @property {unknown} [output]
 * @property {string} [error]
 *
 * @typedef {Object} WorkflowRun
 * @property {string} id
 * @property {string} workflowId
 * @property {WorkflowRunStatus} status
 * @property {WorkflowStepResult[]} steps
 * @property {unknown} [output] sortie du dernier step réussi (résultat global)
 *
 * @typedef {Object} WorkflowStepContext
 * @property {WorkflowStep} step
 * @property {RuntimeScope} scope
 * @property {Record<string, unknown>} event payload du déclencheur (racine du chaînage)
 * @property {unknown} previous sortie du step précédent
 *
 * @typedef {(ctx: WorkflowStepContext) => Promise<unknown>} WorkflowStepHandler
 *
 * @typedef {Object} WorkflowStepExecutors
 * @property {WorkflowStepHandler} [agent]
 * @property {WorkflowStepHandler} [skill]
 * @property {WorkflowStepHandler} [tool]
 * @property {WorkflowStepHandler} [connector]
 * @property {WorkflowStepHandler} [openclaw]
 *
 * @typedef {Object} ScheduleEntry
 * @property {string} workflowId
 * @property {string} cron
 * @property {RuntimeScope} scope
 *
 * @typedef {Object} IWorkflowRuntime
 * @property {(query: WorkflowQuery, scope: RuntimeScope) => Promise<WorkflowDefinition[]>} search
 * @property {(def: WorkflowDefinition, scope: RuntimeScope) => Promise<WorkflowDefinition>} register
 * @property {(id: string, scope: RuntimeScope) => Promise<WorkflowDefinition | null>} read
 * @property {(id: string, patch: Partial<WorkflowDefinition>, scope: RuntimeScope) => Promise<WorkflowDefinition>} update
 * @property {(id: string, scope: RuntimeScope) => Promise<void>} delete
 * @property {(event: string, payload: Record<string, unknown>, scope: RuntimeScope) => Promise<WorkflowRun[]>} trigger
 * @property {(runId: string, scope: RuntimeScope) => Promise<WorkflowRun | null>} getRun
 */

/** Méthodes que tout adapter IWorkflowRuntime DOIT exposer. */
export const REQUIRED_METHODS = Object.freeze([
  "search",
  "register",
  "read",
  "update",
  "delete",
  "trigger",
  "getRun",
]);

/**
 * Vérifie structurellement qu'un objet satisfait le port IWorkflowRuntime.
 * @param {any} adapter
 * @returns {IWorkflowRuntime} le même adapter, quand valide
 */
export function assertWorkflowRuntime(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("IWorkflowRuntime: adapter must be an object");
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new Error(`IWorkflowRuntime: adapter missing method(s): ${missing.join(", ")}`);
  }
  return /** @type {IWorkflowRuntime} */ (adapter);
}

// ── Dispatcher de steps — seam Mastra (exécuteurs injectés) ─────────────────────

/**
 * Dispatcher composable : route chaque step vers l'exécuteur correspondant à son
 * `kind`. C'est le handler concret qu'on passe à InMemoryWorkflowRuntime (ou au
 * backend durable) pour brancher agents/skills/connecteurs sur les Tâches, sans
 * coupler le port au runtime agent. Un kind non câblé lève `STEP_EXECUTOR_MISSING:<kind>`.
 * @param {WorkflowStepExecutors} executors
 * @returns {WorkflowStepHandler}
 */
export function createWorkflowStepHandler(executors) {
  return async (ctx) => {
    const exec = executors[ctx.step.kind];
    if (!exec) throw new Error(`STEP_EXECUTOR_MISSING:${ctx.step.kind}`);
    return exec(ctx);
  };
}

// ── Planificateur pur — isCronDue ───────────────────────────────────────────────

/**
 * Vrai si l'expression `cron` (5 champs `min hour dom mon dow`, UTC) matche la
 * minute de `date`. Supporte wildcard, valeur, liste `a,b`, plage `a-b`, et pas
 * (`/n`). Règle standard jour : si `dom` ET `dow` restreints → OR ; sinon AND.
 * Minimal mais suffisant pour la planification des Tâches (§5), substituable.
 * @param {string} cron
 * @param {Date} date
 * @returns {boolean}
 */
export function isCronDue(cron, date) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  /**
   * @param {string} spec
   * @param {number} value
   * @param {number} lo
   * @param {number} hi
   * @returns {boolean}
   */
  const inField = (spec, value, lo, hi) => {
    for (const token of spec.split(",")) {
      const [range, stepRaw] = token.split("/");
      const step = stepRaw ? Number(stepRaw) : 1;
      if (!Number.isInteger(step) || step <= 0) return false;
      let start = lo;
      let end = hi;
      if (range !== "*" && range !== undefined) {
        const [a, b] = range.split("-");
        start = Number(a);
        end = b !== undefined ? Number(b) : start;
        if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
      }
      for (let v = start; v <= end; v += step) if (v === value) return true;
    }
    return false;
  };
  const minuteOk = inField(min, date.getUTCMinutes(), 0, 59);
  const hourOk = inField(hour, date.getUTCHours(), 0, 23);
  const monthOk = inField(mon, date.getUTCMonth() + 1, 1, 12);
  const domOk = inField(dom, date.getUTCDate(), 1, 31);
  const dowOk = inField(dow, date.getUTCDay(), 0, 6);
  const dayOk = dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
  return minuteOk && hourOk && monthOk && dayOk;
}

// ── InMemoryWorkflowRuntime — impl par défaut, scope-isolée ────────────────────

/**
 * Impl par défaut, scope-isolée par `tenantId`. Exécution synchrone déterministe des
 * steps (chaînés via `previous`), état de run persisté en mémoire : socle de test +
 * fallback avant le backend durable. Ce N'EST PAS un stub — les runs, leurs steps et
 * l'index de planification sont réels et inspectables.
 *   • Collision d'`id` sur `register` → `WORKFLOW_EXISTS` (pas d'écrasement).
 *   • À la 1re erreur de step le run s'arrête, statut `failed`, dernier step porte
 *     l'erreur (point de reprise inspectable).
 *   • `schedule` catalogué/indexé mais NON déclenché ici (pas d'horloge in-process :
 *     la planification est déléguée au backend durable, ADR §5).
 *   • Handler par défaut = identité (echo `previous` puis `event`) → utilisable sans
 *     Mastra ; le vrai handler s'injecte au constructeur.
 * @implements {IWorkflowRuntime}
 */
export class InMemoryWorkflowRuntime {
  /**
   * @param {WorkflowStepHandler} [handler] dispatcher de steps (défaut = identité)
   */
  constructor(handler = async (ctx) => ctx.previous ?? ctx.event) {
    /** @type {WorkflowStepHandler} */
    this._handler = handler;
    /** @type {Map<string, Map<string, WorkflowDefinition>>} */
    this._byTenant = new Map();
    /** @type {Map<string, Map<string, WorkflowRun>>} */
    this._runsByTenant = new Map();
    /** @type {Map<string, ScheduleEntry>} index de planif cross-tenant, clé `${tenantId} ${id}` */
    this._scheduleIndex = new Map();
    /** @type {number} */
    this._runSeq = 0;
  }

  /** Capacités du backend. */
  get capabilities() {
    return { backend: "memory", persistent: false, durable: false, native: false };
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Map<string, WorkflowDefinition>}
   */
  _defs(scope) {
    let b = this._byTenant.get(scope.tenantId);
    if (!b) {
      b = new Map();
      this._byTenant.set(scope.tenantId, b);
    }
    return b;
  }

  /**
   * @param {RuntimeScope} scope
   * @returns {Map<string, WorkflowRun>}
   */
  _runs(scope) {
    let b = this._runsByTenant.get(scope.tenantId);
    if (!b) {
      b = new Map();
      this._runsByTenant.set(scope.tenantId, b);
    }
    return b;
  }

  /**
   * @param {WorkflowQuery} query
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowDefinition[]>}
   */
  async search(query, scope) {
    const text = query.text?.toLowerCase();
    const tags = query.tags ?? [];
    return [...this._defs(scope).values()].filter((d) => {
      if (text) {
        const hay = `${d.name} ${d.description ?? ""}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      if (tags.length > 0) {
        const owned = new Set(d.tags ?? []);
        if (!tags.every((t) => owned.has(t))) return false;
      }
      return true;
    });
  }

  /**
   * Maintient l'index de planif pour une def (upsert si `schedule`, sinon purge).
   * @param {WorkflowDefinition} def
   * @param {RuntimeScope} scope
   */
  _indexSchedule(def, scope) {
    const key = `${scope.tenantId} ${def.id}`;
    if (def.trigger.type === "schedule") {
      this._scheduleIndex.set(key, { workflowId: def.id, cron: def.trigger.cron, scope });
    } else {
      this._scheduleIndex.delete(key);
    }
  }

  /**
   * @param {WorkflowDefinition} def
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowDefinition>}
   */
  async register(def, scope) {
    const b = this._defs(scope);
    if (b.has(def.id)) throw new Error("WORKFLOW_EXISTS");
    b.set(def.id, def);
    this._indexSchedule(def, scope);
    return def;
  }

  /**
   * Énumère (cross-tenant) les Tâches `schedule` indexées — socle du planificateur durable.
   * @returns {Promise<ScheduleEntry[]>}
   */
  async listSchedules() {
    return [...this._scheduleIndex.values()];
  }

  /**
   * @param {string} id
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowDefinition | null>}
   */
  async read(id, scope) {
    return this._defs(scope).get(id) ?? null;
  }

  /**
   * @param {string} id
   * @param {Partial<WorkflowDefinition>} patch
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowDefinition>}
   */
  async update(id, patch, scope) {
    const b = this._defs(scope);
    const current = b.get(id);
    if (!current) throw new Error("WORKFLOW_NOT_FOUND");
    /** @type {WorkflowDefinition} */
    const next = { ...current, ...patch, id };
    b.set(id, next);
    this._indexSchedule(next, scope);
    return next;
  }

  /**
   * @param {string} id
   * @param {RuntimeScope} scope
   * @returns {Promise<void>}
   */
  async delete(id, scope) {
    this._defs(scope).delete(id);
    this._scheduleIndex.delete(`${scope.tenantId} ${id}`);
  }

  /**
   * Émet un `event` : exécute chaque workflow `event` correspondant et retourne son
   * run durable. Aucun match ⇒ tableau vide (pas d'erreur).
   * @param {string} event
   * @param {Record<string, unknown>} payload
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowRun[]>}
   */
  async trigger(event, payload, scope) {
    const matched = [...this._defs(scope).values()].filter(
      (d) => d.trigger.type === "event" && d.trigger.event === event,
    );
    /** @type {WorkflowRun[]} */
    const runs = [];
    for (const def of matched) runs.push(await this._execute(def, payload, scope));
    return runs;
  }

  /**
   * @param {WorkflowDefinition} def
   * @param {Record<string, unknown>} payload
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowRun>}
   */
  async _execute(def, payload, scope) {
    /** @type {WorkflowRun} */
    const run = {
      id: `run-${++this._runSeq}`,
      workflowId: def.id,
      status: "completed",
      steps: [],
    };
    /** @type {unknown} */
    let previous = undefined;
    for (const step of def.steps) {
      try {
        const output = await this._handler({ step, scope, event: payload, previous });
        run.steps.push({ stepId: step.id, output });
        previous = output;
      } catch (err) {
        run.steps.push({
          stepId: step.id,
          error: err instanceof Error ? err.message : String(err),
        });
        run.status = "failed";
        break;
      }
    }
    if (run.status === "completed") run.output = previous;
    this._runs(scope).set(run.id, run);
    return run;
  }

  /**
   * @param {string} runId
   * @param {RuntimeScope} scope
   * @returns {Promise<WorkflowRun | null>}
   */
  async getRun(runId, scope) {
    return this._runs(scope).get(runId) ?? null;
  }
}

// ── Seam de composition/DI ─────────────────────────────────────────────────────

/**
 * Seam de composition du port ADR §3. Point unique où l'on câble l'impl
 * `IWorkflowRuntime`. Défaut = in-memory ; le backend durable (Inngest self-hosted)
 * s'y substitue via injection sans toucher les appelants.
 * @param {IWorkflowRuntime} [impl] impl injectée (défaut in-memory)
 * @returns {IWorkflowRuntime}
 */
export function createWorkflowRuntime(impl = new InMemoryWorkflowRuntime()) {
  return assertWorkflowRuntime(impl);
}

/**
 * @typedef {object} CreateWorkflowRuntimeResult
 * @property {IWorkflowRuntime} runtime
 * @property {string} backend
 * @property {boolean} durable
 */

/**
 * Sélection d'impl `IWorkflowRuntime` par ENV. Défaut = in-memory (déterministe,
 * sans dépendance serveur). `WORKFLOW_RUNTIME_PROVIDER=inngest` (ou `INNGEST_BASE_URL`
 * présent) demande le backend DURABLE — mais celui-ci dépend du package `inngest` et
 * n'est PAS bundlé dans le cœur (parité IToolResolver/S3) : il est fourni via
 * `opts.durableFactory` (injection consommateur). Le handler (seam Mastra §5) est
 * injecté par l'appelant : MÊME exécuteur de step quel que soit le backend. Sélection
 * réversible (aucun `INNGEST_*` ⇒ in-memory) ; provider=inngest sans factory injectée
 * → erreur explicite (doctrine §2 : dégradation explicite, pas de piège caché).
 * @param {object} [opts]
 * @param {WorkflowStepHandler} [opts.handler] dispatcher de steps injecté
 * @param {'auto'|'memory'|'inngest'} [opts.prefer] préférence (défaut env ou 'auto')
 * @param {(handler: WorkflowStepHandler, env: Record<string, string | undefined>) => Promise<IWorkflowRuntime>} [opts.durableFactory] fabrique du backend durable (consommateur)
 * @param {Record<string, string | undefined>} [opts.env] env (défaut process.env)
 * @returns {Promise<CreateWorkflowRuntimeResult>}
 */
export async function workflowRuntimeFromEnv(opts = {}) {
  const env = opts.env || (typeof process !== "undefined" && process.env ? process.env : {});
  const handler = opts.handler || (async (ctx) => ctx.previous ?? ctx.event);
  const provider =
    opts.prefer && opts.prefer !== "auto"
      ? opts.prefer
      : env["WORKFLOW_RUNTIME_PROVIDER"] ?? (env["INNGEST_BASE_URL"] ? "inngest" : "memory");

  if (provider === "memory") {
    const runtime = new InMemoryWorkflowRuntime(handler);
    return { runtime: assertWorkflowRuntime(runtime), backend: "memory", durable: false };
  }
  if (provider === "inngest") {
    if (typeof opts.durableFactory !== "function") {
      throw new Error(
        "workflowRuntimeFromEnv: provider='inngest' requires an injected `durableFactory` " +
          "(the durable backend depends on the `inngest` package and is not bundled in the core)",
      );
    }
    const runtime = await opts.durableFactory(handler, env);
    return { runtime: assertWorkflowRuntime(runtime), backend: "inngest", durable: true };
  }
  throw new Error(`Unknown WORKFLOW_RUNTIME_PROVIDER: ${provider}`);
}
