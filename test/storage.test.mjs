// C05 — IStorageLayer unifié. Contract-tests du fallback in-memory WASM-clean, de
// l'adapter fs (node:fs en dynamic-import, anti-traversal) et du seam
// `createStorageLayer` (s3→fs→memory, dégradation RÉVERSIBLE). Extrait/refactoré
// depuis o3c-chat/packages/agent-runtime, DÉCOUPLÉ des registres skills/prompts/tools.
// L'adapter S3 n'est PAS testé live ici (pas de credential) — seule sa sélection et
// sa validation d'args le sont ; l'IT live reste gated (creds ~/.o3c-it.env).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStorageLayer,
  FsStorageLayer,
  S3StorageLayer,
  createStorageLayer,
  assertStorageLayer,
  isS3Available,
  REQUIRED_METHODS,
} from "../src/storage.mjs";

/** Round-trip commun à tout adapter satisfaisant le port. */
async function assertRoundTrip(storage) {
  const bytes = new TextEncoder().encode("hello world");
  await storage.put("a/b/c.txt", bytes);
  const got = await storage.get("a/b/c.txt");
  expect(got).not.toBeNull();
  expect(new TextDecoder().decode(got)).toBe("hello world");
  expect(await storage.get("missing")).toBeNull();

  await storage.put("a/b/d.txt", "second");
  await storage.put("z/other.txt", "third");
  const listed = await storage.list("a/b/");
  expect(listed.sort()).toEqual(["a/b/c.txt", "a/b/d.txt"]);

  await storage.delete("a/b/c.txt");
  expect(await storage.get("a/b/c.txt")).toBeNull();
}

describe("MemoryStorageLayer (pure-JS, WASM-clean default)", () => {
  it("satisfies the IStorageLayer port contract", () => {
    const s = new MemoryStorageLayer();
    expect(() => assertStorageLayer(s)).not.toThrow();
    for (const m of REQUIRED_METHODS) expect(typeof s[m]).toBe("function");
    expect(s.capabilities).toMatchObject({ backend: "memory", persistent: false, native: false });
  });

  it("round-trips put/get/list/delete", async () => {
    await assertRoundTrip(new MemoryStorageLayer());
  });

  it("accepts string data and returns an isolated copy on get", async () => {
    const s = new MemoryStorageLayer();
    await s.put("k", "abc");
    const a = await s.get("k");
    a[0] = 0; // muter le retour ne doit pas corrompre le store
    expect(new TextDecoder().decode(await s.get("k"))).toBe("abc");
  });
});

describe("FsStorageLayer (fs adapter, node:fs dynamic-import)", () => {
  /** @type {string[]} */
  const roots = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });

  async function freshRoot() {
    const r = await mkdtemp(join(tmpdir(), "o3c-store-"));
    roots.push(r);
    return r;
  }

  it("satisfies the port and reports durable capabilities", () => {
    const s = new FsStorageLayer("/tmp/x");
    expect(() => assertStorageLayer(s)).not.toThrow();
    expect(s.capabilities).toMatchObject({ backend: "fs", persistent: true });
  });

  it("requires a root", () => {
    expect(() => new FsStorageLayer("")).toThrow(/root/);
  });

  it("round-trips durably to disk", async () => {
    const root = await freshRoot();
    const s = new FsStorageLayer(root);
    await assertRoundTrip(s);
    // durabilité : les octets sont réellement sur disque
    await s.put("deep/nested/file.bin", new Uint8Array([1, 2, 3]));
    const onDisk = await readFile(join(root, "deep/nested/file.bin"));
    expect([...onDisk]).toEqual([1, 2, 3]);
  });

  it("survives a fresh instance on the same root (persistent)", async () => {
    const root = await freshRoot();
    await new FsStorageLayer(root).put("k.txt", "persisted");
    const reopened = await new FsStorageLayer(root).get("k.txt");
    expect(new TextDecoder().decode(reopened)).toBe("persisted");
  });

  it("rejects path traversal outside root", async () => {
    const root = await freshRoot();
    const s = new FsStorageLayer(root);
    await expect(s.get("../escape")).rejects.toThrow(/escape(s)? root/i);
    await expect(s.put("../../etc/passwd", "x")).rejects.toThrow(/root/);
  });
});

describe("S3StorageLayer (native adapter, no live creds)", () => {
  it("validates its constructor args", () => {
    const mod = { S3Client: class {} };
    expect(() => new S3StorageLayer(null, { endpoint: "e", bucket: "b" })).toThrow(
      /@aws-sdk\/client-s3/,
    );
    expect(() => new S3StorageLayer(mod, { bucket: "b" })).toThrow(/endpoint/);
    expect(() => new S3StorageLayer(mod, { endpoint: "e" })).toThrow(/bucket/);
  });

  it("maps put/get/list onto the S3 command surface", async () => {
    /** @type {any[]} */
    const sent = [];
    class S3Client {
      constructor(cfg) {
        this.cfg = cfg;
      }
      async send(cmd) {
        sent.push(cmd);
        if (cmd.__type === "get") {
          return { Body: { async transformToByteArray() {
            return new TextEncoder().encode("body");
          } } };
        }
        if (cmd.__type === "list") {
          return { Contents: [{ Key: "p/a" }, { Key: "p/b" }], IsTruncated: false };
        }
        return {};
      }
    }
    const mod = {
      S3Client,
      GetObjectCommand: class { constructor(i) { Object.assign(this, i); this.__type = "get"; } },
      PutObjectCommand: class { constructor(i) { Object.assign(this, i); this.__type = "put"; } },
      DeleteObjectCommand: class { constructor(i) { Object.assign(this, i); this.__type = "del"; } },
      ListObjectsV2Command: class { constructor(i) { Object.assign(this, i); this.__type = "list"; } },
    };
    const s = new S3StorageLayer(mod, { endpoint: "https://s3", bucket: "bkt" });
    expect(s.capabilities).toMatchObject({ backend: "s3", native: true });

    await s.put("p/a", "x");
    expect(sent.at(-1)).toMatchObject({ __type: "put", Bucket: "bkt", Key: "p/a" });

    const got = await s.get("p/a");
    expect(new TextDecoder().decode(got)).toBe("body");

    const keys = await s.list("p/");
    expect(keys).toEqual(["p/a", "p/b"]);
  });
});

describe("createStorageLayer (fromEnv seam)", () => {
  it("falls back to in-memory when nothing is configured", async () => {
    const { storage, backend, nativeAvailable } = await createStorageLayer({ prefer: "memory" });
    expect(() => assertStorageLayer(storage)).not.toThrow();
    expect(backend).toBe("memory");
    expect(nativeAvailable).toBe(false);
  });

  it("selects fs when a root is provided", async () => {
    const { storage, backend } = await createStorageLayer({ prefer: "fs", root: "/tmp/o3c-x" });
    expect(backend).toBe("fs");
    expect(storage).toBeInstanceOf(FsStorageLayer);
  });

  it("auto-selects fs over memory when a root is given, s3 SDK not required", async () => {
    const s3 = await isS3Available();
    const { backend } = await createStorageLayer({ root: "/tmp/o3c-y" });
    expect(backend).toBe("fs");
    expect(typeof s3).toBe("boolean");
  });

  it("throws for prefer='s3' with no config (never silently degrades)", async () => {
    await expect(createStorageLayer({ prefer: "s3" })).rejects.toThrow(/S3 config/);
  });
});
