# ADR-0001 — `@ori3com/agent-core` : le socle agent partagé, canal-agnostique

> Statut : **Accepté — livré C01→C09** (2026-09-07 ; proposé 2026-09-06). Publication npm (C07)
> **DEPTH-BLOCKED** sur `NPM_TOKEN` (scaffolding livré, publish gated). · Repo dédié
> `dr-basalt/o3c-core` (doctrine « repo séparé », cf. `o3c-chat/.planning/adr/ADR-o3c-origin.md`).
> Décline `ADR-o3c-cognitive-engine.md` et `ADR-o3c-systeme-origin.md` (§3 core). Source
> d'extraction : `o3c-chat/packages/agent-runtime` (`@ori3com/agent-runtime`, déjà porté + testé
> par le loop o3c-systeme-origin).

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

> État de livraison (2026-09-07) : **C01–C06, C09 ✅ livrés** (typecheck + vitest verts, vrai
> code) ; **C07 ⏳ DEPTH-BLOCKED** — scaffolding de publication livré (allowlist, provenance,
> leakscan, `prepublishOnly`), publish npm réel gated sur `NPM_TOKEN` (secret absent) ;
> **C08 ⏳ DEPTH-BLOCKED** — aucun consommateur réel (grep `@ori3com/agent-core` = 0 dans
> o3c-code-cli + o3c-chat, lockfile = 0) ; déblocage impossible avant C07 (package non publié).

- **C01 ✅ — Skeleton package** : `@ori3com/agent-core`, ESM, build esbuild multi-cible (node + wasm-friendly),
  exports typés des ports, CI test. Smoke `import { ... } from '@ori3com/agent-core'`.
- **C02 ✅ — Extraire ports + ContextBuilder + Embedder + agent-factory** depuis `o3c-chat/packages/agent-runtime`
  (copie/refactor, **découplé de tout o3c-chat-specific** : pas de chatindex-sidecar, pas de BFF).
- **C03 ✅ — `ICognitiveMemory` unifié** : adapter cognee-rs (`@cognee/cognee-ts`, probe natif) + fallback
  pur-JS (TF·IDF) — **reprendre/converger l'impl P02 de o3c-code-cli**. Contract-tests.
- **C04 ✅ — Seam LLM** : `llmFromEnv()` → `api.ori3com.cloud` (openai-compatible) + cascade SLM local. IT live.
- **C05 ✅ — `fromEnv` seams** : sélection substituable des backends (memory/vector/graph/storage) par env,
  natives en dynamic-import (jamais tirées quand non utilisées). Dégradation réversible.
- **C06 ✅ — Build targets verts** : node natif **et** cible WASM-friendly ; contract-tests sur les 2 chemins.
- **C07 ⏳ — Publication npm** `@ori3com/agent-core` (files allowlist, provenance, leakscan) — **DEPTH-BLOCKED** :
  scaffolding + `prepublishOnly` livrés, `npm publish` réel gated `NPM_TOKEN` (secret absent).
- **C08 ⏳ — Convergence consommateurs** : o3c-code-cli + chat2 `agent-runtime` dépendent de `@ori3com/agent-core`
  (retirer les impls dupliquées) ; IT de non-régression côté consommateurs.
  **DEPTH-BLOCKED reason=NPM_TOKEN** : dépend de C07 (package publié) — impossible d'importer un
  package privé/non-publié. Aujourd'hui o3c-code-cli a sa propre `ICognitiveMemory` locale (`src/agent-core/memory/`)
  et chat2 a `@ori3com/agent-runtime` local : deux impls dupliquées non convergées. Vérification : 2026-09-07,
  `grep -rn "@ori3com/agent-core" o3c-code-cli/ o3c-chat/` = **0 résultat**.
- **C09 ✅ — Cible WASM EXÉCUTABLE + hook RuntimeBroker** (au-delà du « wasm-friendly » de C06) : produire un
  artefact `@ori3com/agent-core` **réellement exécutable en WASM** (navigateur / Cloudflare Worker / WebVM) —
  cœur Mastra+ports en WASM, cognee-rs via son core Rust→WASM (fallback pur-JS sinon), LLM via fetch
  `api.ori3com.cloud`. **DoD** : un smoke réel « import + `remember`/`recall` » tourne **dans un runtime WASM**
  (ex. Node avec WASI ou headless-browser), pas seulement « ne casse pas ». Exposer l'interface
  **`RuntimeBroker`** (`invoke(workload, ctx)`) que l'IHM appelle en boîte-noire — le placement/handoff
  (local/wasm/webvm/edge/cloud) est opaque au frontend (cf. `ADR-o3c-portability-handoff.md`). L'état
  `.lbug`+session reste **portable sur storage account-keyed** → handoff par checkpoint. Sans hôte glibc/WASM
  dispo → STATUS=DEPTH-BLOCKED reason=wasm-runtime, jamais DONE sur un « ne casse pas ».

## 5. Loop autonome `autonome-o3c-core` (cron OpenClaw fly)

Même machinerie phase-aware (`cloudcli_autopilot_ws.cjs` + wrapper), `PROJECT_PATH=/home/cloudcli/workspace/o3c-core`,
goal = progresser cet ADR-0001 phase par phase (Cxx), même conversation cloudcli tant que non `DONE`, DoD durcie,
arbitrage autonome. Peut lire `o3c-chat/packages/agent-runtime` (même filesystem) comme source d'extraction.
