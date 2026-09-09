import { applyCompletionTo, type CompletionItem } from "../completion";

const item = (over: Partial<CompletionItem>): CompletionItem => ({
  label: "x",
  kind: "value",
  insert: "x",
  replaceFrom: 0,
  replaceTo: 0,
  ...over,
});

describe("applyCompletionTo", () => {
  it("inserts at a collapsed range and puts the caret after", () => {
    const r = applyCompletionTo("ab", item({ insert: "X", replaceFrom: 1, replaceTo: 1 }));
    expect(r.value).toBe("aXb");
    expect(r.caret).toBe(2);
  });

  it("replaces a range", () => {
    const r = applyCompletionTo("subj", item({ insert: "`Subject`", replaceFrom: 0, replaceTo: 4 }));
    expect(r.value).toBe("`Subject`");
    expect(r.caret).toBe("`Subject`".length);
  });

  it("honors caretOffset (caret inside function parens)", () => {
    const r = applyCompletionTo("", item({ insert: "CONCAT()", replaceFrom: 0, replaceTo: 0, caretOffset: 7 }));
    expect(r.value).toBe("CONCAT()");
    expect(r.caret).toBe(7);
  });

  it("preserves text on both sides of the range", () => {
    const r = applyCompletionTo("a + b", item({ insert: "name", replaceFrom: 4, replaceTo: 5 }));
    expect(r.value).toBe("a + name");
    expect(r.caret).toBe(8);
  });
});
