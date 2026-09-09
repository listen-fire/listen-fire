// Typed positions for the movement checker (M2b).
//
// Layers schema types onto M2a's binding layer: every bound name MAY carry a
// `PositionTypeRef` (where one is derivable), and the typed checks — writes
// (check 2), traversal validity (check 4), linked writes (check 5),
// narrowing (check 6), call fit (check 7), effect typing (check 8),
// extraction-tree validity (check 9) — fire only where a type is KNOWN.
// Unknown stays silent: a missing catalog schema, an untyped alias, a
// `_resources` hop all degrade to "no diagnostics", never to false
// positives.
//
// `ExpressionTyping` is the one expression walker: it validates every
// traversal it can root (reporting unknown edges / extract-field misuse)
// while inferring a shallow value type for write-field compatibility. The
// statement-level integration (which symbols carry which types) lives in
// check.ts; this module knows schemas and expressions, not scopes.

import {
  AI_TIER_ALIASES,
  AI_TIERS,
  FOLD_ALGEBRA,
  type AggregationFunction,
  type EdgeCapability,
  type Expression,
  type FilterOperator,
  type TraversalStep,
} from '@listen-fire/shared/expression/types';
import { isNullLiteral, isPurePredicate } from '@listen-fire/shared/expression/filter';
import { orderKeyProperty } from '@listen-fire/shared/expression/order_limit';
import { quoteName } from '@listen-fire/shared/expression/formula';
import { POSITION_SENTINEL } from '../expression/bridge';
import {
  FILE_FUNCTION_ID,
  stdlibFunctionById,
  type StdlibFunctionSpec,
} from '../expression/stdlib';
import { Span } from '../parser/ast';
import {
  describeFieldType,
  EdgeSchema,
  EVENT_ACTION_FIELD,
  FieldType,
  InstanceSchema,
  PositionSchema,
  refinementKey,
  surfaceNotEnumerated,
} from './catalog';
import type { EffectRow } from './effects';
import { eventAddressKey, type EventAddress } from './event_address';
import {
  closestByEditDistance,
  closestMovementMetaKey,
  isClockMetaKey,
  isMovementMetaKey,
  movementMetaKeyType,
} from './meta';

export const TypedDiagnosticCodes = {
  WRITE_UNKNOWN_ROOT: 'MOV_WRITE_UNKNOWN_ROOT',
  WRITE_UNKNOWN_FIELD: 'MOV_WRITE_UNKNOWN_FIELD',
  WRITE_FIELD_TYPE: 'MOV_WRITE_FIELD_TYPE',
  /** A DISCRIMINATED write shape's discriminant field is present but its value
   *  is NOT a compile-time literal (a property read, an AI() call, an
   *  interpolation). A create must know its shape at author time — without the
   *  literal the checker cannot select the variant and validate the body, so
   *  this is an ERROR (not a silent degrade). The message tells the author to
   *  name the target with a literal. The write-side dual of read narrowing,
   *  where a WHERE's literal selects a variant. */
  WRITE_DISCRIMINANT_NOT_LITERAL: 'MOV_WRITE_DISCRIMINANT_NOT_LITERAL',
  /** A write body field that PARAMETERIZES an edge's landing type
   *  (`EdgeSchema.genericOver` with `onNonLiteral: 'error'`) is present but is not a
   *  compile-time literal — an ask's `Answer Type` read out of a variable. The
   *  adapter already refuses this at run time (the answer's type has to be
   *  fixed when the ask is raised), so the checker says so up front instead of
   *  letting a create fail live. The WRITE_DISCRIMINANT_NOT_LITERAL shape, one
   *  door over: there the literal selects a write SHAPE, here it fixes a
   *  LANDING type. What a computed value costs is the edge's own declaration
   *  (`genericOver.onNonLiteral`); absent, it degrades silently — computed
   *  options are legitimate and were promised nothing. */
  WRITE_GENERIC_NOT_LITERAL: 'MOV_WRITE_GENERIC_NOT_LITERAL',
  /** WARNING severity: the same body field, on an edge that declares
   *  `onNonLiteral: 'warn'` — the write RUNS (an ask's `Fields` built from a
   *  query is a real thing to do), but the landing cannot be typed, so the
   *  answer arrives as one opaque value instead of a property per name. Not an
   *  error: nothing is wrong, something was LOST, and a guarantee lost in
   *  silence is lost twice. The message names the trade and how to take it
   *  back. */
  WRITE_GENERIC_UNTYPED: 'MOV_WRITE_GENERIC_UNTYPED',
  /** A write body's field set is assignable to NO variant of an UNTAGGED write
   *  union (`WritableRootSchema.writeUnion`) — a Slack message setting both
   *  `File` and `Blocks`. Nothing discriminates the variants, so this is plain
   *  assignability: the fields a body maps must be a subset of one shape. The
   *  message names the shapes and the fields that fit none of them together. */
  WRITE_UNION_UNSATISFIED: 'MOV_WRITE_UNION_UNSATISFIED',
  UNIQUE_UNKNOWN_FIELD: 'MOV_UNIQUE_UNKNOWN_FIELD',
  LINKED_UNKNOWN_EDGE: 'MOV_LINKED_UNKNOWN_EDGE',
  LINKED_NEEDS_TYPE: 'MOV_LINKED_NEEDS_TYPE',
  LINKED_TYPE_MISMATCH: 'MOV_LINKED_TYPE_MISMATCH',
  LINKED_TARGET_NOT_WRITABLE: 'MOV_LINKED_TARGET_NOT_WRITABLE',
  TRAVERSE_UNKNOWN_EDGE: 'MOV_TRAVERSE_UNKNOWN_EDGE',
  /** A read traversal walks a WRITE-ONLY edge (`EdgeSchema.readable: false`)
   *  — a pure create path with no read API behind it (WhatsApp's `replies`).
   *  Traversing it would silently yield nothing, so the read is an error;
   *  writes along the edge are untouched. */
  WRITE_ONLY_EDGE: 'MOV_WRITE_ONLY_EDGE',
  /** A BARE traversal walks an AWAITABLE edge (`EdgeSchema.awaitable: true`) —
   *  a promise in type-space (an ask's `Response`). Reading it live would
   *  yield nothing until it resolves; the author meant to `await` it. The TS
   *  analogue: property access on an un-awaited Promise. Carries a did-you-mean
   *  pointing at `await <head>-[:edge]->`. */
  AWAIT_REQUIRED: 'MOV_AWAIT_REQUIRED',
  /** An `await`'s WHERE narrows the awaited edge with an IMPURE predicate
   *  (AI() / EXISTS / a nested live traversal). The engine evaluates an await's
   *  WHERE against a candidate + the park's serialized scope WITHOUT rehydrating
   *  the run (F10), so it must be PURE. */
  AWAIT_IMPURE_WHERE: 'MOV_AWAIT_IMPURE_WHERE',
  /** A value that MAY be absent (a combinator slot no arm filled, a maybe-empty
   *  node's field — F19, an out-of-range index read) flows where a
   *  NON-ABSENT value is REQUIRED: a plain write field, an ORDERED comparison.
   *  (Equality is NOT such a site — absent is simply never equal.) The TS
   *  analogue is "possibly undefined" at a use site — the read itself is fine;
   *  the error is at the USE. Discharge it: a `?:` (fill) write field, a
   *  traversal-as-gate, an `==` guard, or a `COALESCE` whose fallback always
   *  answers. (asks-as-adapter P20/F13; layer 6.) */
  ABSENT_REQUIRED: 'MOV_ABSENT_REQUIRED',
  /** A property read names a field a CLOSED typed position does not declare
   *  (positions are closed unless the schema marks them `openProperties`). */
  UNKNOWN_PROPERTY: 'MOV_UNKNOWN_PROPERTY',
  /** A read or traversal through a handle NOTHING HAS DESCRIBED
   *  (`PositionSchema.undescribed`) — an unnarrowed event's `record` edge
   *  landing on the meta type, a type no describe answered for.
   *
   *  Distinct from an OPEN position, which is a positive claim that the surface
   *  is wider than enumerated and therefore stays silent. This is the ABSENCE of
   *  a claim: nothing has said what the handle carries, so the read cannot be
   *  checked and returns null at run time. The rule for a `never` — don't
   *  error at the narrow, error where the handle is USED. */
  UNDESCRIBED_POSITION: 'MOV_UNDESCRIBED_POSITION',
  /** A property read names a WRITE-ONLY field — declared on the type's write
   *  shape only (`readable: false`): a value a write SETS (WhatsApp Message's
   *  send-side `File`), never one with a value to read. Distinct from
   *  UNKNOWN_PROPERTY so the message can carry the adapter's own guidance
   *  for the field's real read path. */
  WRITE_ONLY_PROPERTY: 'MOV_WRITE_ONLY_PROPERTY',
  /** WARNING severity: the property name is carried by more than one of the
   *  source's fields, so the read resolves to the first. Legal — it never
   *  gates a compile — but the author should know their source has two fields
   *  wearing one name, because only they can rename one. */
  AMBIGUOUS_PROPERTY: 'MOV_AMBIGUOUS_PROPERTY',
  EXTRACT_UNKNOWN_FIELD: 'MOV_EXTRACT_UNKNOWN_FIELD',
  EXTRACT_TYPE_CONFLICT: 'MOV_EXTRACT_TYPE_CONFLICT',
  /** Info severity: an unannotated extract field flows into a typed write
   *  target — suggest the explicit (borrowed) annotation. The message names
   *  the discharge in the same breath, because annotating is exactly what
   *  makes the read `T | absent` (R14) and a plain write field then refuses
   *  it: a nudge that led an author into a refusal it never mentioned would
   *  be pointing two ways at once. */
  EXTRACT_ANNOTATE: 'MOV_EXTRACT_ANNOTATE',
  NARROWING: 'MOV_NARROWING',
  CALL_ARG_TYPE: 'MOV_CALL_ARG_TYPE',
  /** A comparison (relational `< <= > >=` or equality `== !=`) whose two
   *  operands are in different value categories (temporal / numeric / textual
   *  / boolean) — e.g. `date <= number`. Only raised when BOTH operand types
   *  are KNOWN; an underspecified side stays silent. The message names the two
   *  types and suggests a coercer (DATE / DATETIME / NUMBER). */
  COMPARE_TYPE_MISMATCH: 'MOV_COMPARE_TYPE_MISMATCH',
  /** A `json` value is OPERATED ON — compared, used in arithmetic, folded into
   *  text, aggregated. A structured value has no known shape (the DATA top
   *  type, TypeScript's `unknown`), so every such operation is meaningless
   *  rather than merely risky: the old `text` projection let them all through
   *  and produced `[object Object]` at run time. The message says what the
   *  author CAN do — pass the value through unchanged to a json field — and
   *  never suggests a narrowing syntax, because there isn't one. */
  JSON_OPAQUE: 'MOV_JSON_OPAQUE',
  /** An arithmetic operand (`+ - * /`) whose KNOWN type is not numeric — the
   *  classic being `"a" + b`, since `+` is addition and the language has no
   *  concat overload. The engine coerces through `Number()`, so such an
   *  operation evaluated to NaN and was stored as null without a word: the
   *  recurring "the type system said nothing" bug class. TypeScript's analogue
   *  ("the left-hand side of an arithmetic operation must be of type number")
   *  is an error, and so is this. A string operand carries a did-you-mean for
   *  `${…}` interpolation — the one real string-building path. Unknown operands
   *  stay silent, and a `json` one is JSON_OPAQUE's to report. */
  ARITH_NON_NUMERIC: 'MOV_ARITH_NON_NUMERIC',
  /** A string LITERAL compared to, written into, or narrowed against an enum
   *  field that is not one of that enum's options. Only literals are checked —
   *  a text field vs an enum stays silent (the value isn't known at author
   *  time). A typo'd value would silently never match at runtime, so this is an
   *  error, with a did-you-mean for the closest option. */
  ENUM_UNKNOWN_VALUE: 'MOV_ENUM_UNKNOWN_VALUE',
  /** A CLOSED enum whose option set is EMPTY — the empty union, TypeScript's
   *  `never`. No value satisfies it, so any use of the field is impossible
   *  rather than mistaken. Distinct from ENUM_UNKNOWN_VALUE so the message can
   *  say the domain is empty instead of sending the author hunting for a typo
   *  in a value that could never have been right. Unlike every other
   *  membership rule this does NOT depend on the value, so it also fires for a
   *  non-literal expression: "the value isn't known at author time" stops
   *  being a reason for silence when NO value would do. */
  ENUM_EMPTY_DOMAIN: 'MOV_ENUM_EMPTY_DOMAIN',
  /** Warning: a string LITERAL against an OPEN known-values field that is
   *  neither a known value nor id-shaped (`open.allowPattern`). The listing
   *  may be incomplete (private channels, later-created values), so this
   *  never gates a compile — it catches the typo'd-name case with a
   *  did-you-mean. */
  VALUE_UNLISTED: 'MOV_VALUE_UNLISTED',
  /** An `@`-prefixed meta field whose key is not one of the canonical eight
   *  (`@current_date`, `@user_email`, …). An unknown key resolves to null at
   *  runtime SILENTLY, so this is an error — almost always a legacy name
   *  (`@current_user_email`) or a typo; the message suggests the closest key. */
  META_UNKNOWN_KEY: 'MOV_META_UNKNOWN_KEY',
  /** A hop WHERE / ORDER BY / LIMIT asks for something the source can't do
   *  across that relationship — filter a non-filterable field/operator, order
   *  by a non-orderable field, or limit an edge that doesn't support it
   *  (adapter-capability-contract chunk 6). Only raised when the adapter has
   *  DECLARED its capability; an undeclared surface stays silent. */
  HOP_FILTER_UNSUPPORTED: 'MOV_HOP_FILTER_UNSUPPORTED',
  /**
   * WARNING — part of a hop's WHERE pushes to the source and part of it cannot,
   * so the rest runs app-side over what came back. The bracket states the
   * condition and the boundedness; WHERE it runs is delivery, and the engine is
   * free to deliver the same condition worse. So this is a note about the cost,
   * never a refusal — an adapter that loses a filter capability must not turn
   * saved movements into save errors.
   *
   * It is not a one-time save message either: it is derived from the capability
   * surface every time the program is checked, so validate and the picture both
   * carry it for as long as it is true, and it disappears on its own when the
   * source grows the filter.
   *
   */
  HOP_FILTER_RESIDUAL: 'MOV_HOP_FILTER_RESIDUAL',
  /**
   * WARNING — the filter sibling of `HOP_ORDER_ENGINE`, for the other half of
   * the bracket. A root collection whose source cannot narrow AT ALL
   * (`filter: 'bounded'`) is fetched in full and the WHERE runs here, over
   * everything the source handed back. The records you get are the WHERE's
   * answer either way; what differs is the size of the fetch, so this is the
   * cost said out loud, never a refusal.
   *
   * Like `HOP_ORDER_ENGINE` it is re-derived from the capability surface on
   * every check, so it appears for as long as it is true and disappears on
   * its own the day the source grows a native filter. A record edge's
   * `bounded` filter stays silent — the set is already in hand, bounded by
   * the record it left, so there is no bigger fetch to warn about.
   *
   */
  HOP_FILTER_ENGINE: 'MOV_HOP_FILTER_ENGINE',
  HOP_ORDER_UNSUPPORTED: 'MOV_HOP_ORDER_UNSUPPORTED',
  /**
   * WARNING — the sibling of `HOP_FILTER_RESIDUAL`, for the other half of the
   * bracket. A root collection whose source can NARROW but cannot SORT
   * (`filter: 'native'`, `order: 'bounded'`) is fetched in full — everything
   * the WHERE let through — and sorted here. The rows and their order are the
   * ones the author asked for; what differs is the size of the fetch, so this
   * is the cost said out loud, never a refusal.
   *
   * Like the residual-filter warning it is re-derived from the capability
   * surface on every check, so it appears for as long as it is true and
   * disappears on its own the day the source grows the sort.
   *
   */
  HOP_ORDER_ENGINE: 'MOV_HOP_ORDER_ENGINE',
  HOP_LIMIT_UNSUPPORTED: 'MOV_HOP_LIMIT_UNSUPPORTED',
  /** An ORDER-SENSITIVE fold (`JOIN`, `FIRST`, `LAST`, `AT`) reads a collection
   *  whose order MEANS NOTHING — a traversal with no `ORDER BY` over an edge no
   *  adapter declares sequenced, or a list collected from one. The fold would
   *  answer whatever the source happened to hand over that minute, and answer
   *  differently the next: a guarantee nobody has, spelled as if they did.
   *
   *  The message names the fixes that exist, in the order they usually apply:
   *  `ONLY` when the author means "the one that matched" (which is what most
   *  `FIRST`s mean), an `ORDER BY` on the hop when they mean a ranking, or a
   *  relationship the source keeps in order. Commutative folds (`COUNT`, `SUM`,
   *  `MIN`, `ONLY`, …) are unaffected — they answer the same over any
   *  permutation, so they take a set or a list. */
  FOLD_NEEDS_ORDER: 'MOV_FOLD_NEEDS_ORDER',
  /** A hop takes a `LIMIT` with no `ORDER BY`, over a relationship the source
   *  keeps in no particular order — "some n of them", which is the same bug as
   *  `FIRST` over an unordered set and gets the same treatment. */
  LIMIT_NEEDS_ORDER: 'MOV_LIMIT_NEEDS_ORDER',
  /** An ordering key — a hop's `ORDER BY`, or `SORT`'s key — that answers with
   *  SEVERAL values for one element (a many-valued field, a path ending in
   *  one). There is no single value to rank the element by, and comparing the
   *  collection would rank by whatever its text happens to be. Fold the key
   *  down to one value (`MIN`, `MAX`, `FIRST`) or name a single-valued one. */
  ORDER_KEY_MULTI: 'MOV_ORDER_KEY_MULTI',
  /** An ordering key that asks a model (`AI(…)`) or extracts a value. A key is
   *  read once per element and its answers are compared with each other, which
   *  needs a function of the element and nothing else. */
  ORDER_KEY_IMPURE: 'MOV_ORDER_KEY_IMPURE',
  /** `SORT` given something that is not a collection — one value has no order
   *  to put it in. */
  SORT_NOT_COLLECTION: 'MOV_SORT_NOT_COLLECTION',
  /** `SORT` given a key over a collection of plain values (text, numbers).
   *  A member has no fields to key on; such a list sorts by the members
   *  themselves — `SORT(xs)` / `SORT(xs, DESC)`. */
  SORT_KEY_ON_SCALAR: 'MOV_SORT_KEY_ON_SCALAR',
  /** `SORT` over a walk written INSIDE the call. A walk in an expression hands
   *  over its landings as plain records with no graph behind them, so there is
   *  nothing to read a key from. Bind the walk first —
   *  `entries = list-[e:Entries]-> { return e }` — and sort the name. */
  SORT_KEY_ON_WALK: 'MOV_SORT_KEY_ON_WALK',
  /** `SORT` over records with no key. A record has no order of its own, so
   *  there is nothing to rank it by until the key says. */
  SORT_NEEDS_KEY: 'MOV_SORT_NEEDS_KEY',
  /** A stdlib argument the function PARSES rather than passes on (a date format
   *  pattern) is given a computed value. Nothing at author time can see what
   *  the string will say, so the pattern would go unchecked and a typo in it
   *  would print silently wrong — the WRITE_DISCRIMINANT_NOT_LITERAL shape, one
   *  door over. Write the pattern down. */
  STDLIB_ARG_NOT_LITERAL: 'MOV_STDLIB_ARG_NOT_LITERAL',
  /** The same argument, written down and wrong — an unknown format token. The
   *  message carries the vocabulary and a did-you-mean, the way a typo'd enum
   *  value does. */
  STDLIB_ARG_INVALID: 'MOV_STDLIB_ARG_INVALID',
  /** Info severity: a tier written in a spelling that predates the tiers
   *  (`AI(…, "smart")`). It still means what it always meant, so nothing is
   *  broken and this never gates a save — but the word the language now uses
   *  is the one the handbook teaches and the one the next reader will look
   *  for, so the nudge names it. */
  AI_TIER_LEGACY: 'MOV_AI_TIER_LEGACY',
  /** Info severity: a presence test — `x == null`, `x != null`, `EXISTS(x)` —
   *  whose subject can NEVER be absent, so the answer is fixed at author time.
   *  Not an error (the guard is harmless and may be defensive habit), but the
   *  author is testing for something the type says cannot happen; TypeScript
   *  reports the same shape as an always-truthy condition. Silent whenever the
   *  subject's type is unknown — an underspecified surface is not a claim. */
  PRESENCE_TEST_CONSTANT: 'MOV_PRESENCE_TEST_CONSTANT',
  /** A read or traversal off a position whose union has had EVERY member ruled
   *  out by the `IS` tests above it — the empty union, TypeScript's `never`.
   *  Nothing can reach the branch, so there is no surface to read. Reaching the
   *  branch is not itself the error (an exhaustive chain is good code, and
   *  erroring at the narrow would be erroring at a true statement), which is
   *  why this fires at the USE. Distinct from NARROWING so the message can say
   *  the cases are already covered rather than send the author to add another
   *  `IS` that could never match. */
  UNREACHABLE_BRANCH: 'MOV_UNREACHABLE_BRANCH',
  /** A dict is looked up by TEXT and by nothing else — the key world is JSON's,
   *  which has one key type. A key of some other shape reaches this rather than
   *  being stringified on the way in: the coercion is a decision (which format?
   *  which timezone?) and the author makes it, in writing. Fires at the two
   *  boundaries a key crosses: `GROUPBY`/`KEYBY`'s key function, and `AT(dict,
   *  key)`. */
  DICT_KEY_NOT_TEXT: 'MOV_DICT_KEY_NOT_TEXT',
} as const;

// ── Tiers ──

/** What the checker has to say about a written tier, if anything. Returned
 *  rather than reported, because the SAME vocabulary is written in two places
 *  — `AI(prompt, "…")`, an expression, and `extract "…" from […]`, a
 *  statement — and each reports at its own span. One rule, two callers. */
export interface TierDiagnostic {
  code: string;
  message: string;
  severity?: 'error' | 'info' | 'warning';
}

/**
 * A written tier, judged. Unknown is an ERROR with a did-you-mean, exactly as
 * a typo'd enum value is: it would otherwise mean "whatever the platform
 * defaults to", which is the same word doing double duty for "I didn't say"
 * and "I said something you ignored. A legacy spelling still runs — it means
 * what it always meant — so it is an INFO nudge toward the word we teach.
 */
export function aiTierDiagnostics(written: string | undefined): TierDiagnostic[] {
  if (written === undefined) return [];
  if ((AI_TIERS as readonly string[]).includes(written)) return [];
  const legacy = AI_TIER_ALIASES.get(written);
  if (legacy !== undefined) {
    return [
      {
        code: TypedDiagnosticCodes.AI_TIER_LEGACY,
        message:
          `"${written}" is the old spelling of the "${legacy}" tier and still means it — `
          + `write \`"${legacy}"\` instead, which is the word the tiers are named in `
          + `(${AI_TIERS.map(t => `"${t}"`).join(' | ')}).`,
        severity: 'info',
      },
    ];
  }
  const closest = closestByEditDistance(written, [...AI_TIERS]);
  return [
    {
      code: TypedDiagnosticCodes.ENUM_UNKNOWN_VALUE,
      message:
        `"${written}" isn't a tier — expected one of: ${AI_TIERS.map(t => `"${t}"`).join(' | ')}.`
        + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
    },
  ];
}

// ── Position type references ──

/**
 * Identity of the graph a position belongs to. `token` is the ScopeSymbol
 * that introduced the graph (the constructed instance, the shape
 * declaration, the ambient kg) compared by reference — two positions are in
 * the same graph iff their tokens are the same object.
 */
export interface InstanceRef {
  token: object;
  name: string;
  schema: InstanceSchema;
}

/**
 * What a body hands back. `returns` is whether it hands anything back AT ALL —
 * a fact callers act on (a call that returns nothing cannot be bound) — kept
 * apart from the TYPE, which may be unknown for a body that plainly does
 * return. Conflating the two would turn "we couldn't type this" into "there is
 * nothing here", which is the accusation the checker must never make.
 *
 * The type, when known, sits on the plane every bound value already has: a
 * record POSITION (the arrow plane) or a VALUE (the dot plane).
 */
export interface ReturnShape extends PlaneType {
  returns: boolean;
}

/** A type on whichever PLANE it lives: a record POSITION (the arrow plane) or
 *  a VALUE (the dot plane). Both absent = untyped. */
export interface PlaneType {
  posType?: PositionTypeRef;
  fieldType?: FieldType;
}

/** One parameter of a closure: its name, and what it accepts. */
export interface ClosureParam extends PlaneType {
  name: string;
}

export type PositionTypeRef =
  /** A bare instance name — the meta position whose edges are the collections. */
  | { kind: 'meta'; instance: InstanceRef }
  /** A position of a known type in a graph. */
  | {
      kind: 'position';
      instance: InstanceRef;
      position: string;
      narrowsEvent?: string;
      display?: string;
      address?: EventAddress;
    }
  /** A union-typed position (`crm.record`); narrowed by `IS` tests. */
  | {
      kind: 'union';
      instance: InstanceRef;
      union: string;
      variants: string[];
      narrowsEvent?: string;
      display?: string;
      address?: EventAddress;
    }
  // `narrowsEvent` above: the UNNARROWED event type this one narrows (the
  // event edge whose address pins base/table/action). Set only on an
  // address-narrowed event type — a listen's derived type, or a signature that
  // pins one. It is what makes an unaddressed signature the WIDER type rather
  // than a different one: "no address on the param accepts any listen".
  //
  // `address` above: the parsed event address itself (edge + pins), carried so
  // an IS test can narrow BY EXTENDING it (subject pins ∪ test pins — an
  // intersection type, exactly TS's `A & B`). The KEY stays the identity;
  // the address is the two sides' shared pre-key struct, never re-parsed
  // from the key.
  //
  // `display`: author-facing text for a ref whose KEY is opaque, when the ref
  // knows it and the schema does not — a LISTEN's derived address is a real type
  // even where no signature named it, so nothing grafted a position to hang a
  // `displayName` on. Diagnostics only.
  /** A write-result handle: position in the target graph + the write's result
   *  shape. `edges` is the write shape's relationship table, carried so a handle
   *  to a writable-only type (no minted position — an ask's `Check`) can still
   *  TRAVERSE its edges (`await a-[:Response]->`); access through the record you
   *  wrote, never a root read. Absent when the write shape declares no edges.
   *
   *  `genericLandings` is where THIS write's own literals landed: edge name →
   *  the position the host synthesized for the values this body authored
   *  (`EdgeSchema.genericOver`). It rides the HANDLE rather than being baked
   *  into `edges` because it is a fact about one construction site, not about
   *  the type — two `Choose` asks in one movement have the same edges and
   *  different landings. Empty/absent ⇒ every edge lands on its declared
   *  target. */
  | {
      kind: 'handle';
      instance: InstanceRef;
      position?: string;
      resultShape: Record<string, FieldType>;
      edges?: Record<string, EdgeSchema>;
      genericLandings?: Record<string, string>;
    }
  /** A position in an extract result graph (the root binding or a traversed node). */
  | { kind: 'extract'; node: ExtractNodeType }
  /**
   * A CLOSURE — `(d: <date>) => { … }`, and everything sugared onto it (a
   * callback's body, an `until` condition). It is a value that can be bound,
   * passed and parked; what it carries is its signature: the parameters it
   * accepts and what calling it hands back (`returns` empty ⇒ it returns
   * nothing). It has no dot plane and no arrow plane — reading a field off a
   * closure or traversing one is an error, not an unknown.
   *
   * `effects` is the closure's own inferred effect row, riding in the type
   * because that is where a value's facts live: passing the closure around
   * carries the row with it, and CALLING it is what adds the row to the
   * caller's. Capturing one adds nothing.
   */
  | {
      kind: 'closure';
      label: string;
      params: ClosureParam[];
      returns: ReturnShape;
      effects: EffectRow;
    }
  /**
   * `T | absent` at the NODE level (asks-as-adapter F19/F20): an awaited landing
   * off a `resolvesEmpty` edge (an ask `Response` a cancel may resolve empty). A
   * DOT read of its field yields `T | absent` (the field may not be there); an
   * ARROW traversal INTO a block is gate-discharged (the block runs zero times
   * when empty), so it unwraps to the inner node. One unified absent with the
   * scalar case. */
  | { kind: 'maybeEmpty'; of: PositionTypeRef }
  /**
   * A CHECKER-LOCAL node — a position a CONSTRUCT mints rather than a system.
   * It belongs to no graph, so there is no schema to consult and nothing to
   * re-resolve at run time: it carries exactly what the construct declared, a
   * closed set of READS (dot plane) and optionally EDGES (arrow plane) whose
   * landings are themselves local. That is a write handle's shape minus the
   * instance — `handle.resultShape` + `handle.edges` for a node no adapter owns
   * — which is why the awaitable-edge story comes for free.
   *
   * `label` is author-facing text for diagnostics ('a callback', "a callback's
   * call"), never an identity: a local node IS its structure.
   *
   * Today's locals are the `callback(…)` binding and its `Called` landing.
   *
   */
  | {
      kind: 'local';
      label: string;
      /** The dot plane. A name PRESENT with an `undefined` type is a read the
       *  construct declared and could not type — different from a name that
       *  isn't there at all, and the difference is load-bearing: one reads
       *  as unknown, the other is an error. */
      reads: Record<string, FieldType | undefined>;
      edges?: Record<string, LocalEdge>;
    };

/** One edge of a checker-local node: the same `EdgeSchema` promises every other
 *  edge carries (awaitable, resolvesEmpty, …), plus the landing itself — a
 *  local node has no instance to resolve a target NAME against. */
export interface LocalEdge {
  schema: EdgeSchema;
  /** The landing. ABSENT means the construct declared this edge and could not
   *  type where it lands — the arrow-plane twin of `reads[name] === undefined`,
   *  and the same load-bearing distinction: traversing it is unknown, not an
   *  unknown NAME. */
  target?: PositionTypeRef;
  /** The edge's landings are RECOMPUTED at every read (a `lazy` entry's walk),
   *  so there is no array for a `link` to append to — appending to one would be
   *  a landing that vanishes at the next read. */
  deferred?: true;
}

// ── The callback surface (one declaration; checker and editor both read it) ──

/** What a callback binding reads: the opaque `id` a platform payload carries
 *  (constant-size — the action's value is baked into the stored body at mint
 *  time) and the `url` a human follows. */
export const CALLBACK_READS: Record<string, FieldType> = { id: 'text', url: 'text' };

/** The callback's one edge: each FIRE, as it happens. */
export const CALLBACK_CALLED_EDGE = 'Called';

/** Every call carries WHEN it happened, whatever the signature. */
export const CALLBACK_CALL_AT = 'At';

/** The settings a `callback(…, { … })` config object accepts. This list is what
 *  diagnostics OFFER; `checkCallbackConfig`'s switch is what ENFORCES — adding
 *  a setting means adding both, in the same change. */
export const CALLBACK_CONFIG_KEYS: readonly string[] = ['once', 'ttl'];

/** A callback's FIRE-TIME signature: the values a platform supplies when it
 *  fires (an untyped entry is one whose declared type didn't resolve). */
export type CallbackParams = ReadonlyArray<{ name: string; type: FieldType | undefined }>;

/**
 * The type of `callback(<subject>, …)`: a local node with the `.id` / `.url`
 * reads and an awaitable `Called` edge landing on the CALL — `At` plus one
 * field per fire-time parameter, named and typed from the subject's own
 * signature. Fully static: the landing is derived here, at the construction
 * site, exactly as a write handle's result shape is.
 *
 * `Called` is `awaitable` (so `await cb-[:Called]->` waits for a fire and
 * `resolvesEmpty` types the landing `T | absent`) AND readable, since a bare
 * traversal reads the calls so far — zero of them before anything fires, which
 * is an empty traversal, not a special state. A repeatable callback simply
 * accumulates landings; traversals are many-valued already, so nothing in the
 * type says otherwise.
 *
 */
export function callbackType(params: CallbackParams): PositionTypeRef {
  const fields: Record<string, FieldType> = { [CALLBACK_CALL_AT]: 'datetime' };
  for (const param of params) {
    if (param.type !== undefined) fields[param.name] = param.type;
  }
  return {
    kind: 'local',
    label: 'a callback',
    reads: CALLBACK_READS,
    edges: {
      [CALLBACK_CALLED_EDGE]: {
        schema: {
          target: CALLBACK_CALLED_EDGE,
          awaitable: true,
          // A tap ARRIVES: the platform posts the callback and the run is woken
          // where it parked (`callback_fire`), so nothing has to look on a timer.
          watchable: true,
          resolvesEmpty: true,
          // The call ledger is APPENDED to as each fire lands
          // (`callback_store.ts`: `calls || [call]`), and the read hands back
          // that array — so the calls are in the order they arrived (R2).
          sequenced: 'arrival',
        },
        target: { kind: 'local', label: "a callback's call", reads: fields },
      },
    },
  };
}

/**
 * The type of `(<params>) => { … }` — its signature, and what calling it does.
 * A closure belongs to no graph and carries no data, so there is no plane to
 * read or traverse: the only thing that can be done with one is call it, so
 * `returns` says what that yields and `effects` says what it does.
 */
export function closureType(
  params: ClosureParam[],
  returns: ReturnShape,
  effects: EffectRow,
): PositionTypeRef {
  return { kind: 'closure', label: 'a closure', params, returns, effects };
}

/**
 * The graph a position belongs to, where it belongs to one — the effect row's
 * `read`/`write` entry. A maybe-empty landing is its own landing's graph; a
 * closure, an extract node and a checker-local node belong to no
 * graph, and saying nothing is the honest answer.
 */
export function instanceOfType(type: PositionTypeRef): InstanceRef | undefined {
  switch (type.kind) {
    case 'meta':
    case 'position':
    case 'union':
    case 'handle':
      return type.instance;
    case 'maybeEmpty':
      return instanceOfType(type.of);
    case 'local':
    case 'extract':
    case 'closure':
      return undefined;
  }
}

// ── Extract result graphs (inferred from the tree) ──

export interface ExtractFieldInfo {
  span: Span;
  /** What the author said this field is, in their own words — the same text the
   *  extraction itself is given. Every field declares one (the parser requires
   *  it), so it is never absent and never invented. */
  description: string;
  /** Explicit annotation — a primitive (`amount: number "…"`) or a
   *  borrowed path (`stage: crm.companies.funding_stage "…"`). The ONLY
   *  thing that types an extract field: backward adoption from write
   *  targets is demoted to a suggestion (explicit over implicit). */
  explicit?: FieldType;
  /** The raw annotation token (`<…>` text) IF the author wrote one — kept
   *  even when it didn't resolve to a type here (missing schema / bad borrow),
   *  so we never suggest annotating a field that's already annotated. */
  annotationRaw?: string;
  /** Annotation suggestions already emitted for this field (dedupe key:
   *  the suggested annotation text). */
  suggested?: Set<string>;
}

export interface ExtractNodeType {
  /** Node name in the tree; the synthetic root reads as 'the extract result'. */
  name: string;
  /** The author's own words for this node. Absent on the synthetic root — it
   *  was never declared, so nobody described it. */
  description?: string;
  /** Every field the node declares, across all its stages — its outward shape.
   *  A later stage inherits the earlier ones and overrides what it re-declares. */
  properties: Map<string, ExtractFieldInfo>;
  /** Child nodes (from any stage) — the result graph's edges. */
  children: Map<string, ExtractNodeType>;
}

// ── Describing types in diagnostics ──

/**
 * A position's author-facing text. An ordinary position is named by its key;
 * a grafted event address is keyed by an OPAQUE token and carries its display
 * separately, so every diagnostic must come through here rather than render the
 * key it happens to hold.
 *
 */
export function displayNameOf(instance: InstanceRef, position: string): string {
  return instance.schema.positions[position]?.displayName ?? position;
}

export function describePosition(type: PositionTypeRef): string {
  switch (type.kind) {
    case 'meta':
      return `'${type.instance.name}' (the instance itself)`;
    case 'position':
      return `${type.instance.name}.${displayNameOf(type.instance, type.position)}`;
    case 'union':
      // Every member ruled out by an `IS` chain — the empty union, TypeScript's
      // `never`. No member is left to name, and naming the graph would imply
      // one was.
      if (type.variants.length === 0) return 'a record kind the branches above already cover';
      // `display` is the ref's own text for a residual the schema never
      // registered; the schema's own name still wins where it has one.
      return `${type.instance.name}.${type.instance.schema.unionDisplayNames?.[type.union] ?? type.display ?? type.union}`;
    case 'handle':
      return type.position !== undefined
        ? `a ${type.instance.name}.${displayNameOf(type.instance, type.position)} handle`
        : `a ${type.instance.name} write handle`;
    case 'extract':
      return type.node.name === EXTRACT_ROOT_NAME
        ? 'the extract result'
        : `the extracted node '${type.node.name}'`;
    case 'closure':
      return type.label;
    case 'local':
      return type.label;
    case 'maybeEmpty':
      return `${describePosition(type.of)} (which may be empty)`;
  }
}

/** A return shape (or a closure parameter's) in author-facing words. Both
 *  planes absent means the body hands nothing back — a fact, not a gap. */
export function describeReturnShape(shape: PlaneType): string {
  if (shape.posType !== undefined) return describePosition(shape.posType);
  if (shape.fieldType !== undefined) return describeFieldType(shape.fieldType);
  return 'nothing';
}

export const EXTRACT_ROOT_NAME = 'extract result';

// ── Field type compatibility ──

/**
 * The three bare built-in coercers and the category they retype to. They are
 * flat functions in the grammar (`{ fn: 'date' | 'datetime' | 'number' }`), so
 * the checker has no per-function spec to read a `returns` off — this map is
 * the single declaration that lets a cross-category comparison clear by
 * wrapping a side (`` `Snoozed Until` <= DATE(x) ``) and still flags a genuine
 * mismatch (`` `Snoozed Until` <= NUMBER(x) `` retypes to number, so a date
 * field on the other side is still caught).
 */
const BARE_COERCER_RETURNS: Readonly<Record<string, FieldType>> = {
  date: 'date',
  datetime: 'datetime',
  number: 'number',
};

/** The flat built-in `COALESCE(a, b, …)`. The grammar lowercases every function
 *  name, so this is the id that reaches the checker. */
const COALESCE_FUNCTION_ID = 'coalesce';

/** Wrap `T` as `T | absent`, flattening (`maybeAbsent(maybeAbsent(T))` is one
 *  level) so callers never nest. `undefined` (untyped) stays untyped — an
 *  unknown type can't be made partial. (asks-as-adapter P20/F13.) */
export function maybeAbsent(type: FieldType | undefined): FieldType | undefined {
  if (type === undefined) return undefined;
  if (typeof type === 'object' && type.kind === 'maybeAbsent') return type;
  return { kind: 'maybeAbsent', of: type };
}

/** The present component of a possibly-absent type — `T | absent → T`, `T → T`. */
export function stripAbsent(type: FieldType): FieldType {
  return typeof type === 'object' && type.kind === 'maybeAbsent' ? type.of : type;
}

/** Whether reading this type may yield NO value — the checker's require-present
 *  sites (a plain write field, a comparison) fire on it unless discharged. */
export function isMaybeAbsent(type: FieldType | undefined): boolean {
  return typeof type === 'object' && type.kind === 'maybeAbsent';
}

/**
 * COALESCE on the ABSENCE axis — the one axis this layer types it on.
 *
 * It answers the first argument that HAS a value, so it discharges absence
 * exactly when one argument definitely has one: a literal, or any present-typed
 * expression. `null` is not such an argument — it IS the absence — so
 * `COALESCE(x, null)` may still be absent.
 *
 * When EVERY argument may be absent, so may the result: `COALESCE(FIRST(x))` is
 * `FIRST(x)` with a longer name, and it is refused wherever the bare form is.
 * Answering "untyped" there was laundering — information destruction reading as
 * a guarantee.
 *
 * An UNTYPED argument is the third answer, and it leaves the result unknown:
 * nothing here knows whether it answers, so this manufactures neither a
 * presence nor an absence (unknown stays unknown, as in TS).
 *
 * The value KIND is not inferred — a discharged result is untyped, exactly as
 * every other bare built-in's is, and a maybe-absent one carries the first
 * maybe-absent argument's shape (a real COALESCE's arguments agree).
 */
function coalesceAbsence(args: Array<FieldType | undefined>): FieldType | undefined {
  const definitelyPresent = (type: FieldType | undefined): boolean =>
    type !== undefined && type !== 'absent' && !isMaybeAbsent(type);
  if (args.some(definitelyPresent)) return undefined;
  if (args.some(type => type === undefined)) return undefined;
  // Every argument may be absent; `absent` is what is left when they were all
  // the `null` literal — the value that is never there.
  return args.find(isMaybeAbsent) ?? 'absent';
}

function unwrapList(type: FieldType): FieldType {
  const t = stripAbsent(type);
  if (typeof t === 'object' && t.kind === 'list') return unwrapList(t.of);
  // A tuple behaves as the list it is wherever the slots agree — one element
  // type, so every list rule applies unchanged. Slots that DISAGREE have no
  // element type, and the tuple stays itself (`baseKind` calls that `json`:
  // structured data whose shape nothing here describes).
  if (typeof t === 'object' && t.kind === 'tuple') {
    const slots = t.of;
    if (slots.length === 0 || slots.some(slot => slot === null)) return t;
    const first = slots[0]!;
    return slots.every(slot => fieldTypeEquals(slot!, first)) ? unwrapList(first) : t;
  }
  return t;
}

// ── The order discipline (set vs list) ──────────────────────────────────────
//
// A collection either carries a MEANINGFUL order or it does not, and the
// difference decides which folds may read it. The fact lives on two planes,
// the same split absence already lives on:
//
//   • the POSITION plane — a walk is ordered when its LAST hop is: the author
//     wrote an `ORDER BY` on it, or the adapter declares the edge inherently
//     sequenced (`EdgeSchema.sequenced`). The last hop is what produced the
//     members the fold reads; earlier hops chose where to start from. A chain
//     whose earlier hops fan out can still hand back a concatenation nobody
//     ordered — the honest limit of a checker that cannot see hop cardinality,
//     and the reason the rule is stated rather than implied.
//   • the VALUE plane — `FieldType`'s `{ kind: 'list', unordered? }`. A list is
//     a sequence by construction, so the flag marks the exception.
//
// `unknown` is the third answer and it is never a diagnostic: an untyped
// binding, an edge no schema described, a hop off a position nobody looked at.
// Saying nothing about a surface nobody described is the same rule the rest of
// this file follows.

export type CollectionOrder = 'ordered' | 'unordered' | 'unknown';

/** A walk written as a VALUE and read for its landings (`l-[e:Entries]->`) —
 *  the shape whose records arrive without the graph behind them. */
function isBareWalk(expr: Expression): boolean {
  return (
    expr.type === 'traverse'
    && expr.steps.length > 0
    && expr.expression.type === 'property'
    && expr.expression.propertyTypeId === POSITION_SENTINEL
  );
}

/** A value read BY NAME — a dict. It has parts, so a key can name one, and no
 *  order of its own, so a key must. */
function isKeyedValue(type: FieldType): boolean {
  const t = stripAbsent(type);
  return typeof t === 'object' && t.kind === 'dict';
}

/** A PLAIN value — text, a number, a date: something with no fields to key on
 *  and a natural order of its own. `json` and `file` are neither. */
function isPlainValue(type: FieldType): boolean {
  const t = stripAbsent(type);
  if (typeof t === 'object') return t.kind === 'enum';
  return t === 'text' || t === 'number' || t === 'boolean' || t === 'date' || t === 'datetime';
}

/**
 * The call inside an ordering key that makes it something other than a
 * function of the element — a model call, an extraction. Named for the
 * message; undefined when the key is a read (a field, a path, arithmetic on
 * them), however deep.
 *
 */
function impureKeyCall(expr: Expression): string | undefined {
  switch (expr.type) {
    case 'llm':
      return 'AI(…)';
    case 'extract_value':
      return 'EXTRACT_VALUE(…)';
    case 'kg_exists':
    case 'kg_value':
      return expr.type === 'kg_exists' ? 'KG_EXISTS(…)' : 'KG_VALUE(…)';
    default:
      return subExpressions(expr).map(impureKeyCall).find(found => found !== undefined);
  }
}

/** Every expression written INSIDE one — the sub-terms a rule about the whole
 *  has to look through. */
function subExpressions(expr: Expression): Expression[] {
  switch (expr.type) {
    case 'traverse':
      return [expr.expression, ...expr.steps.flatMap(step =>
        step.type === 'edge' && step.expressionFilter !== undefined ? [step.expressionFilter] : [],
      )];
    case 'resource_traverse':
      return expr.expressionFilter !== undefined ? [expr.expressionFilter, expr.expression] : [expr.expression];
    case 'aggregate':
      return expr.orderBy !== undefined ? [expr.expression, expr.orderBy] : [expr.expression];
    case 'not':
      return [expr.expression];
    case 'at':
      return [expr.expression, expr.index];
    case 'arithmetic':
    case 'compare':
      return [expr.left, expr.right];
    case 'logical':
      return expr.operands;
    case 'concat':
      return expr.parts;
    case 'conditional':
      return [expr.condition, expr.then, expr.else];
    case 'list':
      return expr.elements;
    case 'object':
      return expr.entries.map(entry => entry.value);
    case 'function':
      return expr.args;
    case 'exists':
      return expr.where !== undefined ? [expr.where] : [];
    default:
      return [];
  }
}

/**
 * One member of a VALUE collection — a list's element type, a tuple's shared
 * one. Undefined where the type is not a collection of values at all, which is
 * what the collection ops refuse on.
 */
export function collectionElementOf(type: FieldType): FieldType | undefined {
  const t = stripAbsent(type);
  if (typeof t !== 'object') return undefined;
  if (t.kind === 'list') return t.of;
  if (t.kind === 'tuple') {
    const shared = unwrapList(t);
    // Slots that disagree leave a tuple with no element type — the collection
    // is real, but nothing here can say what one member is.
    return typeof shared === 'object' && shared.kind === 'tuple' ? undefined : shared;
  }
  return undefined;
}

/** The ordering a value collection carries — the public half of the order
 *  discipline, for rules outside this file (the collection ops). */
export function collectionOrderOf(type: FieldType | undefined): CollectionOrder {
  return valueOrdering(type);
}

/** The ordering a VALUE collection carries. Undefined / non-collection types
 *  say nothing — a fold over one is not this rule's business. */
function valueOrdering(type: FieldType | undefined): CollectionOrder {
  if (type === undefined) return 'unknown';
  const t = stripAbsent(type);
  if (typeof t !== 'object') return 'unknown';
  // A tuple is a fixed sequence of slots — order is what it IS.
  if (t.kind === 'tuple') return 'ordered';
  if (t.kind === 'list') return t.unordered === true ? 'unordered' : 'ordered';
  return 'unknown';
}

/** The list type `of` collected under `ordering` — the one place the value
 *  plane's flag is set, so "unordered" cannot be spelled two ways. */
export function listOf(of: FieldType, ordering: CollectionOrder): FieldType {
  return ordering === 'unordered' ? { kind: 'list', of, unordered: true } : { kind: 'list', of };
}

/** The author-facing name of an order-sensitive fold. */
const FOLD_SPELLING: Partial<Record<AggregationFunction | 'at', string>> = {
  first: 'FIRST',
  last: 'LAST',
  join: 'JOIN',
  at: 'AT',
};

/** The type a LITERAL index reads off a tuple. Out of range is knowably null —
 *  a fixed length is a fact, so the read is `absent` rather than an unknown.
 *  A non-literal index cannot pick a slot, so it reads the slots' shared type
 *  (or nothing, when they disagree), possibly absent as any index read is. */
function tupleSlotType(
  tuple: Extract<FieldType, { kind: 'tuple' }>,
  index: number | undefined,
): FieldType | undefined {
  if (index === undefined) {
    const element = unwrapList(tuple);
    return typeof element === 'object' && element.kind === 'tuple'
      ? undefined
      : maybeAbsent(element);
  }
  const resolved = index < 0 ? tuple.of.length + index : index;
  if (resolved < 0 || resolved >= tuple.of.length) return 'absent';
  return tuple.of[resolved] ?? undefined;
}

/** The integer an index expression is FIXED at, when it is written down. */
function literalIndex(expr: Expression): number | undefined {
  if (expr.type !== 'static' || typeof expr.value !== 'number') return undefined;
  return Number.isInteger(expr.value) ? expr.value : undefined;
}

function baseKind(
  type: FieldType,
): 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'file' | 'json' | 'absent' {
  const unwrapped = unwrapList(type);
  // A tuple whose slots disagree survives `unwrapList` — structured data with
  // no element type, which is exactly what `json` means here. A DICT is the
  // same answer for the same reason: it is a keyed structure, and adding one
  // up or joining it into text reads nothing meaningful.
  if (typeof unwrapped === 'object' && (unwrapped.kind === 'tuple' || unwrapped.kind === 'dict')) {
    return 'json';
  }
  if (typeof unwrapped === 'object') return 'text'; // enum values are text
  return unwrapped;
}

/** Is this a DATA shape — something a `json` field can hold? Everything but a
 *  `file`, which is a HANDLE (a byte channel the adapter pulls), not a value
 *  that serializes into a JSON document. */
function isDataShaped(type: FieldType): boolean {
  return baseKind(type) !== 'file';
}

/**
 * The comparison CATEGORY of a value type — two values compare only within a
 * category. `date`/`datetime` are both temporal (a date is midnight, so they
 * order against each other); `text`/`enum` are both textual (a string literal
 * compared to an enum is additionally membership-checked by
 * `checkEnumLiteralOperand`); `list`/`file` are structural (comparable only to
 * an identical type). `json` is `opaque` — comparable to NOTHING, itself
 * included: a structured value has no known shape, so no comparison of one is
 * meaningful (`checkComparable` reports it before the category rule, with the
 * pass-it-through guidance rather than a coercer hint).
 */
type ComparisonCategory =
  | 'temporal'
  | 'numeric'
  | 'textual'
  | 'boolean'
  | 'structural'
  | 'opaque'
  /** The `null` literal's own category — in no other, so it matches nothing by
   *  the category rule. `== null` never reaches here (it is intercepted as the
   *  one loose comparison); everything else against `null` IS a mismatch. */
  | 'absent';

export function comparisonCategory(type: FieldType): ComparisonCategory {
  type = stripAbsent(type);
  if (typeof type === 'object') return type.kind === 'enum' ? 'textual' : 'structural';
  switch (type) {
    case 'date':
    case 'datetime':
      return 'temporal';
    case 'number':
      return 'numeric';
    case 'text':
      return 'textual';
    case 'boolean':
      return 'boolean';
    case 'file':
      return 'structural';
    case 'json':
      return 'opaque';
    case 'absent':
      return 'absent';
  }
}

/** A type-only enum shape — the membership check's subject. */
type EnumType = Extract<FieldType, { kind: 'enum' }>;

function isEnumType(type: FieldType | undefined): type is EnumType {
  return typeof type === 'object' && type.kind === 'enum';
}

/** What an enum check reports: a code, a message, and (open known-values only)
 *  a warning severity. */
type EnumDiagnostic = { code: string; message: string; severity?: 'warning' };

/**
 * Is this enum's domain EMPTY — a closed option set with nothing in it? That is
 * the empty union, TypeScript's `never`: it accepts NOTHING, not everything. So
 * the diagnostic is about the field, not the value — checked before membership
 * (a "not one of: ()" message is worse than useless) and independent of whether
 * the value is a literal at all.
 *
 * An OPEN known-values field with nothing listed is the OTHER fact: the adapter
 * couldn't enumerate the values, not that there are none. That stays silent —
 * "I haven't looked" and "there is nothing" must not collapse together.
 *
 * `subject` names the field when the call site knows it ("'listName' on the
 * List"); callers that only hold the type get the anonymous phrasing.
 */
export function checkEnumDomain(
  enumType: EnumType,
  subject = 'This field',
): EnumDiagnostic | null {
  if (enumType.open !== undefined || enumType.options.length > 0) return null;
  return {
    code: TypedDiagnosticCodes.ENUM_EMPTY_DOMAIN,
    message:
      `${subject} has no values to choose from — the connected system currently `
      + `offers none, so its option set is empty. No value can satisfy it, which `
      + `makes this impossible rather than mistaken: it is not a typo, and no `
      + `spelling would work. Nothing can use this field until an option exists.`,
  };
}

/**
 * The one place enum-literal membership is decided. A string LITERAL that is
 * contextually an enum value — one operand of a comparison against an enum
 * field, a value written into an enum field, the literal an enum position is
 * narrowed against — must be one of the enum's options. Returns the diagnostic
 * (code + message, with a did-you-mean for the closest option) when it isn't,
 * or null when it's valid. Shared by the compare, write, and IS-narrow sites so
 * the membership rule and the suggestion phrasing can never drift.
 */
export function checkEnumLiteral(
  literal: string,
  enumType: EnumType,
): EnumDiagnostic | null {
  const empty = checkEnumDomain(enumType);
  if (empty !== null) return empty;
  if (enumType.options.includes(literal)) return null;
  if (enumType.open) {
    // Open known-values: id-shaped literals are always legal; anything else
    // unknown is a WARNING (the listing may be incomplete), with the same
    // did-you-mean as the closed check.
    const pattern = enumType.open.allowPattern;
    if (pattern !== undefined) {
      try {
        if (new RegExp(pattern).test(literal)) return null;
      } catch {
        // An unparseable pattern never blocks the author — skip the id gate.
        return null;
      }
    }
    const closest = closestByEditDistance(literal, enumType.options);
    return {
      code: TypedDiagnosticCodes.VALUE_UNLISTED,
      severity: 'warning',
      message:
        `"${literal}" isn't among the known values here (the list may be incomplete) — `
        + `known: ${enumType.options.slice(0, 20).join(' | ')}.`
        + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
    };
  }
  const closest = closestByEditDistance(literal, enumType.options);
  return {
    code: TypedDiagnosticCodes.ENUM_UNKNOWN_VALUE,
    message:
      `"${literal}" isn't a value of ${describeFieldType(enumType)} — `
      + `expected one of: ${enumType.options.join(' | ')}.`
      + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
  };
}

/**
 * The one place "you can't do that to a structured value" is decided — the
 * shape of `checkEnumLiteral`, for the same reason: the rule and its wording
 * are shared by every site that operates on a value (the typing walker's
 * comparisons / arithmetic / folds, and the statement layer's conditions), so
 * they cannot drift apart. `operation` completes "it can't be …".
 *
 * Returns null for anything else, an unknown type included — silence for an
 * unknown type is this layer's contract.
 */
export function checkJsonOpaque(
  type: FieldType | undefined,
  operation: string,
): { code: string; message: string } | null {
  if (type === undefined || baseKind(type) !== 'json') return null;
  return {
    code: TypedDiagnosticCodes.JSON_OPAQUE,
    message:
      `${describeFieldType(stripAbsent(type))} is a structured value and nothing describes `
      + `its shape, so it can't be ${operation} — pass it through unchanged into a json `
      + `field instead`,
  };
}

/**
 * The one place "arithmetic is numeric" is decided — `checkJsonOpaque`'s shape,
 * for the same reason. `+ - * /` are the four arithmetic operators, and `+` has
 * no concat overload: the engine coerces both sides through `Number()`, so a
 * non-numeric operand evaluated to NaN and stored as null, SILENTLY. That is
 * the absence of a guarantee, not a weaker one, so a KNOWN non-numeric operand
 * is an error — TypeScript's "the left-hand side of an arithmetic operation
 * must be of type number".
 *
 * Permissive where it cannot see: an undefined (untyped/underspecified) operand
 * stays silent, like every check in this layer. A `json` operand belongs to
 * MOV_JSON_OPAQUE, which the same site already reports — saying it twice, in
 * two vocabularies, helps nobody.
 *
 * Numeric means `number` after `baseKind` — absence and list cardinality are
 * transparent here (their own sites police them), and an enum is text.
 */
export function checkArithmeticOperands(
  expr: Extract<Expression, { type: 'arithmetic' }>,
  left: FieldType | undefined,
  right: FieldType | undefined,
): { code: string; message: string } | null {
  const sides = [
    { label: 'left', expr: expr.left, type: left },
    { label: 'right', expr: expr.right, type: right },
  ];
  if (sides.some(s => s.type !== undefined && baseKind(s.type) === 'json')) return null;
  const offenders = sides.filter(s => s.type !== undefined && baseKind(s.type) !== 'number');
  if (offenders.length === 0) return null;

  const described = offenders.map(o => describeFieldType(stripAbsent(o.type!)));
  const subject =
    offenders.length === 1
      ? `the ${offenders[0].label} side of '${expr.op}' is ${described[0]}`
      : described[0] === described[1]
        ? `both sides of '${expr.op}' are ${described[0]}`
        : `the left side of '${expr.op}' is ${described[0]} and the right side is ${described[1]}`;

  return {
    code: TypedDiagnosticCodes.ARITH_NON_NUMERIC,
    message: `An arithmetic operation requires numeric operands — ${subject}.${hintFor(expr, offenders.map(o => baseKind(o.type!)))}`,
  };
}

/** The remedy clause, chosen by what the offending operand actually is: a
 *  string wants interpolation (`+` is the only operator anyone means as
 *  concatenation; for the others it is a value that needs coercing), a date
 *  wants the shift function. Anything else gets no guess. */
function hintFor(
  expr: Extract<Expression, { type: 'arithmetic' }>,
  offending: ReturnType<typeof baseKind>[],
): string {
  if (offending.includes('text')) {
    if (expr.op !== '+') return ' Wrap it in NUMBER(…) if it holds a number.';
    const rewritten = interpolationRewrite(expr);
    return (
      ' Build the string with "${…}" interpolation instead'
      + (rewritten !== undefined ? `: ${rewritten}.` : '.')
    );
  }
  if (offending.includes('date') || offending.includes('datetime')) {
    return ' Shift a date with DATE.ADD_DAYS(date, days) instead.';
  }
  return '';
}

/**
 * The `+` chain rewritten as one interpolated string — `a.\`Url\` + "?answer=true"`
 * as `"${a.\`Url\`}?answer=true"`. Literals contribute their own text, everything
 * else an interpolation, and the chain is flattened so a three-part concat
 * suggests the whole string rather than a fragment.
 *
 * Undefined unless EVERY leaf is cheaply printable back to source: a suggestion
 * that silently dropped part of the expression, or that re-parsed differently
 * from what the author wrote, would be worse than no suggestion at all.
 */
function interpolationRewrite(expr: Expression): string | undefined {
  const parts: string[] = [];
  const walk = (e: Expression): boolean => {
    if (e.type === 'arithmetic' && e.op === '+') return walk(e.left) && walk(e.right);
    const literal = literalText(e);
    if (literal !== undefined) {
      parts.push(literal);
      return true;
    }
    const source = operandSource(e);
    if (source === undefined) return false;
    parts.push('${' + source + '}');
    return true;
  };
  return walk(expr) ? `"${parts.join('')}"` : undefined;
}

/** A literal's contribution to an interpolated string: its own text, verbatim.
 *  A string carrying quoting-significant characters is not cheaply printable —
 *  re-escaping it here is how a suggestion drifts from what it replaces. */
function literalText(expr: Expression): string | undefined {
  if (expr.type !== 'static' || expr.value === null) return undefined;
  if (typeof expr.value !== 'string') return String(expr.value);
  return /["\\\n]|\$\{/.test(expr.value) ? undefined : expr.value;
}

/** The short source form of an operand — a field read, a dotted read off a
 *  bound name, a meta field, a bare alias. Traversals with hops and every
 *  compound form are deliberately absent: they have no one-line spelling the
 *  author would recognise as their own. */
function operandSource(expr: Expression): string | undefined {
  if (expr.type === 'property') return quoteName(expr.propertyTypeId);
  if (expr.type === 'meta') return `@${expr.key}`;
  if (expr.type === 'alias_ref') return quoteName(expr.name);
  if (
    expr.type === 'traverse'
    && expr.aliasRoot !== undefined
    && expr.steps.length === 0
    && expr.expression.type === 'property'
  ) {
    return `${quoteName(expr.aliasRoot)}.${quoteName(expr.expression.propertyTypeId)}`;
  }
  return undefined;
}

/**
 * May a value of type `value` be written into a field of type `target`?
 * Deliberately lenient (lists coerce both ways, everything renders into
 * text, text parses into dates) — a typed check fires only on clear shape
 * mistakes.
 */
export function fieldTypeCompatible(value: FieldType, target: FieldType): boolean {
  // Absence is a require-present concern (checked separately at the write site),
  // not a shape mismatch — compare the present shapes.
  const v = baseKind(value);
  const t = baseKind(target);
  // A literal `null` has no shape to mismatch — it is the ABSENCE of one, which
  // the require-present sites police. Saying it twice, in the shape vocabulary,
  // would send the author hunting for a coercer that could never help.
  if (v === 'absent') return true;
  // `json` is the DATA top type: every data shape flows INTO it (an object
  // literal, a list, a scalar — the field mirrors the target API verbatim), and
  // a `file` does not, being a handle rather than data. Nothing flows OUT of it:
  // a json value has no known shape, so writing one into a typed field is the
  // error that tells the author to pass it through instead. Both rules sit ahead
  // of the `text` catch-all — "everything renders into text" is exactly the
  // conflation the json type exists to end.
  if (t === 'json') return v !== 'file';
  if (v === 'json') return false;
  if (t === 'text') return true;
  if (v === t) return true;
  if (v === 'text' && t === 'date') return true;
  return false;
}

/** Strict sameness (number vs text IS different; enum options compared).
 *  Absence is transparent to sameness — `T | absent` equals `T` here (the
 *  require-present sites police absence, not the shape checks). */
export function fieldTypeEquals(a: FieldType, b: FieldType): boolean {
  a = stripAbsent(a);
  b = stripAbsent(b);
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.kind === 'list' && b.kind === 'list') return fieldTypeEquals(a.of, b.of);
  // Two tuples are the same type iff they are the same LENGTH and agree slot by
  // slot — an untyped slot matches only another untyped one, because "we could
  // not see" is not a type two tuples can agree on.
  if (a.kind === 'tuple' && b.kind === 'tuple') {
    return (
      a.of.length === b.of.length
      && a.of.every((slot, i) => {
        const other = b.of[i];
        if (slot === null || other === null) return slot === other;
        return fieldTypeEquals(slot, other);
      })
    );
  }
  // Two dicts agree when what they hold agrees — the keys are data, not type.
  if (a.kind === 'dict' && b.kind === 'dict') return fieldTypeEquals(a.of, b.of);
  if (a.kind === 'enum' && b.kind === 'enum') {
    return a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i]);
  }
  return false;
}

/**
 * Does this write target accept LESS than free text — i.e. would a wrong
 * annotation on the extraction actually produce a value it rejects? A non-text
 * base type (number, date, boolean, file) and a CLOSED option set do; plain
 * text does not (everything renders into it), and neither does an OPEN
 * known-values field, where an unlisted value is only a warning.
 */
function targetConstrainsExtraction(target: FieldType): boolean {
  const t = unwrapList(target);
  if (typeof t === 'object') return t.kind === 'enum' && t.open === undefined;
  // `json` constrains nothing, for the same reason `text` doesn't: it accepts
  // every data shape, so no annotation on the extraction can be the wrong one.
  return t !== 'text' && t !== 'json';
}

/** Can a value of `source` be read where `target` is expected (width-subtype
 *  of a single field)? Identical types pass; an enum (a text base) widens to a
 *  text target; otherwise same comparison-category passes. The reverse of a
 *  widening (text → enum) does NOT pass. */
export function fieldAssignable(source: FieldType, target: FieldType): boolean {
  source = stripAbsent(source);
  target = stripAbsent(target);
  if (fieldTypeEquals(source, target)) return true;
  // `json` widens the same way in a read position as in a write: any data shape
  // reads AS json, and a json value reads as nothing else (see
  // `fieldTypeCompatible`). Cardinality stays strict here, unlike the write
  // gate — a `list<json>` target is reached through `fieldTypeEquals` above.
  if (target === 'json') return isDataShaped(source);
  if (source === 'json') return false;
  if (target === 'text' && (source === 'text' || (typeof source === 'object' && source.kind === 'enum'))) {
    return true;
  }
  // text → enum is the disallowed reverse of the enum→text widening: a
  // plain-text source can hold any string, so it does NOT satisfy a target
  // constrained to an enum's options.
  if (typeof target === 'object' && target.kind === 'enum') return false;
  return comparisonCategory(source) === comparisonCategory(target)
    && comparisonCategory(source) !== 'structural';
}

// ── Schema lookups ──

/** Resolves a position-type name within a schema: union first, then position. */
export function positionRefIn(instance: InstanceRef, name: string): PositionTypeRef | undefined {
  const variants = instance.schema.unions?.[name];
  if (variants) return { kind: 'union', instance, union: name, variants };
  if (instance.schema.positions[name]) return { kind: 'position', instance, position: name };
  return undefined;
}

/**
 * Position-aware narrowing: when the instance schema registered a refined
 * position for this hop's WHERE, the hop lands on the REFINEMENT — an anonymous
 * subtype whose surface (notably its edge set) is the selected position's own,
 * not the type's whole-collection union.
 *
 * The checker does not DECIDE anything here, and that is the point. Narrowing
 * consumes a predicate that evaluates to a Boolean, and only the host can
 * evaluate one — it holds the members' published data. So the host resolves
 * every selection it can and registers the result; the checker looks the WHERE
 * up by its canonical key. A predicate the host couldn't decide (an `AI()`, a
 * runtime value) simply has no refinement, so it doesn't narrow — and the
 * runtime guards stay the safety mechanism, exactly as before.
 *
 * This is why there is no `decidableEquality` any more: "which filter shapes
 * can the compiler decide?" was the wrong question. It only ever needed to
 * agree with the host on a key.
 *
 */
export function refineSelected(
  target: PositionTypeRef,
  filter: Expression | undefined,
): PositionTypeRef {
  if (filter === undefined || target.kind !== 'position') return target;
  const refined =
    target.instance.schema.refinements?.[refinementKey({ type: target.position, filter })];
  if (refined === undefined) return target;
  return positionRefIn(target.instance, refined) ?? target;
}

/** The underlying position schema of a position/handle ref (undefined for the rest). */
export function positionSchemaOfRef(type: PositionTypeRef): PositionSchema | undefined {
  if (type.kind === 'position') return type.instance.schema.positions[type.position];
  if (type.kind === 'handle' && type.position !== undefined) {
    return type.instance.schema.positions[type.position];
  }
  if (type.kind === 'meta') {
    // The instance's meta position, as a real position: its edges ARE its
    // collections, each a create-along edge to that collection's writable root.
    // This is what lets a meta-rooted linked write — `<instance>-[:Companies]->
    // { … }`, the ONLY top-level write form now that flat `X.Type` is gone —
    // resolve and VALIDATE through the same `checkLinkedPath` path as any other
    // linked write. Reads still resolve collections directly (walkSteps' `meta`
    // case), so this doesn't touch the read side. The collection's declared
    // capability rides along because it is the SAME fact an `EdgeSchema` states
    // — one collection, one declaration, whichever view asks for it.
    const schema = type.instance.schema;
    const edges: Record<string, EdgeSchema> = {};
    for (const [collection, { target, capability }] of Object.entries(schema.collections)) {
      edges[collection] = {
        target,
        ...(capability !== undefined ? { capability } : {}),
        ...(schema.writableRoots[target] !== undefined ? { writable: true } : {}),
      };
    }
    return { properties: {}, edges };
  }
  return undefined;
}

/**
 * The declared type of `propertyId` at `position` — a PURE lookup, no
 * diagnostics. Used to type a bracket-WHERE field reference (an
 * `edge_property` against the hop target) for the comparison check; an
 * unknown field, an open or under-described position, or a union where the
 * field's type is ambiguous all degrade to undefined (which keeps the
 * comparison check permissive). `readProperty` is the reporting counterpart.
 */
export function lookupPropertyType(
  position: PositionTypeRef | undefined,
  propertyId: string,
): FieldType | undefined {
  if (position === undefined) return undefined;
  switch (position.kind) {
    case 'position':
    case 'handle': {
      const fromShape = position.kind === 'handle' ? position.resultShape[propertyId] : undefined;
      if (fromShape !== undefined) return fromShape;
      return positionSchemaOfRef(position)?.properties[propertyId];
    }
    case 'union': {
      const types = position.variants
        .map(v => position.instance.schema.positions[v]?.properties[propertyId])
        .filter((t): t is FieldType => t !== undefined);
      if (types.length !== position.variants.length) return undefined;
      return types.every(t => fieldTypeEquals(t, types[0])) ? types[0] : undefined;
    }
    case 'maybeEmpty':
      // A field of a maybe-empty node is itself possibly-absent (F19).
      return maybeAbsent(lookupPropertyType(position.of, propertyId));
    case 'local':
      return position.reads[propertyId];
    case 'closure':
      return undefined;
    case 'meta':
    case 'extract':
      return undefined;
  }
}

// ── Presence narrowing (comparison as a guard form) ──

/**
 * What a condition can prove present. Two shapes, because there are two
 * absences:
 * - `field` — `x.`F`` with no hops (a traversal is already its own gate, so only
 *   the direct read narrows). Discharged by `narrowPresent`.
 * - `binding` — the bound name ITSELF (`channel`, `domain`), whose absence lives
 *   on the binding: `fieldType` for a scalar (`FIRST(co.Domains)`), a
 *   `maybeEmpty` `posType` for a node (`FIRST(chat-[:Channels]->)`, an awaited
 *   `resolvesEmpty` landing). Discharged by `narrowPresentNode` / `stripAbsent`.
 */
export type PresenceProof =
  | { kind: 'field'; root: string; propertyId: string }
  | { kind: 'binding'; root: string };

/** `x.`F`` as authored — the bridge folds a rooted property read into an
 *  alias-rooted traverse with no steps. */
function directFieldRead(
  expr: Expression,
): Extract<PresenceProof, { kind: 'field' }> | undefined {
  if (expr.type !== 'traverse') return undefined;
  if (expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
  if (expr.expression.type !== 'property') return undefined;
  return { kind: 'field', root: expr.aliasRoot, propertyId: expr.expression.propertyTypeId };
}

/** A BARE bound name as authored. The bridge's `resolveProperty` is total, so a
 *  bare identifier arrives as a rootless `property` read (never `alias_ref`);
 *  the statement layer resolves it against the scope, exactly as the engine
 *  does. */
export function bareName(expr: Expression): string | undefined {
  if (expr.type === 'property') return expr.propertyTypeId;
  if (expr.type === 'alias_ref') return expr.name;
  return undefined;
}

/** The subject a condition tests for presence: `x.`F`` or a bare `x`. */
function presenceSubject(expr: Expression): PresenceProof | undefined {
  const field = directFieldRead(expr);
  if (field !== undefined) return field;
  const name = bareName(expr);
  return name !== undefined ? { kind: 'binding', root: name } : undefined;
}

/**
 * `FIRST(<bare traversal>)` / `LAST(…)` / `ONLY(…)` — the folds that pick a
 * POSITION rather than a value. Recognised by the bridge's own marker: a bare
 * path's terminal is the position sentinel, a value path's is a real field. So
 * the two planes are told apart by the SHAPE the bridge already produces, with
 * nothing re-parsed from text.
 */
export function aggregatedBarePath(
  expr: Expression,
): { fn: 'first' | 'last' | 'only'; aliasRoot?: string; steps: TraversalStep[] } | undefined {
  if (expr.type !== 'aggregate') return undefined;
  if (expr.fn !== 'first' && expr.fn !== 'last' && expr.fn !== 'only') return undefined;
  const inner = expr.expression;
  if (inner.type !== 'traverse' || inner.steps.length === 0) return undefined;
  const terminal = inner.expression;
  if (terminal.type !== 'property' || terminal.propertyTypeId !== POSITION_SENTINEL) {
    return undefined;
  }
  return {
    fn: expr.fn,
    ...(inner.aliasRoot !== undefined ? { aliasRoot: inner.aliasRoot } : {}),
    steps: inner.steps,
  };
}

/** `EXISTS(<bare name>)`'s subject. The bridge folds it to an alias-rooted
 *  zero-step traverse wrapping a zero-step `exists`; with hops it is a
 *  TRAVERSAL quantifier, which is its own gate and proves nothing about the
 *  root binding. */
export function existsSubject(expr: Expression): string | undefined {
  if (expr.type !== 'traverse') return undefined;
  if (expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
  const inner = expr.expression;
  if (inner.type !== 'exists' || inner.steps.length > 0 || inner.where !== undefined) {
    return undefined;
  }
  return expr.aliasRoot;
}

/** How a presence test's subject reads back in a diagnostic — the author's own
 *  spelling for the two shapes that have one, undefined for everything else
 *  (a compound expression has no short form worth quoting back). */
function subjectLabel(expr: Expression): string | undefined {
  const name = bareName(expr);
  if (name !== undefined) return name;
  const field = directFieldRead(expr);
  return field !== undefined ? `${field.root}.${quoteName(field.propertyId)}` : undefined;
}

/** The two operand orders of a comparison — every rule here is symmetric. */
function comparisonSides(
  expr: Extract<Expression, { type: 'compare' }>,
): Array<[Expression, Expression]> {
  return [
    [expr.left, expr.right],
    [expr.right, expr.left],
  ];
}

/**
 * The field reads a TRUE condition proves PRESENT. `x.F == <a present value>`
 * is the whole proof: the engine compares `left === right`, so an absent read
 * (null/undefined) is never equal to a present value — equality therefore joins
 * `?:` fill and traversal-as-gate as a guard form, exactly as TS narrows
 * `x.f === 'a'`.
 *
 * The rules that fall out of that, rather than being chosen:
 * - positive AND conjuncts only. Under `OR` / `NOT`, a true condition proves
 *   nothing about any one operand.
 * - `==` only. `!=` against a present value proves presence in its FALSE branch,
 *   and `else` arms carry no narrowing (see `checkIf`), so there is nowhere to
 *   put it.
 * - the OTHER side must itself be present. `absent == absent` is TRUE at runtime
 *   (`undefined === undefined`), so comparing two maybe-absent reads proves
 *   nothing; an untyped side proves nothing either.
 *
 * Two forms join it once `null` is a typed literal, both TS's own: `x != null`
 * proves presence directly, and `EXISTS(x)` asks the same question in the
 * language's older spelling. `x == null` proves presence in its FALSE branch —
 * see `negativePresenceProofs`.
 */
export function presenceProofs(
  expr: Expression,
  typeOf: (operand: Expression) => FieldType | undefined,
): PresenceProof[] {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.flatMap(o => presenceProofs(o, typeOf));
  }
  // `NOT A` true ⟹ A false, so A's negative proofs hold — the dual of the
  // `not` arm in `negativePresenceProofs`, and what makes `NOT ISNULL(x)` a
  // guard.
  if (expr.type === 'not') return negativePresenceProofs(expr.expression, typeOf);
  const exists = existsSubject(expr);
  if (exists !== undefined) return [{ kind: 'binding', root: exists }];
  if (expr.type !== 'compare') return [];
  if (expr.op !== 'eq' && expr.op !== 'neq') return [];
  const proofs: PresenceProof[] = [];
  for (const [subject, other] of comparisonSides(expr)) {
    // `x != null` — the direct presence test. `x != <a value>` proves nothing
    // (an absent x is unequal to it too), and `x == null` proves the opposite.
    if (isNullLiteral(other)) {
      if (expr.op !== 'neq') continue;
      const proof = presenceSubject(subject);
      if (proof !== undefined) proofs.push(proof);
      continue;
    }
    if (expr.op !== 'eq') continue;
    const proof = presenceSubject(subject);
    if (proof === undefined) continue;
    const otherType = typeOf(other);
    if (otherType === undefined || isMaybeAbsent(otherType)) continue;
    proofs.push(proof);
  }
  return proofs;
}

/**
 * What a FALSE condition proves present — the dual of `presenceProofs`, and the
 * half a guard clause needs: `if channel == null { ERROR(…) }` proves `channel`
 * present for everything AFTER the `if` (see `terminates` and `checkIf`).
 *
 * The boolean algebra dualizes rather than being chosen:
 * - `A OR B` false ⟹ BOTH false, so both operands' negative proofs hold
 *   (`and`'s role in the positive direction);
 * - `A AND B` false ⟹ only that one of them is, which is nothing;
 * - `NOT A` false ⟹ A true, so its POSITIVE proofs hold.
 */
export function negativePresenceProofs(
  expr: Expression,
  typeOf: (operand: Expression) => FieldType | undefined,
): PresenceProof[] {
  if (expr.type === 'logical' && expr.op === 'or') {
    return expr.operands.flatMap(o => negativePresenceProofs(o, typeOf));
  }
  if (expr.type === 'not') return presenceProofs(expr.expression, typeOf);
  // `ISNULL(x)` false ⟹ x is not null ⟹ present. The third null-plane guard
  // spelling, and the one the guard clause reaches for: `if ISNULL(x) { ERROR(…) }`.
  if (expr.type === 'function' && expr.fn === 'isnull' && expr.args.length === 1) {
    const proof = presenceSubject(expr.args[0]);
    return proof !== undefined ? [proof] : [];
  }
  if (expr.type !== 'compare' || expr.op !== 'eq') return [];
  const proofs: PresenceProof[] = [];
  for (const [subject, other] of comparisonSides(expr)) {
    if (!isNullLiteral(other)) continue;
    const proof = presenceSubject(subject);
    if (proof !== undefined) proofs.push(proof);
  }
  return proofs;
}

/**
 * `position` with `propertyId`'s absence discharged, or undefined when there was
 * none to discharge. The two absences narrow differently because they ARE
 * different facts:
 * - `maybeEmpty` is NODE-level (the ask resolved, or it settled empty), so one
 *   present field proves the whole landing is there — every field discharges.
 */
export function narrowPresent(
  position: PositionTypeRef,
  propertyId: string,
): PositionTypeRef | undefined {
  switch (position.kind) {
    case 'maybeEmpty':
      return isMaybeAbsent(lookupPropertyType(position, propertyId)) ? position.of : undefined;
    // Every other position type is unconditionally present — nothing to
    // discharge. Listed rather than defaulted so a new kind that CAN be absent
    // has to say so here.
    case 'meta':
    case 'position':
    case 'union':
    case 'handle':
    case 'local':
    case 'extract':
    case 'closure':
      return undefined;
  }
}

/**
 * `position` with the WHOLE landing's absence discharged — the node-plane twin
 * of `narrowPresent`, for a proof about the BINDING rather than one of its
 * fields (`channel != null`, `EXISTS(channel)`). Undefined when there was no
 * node-level absence to discharge, so a caller can tell "narrowed" from
 * "nothing to narrow".
 */
export function narrowPresentNode(position: PositionTypeRef): PositionTypeRef | undefined {
  return position.kind === 'maybeEmpty' ? position.of : undefined;
}

// ── The typed expression walker ──

export interface TypingReporter {
  (code: string, message: string, span: Span, severity?: 'error' | 'info' | 'warning'): void;
}

/**
 * A primitive effect an expression walk passed. A `read` offers every graph the
 * walk touched — its start and each landing — with `undefined` where a hop did
 * not type. The row keeps the ones that resolved and records incompleteness
 * only when NONE did: a walk whose middle hop is an untyped `_resources` step
 * still plainly reads the graph it started in.
 */
export type ExpressionEffect =
  | { kind: 'read'; instances: Array<InstanceRef | undefined> }
  | { kind: 'ai' }
  | { kind: 'now' };

/**
 * The write target an expression flows into, threaded through `infer` so
 * extract-field reads can suggest annotations. `path` is the borrowable
 * `<instance>.<root>.<field>` spelling of the target, when the write's
 * target graph is known.
 */
export interface WriteTargetRef {
  type: FieldType;
  path?: string;
}

/** Plain-language names for filter operators, for the gate's diagnostics. */
/** What a comparison operator expects of its operands — see
 *  {@link ExpressionTyping.checkCompareOperands}. */
type CompareOperandRule = 'same-category' | 'element-wise' | 'duration' | 'none';

const COMPARE_OPERAND_RULES: Record<FilterOperator, CompareOperandRule> = {
  eq: 'element-wise',
  neq: 'element-wise',
  in: 'element-wise',
  contains: 'element-wise',
  gt: 'same-category',
  gte: 'same-category',
  lt: 'same-category',
  lte: 'same-category',
  within: 'duration',
  exists: 'none',
};

const FILTER_OP_LABELS: Record<FilterOperator, string> = {
  eq: 'equals',
  neq: 'not equals',
  contains: 'contains',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  exists: 'exists',
  in: 'in',
  within: 'within',
};

function describeFilterOp(op: FilterOperator): string {
  return FILTER_OP_LABELS[op] ?? op;
}

/**
 * The (field, operator) pairs a hop WHERE constrains directly — the LEFT-hand
 * property of each `compare`, walked through boolean structure. Sub-traversals
 * (`EXISTS(...)`, nested hops) are their own hops, gated separately, so we
 * don't descend into them.
 */
function collectFilterPredicates(expr: Expression): Array<{ field: string; op: FilterOperator }> {
  const out: Array<{ field: string; op: FilterOperator }> = [];
  const visit = (e: Expression): void => {
    switch (e.type) {
      case 'compare':
        if (e.left.type === 'property' || e.left.type === 'edge_property') {
          out.push({ field: e.left.propertyTypeId, op: e.op });
        }
        visit(e.left);
        visit(e.right);
        break;
      case 'logical':
        e.operands.forEach(visit);
        break;
      case 'not':
        visit(e.expression);
        break;
      case 'conditional':
        visit(e.condition);
        visit(e.then);
        visit(e.else);
        break;
      default:
        break;
    }
  };
  visit(expr);
  return out;
}

export class ExpressionTyping {
  /** Aliases bound by traversal steps within the expression(s) this walker has seen. */
  readonly locals = new Map<string, PositionTypeRef | undefined>();

  /** True while walking the traversal INSIDE an `await` — an awaitable final
   *  edge then types as its landing (no MOV_AWAIT_REQUIRED). Set per-walk by
   *  `walkSteps`'s `awaited` option. */
  private awaited = false;

  /** The `EdgeSchema` of the LAST edge hop the most recent `walkSteps` resolved
   *  — undefined when the final hop's source/edge was untyped. Read by the
   *  `await` checker to decide MOV_NOT_AWAITABLE and whether the resolution
   *  `resolvesEmpty`. */
  lastEdgeSchema: EdgeSchema | undefined = undefined;

  /** Where each hop of the most recent `walkSteps` landed, POSITIONALLY against
   *  its steps. Recorded for the same reason `lastEdgeSchema` is: the walk is
   *  the one place a path's landings are known, and re-deriving them anywhere
   *  else would be a second implementation of the hop rules. */
  lastLandings: Array<PositionTypeRef | undefined> = [];

  /** The ordering the most recent `walkSteps` RESULT carries — the fact the
   *  fold discipline reads. Set once, at the end of the walk, so a nested walk
   *  inside a hop's WHERE cannot leave its answer behind. */
  lastOrdering: CollectionOrder = 'unknown';

  /** The edge whose sequencing decided `lastOrdering` — what a diagnostic
   *  names when it asks the author to order the hop. */
  lastOrderingEdge: string | undefined = undefined;

  /** Every traversal this walker has typed, with the ordering its walk found.
   *  A fold asks about its ARGUMENT, which was walked while the argument was
   *  typed; keying on the expression itself is how the answer survives the
   *  nested walks that happen in between. */
  private readonly walkOrderings = new WeakMap<
    Expression,
    { order: CollectionOrder; edge: string | undefined }
  >();

  /** Where each walked traversal LANDED. `SORT`'s key is written against the
   *  members, and the members of a walked collection are the walk's landings —
   *  the same reason the ordering above is remembered per expression. */
  private readonly walkDestinations = new WeakMap<Expression, PositionTypeRef>();

  /** Presence narrowings in force for the sub-expression being walked — the
   *  `then` side of `IF EXISTS(x) THEN … END`. Expression-local: TS narrows
   *  inside a conditional too, and without it the language would force a
   *  statement `if` for a value the author is building inline. */
  private readonly narrowedScalars = new Map<string, FieldType>();

  constructor(
    private readonly options: {
      /** Statement-scope resolution: bound name → its position type (undefined = untyped/unknown). */
      resolveRoot: (name: string) => PositionTypeRef | undefined;
      /** Statement-scope resolution of the SCALAR plane: bound name → the value
       *  type it carries (`domain = FIRST(co.Domains)` reads `text | absent`).
       *  Without it a binding's absence dies at the `=`. */
      resolveScalar?: (name: string) => FieldType | undefined;
      report: TypingReporter;
      /** The span diagnostics point at (the slot / head). */
      span: Span;
      /**
       * Every traversal walked INSIDE an expression, as it is walked.
       *
       * A path head written as a statement (`chat-[ch:Channels]-> { … }`) is
       * recorded by the checker where it reads it. A path written as a VALUE
       * (`n-[:Attendees]->.\`Name\``) is only ever walked here, so it had no
       * record at all — and a renderer with no record has nothing to compose a
       * sentence from but the syntax.
       */
      recordPath?: (path: {
        root?: string;
        steps: TraversalStep[];
        landings: Array<PositionTypeRef | undefined>;
      }) => void;
      /**
       * Every PRIMITIVE EFFECT this walk passes — the expression half of the
       * effect row. The walk is the only place an expression's traversals are
       * resolved to a graph and its `AI(…)` / `@current_date` leaves are seen,
       * so the row is fed from here rather than by a second walker that would
       * have to re-derive both.
       *
       * A walk with NO hops is not a read: `co.\`Name\`` reads a value already
       * in hand, which is exactly the carve-out `isPurePredicate` makes.
       */
      onEffect?: (effect: ExpressionEffect) => void;
      /**
       * A BARE read of an edge the source pushes events for (`watchable`).
       * Not an effect — watchability is a delivery fact, not something running
       * the expression does — so it rides its own hook. The `until` checker is
       * the only listener: polling for something that arrives on its own is
       * what the upgrade nudge is about.
       */
      onWatchableRead?: (edge: string) => void;
    },
  ) {}

  private report(code: string, message: string, severity?: 'error' | 'info' | 'warning'): void {
    this.options.report(code, message, this.options.span, severity);
  }

  /** Hands the walk just finished to the recorder, if anyone asked for one. A
   *  stepless dot-chain (`co.\`Name\``) is not a walk and is left alone — the
   *  reference machinery already reads it. */
  /** Files the walk just finished under the traversal that asked for it, so a
   *  fold reading this traversal can ask about ITS order rather than whichever
   *  walk happened last. */
  private rememberOrdering(expr: Expression, destination?: PositionTypeRef): void {
    this.walkOrderings.set(expr, { order: this.lastOrdering, edge: this.lastOrderingEdge });
    if (destination !== undefined) this.walkDestinations.set(expr, destination);
  }

  private recordWalked(expr: Extract<Expression, { type: 'traverse' }>): void {
    if (expr.steps.length === 0) return;
    this.options.recordPath?.({
      ...(expr.aliasRoot !== undefined ? { root: expr.aliasRoot } : {}),
      steps: expr.steps,
      landings: [...this.lastLandings],
    });
  }

  private rootType(name: string): PositionTypeRef | undefined {
    if (this.locals.has(name)) return this.locals.get(name);
    return this.options.resolveRoot(name);
  }

  /** A bound name's SCALAR type, with any expression-local narrowing applied. */
  private scalarType(name: string): FieldType | undefined {
    const narrowed = this.narrowedScalars.get(name);
    if (narrowed !== undefined) return narrowed;
    return this.options.resolveScalar?.(name);
  }

  /**
   * Can the name be absent? Undefined means NOTHING SAID — an untyped binding,
   * a name that isn't one — and every caller stays silent on it. The two planes
   * carry the fact differently (a scalar's `T | absent`, a node's `maybeEmpty`),
   * which is why this asks both rather than one type answering for both.
   */
  private nameMayBeAbsent(name: string): boolean | undefined {
    const scalar = this.scalarType(name);
    if (scalar !== undefined) return isMaybeAbsent(scalar);
    const node = this.rootType(name);
    if (node !== undefined) return node.kind === 'maybeEmpty';
    return undefined;
  }

  /** A presence test whose subject can never be absent has a fixed answer —
   *  say so (info), the way TS reports an always-truthy condition. */
  private reportConstantPresenceTest(
    name: string,
    test: string,
    verdict: 'always true' | 'always false',
  ): void {
    if (this.nameMayBeAbsent(name) !== false) return;
    this.report(
      TypedDiagnosticCodes.PRESENCE_TEST_CONSTANT,
      `'${name}' always has a value here, so '${test}' is ${verdict} — nothing on this path can make it absent.`,
      'info',
    );
  }

  /** Walk `body` with `proofs`' subjects read as PRESENT — the narrowing an
   *  `IF <guard> THEN <body>` earns for its own THEN side. Restores whatever
   *  was in force, so sibling branches never see it. */
  private withPresence<T>(proofs: PresenceProof[], body: () => T): T {
    const restore = new Map(this.narrowedScalars);
    for (const proof of proofs) {
      if (proof.kind !== 'binding') continue;
      const current = this.scalarType(proof.root);
      if (current !== undefined) this.narrowedScalars.set(proof.root, stripAbsent(current));
    }
    try {
      return body();
    } finally {
      this.narrowedScalars.clear();
      for (const [name, type] of restore) this.narrowedScalars.set(name, type);
    }
  }

  /**
   * Infers a shallow value type while validating every traversal the walk
   * can root. `writeTarget` is the typed write target the expression flows
   * into: when the expression is a DIRECT property read (`x.`field``) of an
   * extract field, the target informs the read — an unannotated field gets
   * an info-severity ANNOTATE suggestion naming the target's path, and an
   * annotated field is checked for option-set conflicts. Explicit
   * annotations alone constrain extraction (adoption is demoted).
   */
  infer(expr: Expression, writeTarget?: WriteTargetRef): FieldType | undefined {
    if (writeTarget !== undefined && expr.type === 'traverse' && expr.expression.type === 'property') {
      const start = expr.aliasRoot !== undefined ? this.rootType(expr.aliasRoot) : undefined;
      const position = this.walkSteps(start, expr.steps);
      this.rememberOrdering(expr, position);
      this.recordWalked(expr);
      return this.readProperty(position, expr.expression.propertyTypeId, writeTarget);
    }
    return this.inferAt(expr, undefined);
  }

  /** `position` is the ambient position for rootless reads (a traversal's destination). */
  private inferAt(expr: Expression, position: PositionTypeRef | undefined): FieldType | undefined {
    switch (expr.type) {
      case 'static':
        if (typeof expr.value === 'string') return 'text';
        if (typeof expr.value === 'number') return 'number';
        if (typeof expr.value === 'boolean') return 'boolean';
        if (expr.value === null) return 'absent';
        return undefined;
      case 'property':
        // Rootless and nothing to stand on ⇒ this is a bare NAME, not a field:
        // the bridge's property resolver is total, so `domain` and `co.Name`
        // arrive in the same shape and only the ambient position tells them
        // apart. The engine resolves it the same way (`scopedBinding`).
        if (position === undefined) return this.scalarType(expr.propertyTypeId);
        return this.readProperty(position, expr.propertyTypeId);
      case 'traverse': {
        const exists = existsSubject(expr);
        if (exists !== undefined) {
          this.reportConstantPresenceTest(exists, `EXISTS(${exists})`, 'always true');
          return 'boolean';
        }
        const start = expr.aliasRoot !== undefined ? this.rootType(expr.aliasRoot) : position;
        const destination = this.walkSteps(start, expr.steps);
        this.rememberOrdering(expr, destination);
        this.recordWalked(expr);
        return this.inferAt(expr.expression, destination);
      }
      case 'resource_traverse':
        // `_resources` yields untyped file positions (M2b leaves them silent).
        this.inferAt(expr.expression, undefined);
        return undefined;
      case 'exists':
        this.checkExistsSteps(expr.steps, expr.where, position);
        return 'boolean';
      case 'list': {
        const elementTypes = expr.elements.map(e => this.inferAt(e, position));
        const first = elementTypes[0];
        if (first === undefined) return undefined;
        if (!elementTypes.every(t => t !== undefined && fieldTypeEquals(t, first))) return undefined;
        return { kind: 'list', of: first };
      }
      case 'object': {
        // `{ k: v, … }` — a DICT when its values agree on a type, and `json`
        // when they do not. Both answers are the honest one for what was
        // written: a dict is homogeneous (that is what makes `AT` on one type
        // exactly), and a literal whose values disagree describes a structured
        // value nothing here has a shape for — which is what `json` means, and
        // is how such a literal already reached the API surface it mirrors.
        // Every value is walked either way, since a traversal inside one must
        // be validated like any other.
        const valueTypes = expr.entries.map(e => this.inferAt(e.value, position));
        const first = valueTypes[0];
        if (first === undefined || valueTypes.length === 0) return 'json';
        if (!valueTypes.every(t => t !== undefined && fieldTypeEquals(t, first))) return 'json';
        // Sameness is transparent to absence, so it has to be carried
        // separately: one entry that may not answer makes every read of this
        // dict one that may not answer.
        const of = valueTypes.some(isMaybeAbsent) ? maybeAbsent(first)! : first;
        return { kind: 'dict', of };
      }
      case 'concat': {
        const parts = expr.parts.map(p => this.inferAt(p, position));
        parts.forEach(t => this.requireTransparent(t, 'combined into text'));
        return 'text';
      }
      case 'arithmetic': {
        const left = this.inferAt(expr.left, position);
        const right = this.inferAt(expr.right, position);
        this.requireTransparent(left, 'used in arithmetic');
        this.requireTransparent(right, 'used in arithmetic');
        const nonNumeric = checkArithmeticOperands(expr, left, right);
        if (nonNumeric !== null) this.report(nonNumeric.code, nonNumeric.message);
        return 'number';
      }
      case 'compare': {
        const leftType = this.inferAt(expr.left, position);
        const rightType = this.inferAt(expr.right, position);
        this.checkCompareOperands(expr.op, expr, leftType, rightType);
        return 'boolean';
      }
      case 'logical':
        expr.operands.forEach(o => this.inferAt(o, position));
        return 'boolean';
      case 'not':
        this.inferAt(expr.expression, position);
        return 'boolean';
      case 'conditional': {
        this.inferAt(expr.condition, position);
        // The condition guards its own THEN — `IF EXISTS(x) THEN "…${x}…"` is
        // the value-level guard clause, and TS narrows inside a ternary too.
        const proofs = presenceProofs(expr.condition, o => this.inferAt(o, position));
        const thenType = this.withPresence(proofs, () => this.inferAt(expr.then, position));
        const elseType = this.inferAt(expr.else, position);
        if (thenType !== undefined && elseType !== undefined && fieldTypeEquals(thenType, elseType)) {
          return thenType;
        }
        return undefined;
      }
      case 'at': {
        const inner = this.inferAt(expr.expression, position);
        const indexType = this.inferAt(expr.index, position);
        const innerShape = inner === undefined ? undefined : stripAbsent(inner);
        // A DICT is looked up, not indexed: there is no order to demand, and
        // the second argument is a KEY, checked as one. What comes back is
        // `T | absent` under the ordinary absence discipline — a key that is
        // not there is the everyday case, not an error.
        if (typeof innerShape === 'object' && innerShape.kind === 'dict') {
          this.requireDictKey(indexType, 'looked up in a dict');
          return maybeAbsent(innerShape.of);
        }
        this.checkFoldOrder('at', expr.expression, position);
        if (inner === undefined) return undefined;
        const element = stripAbsent(inner);
        // A TUPLE has a slot per position, so a LITERAL index reads that slot
        // and nothing else — present, because a fixed-length list always has
        // it. That exactness is the whole reason the tuple type exists.
        if (typeof element === 'object' && element.kind === 'tuple') {
          return tupleSlotType(element, literalIndex(expr.index));
        }
        // Indexing can miss — an out-of-range index reads null at run time, so
        // the element is `T | absent`, exactly as FIRST/LAST are.
        return maybeAbsent(
          typeof element === 'object' && element.kind === 'list' ? element.of : element,
        );
      }
      case 'aggregate': {
        const inner = this.inferAt(expr.expression, position);
        if (expr.fn === 'sort') return this.inferSort(expr, inner, position);
        this.checkFoldOrder(expr.fn, expr.expression, position);
        // The folds that READ the elements (arithmetic, ordering, text) can't
        // read a structured one; the shape-preserving ones (count, first/last,
        // collect) carry json through untouched.
        const element = inner === undefined ? undefined : unwrapList(inner);
        switch (expr.fn) {
          case 'count':
            return 'number';
          case 'sum':
          case 'avg':
            this.requireTransparent(element, 'added up');
            return 'number';
          case 'join':
            this.requireTransparent(element, 'joined into text');
            return 'text';
          // The folds that pick an ELEMENT can come up empty — the engine
          // answers null over an empty set — so they type `T | absent` and the
          // absence fires at whatever site requires a value. (`count` / `sum` /
          // `avg` / `join` / `collect` have a zero, so they always answer.)
          case 'min':
          case 'max':
            this.requireTransparent(element, 'ordered');
            return maybeAbsent(element);
          case 'first':
          case 'last':
            return maybeAbsent(element);
          /**
           * `ONLY` is the commutative singleton — "the one that matched".
           * Nothing matched is ordinary absence, and the absence discipline
           * already carries it (`T | absent`); MORE than one is the author's
           * cardinality claim turning out false, which nothing at author time
           * can see, so it fails the run. Order-free by construction: it never
           * has to say which one, only that there is one.
           */
          case 'only':
            return maybeAbsent(element);
          case 'collect':
            return element !== undefined
              ? listOf(element, this.collectionOrdering(expr.expression, position).order)
              : undefined;
          case 'llm':
            this.options.onEffect?.({ kind: 'ai' });
            return undefined;
        }
        return undefined;
      }
      case 'llm':
        this.options.onEffect?.({ kind: 'ai' });
        for (const d of aiTierDiagnostics(expr.tier)) this.report(d.code, d.message, d.severity);
        if (expr.promptExpression) this.inferAt(expr.promptExpression, position);
        return undefined;
      case 'function': {
        const args = expr.args.map(a => this.inferAt(a, position));
        // FILE(content, "pdf"|"text") yields a file value; the bare
        // coercers DATE/DATETIME/NUMBER retype their argument to the named
        // category (this is what lets a cross-category comparison clear by
        // wrapping a side in one); COALESCE is typed on the ABSENCE axis alone
        // (it is the value-level fallback, so it discharges `T | absent` — and
        // only when something always answers); namespaced stdlib calls
        // (bridge-folded dotted ids) declare their returns. Additive only —
        // every other bare function stays untyped (silent).
        if (expr.fn === FILE_FUNCTION_ID) return 'file';
        if (expr.fn in BARE_COERCER_RETURNS) return BARE_COERCER_RETURNS[expr.fn];
        if (expr.fn === COALESCE_FUNCTION_ID) return coalesceAbsence(args);
        const stdlibSpec = stdlibFunctionById(expr.fn);
        if (stdlibSpec === undefined) return undefined;
        this.checkStdlibLiteralArgs(stdlibSpec, expr.args);
        // `DATE.TODAY(zone)` reads the run's clock, exactly as `@current_date`
        // does — same effect, so the row says so from the registry rather than
        // from a second list of names.
        if (stdlibSpec.readsClock === true) this.options.onEffect?.({ kind: 'now' });
        // A parse that can fail (`DATE.PARSE`) types its result `T | absent`,
        // so the absence propagates and fires at the required-value site (F13).
        return stdlibSpec.maybeAbsent ? maybeAbsent(stdlibSpec.returns) : stdlibSpec.returns;
      }
      case 'kg_exists':
        expr.params.forEach(p => this.inferAt(p, position));
        return 'boolean';
      case 'kg_value':
        expr.params.forEach(p => this.inferAt(p, position));
        return undefined;
      case 'meta':
        this.checkMetaKey(expr.key);
        if (isClockMetaKey(expr.key)) this.options.onEffect?.({ kind: 'now' });
        return movementMetaKeyType(expr.key);
      case 'edge_property':
        // Inside a bracket WHERE (`-[:companies WHERE `Count` == …]->`) EVERY
        // bare name parses as edge_property, and the engine resolves it against
        // two surfaces: a value binding in the surrounding scope, else a field
        // of the hop TARGET (the ambient `position`). So this types both —
        // otherwise a binding used in a WHERE reads as an undeclared field,
        // types as nothing, and every rule that fires on a type (the
        // ordered-comparison presence rule above all) says nothing about it.
        //
        // Field first, binding second, where the engine's order is the reverse.
        // It only differs when a binding SHADOWS a declared field of the target,
        // which no real movement does, and preferring the binding there would
        // silently retype existing filters. Still a pure lookup — no
        // UNKNOWN_PROPERTY reporting, since an unknown WHERE field isn't this
        // layer's concern (the hop gate already handles them).
        return (
          lookupPropertyType(position, expr.propertyTypeId)
          ?? this.scalarType(expr.propertyTypeId)
        );
      case 'alias_ref':
        // The bridge only emits this where its property resolver is partial;
        // either way a bare name is a scope lookup, same as the `property` case.
        return this.scalarType(expr.name);
      case 'parent_result':
      case 'action_result':
      case 'extract_value':
        // The scalar sub-prompt inside an extraction tree — a model call like
        // `AI()`, spelled for a field.
        this.options.onEffect?.({ kind: 'ai' });
        return undefined;
      case 'resource':
      case 'linked_object':
        return undefined;
    }
  }

  /**
   * A `json` value is OPAQUE — the DATA top type, TypeScript's `unknown`. Every
   * operation that READS a value (comparison, arithmetic, text folding) needs a
   * shape, and nothing has described this one, so `operation` is an error rather
   * than a risk: the `text` projection this type replaced accepted them all and
   * produced `[object Object]` at run time. The message names what the author
   * CAN do — pass the value through unchanged — and deliberately suggests no
   * narrowing syntax, because none exists to teach.
   *
   * Returns true when it fired, so a caller can stop rather than pile a second
   * diagnostic onto the same expression. Silent for an unknown type, like every
   * other check in this layer.
   */
  /**
   * A dict's keys are TEXT. Anything else is refused here, with the coercion
   * the author has to write themselves — because there is no right default:
   * a date has a dozen spellings and picking one silently is how two parts of
   * one movement come to disagree about what the same day is called.
   *
   * Text and any option set (declared or borrowed) pass — an enum's values ARE
   * strings. Unknown stays silent, like every other rule in this layer.
   */
  requireDictKey(type: FieldType | undefined, where: string): void {
    if (type === undefined) return;
    const key = stripAbsent(type);
    if (key === 'text') return;
    if (typeof key === 'object' && key.kind === 'enum') return;
    const repair =
      key === 'date' || key === 'datetime'
        ? "write the spelling down — `DATE.FORMAT(d, \"YYYY-MM-DD\")`"
        : 'write it into text — `"${…}"`';
    this.report(
      TypedDiagnosticCodes.DICT_KEY_NOT_TEXT,
      `a dict is keyed by text, and this key is ${describeFieldType(key)} (${where}). There is no one way to spell ${describeFieldType(key)} as text, so ${repair}.`,
    );
  }

  private requireTransparent(type: FieldType | undefined, operation: string): boolean {
    const diagnostic = checkJsonOpaque(type, operation);
    if (diagnostic === null) return false;
    this.report(diagnostic.code, diagnostic.message);
    return true;
  }

  /**
   * Comparisons (`< <= > >=` and `== !=` alike) must be within a value
   * CATEGORY — temporal (date/datetime, mutually comparable since a date is
   * midnight), numeric (number), textual (text/enum, mutually comparable),
   * boolean. A cross-category compare (`date <= number`, `text == number`)
   * can never be meaningful, so flag it with a coercer hint. Permissive by
   * design: only a DEFINITE mismatch (both sides known, different categories)
   * is flagged — an unknown/undefined side (schema-underspecified) stays
   * silent, never a false positive.
   *
   * text/enum stay same-category here; a string literal compared against an
   * enum is additionally membership-checked by `checkEnumLiteralOperand` (a
   * typo'd option is `MOV_ENUM_UNKNOWN_VALUE`, not a category mismatch).
   */
  private checkComparable(
    left: FieldType | undefined,
    right: FieldType | undefined,
  ): void {
    if (left === undefined || right === undefined) return;
    // A structured value is comparable to nothing, itself included — reported
    // ahead of the category rule so the author gets the pass-it-through
    // guidance instead of a coercer hint that couldn't help.
    if (this.requireTransparent(left, 'compared') || this.requireTransparent(right, 'compared')) {
      return;
    }
    const leftCategory = comparisonCategory(left);
    const rightCategory = comparisonCategory(right);
    // list / file: comparable only to an identical type; any category mismatch
    // (including list-vs-list of different element types) is flagged below.
    if (leftCategory === 'structural' || rightCategory === 'structural') {
      if (!fieldTypeEquals(left, right)) this.reportCompareMismatch(left, right);
      return;
    }
    if (leftCategory !== rightCategory) this.reportCompareMismatch(left, right);
  }

  /**
   * When `operand` is a bare string LITERAL and the OTHER side of the
   * comparison is enum-typed, the literal is contextually that enum's value —
   * validate its membership through the shared helper. `operandType` is the
   * literal's own (textual) type; `otherType` carries the enum.
   */
  private checkEnumLiteralOperand(
    operand: Expression,
    operandType: FieldType | undefined,
    otherType: FieldType | undefined,
  ): void {
    if (operand.type !== 'static' || typeof operand.value !== 'string') return;
    // Only a textual literal is contextually an enum value — a number/bool
    // literal mistyped against an enum is the category check's concern.
    if (operandType !== 'text') return;
    if (!isEnumType(otherType)) return;
    const diagnostic = checkEnumLiteral(operand.value, otherType);
    if (diagnostic) this.report(diagnostic.code, diagnostic.message, diagnostic.severity);
  }

  /**
   * Dispatch operand typing by the OPERATOR's signature — the rule set is
   * per-operator, not one homogeneous "both sides same category":
   *
   * - `element-wise` (eq / neq / in / contains): membership-shaped. A list
   *   operand participates through its ELEMENT type — `Tags CONTAINS "x"`,
   *   `Domains == "acme.com"` — so lists unwrap before the category rule
   *   (and the enum membership check) applies. Two lists still compare by
   *   their unwrapped element categories.
   * - `same-category` (gt / gte / lt / lte): strict ordering — both sides one
   *   category; lists and files compare only to an identical type.
   * - `duration` (within): the right operand is a duration literal, not a
   *   value the left compares to — validated by shape instead.
   * - `none` (exists): effectively unary; nothing to type.
   *
   * Absence splits along the same seam, mirroring TS. Equality and membership
   * TOLERATE a possibly-absent operand — `undefined === "Ship"` is false, not an
   * error, so the comparison IS the handling and `==` inside an `if` additionally
   * NARROWS (see `presenceProofs`). ORDERING does not: TS errors on
   * `x < 3` for `x: number | undefined`, and here `relationalOrder` would answer
   * false silently, which is the absence of a guarantee rather than a weaker one.
   */
  private checkCompareOperands(
    op: FilterOperator,
    expr: Extract<Expression, { type: 'compare' }>,
    leftType: FieldType | undefined,
    rightType: FieldType | undefined,
  ): void {
    // `== null` is the ONE loose comparison — TypeScript's own carve-out, and
    // the reason it is handled ahead of the category rules: `null` is in no
    // value category, so every other rule would call it a mismatch.
    if (isNullLiteral(expr.left) || isNullLiteral(expr.right)) {
      this.checkNullComparison(op, expr, leftType, rightType);
      return;
    }
    switch (COMPARE_OPERAND_RULES[op]) {
      case 'none':
        return;
      case 'duration':
        // WITHIN orders a timestamp against the wall clock — an ordering, so it
        // demands a present left just like `<`/`>`.
        if (isMaybeAbsent(leftType)) this.reportAbsentInComparison(leftType!);
        this.checkWithinDuration(expr.right);
        return;
      case 'element-wise': {
        const left = leftType === undefined ? undefined : unwrapList(leftType);
        const right = rightType === undefined ? undefined : unwrapList(rightType);
        this.checkComparable(left, right);
        this.checkEnumLiteralOperand(expr.left, left, right);
        this.checkEnumLiteralOperand(expr.right, right, left);
        return;
      }
      case 'same-category':
        // Checked BEFORE `checkComparable`, whose `stripAbsent` erases the very
        // thing this reports.
        if (isMaybeAbsent(leftType)) this.reportAbsentInComparison(leftType!);
        if (isMaybeAbsent(rightType)) this.reportAbsentInComparison(rightType!);
        this.checkComparable(leftType, rightType);
        this.checkEnumLiteralOperand(expr.left, leftType, rightType);
        this.checkEnumLiteralOperand(expr.right, rightType, leftType);
        return;
    }
  }

  /**
   * A comparison against the `null` LITERAL. `==` / `!=` ask whether the other
   * side has a value at all — legal at any type, and the guard form the rest of
   * this layer narrows on. Every other operator is asking to ORDER or MATCH
   * against nothing, which no value can satisfy: an error rather than a silent
   * false, since silence there is the absence of a guarantee.
   */
  private checkNullComparison(
    op: FilterOperator,
    expr: Extract<Expression, { type: 'compare' }>,
    leftType: FieldType | undefined,
    rightType: FieldType | undefined,
  ): void {
    if (op !== 'eq' && op !== 'neq') {
      this.report(
        TypedDiagnosticCodes.COMPARE_TYPE_MISMATCH,
        `'${describeFilterOp(op)}' can't be used with null — null is the absence of a value, so only '==' and '!=' say anything about it.`,
      );
      return;
    }
    const sides: Array<[Expression, FieldType | undefined]> = [
      [expr.left, leftType],
      [expr.right, rightType],
    ];
    for (const [subject, subjectType] of sides) {
      if (isNullLiteral(subject)) continue;
      const label = subjectLabel(subject);
      if (label === undefined) continue;
      // The subject's own type answers when it HAS one (a field read, a typed
      // scalar binding); a node-plane binding types nothing on this plane, so
      // its absence is read off the binding instead.
      const absent =
        subjectType !== undefined
          ? isMaybeAbsent(subjectType)
          : this.nameMayBeAbsent(bareName(subject) ?? '');
      if (absent !== false) continue;
      this.report(
        TypedDiagnosticCodes.PRESENCE_TEST_CONSTANT,
        `'${label}' always has a value here, so '${label} ${op === 'eq' ? '==' : '!='} null' is ${op === 'eq' ? 'always false' : 'always true'} — nothing on this path can make it absent.`,
        'info',
      );
    }
  }

  /** WITHIN's right side, when literal, must be a duration: `<n>d` days,
   *  `<n>h` hours, `<n>w` weeks — the shapes the engine's recency evaluator
   *  understands. Anything else would silently filter everything out. */
  private checkWithinDuration(operand: Expression): void {
    if (operand.type !== 'static') return;
    if (typeof operand.value === 'string' && /^\d+[dhw]$/.test(operand.value)) return;
    this.report(
      TypedDiagnosticCodes.COMPARE_TYPE_MISMATCH,
      `WITHIN takes a duration literal — a number with a unit, like 30d (days), 12h (hours), or 1w (weeks); got ${JSON.stringify(operand.value)}.`,
    );
  }

  private reportAbsentInComparison(type: FieldType): void {
    this.report(
      TypedDiagnosticCodes.ABSENT_REQUIRED,
      `this side of the ordered comparison may be absent (${describeFieldType(type)}) — it comes from a branch that might not have run, or an answer that might not be there. Ordering needs a value on both sides: fall back to something that always answers ('COALESCE(…, 0)'), gate on it first ('r-[x:…]-> { … }'), or test it with '==' and order inside that branch. (Equality itself is fine on a maybe-absent value — absent is simply never equal.)`,
    );
  }

  private reportCompareMismatch(left: FieldType, right: FieldType): void {
    this.report(
      TypedDiagnosticCodes.COMPARE_TYPE_MISMATCH,
      `Can't compare a ${describeFieldType(left)} to a ${describeFieldType(right)} — `
        + 'wrap one side in DATE(…), DATETIME(…), or NUMBER(…) to coerce it.',
    );
  }

  /** An `@`-prefixed meta field must name one of the canonical keys; an unknown
   *  key would resolve to null silently at runtime, so flag it (with a
   *  did-you-mean for the closest canonical key). */
  private checkMetaKey(key: string): void {
    if (isMovementMetaKey(key)) return;
    const closest = closestMovementMetaKey(key);
    this.report(
      TypedDiagnosticCodes.META_UNKNOWN_KEY,
      `'@${key}' isn't a known meta field.${closest !== undefined ? ` Did you mean '@${closest}'?` : ''}`,
    );
  }

  private checkExistsSteps(
    steps: TraversalStep[],
    where: Expression | undefined,
    position: PositionTypeRef | undefined,
  ): void {
    const destination = this.walkSteps(position, steps);
    if (where) this.inferAt(where, destination);
  }

  /**
   * Walks traversal hops from `start`, validating each edge against the
   * current position type (check 4) and binding hop aliases' types. An
   * unknown start or a `_resources` hop makes the rest of the walk untyped
   * (silent), never wrong. A polymorphic edge does NOT: it lands on its union,
   * which is a type like any other.
   */
  walkSteps(
    start: PositionTypeRef | undefined,
    steps: TraversalStep[],
    opts?: { awaited?: boolean },
  ): PositionTypeRef | undefined {
    this.awaited = opts?.awaited ?? false;
    this.lastEdgeSchema = undefined;
    const landings: Array<PositionTypeRef | undefined> = [];
    this.lastLandings = landings;
    let current = start;
    // The ordering the walk hands back — the LAST hop's, overwritten per hop.
    let ordering: CollectionOrder = 'unknown';
    let orderingEdge: string | undefined = undefined;
    for (const step of steps) {
      if (step.type === 'edge') {
        const from = current;
        const stepped =
          current !== undefined
            ? this.stepEdge(current, step.edgeTypeId, step.expressionFilter)
            : undefined;
        // Read the hop's sequencing NOW: typing the WHERE below walks its own
        // traversals, and `lastEdgeSchema` belongs to whichever walked last.
        ordering = this.hopOrdering(from, step, this.lastEdgeSchema);
        orderingEdge = step.edgeTypeId;
        this.checkHopLimitOrder(step, ordering);
        const next =
          stepped !== undefined ? refineSelected(stepped, step.expressionFilter) : stepped;
        if (step.expressionFilter) this.inferAt(step.expressionFilter, next);
        // The bracket `ORDER BY` key is an expression over the element the hop
        // lands on, so it types exactly as the WHERE just did: at the
        // destination, in check 4's vocabulary, silent on an untyped one. The
        // hop's own alias names that element, so a path key (`ORDER BY
        // e-[:Signal]->.`Discovered At``) is bound before the key is read.
        const orderKey = step.cardinality?.orderBy;
        if (orderKey !== undefined) {
          if (step.alias) this.locals.set(step.alias, next);
          const keyType = this.inferAt(orderKey, next);
          this.checkOrderingKey(orderKey, keyType, `ORDER BY on '${step.edgeTypeId}'`);
        }
        // Gate the hop's WHERE / ORDER BY / LIMIT against the source's declared
        // filter/order/limit capability (chunk 6). Silent when undeclared.
        if (current !== undefined) this.gateHopCapability(current, step, next);
        if (step.alias) this.locals.set(step.alias, next);
        current = next;
      } else if (step.type === 'meta_edge') {
        if (step.expressionFilter) this.inferAt(step.expressionFilter, undefined);
        if (step.alias) this.locals.set(step.alias, undefined);
        current = undefined;
        ordering = 'unknown';
        orderingEdge = undefined;
      } else {
        current = undefined; // resource / linkBack steps are untyped
        ordering = 'unknown';
        orderingEdge = undefined;
      }
      landings.push(current);
    }
    this.lastOrdering = steps.length > 0 ? ordering : 'unknown';
    this.lastOrderingEdge = orderingEdge;
    // A hop is a fetch from whatever graph it walks in. A STEPLESS walk is not
    // — `co.`Name`` reads a value the run already holds — so it raises no read,
    // the same line `isPurePredicate` draws.
    if (steps.length > 0) {
      this.options.onEffect?.({
        kind: 'read',
        instances: [start, ...landings].map(type =>
          type !== undefined ? instanceOfType(type) : undefined,
        ),
      });
    }
    return current;
  }

  /**
   * What order ONE hop hands its members back in.
   *
   * An authored `ORDER BY` is the author saying it; `EdgeSchema.sequenced` is
   * the adapter saying it. An extract result's nested nodes come back in the
   * order the document put them in, which is a real and stable order (R3), and
   * is declared here because an extract result graph has no adapter to declare
   * it. A hop off a position nobody described, or over an edge no schema
   * carries, says NOTHING — the third answer, and never a diagnostic.
   */
  private hopOrdering(
    from: PositionTypeRef | undefined,
    step: Extract<TraversalStep, { type: 'edge' }>,
    edgeSchema: EdgeSchema | undefined,
  ): CollectionOrder {
    if (step.cardinality?.orderBy !== undefined) return 'ordered';
    if (from === undefined) return 'unknown';
    // An extract result's entry edges are document-ordered (R3).
    if (from.kind === 'extract') return 'ordered';
    // A root collection (`crm-[c:Companies]->`) is a query with no order asked
    // for — a set, until an ORDER BY says otherwise.
    if (from.kind === 'meta') {
      return from.instance.schema.collections[step.edgeTypeId] !== undefined
        ? 'unordered'
        : 'unknown';
    }
    if (from.kind === 'local') {
      const local = from.edges?.[step.edgeTypeId];
      if (local === undefined) return 'unknown';
      return local.schema.sequenced !== undefined ? 'ordered' : 'unordered';
    }
    if (edgeSchema === undefined) return 'unknown';
    return edgeSchema.sequenced !== undefined ? 'ordered' : 'unordered';
  }

  /** `LIMIT n` with no `ORDER BY` over a hop that comes back in no particular
   *  order is "some n of them" — the same bug as `FIRST` over a set, and it
   *  gets the same refusal. */
  private checkHopLimitOrder(
    step: Extract<TraversalStep, { type: 'edge' }>,
    ordering: CollectionOrder,
  ): void {
    if (step.cardinality?.limit === undefined) return;
    if (step.cardinality.orderBy !== undefined) return;
    if (ordering !== 'unordered') return;
    this.report(
      TypedDiagnosticCodes.LIMIT_NEEDS_ORDER,
      `'${step.edgeTypeId}' comes back in no particular order, so 'LIMIT ${step.cardinality.limit}' takes some ${step.cardinality.limit} of them — a different ${step.cardinality.limit} each run. Say which ones you mean with an ORDER BY (\`-[:${step.edgeTypeId} ORDER BY \`…\` DESC LIMIT ${step.cardinality.limit}]->\`).`,
    );
  }

  /**
   * The ordering of the collection a fold is about to read. The two planes
   * answer separately — a walk from its last hop, a value from its type — and
   * `unknown` means nobody said, which is never an error.
   */
  private collectionOrdering(
    expr: Expression,
    position: PositionTypeRef | undefined,
  ): { order: CollectionOrder; subject: string | undefined } {
    switch (expr.type) {
      case 'traverse': {
        const walked = this.walkOrderings.get(expr);
        if (walked !== undefined) return { order: walked.order, subject: walked.edge };
        return { order: 'unknown', subject: undefined };
      }
      case 'list':
        return { order: 'ordered', subject: undefined };
      case 'aggregate':
        // `SORT` IS the ordering — that is the whole of what it does, so a
        // fold over its answer needs nothing further. `COLLECT` hands the
        // members back as they came, so it is its argument's ordering; nothing
        // else folds to a collection.
        if (expr.fn === 'sort') return { order: 'ordered', subject: undefined };
        return expr.fn === 'collect'
          ? this.collectionOrdering(expr.expression, position)
          : { order: 'unknown', subject: undefined };
      case 'property':
      case 'edge_property':
      case 'alias_ref': {
        // A pure lookup — the read itself was already typed (and diagnosed)
        // when the argument was inferred; asking again must not say it twice.
        const name = expr.type === 'alias_ref' ? expr.name : expr.propertyTypeId;
        const type =
          (position !== undefined ? lookupPropertyType(position, name) : undefined)
          ?? this.scalarType(name);
        return { order: valueOrdering(type), subject: name };
      }
      default:
        return { order: 'unknown', subject: undefined };
    }
  }

  /** A stdlib argument the function READS — a format pattern — must be written
   *  down, and must be right, at save. */
  private checkStdlibLiteralArgs(
    spec: StdlibFunctionSpec,
    args: ReadonlyArray<Expression>,
  ): void {
    for (const declared of spec.literalArgs ?? []) {
      const arg = args[declared.index];
      if (arg === undefined) continue; // arity is the bridge's to report
      if (arg.type !== 'static' || typeof arg.value !== 'string') {
        this.report(
          TypedDiagnosticCodes.STDLIB_ARG_NOT_LITERAL,
          `${spec.signature} reads ${declared.what}, so it has to be written down — a computed one can't be checked here, and a mistake in it would show up in the output instead. Write the text in place.`,
        );
        continue;
      }
      const problem = declared.check(arg.value);
      if (problem !== undefined) {
        this.report(TypedDiagnosticCodes.STDLIB_ARG_INVALID, problem);
      }
    }
  }

  /**
   * `SORT(xs)` / `SORT(xs, DESC)` / `SORT(xs, key)` / `SORT(xs, key, DESC)` —
   * the same members, ordered. Its type is the argument's, as an ORDERED list,
   * which is what lets a `JOIN` / `FIRST` / `LAST` / `AT` over the answer stand
   * without further ceremony.
   *
   */
  private inferSort(
    expr: Extract<Expression, { type: 'aggregate' }>,
    inner: FieldType | undefined,
    position: PositionTypeRef | undefined,
  ): FieldType | undefined {
    const members = this.sortElementPosition(expr.expression, position);
    const element = inner === undefined ? undefined : unwrapList(inner);
    if (isBareWalk(expr.expression)) {
      // A walk written as a value hands over its records without the graph
      // behind them, so nothing here can read a key off one — and records have
      // no order of their own to fall back on.
      this.report(
        TypedDiagnosticCodes.SORT_KEY_ON_WALK,
        `SORT reads a key off each record, and a walk written inside the call hands its records over without the graph they came from. Bind the walk first — \`entries = … { return … }\` — then SORT the name.`,
      );
    } else if (
      expr.orderBy === undefined
      && (members !== undefined || (element !== undefined && isKeyedValue(element)))
    ) {
      // A record — or a set of values under names — has no order of its own,
      // and comparing two of them would compare their text.
      this.report(
        TypedDiagnosticCodes.SORT_NEEDS_KEY,
        `SORT is ordering ${members !== undefined ? 'records' : 'values with named parts'}, and one of those has no order of its own — say what to rank them by: SORT(…, \`Added At\`, DESC).`,
      );
    } else if (expr.orderBy !== undefined) {
      if (members === undefined && element !== undefined && isPlainValue(element)) {
        // A list of text or numbers has no fields to key on — a member IS the
        // key, which is the form with no key at all.
        this.report(
          TypedDiagnosticCodes.SORT_KEY_ON_SCALAR,
          `SORT reads this key off each member, and these members are plain values — there is nothing to read it from. Order them by themselves: SORT(…) or SORT(…, DESC).`,
        );
      } else {
        const keyType = this.inferAt(expr.orderBy, members);
        this.checkOrderingKey(expr.orderBy, keyType, 'SORT');
      }
    } else if (
      members === undefined
      && inner !== undefined
      && collectionElementOf(inner) === undefined
      // A WALK fans out invisibly — its members' TYPE is one member's, so a
      // scalar there says nothing about how many came back.
      && !(expr.expression.type === 'traverse' && expr.expression.steps.length > 0)
      && isPlainValue(inner)
    ) {
      this.report(
        TypedDiagnosticCodes.SORT_NOT_COLLECTION,
        `SORT orders a collection, and this is one value — there is nothing to put in order.`,
      );
    }
    if (element === undefined) return undefined;
    return listOf(element, 'ordered');
  }

  /**
   * What an ordering key must be, wherever one is written (a hop's `ORDER BY`,
   * `SORT`'s second argument): ONE value per element, read from the element
   * alone. A key that answers with several has nothing to rank by, and a key
   * that asks a model is not a function of the element.
   *
   */
  private checkOrderingKey(
    key: Expression,
    keyType: FieldType | undefined,
    site: string,
  ): void {
    const call = impureKeyCall(key);
    if (call !== undefined) {
      this.report(
        TypedDiagnosticCodes.ORDER_KEY_IMPURE,
        `${site} reads this key once per record and compares the answers, so it has to be a function of the record — ${call} isn't. Read a field, or a short path to one.`,
      );
      return;
    }
    if (keyType !== undefined && collectionElementOf(keyType) !== undefined) {
      this.report(
        TypedDiagnosticCodes.ORDER_KEY_MULTI,
        `${site} needs one value per record to rank it by, and this key answers with several. Fold it to one (MIN(…), MAX(…), FIRST(…)), or key on a single-valued field.`,
      );
    }
  }

  /**
   * The POSITION a `SORT` key is written against — the members' own type. A
   * walked collection's members are where the walk landed; a bound one's are
   * whatever the name holds. Undefined ⇒ the members are plain values, which
   * is what `SORT_KEY_ON_SCALAR` is about.
   */
  private sortElementPosition(
    argument: Expression,
    position: PositionTypeRef | undefined,
  ): PositionTypeRef | undefined {
    // A WALK's members are where it landed; a stepless dot-chain (`c.\`Name\``)
    // is a value read, and the value has no position.
    if (argument.type === 'traverse') {
      return argument.steps.length > 0 ? this.walkDestinations.get(argument) : undefined;
    }
    if (argument.type === 'property' && position === undefined) {
      return this.rootType(argument.propertyTypeId);
    }
    if (argument.type === 'alias_ref') return this.rootType(argument.name);
    return undefined;
  }

  /** The order discipline at a fold: an order-sensitive fold over a collection
   *  whose order means nothing is refused, naming the fixes that exist. */
  private checkFoldOrder(
    fn: AggregationFunction | 'at',
    argument: Expression,
    position: PositionTypeRef | undefined,
  ): void {
    if (fn !== 'at' && FOLD_ALGEBRA[fn] !== 'order-sensitive') return;
    const { order, subject } = this.collectionOrdering(argument, position);
    if (order !== 'unordered') return;
    const named = subject !== undefined ? `'${subject}'` : 'this collection';
    const orderByFix =
      subject !== undefined && argument.type === 'traverse'
        ? ` Order the hop (\`-[:${subject} ORDER BY \`…\` DESC]->\`), or reach for a relationship the source keeps in order.`
        : ' Order the traversal it came from, or reach for a relationship the source keeps in order.';
    const spelling = FOLD_SPELLING[fn] ?? fn.toUpperCase();
    const meaning =
      fn === 'join'
        ? `${spelling} writes the values out in the order they come in, and ${named} comes back in no particular order — the same line would read differently run to run.`
        : fn === 'at'
          ? `${spelling} reads a position in a sequence, and ${named} comes back in no particular order — every index picks an arbitrary member.`
          : `${spelling} takes the ${fn === 'last' ? 'last' : 'first'} of a sequence, and ${named} comes back in no particular order — so there is no ${fn === 'last' ? 'last' : 'first'}.`;
    const onlyFix =
      fn === 'first' || fn === 'last'
        ? ' If you mean the one that matched, write ONLY(…) — it answers that one and fails the run if there turns out to be more than one.'
        : '';
    this.report(TypedDiagnosticCodes.FOLD_NEEDS_ORDER, `${meaning}${onlyFix}${orderByFix}`);
  }

  /**
   * The filter/order/limit capability of a hop OUT of `from` over `edge`
   * (chunk 6). A top-level collection declares its own, exactly as a
   * record-reference edge does — the root is a node and the meta edge is an
   * edge. Undefined ⇒ undeclared surface ⇒ the gate stays silent.
   *
   */
  private edgeCapabilityFor(from: PositionTypeRef, edge: string): EdgeCapability | undefined {
    if (from.kind === 'meta') {
      return from.instance.schema.collections[edge]?.capability;
    }
    if (from.kind === 'position' || from.kind === 'handle') {
      return positionSchemaOfRef(from)?.edges[edge]?.capability;
    }
    return undefined;
  }

  /**
   * Author-time gate (chunk 6): a hop's WHERE / ORDER BY / LIMIT must be
   * within what the source can do across that relationship. Only fires when
   * the adapter has DECLARED its capability; an undeclared edge or
   * under-described target stays silent (best-effort, like schema today). For
   * a `native` filter/order, the per-field gate consults the TARGET position's
   * `propertyCapabilities`; a `bounded` edge satisfies any field via the shared
   * filter unit, so no per-field gate applies.
   */
  private gateHopCapability(
    from: PositionTypeRef,
    step: Extract<TraversalStep, { type: 'edge' }>,
    target: PositionTypeRef | undefined,
  ): void {
    const cap = this.edgeCapabilityFor(from, step.edgeTypeId);
    if (cap === undefined) return; // undeclared surface ⇒ silent
    const edge = step.edgeTypeId;
    const targetSchema = target !== undefined ? positionSchemaOfRef(target) : undefined;

    if (step.expressionFilter !== undefined) {
      if (cap.filter === undefined) {
        this.report(
          TypedDiagnosticCodes.HOP_FILTER_UNSUPPORTED,
          `'${edge}' can't be filtered here — this source doesn't support a WHERE across that relationship.`,
        );
      } else if (cap.filter === 'native' && !isPurePredicate(step.expressionFilter)) {
        // An impure filter (AI() / EXISTS) can only run in the app, over a
        // BOUNDED set — never over an unbounded native source, which would mean
        // fetching everything and filtering in memory (the very thing we refuse
        // to do). Bounded edges accept it (the engine evaluates the small set).
        this.report(
          TypedDiagnosticCodes.HOP_FILTER_UNSUPPORTED,
          `This filter has to run in the app (it uses AI() or EXISTS), which isn't possible over '${edge}' — an unbounded source. Narrow to a bounded relationship first, then filter.`,
        );
      } else if (cap.filter === 'native' && targetSchema?.propertyCapabilities !== undefined) {
        const caps = targetSchema.propertyCapabilities;
        const pushed: string[] = [];
        const residual: string[] = [];
        for (const pred of collectFilterPredicates(step.expressionFilter)) {
          // Unknown fields are MOV_UNKNOWN_PROPERTY's concern, not ours.
          if (targetSchema.properties[pred.field] === undefined) continue;
          const ops = caps[pred.field]?.filterOperators;
          const where = ops !== undefined && ops.includes(pred.op) ? pushed : residual;
          where.push(`\`${pred.field}\` (${describeFilterOp(pred.op)})`);
        }
        if (residual.length > 0 && pushed.length === 0) {
          // NOTHING narrows at the source, so the whole relationship comes back
          // to be filtered here. That is the boundedness rule, and it is still
          // a refusal: an unbounded read is not a slower version of a bounded
          // one.
          this.report(
            TypedDiagnosticCodes.HOP_FILTER_UNSUPPORTED,
            `This source can't filter '${edge}' by ${residual.join(' or ')} — reading it would mean fetching every record and filtering here. Narrow it by something the source can filter first.`,
          );
        } else if (residual.length > 0) {
          // Some of the WHERE narrows at the source and the rest runs here, on
          // what came back. The condition is the one that was written — the
          // engine delivers it either way — so this is the COST, said out loud,
          // and it is said again every time the movement is validated rather
          // than once when it was saved.
          this.report(
            TypedDiagnosticCodes.HOP_FILTER_RESIDUAL,
            `${residual.join(' and ')} on '${edge}' can't be filtered by the source, so those run here on what comes back — the rest of the WHERE narrows it first. The records you get are the same either way; the fetch is bigger.`,
            'warning',
          );
        }
      } else if (cap.filter === 'bounded' && from.kind === 'meta') {
        // A ROOT collection is an unbounded fan-out: `bounded` filtering means
        // the source hands over the whole collection and the WHERE runs here.
        // On a record edge that is free (the set is already in hand, bounded
        // by the record it left), which is why only the root says it — the
        // filter sibling of `HOP_ORDER_ENGINE`.
        this.report(
          TypedDiagnosticCodes.HOP_FILTER_ENGINE,
          `WHERE on '${edge}' runs here, not at the source — the whole collection is fetched first and filtered afterwards. The records you get are the same either way; the fetch is bigger.`,
          'warning',
        );
      }
    }

    const orderBy = step.cardinality?.orderBy;
    if (orderBy !== undefined) {
      // Only a bare property of the landed record can cross the seam; any
      // other key is a walk of this engine's, so the source's ordering
      // capability has nothing to say about it beyond the cost.
      const field = orderKeyProperty(orderBy);
      if (field === undefined) {
        // A key the source cannot be handed. Where it COULD have sorted, say
        // that it now won't: the sort runs here, after the fetch, and each
        // record's key is a read of its own. Where it never could, nothing
        // changed and nothing is said.
        if (cap.order !== undefined) {
          this.report(
            TypedDiagnosticCodes.HOP_ORDER_ENGINE,
            `ORDER BY on '${edge}' runs here, not at the source — this key is read off each record in turn, so the sort happens after the fetch. The order you get is the one you asked for.`,
            'warning',
          );
        }
      } else if (cap.order === undefined) {
        this.report(
          TypedDiagnosticCodes.HOP_ORDER_UNSUPPORTED,
          `'${edge}' can't be ordered here — this source doesn't support ORDER BY across that relationship.`,
        );
      } else if (cap.order === 'native' && targetSchema?.propertyCapabilities !== undefined) {
        if (
          targetSchema.properties[field] !== undefined &&
          targetSchema.propertyCapabilities[field]?.orderable !== true
        ) {
          this.report(
            TypedDiagnosticCodes.HOP_ORDER_UNSUPPORTED,
            `This source can't order '${edge}' by \`${field}\` — that field isn't orderable server-side.`,
          );
        }
      } else if (cap.order === 'bounded' && from.kind === 'meta') {
        // A ROOT collection is an unbounded fan-out: `bounded` ordering means
        // the source hands over whatever the WHERE let through and the sort
        // happens here. On a record edge that is free (the set is already in
        // hand, bounded by the record it left), which is why only the root
        // says it.
        this.report(
          TypedDiagnosticCodes.HOP_ORDER_ENGINE,
          `ORDER BY on '${edge}' runs here, not at the source — everything the WHERE lets through is fetched first and sorted afterwards. The order you get is the one you asked for; the fetch is bigger.`,
          'warning',
        );
      }
    }

    if (step.cardinality?.limit !== undefined && cap.supportsLimit === false) {
      this.report(
        TypedDiagnosticCodes.HOP_LIMIT_UNSUPPORTED,
        `'${edge}' can't be limited here — this source doesn't support LIMIT across that relationship.`,
      );
    }
  }

  /** One typed hop. Reports TRAVERSE_UNKNOWN_EDGE / NARROWING; undefined = untyped
   *  onward. `filter` is the hop's WHERE (when any) — used only to gate an
   *  awaitable hop's purity. */
  stepEdge(
    from: PositionTypeRef,
    edge: string,
    filter?: Expression,
  ): PositionTypeRef | undefined {
    // Only a position/handle hop carries an `EdgeSchema`; reset per hop so the
    // last-resolved edge's schema survives for the `await` checker.
    this.lastEdgeSchema = undefined;
    switch (from.kind) {
      case 'meta': {
        const target = from.instance.schema.collections[edge]?.target;
        if (target === undefined) {
          const available = Object.keys(from.instance.schema.collections);
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            `'${from.instance.name}' has no collection '${edge}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        return positionRefIn(from.instance, target);
      }
      case 'position':
      case 'handle': {
        // A write handle to a writable-only type (an ask's `Check`) has no
        // minted position, so `positionSchemaOfRef` is empty — but its WRITE
        // SHAPE declares the relationship table, and traversing a record you
        // just wrote (`await a-[:Response]->`) is real access. Fall back to the
        // handle's own edges so the hop lands on the (minted) target position
        // and every read past it is checked, instead of typing as nothing.
        const schema =
          positionSchemaOfRef(from) ??
          (from.kind === 'handle' && from.edges !== undefined
            ? { properties: {}, edges: from.edges }
            : undefined);
        if (!schema) {
          this.lastEdgeSchema = undefined;
          return undefined;
        }
        const edgeSchema = schema.edges[edge];
        this.lastEdgeSchema = edgeSchema;
        if (!edgeSchema) {
          if (this.reportUndescribed(from, schema, `the edge '${edge}'`)) return undefined;
          // An OPEN position's surface isn't enumerated — that honesty
          // extends to its edges (a raw payload bag). Unknown stays silent.
          // An UNdescribed one is a different fact, handled just above.
          if (schema.openProperties) return undefined;
          const available = Object.keys(schema.edges);
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            `${describePosition(from)} has no edge '${edge}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        // Where this hop LANDS. Normally the edge's declared target; on a write
        // handle whose construction fixed a generic landing (an ask's `Options`
        // deciding its `Response`'s enum), the position the host synthesized for
        // THIS write's literals. Resolved once, ahead of both returns below, so
        // the awaitable and ordinary paths cannot disagree about the landing.
        const landing =
          (from.kind === 'handle' ? from.genericLandings?.[edge] : undefined) ?? edgeSchema.target;
        // AWAITABLE is a READ MODE, not an edge kind (callback-primitive layer
        // 3): `await` is the read that WAITS, over the very same edge. So an
        // awaitable edge that is also readable may be traversed bare — it reads
        // now and yields nothing until it resolves, which is a legitimate thing
        // to ask. Only an awaitable edge that declares `readable: false` (Slack
        // `Replies`) has no bare read to fall back on, and there the author's
        // real fix is `await`, not "this is write-only" — which is why this
        // precedes the readable check. Still land the target type so downstream
        // reads don't cascade a second error.
        if (edgeSchema.awaitable === true) {
          if (this.awaited) {
            if (filter !== undefined && !isPurePredicate(filter)) {
              // An `await`'s WHERE feeds the engine's rehydration-free evaluation
              // (F10) — it must be PURE (no AI() / EXISTS / nested live traversal).
              this.report(
                TypedDiagnosticCodes.AWAIT_IMPURE_WHERE,
                `The WHERE on '-[:${edge}]->' has to run in the app (it uses AI() or EXISTS), which an 'await' can't do — its condition is evaluated against each candidate without re-running the movement. Narrow it with a pure predicate over the awaited record's own fields.`,
              );
            }
            return positionRefIn(from.instance, landing);
          }
          if (edgeSchema.readable === false) {
            this.report(
              TypedDiagnosticCodes.AWAIT_REQUIRED,
              `'-[:${edge}]->' on ${describePosition(from)} resolves only when it is answered — read it with 'await' (\`await …-[:${edge}]->\`). A bare traversal reads now and would yield nothing until then.`,
            );
            return positionRefIn(from.instance, landing);
          }
          // Read bare, and the source would have TOLD us. Whoever asked (the
          // `until` checker) decides whether that is worth saying.
          if (edgeSchema.watchable === true) this.options.onWatchableRead?.(edge);
        }
        if (edgeSchema.readable === false) {
          this.reportWriteOnlyEdge(from, edge, edgeSchema);
          return undefined;
        }
        // A POLYMORPHIC edge's concrete target varies per record — which is
        // what a UNION is, and `positionRefIn` resolves unions first. This used
        // to answer `undefined`, so the hop typed as nothing and every read
        // past it went unchecked: silent degradation, not a weaker guarantee.
        // Landing on the union instead makes the existing machinery apply for
        // free — shared fields read, variant-only ones say "narrow with IS",
        // and the write side already demands the explicit member.
        return positionRefIn(from.instance, landing);
      }
      case 'union': {
        if (from.variants.length === 0) {
          this.report(
            TypedDiagnosticCodes.UNREACHABLE_BRANCH,
            `the tests above already cover every kind this can be, so nothing reaches here — '${edge}' can't be traversed`,
          );
          return undefined;
        }
        const carrying = from.variants.filter(
          v => from.instance.schema.positions[v]?.edges[edge] !== undefined,
        );
        if (
          carrying.length > 0 &&
          carrying.every(v => from.instance.schema.positions[v]?.edges[edge]?.readable === false)
        ) {
          this.reportWriteOnlyEdge(
            from,
            edge,
            from.instance.schema.positions[carrying[0]]!.edges[edge]!,
          );
          return undefined;
        }
        if (carrying.length === from.variants.length && carrying.length > 0) {
          const targets = new Set(
            from.variants.map(v => from.instance.schema.positions[v]?.edges[edge]?.target),
          );
          if (targets.size === 1) {
            const [target] = targets;
            return target !== undefined ? positionRefIn(from.instance, target) : undefined;
          }
          return undefined;
        }
        if (carrying.length > 0) {
          // Variant keys are opaque addresses — render their DISPLAY, and
          // suggest the address-form IS (`.` is for properties; the dotted
          // type marker is retired). The example is DERIVED: the first
          // `action` option whose narrowing actually carries the edge.
          const shown = carrying
            .map(v => `${from.instance.name}'s ${displayNameOf(from.instance, v)}`)
            .join(' / ');
          let example = `x IS <${from.instance.name}-[:\`…\` WHERE …]->>`;
          const address = from.address;
          const actionType =
            address !== undefined
              ? from.instance.schema.positions[address.event]?.properties[EVENT_ACTION_FIELD]
              : undefined;
          if (
            address !== undefined
            && typeof actionType === 'object'
            && 'kind' in actionType
            && actionType.kind === 'enum'
          ) {
            for (const option of actionType.options) {
              const key = eventAddressKey({
                event: address.event,
                narrowing: { ...address.narrowing, [EVENT_ACTION_FIELD]: option },
              });
              if (carrying.includes(key)) {
                example = `x IS <${from.instance.name}-[:\`${address.event}\` WHERE \`${EVENT_ACTION_FIELD}\` == "${option}"]->>`;
                break;
              }
            }
          }
          this.report(
            TypedDiagnosticCodes.NARROWING,
            `'${edge}' is an edge of ${shown} only — narrow with an IS test (e.g. \`${example}\`) before traversing it`,
          );
          return undefined;
        }
        this.report(
          TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
          `no variant of ${describePosition(from)} has an edge '${edge}'`,
        );
        return undefined;
      }
      case 'extract': {
        const child = from.node.children.get(edge);
        if (!child) {
          const available = [...from.node.children.keys()];
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            `${describePosition(from)} has no nested node '${edge}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        return { kind: 'extract', node: child };
      }
      case 'closure': {
        this.report(
          TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
          `${from.label} is a closure — there is nothing to traverse off one. Call it, and traverse what it returns.`,
        );
        return undefined;
      }
      case 'local': {
        const local = from.edges?.[edge];
        if (local === undefined) {
          const available = Object.keys(from.edges ?? {});
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            available.length > 0
              ? `${from.label} has no edge '${edge}' — it has: ${available.join(', ')}`
              : `${from.label} has no edges — read what it carries with a dot: ${Object.keys(from.reads)
                  .map(name => `'.${name}'`)
                  .join(' or ')}`,
          );
          return undefined;
        }
        this.lastEdgeSchema = local.schema;
        // A local AWAITABLE edge is readable BOTH ways: `await` waits for the
        // first landing, a bare traversal reads what has landed so far (zero
        // landings before anything fires — an empty traversal, the language's
        // own way of saying "not yet"). So no MOV_AWAIT_REQUIRED here; only the
        // await's rehydration-free WHERE constraint still applies.
        if (
          local.schema.awaitable === true
          && this.awaited
          && filter !== undefined
          && !isPurePredicate(filter)
        ) {
          this.report(
            TypedDiagnosticCodes.AWAIT_IMPURE_WHERE,
            `The WHERE on '-[:${edge}]->' has to run in the app (it uses AI() or EXISTS), which an 'await' can't do — its condition is evaluated against each candidate without re-running the movement. Narrow it with a pure predicate over the awaited record's own fields.`,
          );
        }
        return local.target;
      }
      case 'maybeEmpty':
        // Traversing INTO a maybe-empty node is gate-discharged (an absent edge
        // matches nothing, so the block runs zero times) — step the inner node.
        return this.stepEdge(from.of, edge, filter);
    }
  }

  /**
   * NOTHING HAS DESCRIBED this position, so anything you do with the handle is
   * a guess — say so instead of waving it through.
   *
   * The counterpart of `openProperties`' silence, and the reason the two are
   * separate fields rather than one. An OPEN position makes a positive claim
   * ("the surface is wider than what's enumerated" — a raw payload bag), which
   * is a real reason to stay quiet. An UNDESCRIBED one makes no claim at all,
   * and the two are not the same fact. Spelling them the same way is what let
   * `` e-[r:record]->.`Name` `` compile against a table nothing had ever
   * fetched: no diagnostics, null at run time.
   *
   * Reports and returns true when `schema` is undescribed. `what` names the
   * thing being reached for (`the field 'Name'`), so the message says what the
   * author was denied rather than only that they were.
   *
   * PENDING short-circuits ahead of that: a position whose fetch is still in
   * flight has no surface to check against either, but the author has done
   * nothing wrong and the answer is coming. It returns true — stop, there is
   * nothing to check — WITHOUT reporting. Reporting here is what would make an
   * editor flash diagnostics on every keystroke until each fetch landed.
   *
   * The two returns look alike and mean opposite things, which is why they read
   * off different flags rather than one: `undescribed` is a verdict, `pending`
   * is a wait.
   */
  private reportUndescribed(
    position: PositionTypeRef,
    schema: PositionSchema,
    what: string,
  ): boolean {
    if (schema.pending === true) return true;
    if (schema.undescribed !== true) return false;
    this.report(
      TypedDiagnosticCodes.UNDESCRIBED_POSITION,
      `nothing describes ${describePosition(position)}, so ${what} can't be checked here — `
        + `it would be null at run time. Narrow the type that reaches it to a concrete one first.`,
    );
    return true;
  }

  /** A read traversal walked a WRITE-ONLY edge — a pure create path with no
   *  read API behind it; traversing it would silently yield nothing. */
  private reportWriteOnlyEdge(from: PositionTypeRef, edge: string, edgeSchema: EdgeSchema): void {
    this.report(
      TypedDiagnosticCodes.WRITE_ONLY_EDGE,
      `'-[:${edge}]->' on ${describePosition(from)} is write-only — ${
        edgeSchema.writable === true
          ? `it writes (write …-[:${edge}]-> { … }); the system offers nothing to read back along it`
          : 'the system offers nothing to read along it'
      }`,
    );
  }

  /**
   * The read is LEGAL and typed — but the source carries more than one field
   * under this name, so say which one won. Warning severity: it never gates a
   * compile, because the author's program is fine; the ambiguity is in their
   * workspace, and renaming one of the two fields is the only real fix.
   */
  private reportAmbiguousProperty(
    position: Extract<PositionTypeRef, { kind: 'position' | 'handle' }>,
    schema: PositionSchema,
    propertyId: string,
  ): void {
    if (!schema.ambiguousProperties?.includes(propertyId)) return;
    this.report(
      TypedDiagnosticCodes.AMBIGUOUS_PROPERTY,
      `${describePosition(position)} has more than one field named '${propertyId}' — this reads the first one. Rename one of them in the connected system to be sure which you get.`,
      'warning',
    );
  }

  /** The pointed diagnostic for reading a WRITE-ONLY field — one the type
   *  declares on its write shape only (`readable: false`). Reports and
   *  returns true when `propertyId` is write-only here; the message carries
   *  the adapter's own field doc so the author is steered to the real read
   *  path, not just refused. */
  private reportWriteOnlyProperty(
    position: Extract<PositionTypeRef, { kind: 'position' | 'handle' }>,
    schema: PositionSchema,
    propertyId: string,
  ): boolean {
    if (!schema.writeOnlyProperties?.includes(propertyId)) return false;
    const typeName = position.position;
    const shape =
      typeName !== undefined
        ? (position.instance.schema.writableRoots[typeName] ??
          position.instance.schema.createShapes?.[typeName])
        : undefined;
    const doc = shape?.fieldDocs?.[propertyId];
    this.report(
      TypedDiagnosticCodes.WRITE_ONLY_PROPERTY,
      `'${propertyId}' on ${describePosition(position)} is write-only — a value a write sets, not one to read.${doc ? ` ${doc}` : ''}`,
    );
    return true;
  }

  /**
   * A terminal property read against a position type. Extract positions get
   * full validity checking (check 9: unknown field, working field,
   * annotation suggestions + conflicts); union positions get narrowing
   * checks (check 6); adapter/shape positions and handles contribute a type
   * when the property is declared and ERROR when it isn't — typed positions
   * are CLOSED unless the schema marks them `openProperties` (the honesty
   * valve for raw/under-describable surfaces, which stays silent).
   */
  readProperty(
    position: PositionTypeRef | undefined,
    propertyId: string,
    writeTarget?: WriteTargetRef,
  ): FieldType | undefined {
    if (position === undefined) return undefined;
    if (propertyId === POSITION_SENTINEL) return undefined; // "the positions themselves"
    switch (position.kind) {
      case 'extract':
        return this.readExtractField(position.node, propertyId, writeTarget);
      case 'handle': {
        const declared = position.resultShape[propertyId];
        if (declared !== undefined) return declared;
        const schema = positionSchemaOfRef(position);
        const fromPosition = schema?.properties[propertyId];
        if (fromPosition !== undefined) {
          // Reading the POSITION's surface through the handle, so the
          // position's ambiguity applies here too. (A name resolved off the
          // handle's own `resultShape` above is a different surface — a write
          // result — and carries no such collision.)
          if (schema) this.reportAmbiguousProperty(position, schema, propertyId);
          return fromPosition;
        }
        if (schema && this.reportWriteOnlyProperty(position, schema, propertyId)) return undefined;
        if (schema && this.reportUndescribed(position, schema, `the field '${propertyId}'`)) {
          return undefined;
        }
        if (schema?.openProperties) return undefined;
        const available = [
          ...new Set([...Object.keys(position.resultShape), ...Object.keys(schema?.properties ?? {})]),
        ];
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${describePosition(position)} has no field '${propertyId}'${available.length ? ` — it carries: ${available.join(', ')}` : ''}`,
        );
        return undefined;
      }
      case 'position': {
        const schema = positionSchemaOfRef(position);
        if (!schema) return undefined;
        const declared = schema.properties[propertyId];
        if (declared !== undefined) {
          this.reportAmbiguousProperty(position, schema, propertyId);
          return declared;
        }
        if (this.reportWriteOnlyProperty(position, schema, propertyId)) return undefined;
        if (this.reportUndescribed(position, schema, `the field '${propertyId}'`)) return undefined;
        if (schema.openProperties) return undefined;
        const available = Object.keys(schema.properties);
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${describePosition(position)} has no field '${propertyId}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
        );
        return undefined;
      }
      case 'union': {
        if (position.variants.length === 0) {
          this.report(
            TypedDiagnosticCodes.UNREACHABLE_BRANCH,
            `the tests above already cover every kind this can be, so nothing reaches here — '${propertyId}' can't be read`,
          );
          return undefined;
        }
        const carrying = position.variants.filter(
          v => position.instance.schema.positions[v]?.properties[propertyId] !== undefined,
        );
        if (carrying.length === 0) {
          const variantSchemas = position.variants.map(
            v => position.instance.schema.positions[v],
          );
          // Write-only on some variant beats unknown — the pointed
          // diagnostic (a value a write sets, not one to read) fires even
          // when another variant is open.
          const writeOnlyVariant = position.variants.find(v =>
            position.instance.schema.positions[v]?.writeOnlyProperties?.includes(propertyId),
          );
          if (writeOnlyVariant !== undefined) {
            this.reportWriteOnlyProperty(
              { kind: 'position', instance: position.instance, position: writeOnlyVariant },
              position.instance.schema.positions[writeOnlyVariant]!,
              propertyId,
            );
            return undefined;
          }
          // Silent when any variant is unresolvable or open — the read may
          // be legitimate against the under-described variant.
          if (variantSchemas.some(s => s === undefined || surfaceNotEnumerated(s))) return undefined;
          const available = [
            ...new Set(variantSchemas.flatMap(s => Object.keys(s!.properties))),
          ];
          this.report(
            TypedDiagnosticCodes.UNKNOWN_PROPERTY,
            `no variant of ${describePosition(position)} has a field '${propertyId}'${available.length ? ` — its variants have: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        if (carrying.length < position.variants.length) {
          // A type names an EDGE, and an edge is an ADDRESS — the dotted
          // spelling this once suggested has been retired and now parse-errors,
          // so the suggestion was teaching a syntax the author cannot write.
          const shown = carrying
            .map(v => `${position.instance.name}'s ${displayNameOf(position.instance, v)}`)
            .join(' / ');
          this.report(
            TypedDiagnosticCodes.NARROWING,
            `'${propertyId}' is a field of ${shown} only — narrow with an IS test (e.g. \`x IS <${position.instance.name}-[:\`${carrying[0]}\`]->>\`) before reading it`,
          );
          return undefined;
        }
        const types = carrying.map(v => position.instance.schema.positions[v]!.properties[propertyId]!);
        return types.every(t => fieldTypeEquals(t, types[0])) ? types[0] : undefined;
      }
      case 'maybeEmpty':
        // A field of a maybe-empty node is `T | absent` (F19) — one unified
        // absent with the scalar case. Delegate the field lookup (and its
        // reporting) to the inner node, then wrap the result.
        return maybeAbsent(this.readProperty(position.of, propertyId, writeTarget));
      case 'local': {
        // Presence, not truthiness: a declared-but-untyped read is unknown, and
        // an unknown type is not an unknown NAME.
        if (Object.hasOwn(position.reads, propertyId)) return position.reads[propertyId];
        // A name on the ARROW plane is reached by traversal, not by dot.
        if (position.edges?.[propertyId] !== undefined) {
          this.report(
            TypedDiagnosticCodes.UNKNOWN_PROPERTY,
            `'${propertyId}' is an edge of ${position.label} — traverse it ('-[x:${propertyId}]->'), don't read it as a value`,
          );
          return undefined;
        }
        const available = Object.keys(position.reads);
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${position.label} has no '${propertyId}'${available.length ? ` — it carries: ${available.join(', ')}` : ''}`,
        );
        return undefined;
      }
      case 'closure': {
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${position.label} is a closure — there is nothing to read off one. Call it, and read what it returns.`,
        );
        return undefined;
      }
      case 'meta':
        return undefined;
    }
  }

  private readExtractField(
    node: ExtractNodeType,
    propertyId: string,
    writeTarget?: WriteTargetRef,
  ): FieldType | undefined {
    const nodeLabel =
      node.name === EXTRACT_ROOT_NAME ? 'the extract result' : `the extracted node '${node.name}'`;
    const field = node.properties.get(propertyId);
    if (field === undefined) {
      const available = [...node.properties.keys()];
      this.report(
        TypedDiagnosticCodes.EXTRACT_UNKNOWN_FIELD,
        `'${propertyId}' is not a field of ${nodeLabel}${available.length ? ` — it declares: ${available.join(', ')}` : ''}`,
      );
      return undefined;
    }
    if (field.explicit !== undefined) {
      // Annotation-vs-write compatibility. A redundant annotation is fine and
      // silent; a WRONG one is reported here, at the annotation. The lenient
      // write gate (`fieldTypeCompatible`, at the value site) already reports
      // every shape mistake it can see, so this site covers exactly its blind
      // spot: a target that CONSTRAINS what the text plane may hold — another
      // enum's option set, a date it would have to parse out of free text.
      // Cardinality stays the gate's deliberate leniency (lists coerce both
      // ways), so assignability is asked of the element type.
      const annotated = unwrapList(field.explicit);
      if (
        writeTarget !== undefined &&
        fieldTypeCompatible(field.explicit, writeTarget.type) &&
        targetConstrainsExtraction(writeTarget.type) &&
        !fieldAssignable(annotated, unwrapList(writeTarget.type))
      ) {
        const target = unwrapList(writeTarget.type);
        const enumTarget = isEnumType(target) ? target : undefined;
        const into = writeTarget.path !== undefined ? ` ${writeTarget.path},` : '';
        const mismatch =
          enumTarget !== undefined
            ? `a field whose options are (${enumTarget.options.join(' | ')}) — ${
                isEnumType(annotated)
                  ? 'the option sets differ'
                  : `${describeFieldType(annotated)} isn't constrained to them`
              }`
            : `a ${describeFieldType(writeTarget.type)} field — the annotation doesn't constrain the extraction to that type`;
        this.options.report(
          TypedDiagnosticCodes.EXTRACT_TYPE_CONFLICT,
          `'${propertyId}' on ${nodeLabel} is annotated as ${describeFieldType(field.explicit)}, but it is written into${into} ${mismatch}${writeTarget.path !== undefined ? `; borrow the target's ${enumTarget !== undefined ? 'options' : 'type'} (\`${propertyId}: <${borrowedAnnotationSpelling(writeTarget.path)}> "…"\`) or align the annotation` : ''}`,
          field.span,
        );
      }
      // R14: an extract field is ALWAYS optional — the model was asked for it
      // and may not have found it, and there is no marker that says otherwise.
      // So a read is `T | absent`, and the absence discipline fires where the
      // value is REQUIRED (a plain write field, an ordered comparison), not at
      // the read. This is the checker catching up with the runtime, which
      // resolves such a field to absent rather than to an empty string.
      return maybeAbsent(field.explicit);
    }
    // Backward adoption is DEMOTED (explicit over implicit): a typed write
    // target no longer silently types the extraction — it earns an
    // info-severity suggestion to annotate, and the field stays untyped.
    // BUT only when the field has NO annotation: if it carries one that simply
    // didn't resolve here (missing schema / bad borrow), "annotate it" is
    // misleading — the author already did, and the engine re-resolves live.
    // And only when the annotation would ADD something: an unannotated
    // extraction already yields text, so a plain-text target has nothing to
    // constrain (TypeScript doesn't ask for `: string` on a string) — and a
    // `json` target constrains even less, since it accepts every data shape.
    if (
      writeTarget !== undefined &&
      field.annotationRaw === undefined &&
      stripAbsent(writeTarget.type) !== 'text' &&
      stripAbsent(writeTarget.type) !== 'json'
    ) {
      const annotation =
        writeTarget.path ??
        (typeof writeTarget.type === 'string' ? writeTarget.type : undefined);
      if (annotation !== undefined) {
        field.suggested ??= new Set();
        if (!field.suggested.has(annotation)) {
          field.suggested.add(annotation);
          this.options.report(
            TypedDiagnosticCodes.EXTRACT_ANNOTATE,
            `'${propertyId}' on ${nodeLabel} flows into a ${describeFieldType(writeTarget.type)} field${writeTarget.path !== undefined ? ` (${writeTarget.path})` : ''} — annotate it as such (\`${propertyId}: <${borrowedAnnotationSpelling(annotation)}> "…"\`) so the extraction is constrained by the target's type; only explicit annotations constrain extraction. An annotated field reads as its type OR absent, so discharge that in the same edit — write the target field with '?:' (set-if-empty), wrap the read in COALESCE, or guard on it — since a plain field is refused a value that may be absent`,
            field.span,
            'info',
          );
        }
      }
    }
    return undefined;
  }
}

/**
 * The paste-able spelling of a borrowed annotation. `WriteTargetRef.path`
 * stores the resolver's `<instance>.<root>.<field>` segments; the SURFACE
 * spelling hops the middle and keeps the dotted property tail — `.` is for
 * properties, `-[:…]->` is for edges. A non-borrowed annotation (a primitive
 * type name) passes through untouched.
 */
function borrowedAnnotationSpelling(path: string): string {
  const segments = path.split('.');
  if (segments.length !== 3) return path;
  return `${segments[0]}-[:${segments[1]}]->.\`${segments[2]}\``;
}
