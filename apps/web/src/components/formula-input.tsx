"use client";

// Reusable formula text input with autocomplete dropdown — extracted from
// the TG field ExpressionEditor so trigger-filter authoring can share its
// keystroke + completion behavior. Source-agnostic: takes PropertyInfo /
// EdgeInfo arrays directly rather than depending on the KG ontology.
//
// Renders the textarea + a portal'd dropdown driven by formula.ts'
// getCompletions. Caller controls validation; this component just shows
// it inline.

import { useCallback, useMemo } from "react";
import {
  getCompletions,
  inferType,
  type EdgeInfo,
  type ExprType,
  type FormulaCapabilities,
  type PropertyContext,
  type PropertyInfo,
  type TgCompletionOptions,
  type ValidationResult,
} from "@/lib/schema-formula/formula";
import {
  HighlightedCodeInput,
  type ValidationState,
} from "@/components/highlighted-code-input";
import type { CompletionItem } from "@/components/highlighted-code-input/completion";
import type { ResolveLeaf } from "@/components/highlighted-code-input/hints";
import type { ExtraSignatures } from "@/components/highlighted-code-input/function-signatures";
import {
  wordAtCaret,
  caretInStringLiteral,
} from "@/lib/schema-formula/traversal-leaf";

/**
 * Expected output type of a formula expression — used by the editor to
 * warn when the inferred type of what the author wrote doesn't fit
 * where it's being written.
 *
 * `'file'` (E5, wave-2): a typed binary handle (the File primitive per
 * resources_currency.md). The editor uses this to route File-typed
 * expressions (e.g., `msg-[:files]->.data`) only into File-typed target
 * fields (Attio attachment slots, KG resources, #extract `data:` slots)
 * and surface an inline error when a File flows into a non-File target.
 */
export type ExpectedType =
  | "string"
  | "number"
  | "boolean"
  | "record"
  | "file"
  | "any";

export interface FormulaInputProps {
  value: string;
  onChange: (next: string) => void;
  properties: PropertyInfo[];
  edges?: EdgeInfo[];
  edgeProperties?: PropertyInfo[];
  /** Context type id for property completions (filter to type-specific
   *  properties). Optional — if omitted, all properties surface. */
  contextTypeId?: string;
  outputConstraints?: string[];
  capabilities?: FormulaCapabilities;
  /** Validation result computed by the caller — drives the inline error
   *  message and the green checkmark. */
  validation: ValidationResult;
  placeholder?: string;
  /** Retained for back-compat; the shared editor auto-grows, so it's a
   *  no-op now. */
  rows?: number;
  /**
   * The kind of value this expression is expected to produce — used to
   * warn (amber, non-blocking) when the parsed expression's inferred
   * type doesn't match. `'any'` (or omitted) disables the check.
   *
   * Filter contexts: pass `'boolean'`. Field-mapping contexts: pass the
   * target field's `kind`. Lets authors catch "I wrote a string where I
   * meant to write a comparison" at edit time rather than runtime.
   */
  expectedType?: ExpectedType;
  /**
   * Whether the target expects a single value or an array. Defaults to
   * `'one'`. When the parsed expression's type is multi-valued and
   * `'one'` is expected, the editor warns (engine auto-CSV-joins at the
   * write boundary, but explicit aggregators are usually what the
   * author meant). `'many'` accepts both single (auto-wrapped) and
   * multi values without warning.
   */
  expectedCardinality?: "one" | "many";
  /**
   * Translation-graph completion options. When supplied, the autocomplete
   * dropdown surfaces TG-only tokens: bare alias bindings from ancestor
   * `#extract` / cypher-bracket bindings + trigger root alias,
   * `EXTRACT_VALUE()` (when an ancestral `#extract` is in scope), cypher
   * bracket templates, and meta-edge config-object key hints. Omit for
   * legacy KG / adapter-source authoring contexts that don't use the
   * TG grammar.
   */
  tgCompletionOptions?: TgCompletionOptions;
  /** Extra argument-hint signatures (the field's adapter functions, e.g.
   *  SLACK_MESSAGE) — forwarded to the editor's hint pipeline. */
  functionSignatures?: ExtraSignatures;
}

export function FormulaInput({
  value,
  onChange,
  properties,
  edges,
  edgeProperties,
  contextTypeId,
  outputConstraints,
  capabilities,
  validation,
  placeholder,
  expectedType,
  expectedCardinality = "one",
  tgCompletionOptions,
  functionSignatures,
}: FormulaInputProps) {
  // Type-validation against the caller's `expectedType`. Surfaced as a
  // non-blocking amber warning below the input — useful for catching
  // "I wrote a string when I meant a boolean comparison" at edit time.
  const typeMismatch = useMemo<{
    expected: ExpectedType;
    expectedCardinality: "one" | "many";
    got: ExprType;
  } | null>(() => {
    if ((!expectedType || expectedType === "any") && expectedCardinality === "one") return null;
    if (!validation.expression) return null;
    const ctx: PropertyContext = {
      getProperty(id) {
        const p = properties.find((pp) => pp.id === id);
        return p
          ? {
              valueType: p.valueType ?? "text",
              enumValues: p.enumValues,
              cardinality: p.cardinality,
            }
          : undefined;
      },
      getEdgeProperty(id) {
        const p = edgeProperties?.find((pp) => pp.id === id);
        return p
          ? {
              valueType: p.valueType ?? "text",
              enumValues: p.enumValues,
              cardinality: p.cardinality,
            }
          : undefined;
      },
    };
    const got = inferType(validation.expression, ctx);
    if (
      isExprTypeCompatible(got, expectedType ?? "any", expectedCardinality)
    ) {
      return null;
    }
    return { expected: expectedType ?? "any", expectedCardinality, got };
  }, [expectedType, expectedCardinality, validation.expression, properties, edgeProperties]);
  // Completions for the caret — this editor decides WHAT to suggest (via
  // formula.ts' getCompletions); the shared editor renders + applies them.
  // The trailing-space + replace-range logic that used to live in
  // `applyCompletion` is baked into each item's `insert` + range.
  const computeCompletions = useCallback(
    (val: string, caret: number): CompletionItem[] => {
      const raw = getCompletions(
        val,
        caret,
        properties,
        edges,
        contextTypeId,
        edgeProperties,
        outputConstraints,
        capabilities,
        tgCompletionOptions,
      );
      const lastWord =
        val.slice(0, caret).match(/[a-zA-Z_][a-zA-Z0-9_]*$/)?.[0] ?? "";
      const after = val.slice(caret);
      return raw.map((c) => {
        let insert = c.insert;
        if (
          !insert.endsWith(" ") &&
          !insert.endsWith("(") &&
          !insert.endsWith("->") &&
          !insert.endsWith("-") &&
          !after.startsWith(" ")
        ) {
          insert += " ";
        }
        return {
          label: c.label,
          // Friendlier badges than the raw kinds.
          kind:
            c.kind === "value"
              ? "prop"
              : c.kind === "special"
                ? "global"
                : c.kind,
          insert,
          replaceFrom: caret - lastWord.length,
          replaceTo: caret,
        };
      });
    },
    [
      properties,
      edges,
      contextTypeId,
      edgeProperties,
      outputConstraints,
      capabilities,
      tgCompletionOptions,
    ],
  );

  // Leaf hint — resolve the field the caret is on (type + description).
  const resolveLeafHint = useCallback<ResolveLeaf>(
    (txt, caret) => {
      if (caretInStringLiteral(txt, caret)) return null;
      const word = wordAtCaret(txt, caret);
      if (!word) return null;
      const lower = word.toLowerCase();
      const prop = properties.find((p) => p.name.toLowerCase() === lower);
      if (!prop) return null;
      const summary = [
        (prop.valueType ?? "value") + (prop.cardinality === "many" ? "[]" : ""),
        prop.description,
      ]
        .filter(Boolean)
        .join(" · ");
      return { label: prop.name, summary };
    },
    [properties],
  );

  // Validation → the shared editor's shape. A File-typed mismatch is a hard
  // error; other type mismatches are amber warnings.
  const involvesFile =
    !!typeMismatch &&
    (typeMismatch.expected === "file" || hasFileKind(typeMismatch.got));
  const fileError =
    typeMismatch && involvesFile
      ? `Expected ${describeExpected(typeMismatch.expected, typeMismatch.expectedCardinality)}; this expression returns ${describeExprType(typeMismatch.got)}. File-typed values can only be written to File-typed target fields.`
      : undefined;
  const warning =
    typeMismatch && !involvesFile
      ? `Expected ${describeExpected(typeMismatch.expected, typeMismatch.expectedCardinality)}; this expression returns ${describeExprType(typeMismatch.got)}.`
      : undefined;
  const validationState: ValidationState = {
    valid: validation.valid && !fileError,
    error: validation.valid ? fileError : validation.error,
    warning,
  };

  return (
    <HighlightedCodeInput
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      getCompletions={computeCompletions}
      resolveLeafHint={resolveLeafHint}
      functionSignatures={functionSignatures}
      validation={validationState}
    />
  );
}

/**
 * Whether an inferred ExprType satisfies a caller's expected kind +
 * cardinality. `literal` (enum-set) is treated as `string`; `null` is
 * universally compatible; `unknown` is a "don't know" pass (under-warn
 * over over-warn for expressions the inferer can't fully reason about).
 * `record` only satisfies a `record` expected type.
 *
 * Cardinality is checked strictly in both directions:
 *   - `many` got + `one` expected: the engine CSV-joins at write time,
 *     but the author probably wanted an explicit aggregator
 *     (FIRST / JOIN / …).
 *   - `one` got + `many` expected: the adapter auto-wraps as `[value]`,
 *     but for multi-select fields the author usually wants either
 *     `MULTI(a, b, …)` (multiple distinct values) or `SPLIT(str, sep)`
 *     (split a delimited string) — surface the mismatch so the choice
 *     is explicit.
 */
function isExprTypeCompatible(
  got: ExprType,
  expected: ExpectedType,
  expectedCardinality: "one" | "many",
): boolean {
  if (got.kind === "unknown") return true;
  if (got.kind === "null") return true;
  if (got.kind === "many" && expectedCardinality === "one") return false;
  if (got.kind === "many" && expectedCardinality === "many") {
    return expected === "any" || isElementTypeCompatible(got.elementType, expected);
  }
  // Single got, multi expected — warn so the author picks MULTI / SPLIT.
  if (got.kind !== "many" && expectedCardinality === "many") return false;
  if (expected === "any") return true;
  return isElementTypeCompatible(got, expected);
}

function isElementTypeCompatible(t: ExprType, expected: ExpectedType): boolean {
  if (expected === "any") return true;
  if (t.kind === "unknown" || t.kind === "null") return true;
  // A scalar string (or string literal) satisfies a reference/record target:
  // the target adapter resolves it to the referenced record at write time via
  // entity lookup (e.g. Attio searchRecords by name). Record-shaped
  // expressions (a node traversal) remain valid too.
  if (expected === "record" && (t.kind === "string" || t.kind === "literal")) return true;
  if (t.kind === "literal") return expected === "string";
  if (t.kind === "many") return false;
  return t.kind === expected;
}

/**
 * Whether an ExprType is or contains a File-typed value. Used to escalate
 * a type mismatch involving File from a soft warning (amber) to a hard
 * error (red) — see resources_currency.md / E5.
 */
function hasFileKind(t: ExprType): boolean {
  if (t.kind === "file") return true;
  if (t.kind === "many") return hasFileKind(t.elementType);
  return false;
}

function describeExprType(t: ExprType): string {
  switch (t.kind) {
    case "literal":
      return t.values.size === 1
        ? `the literal "${[...t.values][0]}"`
        : "a literal value";
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "record":
      return "a record reference (extract a property to get a value)";
    case "file":
      return "a file (binary handle)";
    case "null":
      return "null";
    case "unknown":
      return "an unknown type";
    case "many":
      return `a list of ${describeElementTypePlural(t.elementType)}`;
  }
}

function describeExpected(
  kind: ExpectedType,
  cardinality: "one" | "many",
): string {
  if (kind === "any") {
    return cardinality === "many" ? "a list of values" : "a value";
  }
  if (cardinality === "many") {
    return `a list of ${describePluralExpected(kind)}`;
  }
  return describeSingularExpected(kind);
}

function describeSingularExpected(kind: Exclude<ExpectedType, "any">): string {
  switch (kind) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "record":
      return "a record";
    case "file":
      return "a file";
  }
}

function describePluralExpected(kind: Exclude<ExpectedType, "any">): string {
  switch (kind) {
    case "string":
      return "strings";
    case "number":
      return "numbers";
    case "boolean":
      return "booleans";
    case "record":
      return "records";
    case "file":
      return "files";
  }
}

function describeElementTypePlural(t: ExprType): string {
  switch (t.kind) {
    case "string":
      return "strings";
    case "number":
      return "numbers";
    case "boolean":
      return "booleans";
    case "record":
      return "records";
    case "file":
      return "files";
    case "literal":
      return "literal values";
    case "null":
      return "nulls";
    case "unknown":
      return "values of unknown type";
    case "many":
      return `lists of ${describeElementTypePlural(t.elementType)}`;
  }
}
