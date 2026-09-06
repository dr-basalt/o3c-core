# @ori3com/agent-core

Le **socle agent partagé, canal-agnostique** de l'écosystème o3c : orchestration **Mastra** + **ports
substituables** (mémoire/vecteur/graphe/tools/workflow/storage) + seam LLM unique **`api.ori3com.cloud`**.

Consommé **à l'identique** par `o3c-code-cli`, `o3c-work`, `o3c-browser`, `chat2`, `mcp`. Edge-clean
(deps natives optionnelles + dynamic-import), **build multi-cible** (node natif + WASM-friendly) →
tourne du pod k8s au worker au navigateur (WebVM/WASM).

- Mémoire (« cerveau ») : port `ICognitiveMemory` → cognee-rs (`@cognee/cognee-ts`) + fallback pur-JS.
- LLM : `api.ori3com.cloud` (openai-compatible) + cascade SLM local.

Statut : **en construction** (ADR `docs/adr/0001-o3c-core.md`, phases C01→C08, loop autonome).
Extrait de `@ori3com/agent-runtime`. Voir la doctrine racine `o3c-origin`.
