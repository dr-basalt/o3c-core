# ADR-0001 — `@ori3com/agent-core` : le socle agent partagé, canal-agnostique

> Statut : **Proposé** (2026-09-06) · Repo dédié `dr-basalt/o3c-core` (doctrine « repo séparé »,
> cf. `o3c-chat/.planning/adr/ADR-o3c-origin.md`). Décline `ADR-o3c-cognitive-engine.md` et
> `ADR-o3c-systeme-origin.md` (§3 core). Source d'extraction : `o3c-chat/packages/agent-runtime`
> (`@ori3com/agent-runtime`, déjà porté + testé par le loop o3c-systeme-origin).

---

## 1. Décision

Extraire un package **publiable, canal-agnostique** `@ori3com/agent-core` = **le core partagé** que
**tous** les canaux consomment À L'IDENTIQUE (o3c-code-cli, o3c-work, o3c-browser, chat2, mcp) :
- **Orchestration** : Mastra (agent-factory, `materializeAgent`, ContextBuilder).
- **Ports substituables** : `ICognitiveMemory`, `IVectorMemory`, `IBrainMemory`, `IGraphStore`,
  `IToolResolver`, `IWorkflowRuntime`, `Embedder`, `IStorageLayer` — chacun + `fromEnv` seam.
- **Seam LLM unique** : `api.ori3com.cloud` (openai-compatible), cascade SLM local.
- **Edge-clean** : deps natives (cognee-rs/zvec/lancedb) en `optionalDependencies` + dynamic-import ;
  cœur pur-TS → **build multi-cible** (node natif + WASM-friendly), aligné doctrine portabilité N-axes.

**But** : dé-dupliquer (o3c-code-cli a dû se faire une impl bespoke `ICognitiveMemory` en P02 — elle
converge ici) et **débloquer tous les canaux downstream** (chacun `npm i @ori3com/agent-core`).

## 2. Ce que le package N'EST PAS

Pas de logique spécifique canal (pas d'UI, pas de CLI, pas de BFF chat2). Pas de backend concret couplé
(les backends = impls derrière ports, injectées par le consommateur via `fromEnv`/DI). Pas de secret.

## 3. Réserves (héritées)

cognee-rs early-stage (isolé derrière `ICognitiveMemory`, fallback pur-JS) · natif bloqué glibc 2.36<2.38
sur certains hôtes → fallback/WASM · publication gated `NPM_TOKEN`.

## 4. Roadmap phases (Cxx — DoD tests-first : typecheck+build+tests VERTS, pas de squelette)

- **C01 — Skeleton package** : `@ori3com/agent-core`, ESM, build esbuild multi-cible (node + wasm-friendly),
  exports typés des ports, CI test. Smoke `import { ... } from '@ori3com/agent-core'`.
- **C02 — Extraire ports + ContextBuilder + Embedder + agent-factory** depuis `o3c-chat/packages/agent-runtime`
  (copie/refactor, **découplé de tout o3c-chat-specific** : pas de chatindex-sidecar, pas de BFF).
- **C03 — `ICognitiveMemory` unifié** : adapter cognee-rs (`@cognee/cognee-ts`, probe natif) + fallback
  pur-JS (TF·IDF) — **reprendre/converger l'impl P02 de o3c-code-cli**. Contract-tests.
- **C04 — Seam LLM** : `llmFromEnv()` → `api.ori3com.cloud` (openai-compatible) + cascade SLM local. IT live.
- **C05 — `fromEnv` seams** : sélection substituable des backends (memory/vector/graph/storage) par env,
  natives en dynamic-import (jamais tirées quand non utilisées). Dégradation réversible.
- **C06 — Build targets verts** : node natif **et** cible WASM-friendly ; contract-tests sur les 2 chemins.
- **C07 — Publication npm** `@ori3com/agent-core` (files allowlist, provenance, leakscan) — gated `NPM_TOKEN`.
- **C08 — Convergence consommateurs** : o3c-code-cli + chat2 `agent-runtime` dépendent de `@ori3com/agent-core`
  (retirer les impls dupliquées) ; IT de non-régression côté consommateurs.

## 5. Loop autonome `autonome-o3c-core` (cron OpenClaw fly)

Même machinerie phase-aware (`cloudcli_autopilot_ws.cjs` + wrapper), `PROJECT_PATH=/home/cloudcli/workspace/o3c-core`,
goal = progresser cet ADR-0001 phase par phase (Cxx), même conversation cloudcli tant que non `DONE`, DoD durcie,
arbitrage autonome. Peut lire `o3c-chat/packages/agent-runtime` (même filesystem) comme source d'extraction.
