// Round-trip + scope-validation tests for the `edge_to:<ancestorName>`
// uniqueness grammar (E6 — surfaces R5's compound-scoping discriminator
// in the editor's text grammar).
//
// Validates the editor's UI ↔ save ↔ display contract:
//   1. A draft text with `edge_to:round` parses to the canonical
//      `{ kind: 'edge_to', ancestorName: 'round' }` entry.
//   2. That entry round-trips through `serializeConstraint` back to the
//      same text — what the user sees on reload matches what they typed.
//   3. `ancestorNamesInScope` rejects references to names that aren't
//      bound by an ancestor action.
//   4. The grammar composes with existing terms (property AND edge_to).

import {
  parseConstraintText,
  serializeConstraint,
  isEdgeToEntry,
  type ConstraintEntry,
  type EdgeLookup,
} from "../uniqueness-constraints";

const PROPS_BY_NAME = new Map<string, string>([
  ["name", "prop-name"],
  ["investor_name", "prop-investor-name"],
]);
const PROP_ID_TO_NAME = new Map<string, string>([
  ["prop-name", "Name"],
  ["prop-investor-name", "investor_name"],
]);
const EDGE_BY_NAME = new Map<string, EdgeLookup>([
  [
    "organisation",
    { id: "edge-org", direction: "outgoing", otherNodeTypeName: "Organisation" },
  ],
]);
const EDGE_ID_TO_OTHER = new Map<string, { otherNodeTypeName: string }>([
  ["edge-org", { otherNodeTypeName: "Organisation" }],
]);

describe("edge_to grammar — parse", () => {
  test("parses a bare edge_to:name entry", () => {
    const result = parseConstraintText("edge_to:round", PROPS_BY_NAME, EDGE_BY_NAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(isEdgeToEntry(entry)).toBe(true);
    if (!isEdgeToEntry(entry)) return;
    expect(entry.ancestorName).toBe("round");
    expect(entry.kind).toBe("edge_to");
  });

  test("trims whitespace inside the ancestor name", () => {
    const result = parseConstraintText("edge_to:  round  ", PROPS_BY_NAME, EDGE_BY_NAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [entry] = result.entries;
    if (!isEdgeToEntry(entry)) throw new Error("expected edge_to entry");
    expect(entry.ancestorName).toBe("round");
  });

  test("rejects edge_to with empty ancestor name", () => {
    const result = parseConstraintText("edge_to:", PROPS_BY_NAME, EDGE_BY_NAME);
    expect(result.ok).toBe(false);
  });

  test("ANDs edge_to with property entries", () => {
    const result = parseConstraintText(
      "investor_name AND edge_to:round",
      PROPS_BY_NAME,
      EDGE_BY_NAME,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    const [first, second] = result.entries;
    expect(isEdgeToEntry(first)).toBe(false);
    expect(isEdgeToEntry(second)).toBe(true);
    if (isEdgeToEntry(second)) expect(second.ancestorName).toBe("round");
  });
});

describe("edge_to grammar — ancestor scope validation", () => {
  test("accepts edge_to referencing a bound ancestor", () => {
    const result = parseConstraintText(
      "edge_to:round",
      PROPS_BY_NAME,
      EDGE_BY_NAME,
      { ancestorNamesInScope: new Set(["round", "investor"]) },
    );
    expect(result.ok).toBe(true);
  });

  test("rejects edge_to referencing an unbound ancestor", () => {
    const result = parseConstraintText(
      "edge_to:mystery",
      PROPS_BY_NAME,
      EDGE_BY_NAME,
      { ancestorNamesInScope: new Set(["round"]) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/mystery/);
  });

  test("rejects unbound ancestor even when mixed with valid terms", () => {
    const result = parseConstraintText(
      "investor_name AND edge_to:nope",
      PROPS_BY_NAME,
      EDGE_BY_NAME,
      { ancestorNamesInScope: new Set(["round"]) },
    );
    expect(result.ok).toBe(false);
  });

  test("omitting ancestorNamesInScope accepts any non-empty name", () => {
    // Ontology-editor callers don't carry TG scope; the parser must stay
    // permissive in that case so the saved shape is preserved.
    const result = parseConstraintText("edge_to:anything", PROPS_BY_NAME, EDGE_BY_NAME);
    expect(result.ok).toBe(true);
  });
});

describe("edge_to grammar — round-trip", () => {
  test("parse → serialize → parse preserves the entry shape", () => {
    const original = "Name AND edge_to:round";
    const parsed = parseConstraintText(original, PROPS_BY_NAME, EDGE_BY_NAME);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const serialized = serializeConstraint(
      parsed.entries,
      PROP_ID_TO_NAME,
      EDGE_ID_TO_OTHER,
    );
    expect(serialized).toBe("Name AND edge_to:round");

    // Re-parse the serialized form: ancestor name + property both
    // survive the editor's display-then-edit cycle.
    const reparsed = parseConstraintText(
      serialized,
      PROPS_BY_NAME,
      EDGE_BY_NAME,
      { ancestorNamesInScope: new Set(["round"]) },
    );
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.entries).toEqual(parsed.entries);
  });

  test("round-trip of a stored compound-scope-only constraint", () => {
    // Mirrors how the engine stores R5's compound-scope-only entries
    // (e.g. round participation scoped purely by ancestor binding).
    const stored: ConstraintEntry[] = [{ kind: "edge_to", ancestorName: "round" }];
    const serialized = serializeConstraint(stored, PROP_ID_TO_NAME, EDGE_ID_TO_OTHER);
    expect(serialized).toBe("edge_to:round");

    const parsed = parseConstraintText(serialized, PROPS_BY_NAME, EDGE_BY_NAME);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual(stored);
  });

  test("round-trip preserves order of mixed entries", () => {
    const stored: ConstraintEntry[] = [
      { kind: "edge_to", ancestorName: "round" },
      { expr: { type: "property", propertyTypeId: "prop-investor-name" } },
    ];
    const serialized = serializeConstraint(stored, PROP_ID_TO_NAME, EDGE_ID_TO_OTHER);
    expect(serialized).toBe("edge_to:round AND investor_name");

    const parsed = parseConstraintText(serialized, PROPS_BY_NAME, EDGE_BY_NAME);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual(stored);
  });
});

// #7 — an adapter target's property id is a human-readable slug
// (`email_addresses`), not a UUID. When the name map doesn't cover it the
// serializer must render the slug WHOLE; the legacy `.slice(0, 8)`
// truncated it to "email_ad". UUID ids stay shortened (they're noise).
describe("serializeConstraint — unmapped id fallback", () => {
  const EMPTY = new Map<string, string>();
  const EMPTY_EDGE = new Map<string, { otherNodeTypeName: string }>();

  test("renders an adapter slug id whole, never truncated", () => {
    const stored: ConstraintEntry[] = [
      { expr: { type: "property", propertyTypeId: "email_addresses" } },
    ];
    expect(serializeConstraint(stored, EMPTY, EMPTY_EDGE)).toBe(
      "email_addresses",
    );
  });

  test("prefers the mapped display name when present", () => {
    const stored: ConstraintEntry[] = [
      { expr: { type: "property", propertyTypeId: "email_addresses" } },
    ];
    const map = new Map([["email_addresses", "Email"]]);
    expect(serializeConstraint(stored, map, EMPTY_EDGE)).toBe("Email");
  });

  test("shortens a UUID id to its 8-char prefix as a hint", () => {
    const uuid = "1733fe3d-dff0-4209-848f-6fd19008a809";
    const stored: ConstraintEntry[] = [
      { expr: { type: "property", propertyTypeId: uuid } },
    ];
    expect(serializeConstraint(stored, EMPTY, EMPTY_EDGE)).toBe("1733fe3d");
  });
});
