// C01 smoke — la surface publique s'importe et expose les contrats de ports.
import { describe, it, expect } from "vitest";
import { VERSION, PORT_NAMES } from "../src/index.mjs";

describe("@ori3com/agent-core public surface", () => {
  it("exposes VERSION", () => {
    expect(typeof VERSION).toBe("string");
  });

  it("exposes the 8 canonical substitutable ports (ADR-0001 §1)", () => {
    expect(PORT_NAMES).toEqual([
      "ICognitiveMemory",
      "IVectorMemory",
      "IBrainMemory",
      "IGraphStore",
      "IToolResolver",
      "IWorkflowRuntime",
      "Embedder",
      "IStorageLayer",
    ]);
  });

  it("keeps the port registry immutable", () => {
    expect(Object.isFrozen(PORT_NAMES)).toBe(true);
  });
});
