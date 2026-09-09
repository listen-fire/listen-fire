import {
  signatureHintAtCaret,
  signaturesFromFieldFunctions,
} from "../function-signatures";

describe("signatureHintAtCaret", () => {
  it("returns null on empty / outside any call", () => {
    expect(signatureHintAtCaret("", 0)).toBeNull();
    expect(signatureHintAtCaret("`subject`", 5)).toBeNull();
  });

  it("detects a function and arg 0 right after the open paren", () => {
    const h = signatureHintAtCaret("CONCAT(", 7);
    expect(h?.name).toBe("CONCAT");
    expect(h?.activeParam).toBe(0);
  });

  it("advances activeParam past top-level commas", () => {
    const s = "CONCAT(`a`, ";
    const h = signatureHintAtCaret(s, s.length);
    expect(h?.name).toBe("CONCAT");
    expect(h?.activeParam).toBe(1);
  });

  it("returns null once the call is closed", () => {
    const s = "CONCAT(`a`, `b`)";
    expect(signatureHintAtCaret(s, s.length)).toBeNull();
  });

  it("ignores commas / parens inside string literals", () => {
    const s = 'CONCAT("a, (b)", ';
    const h = signatureHintAtCaret(s, s.length);
    expect(h?.name).toBe("CONCAT");
    expect(h?.activeParam).toBe(1);
  });

  it("reports the innermost function call", () => {
    const s = "CONCAT(UPPER(";
    const h = signatureHintAtCaret(s, s.length);
    expect(h?.name).toBe("UPPER");
    expect(h?.activeParam).toBe(0);
  });

  it("does not count a nested call's commas toward the outer call", () => {
    const s = "CONCAT(JOIN(a, ";
    const h = signatureHintAtCaret(s, s.length);
    expect(h?.name).toBe("JOIN");
    expect(h?.activeParam).toBe(1);
  });

  it("walks out of a grouping paren to the enclosing function", () => {
    const s = "CONCAT((1 + ";
    const h = signatureHintAtCaret(s, s.length);
    expect(h?.name).toBe("CONCAT");
    expect(h?.activeParam).toBe(0);
  });

  it("returns null for an unknown function name", () => {
    expect(signatureHintAtCaret("FOObar(", 7)).toBeNull();
  });

  it("clamps activeParam to the variadic param for extra args", () => {
    const s = "CONCAT(a, b, c, d, ";
    const h = signatureHintAtCaret(s, s.length);
    expect(h?.name).toBe("CONCAT");
    expect(h?.variadic).toBe(true);
    // Raw index (renderer clamps to the variadic param for highlighting).
    expect(h?.activeParam).toBe(4);
  });
});

// Field functions (e.g. Slack's SLACK_MESSAGE) merge into the hint lookup via
// the optional `extra` signatures — built-ins still win.
describe("field-function signatures", () => {
  const extra = signaturesFromFieldFunctions([
    {
      name: "SLACK_MESSAGE",
      summary: "Compose a Slack message.",
      params: [
        { name: "instructions", doc: "What to say." },
        { name: "data", doc: "Values to use.", variadic: true },
      ],
    },
  ]);

  it("converts a field function into a signature keyed by uppercased name", () => {
    expect(extra.SLACK_MESSAGE).toMatchObject({
      name: "SLACK_MESSAGE",
      summary: "Compose a Slack message.",
      variadic: true,
    });
    expect(extra.SLACK_MESSAGE.params.map((p) => p.name)).toEqual(["instructions", "data"]);
  });

  it("resolves an extra signature when typing the function", () => {
    const s = "SLACK_MESSAGE(";
    const h = signatureHintAtCaret(s, s.length, extra);
    expect(h?.name).toBe("SLACK_MESSAGE");
    expect(h?.activeParam).toBe(0);
  });

  it("is unknown without the extra signatures", () => {
    expect(signatureHintAtCaret("SLACK_MESSAGE(", "SLACK_MESSAGE(".length)).toBeNull();
  });

  it("built-ins win over a same-named extra signature", () => {
    const shadow = signaturesFromFieldFunctions([{ name: "CONCAT", summary: "WRONG" }]);
    const h = signatureHintAtCaret("CONCAT(", 7, shadow);
    expect(h?.summary).not.toBe("WRONG");
  });
});
