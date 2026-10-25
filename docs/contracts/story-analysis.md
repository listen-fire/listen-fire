# The story analysis

Version: 1

The story analysis is what the check settled about a movement, as data: the scopes it opened, the symbols it bound, the writes and the nodes it saw, the bodies a lane ends in, and what each movement may do. A surface that draws a movement's story reads this instead of walking the syntax tree and resolving names again. It is the check's own walk, so the verdict and the picture come from one call and cannot disagree.

- **The export:** `story_analysis(src, catalog, options)` in the movement artifact. `options` is `{ upgradingFrom?: string }`, as the check's.
- **The type:** `StoryAnalysis` (`packages/movement-lang/checker/story_analysis.ts`), through `storyAnalysisInRust(source, snapshot, { languageVersion })`.
- **Produced by:** `crates/movement-checker/src/story.rs`.
- **The diagnostics** are the check's, equal to what `check_program` answers for the same text and snapshot.

## Versions

- **The version is an integer**, stated at the top of this document, held by `STORY_ANALYSIS_VERSION`, and written as `storyAnalysisVersion` on every analysis. This release reads version 1 only (`SUPPORTED_STORY_ANALYSIS_VERSIONS`; [the index](README.md)).
- **Refusal:** a reader handed another version refuses it by name and does not read it as version 1.
- **What bumps it:** a change in meaning. A member removed or renamed, a member whose meaning changed, a node kind whose shape changed. A new optional member or a new node kind a reader can skip keeps the version.
- **A pin this release does not read** is not analysed. The answer is the language version diagnostic alone, with every list empty (the refused shape below).

## The shapes

The shapes are TypeScript-ish: `x?: T` is left out when the fact is absent, never written as `null`. Spans are the syntax tree's (1-based line and column). A scope is an id into `scopes`, a symbol an id into `symbols`.

```ts
interface StoryAnalysis {
  storyAnalysisVersion: number;
  diagnostics: Diagnostic[];             // the check's
  scopes: StoryScope[];                  // the file's scope is 0
  symbols: StorySymbol[];
  writes: StoryWrite[];
  nodes: StoryNode[];
  bodies: StoryBody[];
  shapes: StoryShape[];
}

interface StoryScope {
  parent?: number;                       // absent on the file's scope
  span?: Span;                           // absent for a scope with no text of its own
  symbols: Record<string, number>;       // name to symbol id; the last binding of the name
}

interface StorySymbol {
  name: string;
  kind: 'adapter' | 'credential' | 'plugin' | 'fileImport' | 'binding' | 'instance' | 'param' | 'movement' | 'shape' | 'alias' | 'type';
  span: Span;
  adapter?: string;
  address?: StoryAddress;
  extracted?: { entity?: string };       // the binding holds an extraction's graph; entity: the node's name, absent at its root
  effects?: StoryEffects;                // movements only
}

interface StoryAddress {
  instance: string;                      // a system's binding name
  position?: string;                     // its record type, where one place holds it
}

interface StoryEffects {
  reads: string[];                       // instance binding names, or a source a plugin or built-in declares ("the web", "files")
  writes: string[];
  ai: boolean;
  now: boolean;
  suspend: boolean;
  partial: boolean;                      // a callee or a site could not be placed
}

interface StoryWrite {
  span: Span;
  scope: number;
  fields: FieldEntry[];                  // the syntax tree's field lines, spreads written out (a spread's line carries `spread`)
  hasUniqueBy: boolean;
  action: 'create' | 'update' | 'find';  // update: a write to a position; find: a match
  parents: Array<{ edge: string; type?: string }>;
  binding?: string;
  target?: { instance: string; recordType?: string };
}

interface StoryBody {
  span: Span;
  kind: 'movement' | 'arm' | 'else' | 'combinatorArm' | 'callback';
  terminates: boolean;
}

interface StoryShape {                   // a file-level node declaration
  name: string;
  span: Span;
  root: ShapeNode;                       // the declaration the checker resolved, `extends` folded in
}
```

Every node carries `span` and `scope`, and one of 14 kinds:

```ts
type StoryNode = { span: Span; scope: number } & (
  | { kind: 'instance'; name: string; adapterType?: string }
  | { kind: 'listen'; instance: string; adapterType?: string; fires: string; firesMovement: boolean; events?: string[];
      narrowing: Record<string, string>; eventTypes: Array<{ key: string; display?: string }> }
  | { kind: 'link'; from: string; edge: string; to: { kind: 'handle'; name: string } | { kind: 'match'; span: Span } }
  | { kind: 'unlink'; from: string; edge: string; to: { kind: 'handle'; name: string } }
  | { kind: 'await'; binding?: string; source: StoryAwaitedSource }
  | { kind: 'combinator'; combinator: CombinatorKind; binding?: string; arms: Array<{ span: Span; scope?: number }> }
  | { kind: 'branch'; arms: Array<{ span: Span; scope: number; conditionSpan: Span }>; otherwise?: { span: Span; scope: number } }
  | { kind: 'extract'; binding?: string; node?: StoryExtractNode }
  | { kind: 'call'; binding?: string; callee: string; isMovement: boolean; argParams?: Array<string | null> }
  | { kind: 'callReading'; reading: StoryCallReading }
  | { kind: 'traversal'; from?: 'graph' | 'result'; root?: string; steps: TraversalStep[]; landings: Array<StoryAddress | null> }
  | { kind: 'valuePath'; key: string; root?: string; steps: TraversalStep[]; landings: Array<StoryAddress | null> }
  | { kind: 'delete'; subject: string }
  | { kind: 'refresh'; subject: string }
);

type StoryAwaitedSource =
  | { kind: 'traversal'; root?: string; edge?: string; awaitable?: boolean; resolvesEmpty?: boolean }
  | { kind: 'sleep'; duration: string }
  | { kind: 'until'; every?: string };

type StoryCallReading =
  | { kind: 'value'; expr: ExprSlot }
  | { kind: 'collection'; collection: CollectionOpExpression }
  | { kind: 'members'; members: MembersExpression }
  | { kind: 'refused'; refusal: { code: string; message: string; span: Span } };

interface StoryExtractNode {
  name: string;
  fields: Array<{ name: string; at: Span; type?: string; fieldType?: SchemaFieldType | null }>;   // type: in the author's words (`text`, `number`); fieldType: the same type as data, in the catalog's spelling (`"number"`, `{ kind: "enum", options }`), a borrowed field path resolved to its declared type; null with no resolved annotation
  children: StoryExtractNode[];
}
```

- **`landings`** has one entry per hop. A hop that did not type is `null`, so the landings keep their positions.
- **`argParams[i]`** is `null` for an argument past the callee's last parameter. A plugin's come from its own positional binding.
- **`key`** on a value path is the JSON of `[root, steps]` with every object's keys sorted. Match walks by this token, or by comparing structure; a key built in source order will not equal it.
- **A call to `extract(…)` or `extractOne(…)`** records an extract node, with the graph built from the shape.
- **Unlink** is a node of its own, with the shape of a link to a handle.

## Bodies

A body is a statement list a lane is capped by. `terminates` says whether it leaves, by the rule of its kind:

- **`movement`:** a `return` written straight in the body is a step on the spine, not a leave. It terminates by an error.
- **`arm` and `else`:** a `return` leaves.
- **`combinatorArm` and `callback`:** only an error leaves, because a `return` there is the closure's value.

## The effects rule

A movement's `effects` come from the sites inside its span, closures written inside it included.

- **Writes.** A write adds the instance its handle is in to `writes`. A match adds it to `reads`. A write onto a node this run built adds nothing.
- **Link, unlink and delete** add the instance of the subject's type to `writes`. **Refresh** adds it to `reads`.
- **Walks.** A traversal head that was walked, a value path with steps, or a walk inside `exists(…)` (a hop `WHERE` included) adds to `reads` the instance of its start and of each landing.
- **Built-ins.** A built-in called inside an expression folds in what the standard library declares it does: `File.read` reads `files`, the retired `KG_EXISTS` and `KG_VALUE` read `the knowledge graph`.
- **`ai`.** Any extraction sets it. Inside an expression, `ai(…)`, an `llm` aggregate and `extract_value` set it.
- **`now`.** Reading `@current_date` or `@current_timestamp` sets it, and so does `Date.today(zone)`, the one built-in that reads the clock. `DateTime.at` and the other `Date.*` members read only their arguments.
- **`suspend`** is the checker's own inference for the movement.
- **Calls.**
  - A call to a movement of this file is closed by fixpoint, so a cycle shares one row.
  - A plugin folds in the effects it declares, under the names it declares (for example "the web").
  - A closure declared inside the same movement adds nothing, because its body already counted.
  - Anything else marks the row `partial`: an unresolved callee, an imported movement, a plugin that declares nothing, a closure from outside the movement.
- **`partial` from sites.** A write, link, delete, refresh or walked path whose instance could not be placed marks the row `partial`.
- **A closure bound at file level** and called from a movement marks the row `partial`.

## The refused pin

The check takes no pin; the pin rule is the caller's. A caller handed a pin this release does not read answers without asking the artifact (`refused_story_analysis` in `crates/movement-checker/src/story.rs`, and the same shape from `storyAnalysisInRust`):

```ts
{
  storyAnalysisVersion: 1,
  diagnostics: [/* the language version diagnostic alone */],
  scopes: [], symbols: [], writes: [], nodes: [], bodies: [], shapes: [],
}
```

## Changes

- **Version 1.** The first version: the scopes, symbols, writes, 14 node kinds, bodies and shapes, with `effects` on a movement's symbol.
- **Version 1, additive: `fieldType` on an extraction field (after 0.12.3).** Optional and nullable, so a consumer that does not read it is unaffected; the version stays 1.
