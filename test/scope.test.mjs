// C02 — S3PathBuilder : clés de stockage dérivées exclusivement du scope serveur.
// Vérifie l'arborescence multi-tenant et la sécurisation des noms de fichiers client.
import { describe, it, expect } from "vitest";
import { S3PathBuilder } from "../src/scope.mjs";

/** @type {import("../src/scope.mjs").RuntimeScope} */
const SCOPE = {
  tenantId: "t1",
  userId: "u1",
  projectId: "p1",
  agentId: "a1",
  threadId: "th1",
};

describe("S3PathBuilder", () => {
  const b = new S3PathBuilder(SCOPE);

  it("builds a tenant-rooted, project-scoped tree", () => {
    expect(b.tenantRoot()).toBe("tenants/t1");
    expect(b.projectRoot()).toBe("tenants/t1/projects/p1");
    expect(b.agentRoot()).toBe("tenants/t1/projects/p1/agents/a1");
    expect(b.threadRoot()).toBe("tenants/t1/projects/p1/threads/th1");
  });

  it("zero-pads message sequence numbers", () => {
    expect(b.message(7)).toBe("tenants/t1/projects/p1/threads/th1/messages/000007.json");
  });

  it("routes agent instructions and chatindex snapshots", () => {
    expect(b.agentInstructions("persona.md")).toBe(
      "tenants/t1/projects/p1/agents/a1/instructions/persona.md",
    );
    expect(b.chatindexSnapshot()).toBe(
      "tenants/t1/projects/p1/threads/th1/derived/chatindex/current.json",
    );
  });

  it("sanitizes client-supplied filenames (no traversal, basename only)", () => {
    expect(b.fileRaw("report.pdf")).toBe("tenants/t1/projects/p1/files/raw/report.pdf");
    expect(b.fileRaw("../../etc/passwd")).toBe("tenants/t1/projects/p1/files/raw/etcpasswd");
    expect(b.fileNormalized("a/b/c.txt")).toBe(
      "tenants/t1/projects/p1/files/normalized/abc.txt",
    );
    expect(() => b.fileRaw("../")).toThrow(/Invalid filename/);
  });
});
