# The language service

`listen-fire lsp` is a language server over stdio (LSP 3.17, UTF-16 positions). Its answers come from the crate `listen-fire-language` (crates/movement-language), written for the language of its own release. The Rust parser and checker are its reference. It is not a port of the TypeScript service.

Not a versioned contract: an editor speaks LSP, and LSP is the contract. This page says what the service answers, and from where.

## One analysis, many questions

- **The check is the analysis.** Each question is answered from one run of the Rust checker over the file and the project's catalog. The checker keeps what its walk settled (`movement_checker::query::analyze`):
  - every scope a body opens (a function, a closure, an `if` arm, a traversal block), with the text it covers;
  - every symbol ever bound in each scope, with its span and the type the check gave it;
  - each imported name, with the library declaration it resolved to.
- **No second type checker.** The service never re-derives a type. The text before a `.` or a `-[`, from where its expression starts, is typed by the checker's own query (`Analysis::type_walk`), as a program's check would type it there, a hop's `WHERE` included. What is at the landing comes from the checker's description value (`movement_checker::description`), written in the catalog's notation: a field as its name, its marks and its type (`` `Sent At`~ date ``), an edge as its hop with all it can do (`-[:Reactions]-> Reaction [w fires]`).
- **Half-typed code still answers.** When the file does not parse, the service blanks the line the cursor is on and parses again. If that still fails, it keeps the text above the cursor and closes the open braces. The parse error is still reported, as `MOV_PARSE`, on the original text.

## What a position answers

| question | answer | source |
|---|---|---|
| what is in scope | each binding, parameter, function, node, type, import and host unit (`cron`, `manual`) visible here, innermost first, with its type | the check's scopes, cut off at the cursor (a hoisted declaration is seen from anywhere in its list) |
| what follows `x.` or `` x.` `` | the record's fields a read can name, each in the catalog's notation | `x` typed by the checker, then the description of what it holds |
| what follows `-[`, `-[a:` | the edges the walk can take next, each as its hop: where it lands and what it can do | the walk typed by the checker, then the description of its landing |
| what follows `-[`, `-[a:` in a `listen to` | the edges a listen can take next: those that fire first (a listen can end there), then those a walk reads (a listen can pass through); each hop's marks say which | the description's edges, by what each can do |
| what follows `a.` for a hop alias `a` | the fields where that hop lands | the walk typed by the checker; when the cursor's line does not parse, the hop that binds `a` is closed in front of it |
| what follows `<x-[:` in a type | the record types of instance `x` | the instance's schema |
| a built-in | its current spelling and signature | the spelling table (crates/movement-parser/src/surface/table.rs) and the standard library's signatures |
| after `connect` | adapter names | the catalog's adapters (host units left out) |
| inside `import { … } from plugins` | plugin package tags (`` `@lf/<name>` ``) and plugin names | the catalog's plugin packages and plugins |
| after `connect x using` | credential names serving that module | the catalog's credentials, built from listen-fire's secrets bindings (names only, never values) |

## The LSP methods

- **Diagnostics** (`textDocument/publishDiagnostics`): the checker's diagnostics for each open file, against the project's catalog. They are recomputed 200 ms after the last edit. Open buffers stand in for their files when another file imports them.
- **Hover:** the type, a one-line doc, and a link to the versioned docs page: `https://listen-fire.github.io/listen-fire/docs/<key>/<page>#<anchor>` (`<key>` is the release's compatibility key, `next` for a pre-release; every target is a built page and heading; the base is one constant in the crate).
- **Completion:** the table above, picked by what the text just before the cursor is.
- **Go to definition:** a binding, parameter, function or node goes to where it is declared. An imported name goes to its declaration in the library file.
- **Code actions:** each diagnostic's own fix (`MOV_V5_SPELLING` and every other fix the checker offers) as a quick fix. A "did you mean 'x'" in a message becomes a quick fix that replaces the misspelled name.

## The project

- `listen-fire lsp` reads the project the way `listen-fire check` does: lf.yaml, the movement files, and the externals' described schemas.
- If the externals cannot start (a missing credential, a module that fails), the service falls back to a catalog of the host units, the credentials and the files alone, and says so in a log message.

## Over the wasm

The same service is an export of the movement artifact (`packages/movement-lang/wasm/movement.wasm`), `language_query(src, catalog, query)`, so a host that already loads the artifact answers editor questions from the one Rust implementation instead of keeping a second. `listen-fire lsp` stays native: it reads the project from disk, and an editor speaks LSP, not this export.

- **The call.** `src` is the file's text, `catalog` the [catalog snapshot](catalog-snapshot.md) as JSON, `query` the question below. The reply is a status and a JSON body: status 0 and the answer, or status 1 and `{ "error": { "message" } }` when the snapshot does not load, the query does not read, or the text is not UTF-8.
- **The snapshot is the project.** The snapshot's `files` are the library files an import resolves against. Nothing is read from disk.

### The description

A second export answers what a catalog holds, with no source: `describe_query(catalog, request)`, bound in `@listen-fire/movement-lang` as `describeCatalog` and `describeAddress`. It is the description `listen-fire catalog` prints, as JSON, every name, type, hop and mark already spelled (`crates/movement-language/src/describe.rs` has the whole shape).

```ts
interface DescribeRequest {
  address?: string;     // as `listen-fire catalog '<address>'` takes one: '@lf/slack:team_workspace-[:Channels]->'
  showing?: Showing;    // how much of the place
  landings?: Showing;   // how much of where each of its edges lands, one level deep
}
interface Showing { fields?: number; enumOptions?: number }   // absent: all; an enum cut is `"a" | "b" | …+3`
```

- **No address:** `{ legend, connections: [{ adapter, key, place }] }`, every connection the snapshot describes, at its root.
- **An address:** `{ legend, diagnostics, place }`. The address is read and checked as `listen-fire catalog` reads one, with the describing option, against the snapshot as given (a host narrows it first, as for any check); a misspelt edge is the checker's diagnostic and `place` is null. With no walk, `place` is the connection's root and `records` each record type it holds. A run host unit is never connected, so no address names one; its root is in the answer with no address.

### The query

```ts
interface LanguageQuery {
  kind: 'complete' | 'hover' | 'definition' | 'codeActions';
  position: { line: number; character: number };   // 0-based; character counts UTF-16 code units
  range?: { start: Position; end: Position };      // codeActions only; absent: the position, collapsed
}
```

- **Unknown members are refused.** A query with a member this page does not list is an error, not ignored.

### The answers

```ts
interface CompleteAnswer {
  items: Array<{
    label: string;
    kind: 'variable' | 'function' | 'field' | 'edge' | 'module' | 'keyword' | 'property' | 'credential' | 'type' | 'namespace';
    detail?: string;
    insert?: string;                                // the text to insert, where it is not the label
    replace?: Range;                                // what the item replaces, where it is not the word
    connectAction?: { kind: string; adapter: string; credential?: string };
  }>;
  word: Range;                                      // the word before the cursor
}

type HoverAnswer = { contents: string; range: Range } | null;   // markdown

type DefinitionAnswer =
  | { file: string | null; range: Range }           // null: this file; else a library file of the snapshot
  | { module: { namespace: 'adapters' | 'credentials' | 'plugins'; name: string } }
  | null;

type CodeActionsAnswer = Array<{
  title: string;
  edits: Array<{ range: Range; newText: string }>;
  code: string;                                     // the diagnostic code the fix answers
  preferred: boolean;
}>;
```

- **`module.name`** is the catalog's bare key (`slack`, not `@lf/slack`).
- **`connectAction`** is the adapter's own declaration from the snapshot (`connectActions`). A host that sees one opens its connection flow instead of inserting text. The entry's label is `+ <label>` and its detail the adapter.
- **Items follow the snapshot's key order.** A caller that builds its snapshot in another key order gets the same items in another order.

### The offset binding

`@listen-fire/movement-lang` wraps the export in offsets, which is what an editor holds: `completionsAt`, `hoverAt`, `definitionAt` and `quickFixesIn`, plus `offsetOf` and `positionOf` between an offset and a line and character (both clamp). Offsets are UTF-16 code units into the text, so a CodeMirror document position is one directly.

- **A completion item's `from` and `to`** are its own `replace` range, else the word before the cursor.
- **A definition in a library file** has offsets into that file's text in the snapshot (`snapshot.files[file].source`).
- **A `{ error }` reply** throws `RustCheckRefused`.

### The pin rule

A binding takes the program's `languageVersion`. A pin this release does not read ([language-versions.md](language-versions.md)) gets the empty answer for the question (no completions, `null`, `null`, no fixes) and the artifact is not asked. The diagnostics already say why; the service does not guess at a language it does not read.

### Module and connect actions

Two fields reach a presentation surface that has no project on disk:

- **Module definitions.** An adapter, credential or plugin name answers `{ module: { namespace, name } }`, which a surface maps to the page that manages that module.
- **Connect actions.** A completion entry may open a connection flow, as above.
