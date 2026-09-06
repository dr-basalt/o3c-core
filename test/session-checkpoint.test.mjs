// C09 — SessionCheckpoint : le « handoff par checkpoint ». On vérifie que l'état d'une
// session est persisté sur l'IStorageLayer sous une clé ACCOUNT-KEYED déterministe, qu'un
// broker sur un AUTRE placement (storage partagé) restaure le MÊME état sans connaître le
// backend, que la clé isole par tenant/projet/user et résiste à la traversée, et que la
// dégradation est explicite (version inconnue → erreur, absent → null).
import { describe, it, expect } from "vitest";
import { MemoryStorageLayer } from "../src/storage.mjs";
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  checkpointKey,
  utf8Encode,
  utf8Decode,
  CHECKPOINT_VERSION,
  CHECKPOINT_PREFIX,
} from "../src/session-checkpoint.mjs";
import { LocalRuntimeBroker } from "../src/runtime-broker.mjs";

/** @type {import("../src/ports.mjs").RuntimeScope} */
const scope = { tenantId: "acme", userId: "u1", projectId: "p1" };

describe("checkpointKey", () => {
  it("is deterministic and account-keyed (tenant is the top partition)", () => {
    const k = checkpointKey(scope, "sess-42");
    expect(k).toBe(`${CHECKPOINT_PREFIX}/acme/p1/u1/sess-42.json`);
    expect(checkpointKey(scope, "sess-42")).toBe(k); // same inputs → same key
  });

  it("defaults stateKey to 'default' and fills missing scope segments", () => {
    expect(checkpointKey({ tenantId: "acme" })).toBe(
      `${CHECKPOINT_PREFIX}/acme/_/_/default.json`
    );
  });

  it("isolates by tenant / project / user", () => {
    const a = checkpointKey({ tenantId: "acme", projectId: "p1" }, "s");
    const b = checkpointKey({ tenantId: "acme", projectId: "p2" }, "s");
    const c = checkpointKey({ tenantId: "other", projectId: "p1" }, "s");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("neutralises path traversal in every segment", () => {
    const k = checkpointKey({ tenantId: "../../etc", projectId: "..", userId: "a/b" }, "../x");
    expect(k).not.toMatch(/\.\.|\/etc|a\/b/);
    expect(k.startsWith(`${CHECKPOINT_PREFIX}/`)).toBe(true);
  });

  it("requires a tenantId (the account key)", () => {
    expect(() => checkpointKey(/** @type {any} */ ({}), "s")).toThrow(/tenantId/);
  });
});

describe("utf8 codec (WASM-portable, no TextEncoder/TextDecoder)", () => {
  it("round-trips ASCII, multibyte and astral (emoji) code points", () => {
    for (const s of ["", "hello", "résumé élève", "→ ✅ café", "𝕏 emoji 😀🚀", "ünïçödé"]) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });

  it("agrees byte-for-byte with the platform TextEncoder", () => {
    const s = "résumé ✅ élève 😀";
    expect(Array.from(utf8Encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
  });
});

describe("save / load / delete", () => {
  it("round-trips opaque session state (.lbug + session)", async () => {
    const storage = new MemoryStorageLayer();
    const ctx = { scope, stateKey: "sess-1" };
    const state = { lbug: { pc: 12, frames: ["a", "b"] }, session: { turns: 3 } };

    const { key, envelope } = await saveCheckpoint(storage, ctx, state);
    expect(key).toBe(checkpointKey(scope, "sess-1"));
    expect(envelope.v).toBe(CHECKPOINT_VERSION);

    const loaded = await loadCheckpoint(storage, ctx);
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toEqual(state);
    expect(loaded?.scope).toEqual(scope);
    expect(loaded?.stateKey).toBe("sess-1");
  });

  it("returns null when no checkpoint exists", async () => {
    const storage = new MemoryStorageLayer();
    expect(await loadCheckpoint(storage, { scope, stateKey: "nope" })).toBeNull();
  });

  it("overwrites on re-save (last write wins)", async () => {
    const storage = new MemoryStorageLayer();
    const ctx = { scope, stateKey: "s" };
    await saveCheckpoint(storage, ctx, { n: 1 });
    await saveCheckpoint(storage, ctx, { n: 2 });
    expect((await loadCheckpoint(storage, ctx))?.state).toEqual({ n: 2 });
  });

  it("deletes a checkpoint", async () => {
    const storage = new MemoryStorageLayer();
    const ctx = { scope, stateKey: "s" };
    await saveCheckpoint(storage, ctx, { n: 1 });
    await deleteCheckpoint(storage, ctx);
    expect(await loadCheckpoint(storage, ctx)).toBeNull();
  });

  it("rejects an unsupported checkpoint version (explicit degradation)", async () => {
    const storage = new MemoryStorageLayer();
    const key = checkpointKey(scope, "s");
    await storage.put(key, JSON.stringify({ v: 999, scope, stateKey: "s", state: {} }));
    await expect(loadCheckpoint(storage, { scope, stateKey: "s" })).rejects.toThrow(/version/);
  });

  it("rejects a corrupt checkpoint payload", async () => {
    const storage = new MemoryStorageLayer();
    await storage.put(checkpointKey(scope, "s"), "{not json");
    await expect(loadCheckpoint(storage, { scope, stateKey: "s" })).rejects.toThrow(/corrupt/);
  });
});

describe("listCheckpoints", () => {
  it("lists stateKeys for an account, scoped to its tenant", async () => {
    const storage = new MemoryStorageLayer();
    await saveCheckpoint(storage, { scope, stateKey: "s1" }, {});
    await saveCheckpoint(storage, { scope, stateKey: "s2" }, {});
    await saveCheckpoint(storage, { scope: { tenantId: "other" }, stateKey: "z" }, {});

    const keys = await listCheckpoints(storage, scope);
    expect(keys.sort()).toEqual(["s1", "s2"]);
    expect(await listCheckpoints(storage, { tenantId: "other" })).toEqual(["z"]);
  });
});

describe("handoff via a shared storage (the C09 DoD)", () => {
  it("a broker on another placement restores the same state — placement opaque", async () => {
    // Un storage account-keyed partagé = le medium de handoff. Deux brokers, deux
    // placements différents, AUCUN ne connaît le backend de l'autre.
    const storage = new MemoryStorageLayer();
    const ctx = { scope, stateKey: "conv-77" };

    const local = new LocalRuntimeBroker({ storage, placement: "local" });
    await local.checkpoint(ctx, { lbug: { pc: 5 }, draft: "hello" });

    const edge = new LocalRuntimeBroker({ storage, placement: "edge" });
    const resumed = await edge.restore(ctx);
    expect(resumed?.state).toEqual({ lbug: { pc: 5 }, draft: "hello" });
    // Le placement du broker qui restaure diffère de celui qui a checkpointé.
    expect(edge.placement).toBe("edge");
  });

  it("checkpoint/restore require the storage port (explicit PORT_UNAVAILABLE)", async () => {
    const broker = new LocalRuntimeBroker({}); // pas de storage injecté
    await expect(broker.checkpoint({ scope }, {})).rejects.toThrow(/PORT_UNAVAILABLE:storage/);
    await expect(broker.restore({ scope })).rejects.toThrow(/PORT_UNAVAILABLE:storage/);
  });
});
