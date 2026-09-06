// C07 — Leakscan : preuve que le gate pré-publication détecte VRAIMENT les secrets
// (pas un no-op) ET ne se déclenche PAS sur les identifiants/noms d'env légitimes du
// code (secretAccessKey, S3_SECRET_ACCESS_KEY, signingKey…) → zéro faux positif.
import { describe, it, expect } from "vitest";
import { scanText, PATTERNS } from "../scripts/leakscan.mjs";

describe("leakscan scanText", () => {
  it("has a non-empty pattern set", () => {
    expect(PATTERNS.length).toBeGreaterThan(0);
  });

  it("catches high-certainty secret values", () => {
    const cases = [
      'const k = "sk-abcdefghijklmnopqrstuvwx1234567890"',
      "npm_012345678901234567890123456789012345",
      "AKIAABCDEFGHIJKLMNOP",
      "ghp_0123456789012345678901234567890123456",
      "xoxb-1234567890-abcdefghij",
      "AIza" + "b".repeat(35), // Google key = AIza + exactly 35 chars
      "-----BEGIN RSA PRIVATE KEY-----",
      "postgres://user:s3cretpw@db.internal:5432/app",
    ];
    for (const line of cases) {
      expect(scanText(line).length, `should flag: ${line}`).toBeGreaterThan(0);
    }
  });

  it("does NOT flag legitimate identifiers / env var names (no false positives)", () => {
    const benign = [
      "accessKeyId: config.accessKeyId,",
      'const secretAccessKey = env["S3_SECRET_ACCESS_KEY"] ?? "";',
      "this._signingKey = cfg.signingKey;",
      "if (!apiKey) throw new Error('API key required');",
      "// token bucket rate limiter",
      'headers: { Authorization: `Bearer ${this.signingKey}` }',
      "https://api.ori3com.cloud/v1/chat/completions",
    ];
    for (const line of benign) {
      expect(scanText(line), `should NOT flag: ${line}`).toEqual([]);
    }
  });

  it("reports the correct line number", () => {
    const text = "clean line\nAKIAABCDEFGHIJKLMNOP\nanother clean line";
    const hits = scanText(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });
});
