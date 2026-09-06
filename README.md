# @ori3com/agent-core

Le **socle agent partagé, canal-agnostique** de l'écosystème o3c : orchestration **Mastra** + **ports
substituables** (mémoire/vecteur/graphe/tools/workflow/storage) + seam LLM unique **`api.ori3com.cloud`**.

Consommé **à l'identique** par `o3c-code-cli`, `o3c-work`, `o3c-browser`, `chat2`, `mcp`. Edge-clean
(deps natives optionnelles + dynamic-import), **build multi-cible** (node natif + WASM-friendly) →
tourne du pod k8s au worker au navigateur (WebVM/WASM).

- Mémoire (« cerveau ») : port `ICognitiveMemory` → cognee-rs (`@cognee/cognee-ts`) + fallback pur-JS.
- LLM : `api.ori3com.cloud` (openai-compatible) + cascade SLM local.

## Consommateurs — convergence & conformance (C08)

`npm i @ori3com/agent-core` (ou dépendance `file:`/git tant que la publication npm est gated).
Chaque canal retire ses impls dupliquées et dépend du core — guide de migration symbole-par-symbole
(o3c-code-cli + chat2), avec dégradation et parité vérifiées : [`docs/consumer-convergence.md`](docs/consumer-convergence.md).

Vérifiez vos **backends injectés** (S3/object-store, cognee-rs, cozo/zvec, LanceDB, Inngest, Nango/MCP…)
contre le contrat comportemental de chaque port avec la conformance kit :

```js
import { checkPortConformance } from "@ori3com/agent-core/conformance";
const report = await checkPortConformance("IVectorMemory", () => new MyVectorBackend());
// report = { ok, passed, failed, checks: [{ name, ok, error? }] }
```

Statut : **en construction** (ADR `docs/adr/0001-o3c-core.md`, phases C01→C08, loop autonome).
Extrait de `@ori3com/agent-runtime`. Voir la doctrine racine `o3c-origin`.
