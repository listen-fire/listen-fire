import {
  metaEdgeContextAtCaret,
  editorHintAtCaret,
  contextStackAtCaret,
} from "../hints";

const at = (s: string) => s.length;

describe("metaEdgeContextAtCaret", () => {
  it("returns null with no meta-edge in the active region", () => {
    expect(metaEdgeContextAtCaret("-[:Owns]->-[:", at("-[:Owns]->-[:"))).toBeNull();
  });

  it("detects the meta-edge before its config opens", () => {
    const s = "-[x:#extract ";
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({ metaEdge: "extract" });
  });

  it("detects the description value", () => {
    const s = '-[x:#extract { description: "';
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({
      metaEdge: "extract",
      key: "description",
    });
  });

  it("detects the data value", () => {
    const s = '-[x:#extract { description: "hi", data: [';
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({
      metaEdge: "extract",
      key: "data",
    });
  });

  it("returns no key between config entries", () => {
    const s = '-[x:#extract { description: "hi", ';
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({ metaEdge: "extract" });
  });

  it("detects #transform plugin", () => {
    const s = '-[t:#transform { plugin: "';
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({
      metaEdge: "transform",
      key: "plugin",
    });
  });

  it("ignores brackets/keys inside the description string", () => {
    const s = '-[x:#extract { description: "a [b] {c} data: x", data: [';
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({
      metaEdge: "extract",
      key: "data",
    });
  });

  it("reports meta-edge level once the config is closed", () => {
    const s = '-[x:#extract { description: "hi" } ';
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({ metaEdge: "extract" });
  });

  it("works after a prior completed step", () => {
    const s = "-[:Owns]-> -[y:#extract { data: [";
    expect(metaEdgeContextAtCaret(s, at(s))).toEqual({
      metaEdge: "extract",
      key: "data",
    });
  });
});

describe("editorHintAtCaret", () => {
  it("returns a function hint inside a call", () => {
    const h = editorHintAtCaret("CONCAT(", at("CONCAT("));
    expect(h?.kind).toBe("function");
  });

  it("prefers the function hint over the data-arg hint", () => {
    const s = "-[x:#extract { data: [CONCAT(";
    expect(editorHintAtCaret(s, at(s))?.kind).toBe("function");
  });

  it("gives a meta-edge-arg hint for data:", () => {
    const s = "-[x:#extract { data: [";
    const h = editorHintAtCaret(s, at(s));
    expect(h?.kind).toBe("meta-edge-arg");
    expect(h && "label" in h && h.label).toBe("data:");
  });

  it("gives a meta-edge hint on the bare meta-edge", () => {
    const s = "-[x:#extract ";
    const h = editorHintAtCaret(s, at(s));
    expect(h?.kind).toBe("meta-edge");
    expect(h && "label" in h && h.label).toBe("#extract");
  });
});

describe("contextStackAtCaret", () => {
  it("builds the inside-out stack: leaf → call → arg → meta-edge", () => {
    const s = '-[x:#extract { description: "d", data: [CONCAT("a", `from';
    const stack = contextStackAtCaret(s, at(s), {
      resolveLeaf: () => ({ label: "From", summary: "Email field · text" }),
    });
    expect(stack.map((l) => l.kind)).toEqual([
      "token",
      "function",
      "meta-edge-arg",
      "meta-edge",
    ]);
    expect(stack[0]).toMatchObject({ kind: "token", label: "From" });
    expect(stack[1]).toMatchObject({ kind: "function", name: "CONCAT" });
  });

  it("omits the leaf layer when no resolver is supplied", () => {
    const s = "-[x:#extract { data: [";
    const stack = contextStackAtCaret(s, at(s));
    expect(stack.map((l) => l.kind)).toEqual(["meta-edge-arg", "meta-edge"]);
  });

  it("treats a function name the caret is on as the leaf", () => {
    const stack = contextStackAtCaret("CONCAT(", 3);
    expect(stack.map((l) => l.kind)).toEqual(["function"]);
    expect(stack[0]).toMatchObject({ kind: "function", name: "CONCAT" });
  });

  it("does not call the leaf resolver when on a function name", () => {
    let called = false;
    contextStackAtCaret("CONCAT(", 3, {
      resolveLeaf: () => {
        called = true;
        return { label: "x", summary: "y" };
      },
    });
    expect(called).toBe(false);
  });
});

describe("metaEdgeContextAtCaret — caret on the token", () => {
  it("detects the meta-edge with the caret mid-keyword", () => {
    const s = "-[x:#extract";
    expect(metaEdgeContextAtCaret(s, 7)).toEqual({ metaEdge: "extract" });
  });

  it("detects the key with the caret on the key label", () => {
    const s = '-[x:#extract { description: "x" }';
    // caret at index 20 — inside the word "description"
    expect(metaEdgeContextAtCaret(s, 20)).toEqual({
      metaEdge: "extract",
      key: "description",
    });
  });

  it("detects the key with the caret mid-label (colon present)", () => {
    const s = "-[x:#extract { data: [";
    // caret at index 16 — inside the word "data"
    expect(metaEdgeContextAtCaret(s, 16)).toEqual({
      metaEdge: "extract",
      key: "data",
    });
  });
});
