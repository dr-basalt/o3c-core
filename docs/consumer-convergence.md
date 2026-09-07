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

## RuntimeBroker — the black-box capstone (C09) + checkpoint handoff

Consumers don't have to wire the 8 ports by hand. `runtimeBrokerFromEnv()` is the capstone
seam: it assembles every port via its own `fromEnv` (natives dynamic-imported, reversible
degradation) and returns **one black-box broker**. The UI calls `broker.invoke(workload,
ctx)` and never learns a single backend — the *placement* (local / wasm / edge / cloud) is
opaque and only reported for observability.

```js
import { runtimeBrokerFromEnv } from "@ori3com/agent-core";

const { broker, backends } = await runtimeBrokerFromEnv({ projectId: "my-app" });
const ctx = { scope: { tenantId: "acme", userId: "u1", projectId: "my-app" } };
await broker.invoke({ kind: "memory.remember", item: { text: "…" } }, ctx);
const { output } = await broker.invoke({ kind: "memory.recall", query: "…", k: 3 }, ctx);
// backends = { cognitive, vector, brain, graph, workflow, storage, llm } — effective picks
```

Workload `kind`s route to the ports (see `WORKLOAD_KINDS`): `memory.remember|recall`,
`vector.upsert|query`, `brain.consolidate|recall`, `graph.upsert|query`, `workflow.trigger`,
`tools.resolve`, `llm.chat`. A required-but-unwired port fails explicitly with
`PORT_UNAVAILABLE:<port>` (never a silent trap).

**Handoff by checkpoint.** Session state (`.lbug` + session, opaque JSON) is persisted on
the `IStorageLayer` under a deterministic **account-keyed** path
(`checkpoints/<tenant>/<project>/<user>/<stateKey>.json`). Because the key depends only on
the scope + `stateKey` — not the placement — a broker on *any* runtime restores the same
state, so a session started local can resume on wasm/edge/cloud transparently:

```js
await broker.checkpoint({ scope, stateKey: "conv-77" }, { lbug, draft });
// …later, on a different placement sharing the same account-keyed storage:
const resumed = await broker.restore({ scope, stateKey: "conv-77" }); // { state, scope, stateKey } | null
```

The checkpoint codec is pure-JS UTF-8 (no `TextEncoder`/`TextDecoder`), so it runs even in
minimal WASM runtimes (QuickJS) — proven by the executable-WASM smoke, where a broker
checkpoints inside WASM and another placement restores it losslessly.

**Verify your own broker.** A consumer providing a *distributed* broker (real handoff)
proves the contract the UI relies on with `checkRuntimeBrokerConformance` — invoke
validation, unknown-kind rejection, the `{placement, kind, output}` envelope, the
account-keyed checkpoint round-trip, per-tenant isolation, and — the heart of C09 — that a
checkpoint written by one broker instance is **restored by a second instance on a different
placement** (the checkpoint/handoff checks skip gracefully if the broker omits
`checkpoint`/`restore`):

```js
import { checkRuntimeBrokerConformance } from "@ori3com/agent-core/conformance";
// The factory is called more than once; the instances MUST share the same account-keyed
// storage (external object store — never an in-memory layer built per call), or the
// cross-instance handoff check fails. That failure is the point: two placements that can't
// see each other's checkpoints are not a handoff.
const shared = makeMyAccountKeyedStore();
const report = await checkRuntimeBrokerConformance(() => new MyDistributedBroker({ storage: shared }));
expect(report.ok).toBe(true);
```

## Non-regression gate

After swapping, each consumer runs its own suite; the core guarantees the contracts are
identical via the parity ITs listed above, and each injected backend is verified by the
conformance kit. A consumer swap that changes observable behaviour will diverge from these
pinned contracts.
