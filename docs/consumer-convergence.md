# Consumer convergence guide — C08

> How each downstream channel drops its duplicated agent-core impls and depends on
> **`@ori3com/agent-core`** instead. Every replacement mapping below is enforced by
> `test/convergence-map.test.mjs` (it fails if a claimed core export disappears) and
> the drop-in behaviour is pinned by the parity ITs
> (`test/consumer-parity.test.mjs`, `test/consumer-parity-chat.test.mjs`) plus the
> real installable-artifact check (`test/packaged-consumption.test.mjs`).

## Consuming the package

Until C07 publish is unblocked (`NPM_TOKEN`), consumers depend on the package via a
`file:`/git dependency; the surface and resolution are identical to a published
`npm i @ori3com/agent-core` (proven by `packaged-consumption.test.mjs`):

```jsonc
// consumer package.json
"dependencies": { "@ori3com/agent-core": "file:../o3c-core" }
```

```js
import { createCognitiveMemory, ContextBuilder } from "@ori3com/agent-core";
import { PORT_NAMES } from "@ori3com/agent-core/ports";
```

## o3c-code-cli — `src/agent-core/memory/*`

| Duplicated (bespoke P02)                     | Replace with `@ori3com/agent-core`                              |
| -------------------------------------------- | -------------------------------------------------------------- |
| `memory/ICognitiveMemory.mjs`                | `REQUIRED_METHODS`, `assertCognitiveMemory`                    |
| `memory/adapters/local.mjs`                  | `LocalCognitiveMemory` + `FsStorageLayer` (injected persistence) |
| `memory/adapters/cognee.mjs`                 | `CogneeCognitiveMemory`, `loadCognee`, `isCogneeAvailable`      |
| `memory/index.mjs`                           | `createCognitiveMemory`, `buildMemorySeed`                     |

The bespoke local adapter wrote JSONL directly via `node:fs` to `~/.o3c/brain/<id>.jsonl`.
The core keeps the same JSONL semantics but through the injected `IStorageLayer` seam —
converge by pointing an `FsStorageLayer` at the brain dir:

```js
import { createCognitiveMemory, FsStorageLayer } from "@ori3com/agent-core";
const storage = new FsStorageLayer(`${os.homedir()}/.o3c/brain`);
const { memory } = await createCognitiveMemory({ projectId, storage, key: `${projectId}.jsonl` });
```

**Keep (channel-specific, rebuilt on the core):** `memory/hydrate.mjs` (session-history
salience), `memory/lifecycle.mjs`, `memory/sync.mjs` (brain push/pull) — these compose
on top of the core `ICognitiveMemory`, they are not part of the shared surface.

## chat2 `@ori3com/agent-runtime` — `src/{context-builder,scope,agent-factory}.ts`

| Duplicated                          | Replace with `@ori3com/agent-core`                                    |
| ----------------------------------- | -------------------------------------------------------------------- |
| `context-builder.ts` `ContextBuilder` | `ContextBuilder`                                                    |
| `scope.ts` `S3PathBuilder`          | `S3PathBuilder`                                                       |
| `agent-factory.ts` `RequestContext` / `buildRequestContext` | `RequestContext`, `buildRequestContext`              |
| `agent-factory.ts` `materializeAgent` | `materializeAgent` → returns an `AgentBlueprint`; wrap once with Mastra |

`materializeAgent` in the core is deliberately Mastra/@ai-sdk-free: it returns an
`AgentBlueprint` and resolves the model through the injected `modelProvider` seam (C04).
chat2 keeps its `litellm()` provider and the one-line Mastra wrapper:

```js
import { materializeAgent } from "@ori3com/agent-core";
const bp = materializeAgent(spec, envelope, { modelProvider: (id) => litellm()(id), tools });
return new Agent({ id: bp.id, name: bp.name, instructions: bp.instructions, model: bp.model, tools: bp.tools });
```

**Keep (channel-specific):** `scope.ts` DB seams `buildRuntimeScope` / `listUserProjects`
(drizzle/`@ori3com/db`) and the concrete `litellm()` provider — these are the consumer's
injected backends, not shared core.

## Conformance kit — verify your own injected backends

The parity ITs cover the core's reference adapters. But each consumer injects its *own*
durable backends behind the substitutable ports (S3/object-store, cognee-rs, cozo/zvec,
Neo4j, Inngest, LanceDB, LiteLLM, Nango/MCP). `@ori3com/agent-core/conformance` ships a
framework-agnostic behavioral checker per port so a consumer proves its backend satisfies
the port contract inside its own runner — no vitest/jest dependency in the kit:

```js
import { checkPortConformance } from "@ori3com/agent-core/conformance";
const report = await checkPortConformance("IVectorMemory", () => new MyCozoVectorMemory());
expect(report.ok).toBe(true); // report.checks = one {name, ok, error?} per behavioral assertion
```

One checker per substitutable port (registry keyed exactly to `PORT_NAMES`, so no port can
lack a checker):

| Port              | Checker                             |
| ----------------- | ----------------------------------- |
| `ICognitiveMemory` | `checkCognitiveMemoryConformance`  |
| `IVectorMemory`    | `checkVectorMemoryConformance`     |
| `IBrainMemory`     | `checkBrainMemoryConformance`      |
| `IGraphStore`      | `checkGraphStoreConformance`       |
| `IToolResolver`    | `checkToolResolverConformance`     |
| `IWorkflowRuntime` | `checkWorkflowRuntimeConformance`  |
| `Embedder`         | `checkEmbedderConformance`         |
| `IStorageLayer`    | `checkStorageLayerConformance`     |

Use `checkPortConformance(portName, makeAdapter)` to dispatch by name (iterate all your
backends generically), or import a specific checker directly. Each returns
`{ ok, passed, failed, checks }` and never throws — a failing check reports precisely which
behavioral guarantee the backend broke.

## Non-regression gate

After swapping, each consumer runs its own suite; the core guarantees the contracts are
identical via the parity ITs listed above, and each injected backend is verified by the
conformance kit. A consumer swap that changes observable behaviour will diverge from these
pinned contracts.
