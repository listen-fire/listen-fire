# @listen-fire/authoring-mcp

## 0.14.0

### Minor Changes

- f260614: getStarted's digest and describeConnection's compact answer are written in the language's one notation, the one `listen-fire catalog` writes, from the engine's describing query (`describeCatalog`, `describeAddress` in `@listen-fire/movement-lang`): the package spells no type, edge or mark of its own. How much it shows is unchanged: 10 fields on an edge's landing, 40 at the place a describe stands on, 4 options per enum, 1,600 characters per system.
  - An edge leaving the connection or a place is written as a program hops it, then where it lands, what it can do and the fields there: ``- -[:`Linked Users`]-> Linked User: `Chat Id` text, Email text``, for ``- `Linked Users` [r]: `Chat Id` text, Email text``. An edge only written along lists what a write takes.
  - An edge that only reads has no mark; any other lists all it can do (`[w]`, `[fires]`, `[r w fires]`), for `[r]`, `[w]`, `[rw]` and `[listenable]`. Field marks follow the name (`Text! text`, for `Text text!`), and a field only a write gives is `(write only)`. An enum is `"a" | "b" | …+3`, for `enum(a|b|…+3)`, and a field list cut for room ends `…+N`, for `+N more`. One legend line heads the digest.
  - A `position` is a walk the checker reads, as a program's: it may go any depth and carry a `WHERE`, and a misspelt edge is answered with the checker's diagnostic naming the edges there are, for "No such place". Each edge's ``— position "…"`` goes: the place's answer ends with one position to copy, its own followed by its first edge's hop.
  - A line too long for a system's block is no longer cut mid text; its edge gives up its fields as before.
  - `compactType` and `DIGEST_LEGEND` are no longer exported.

## 0.13.3

### Patch Changes

- c8e1bfe: The micro examples: a few checked lines of listen-fire doing one thing each, found by asking in your own words. The handbook exports them (`microExamples`, `searchExamples`, `renderExampleLookup`, `renderExampleIndex`); they are read from the `listen-fire` command's own copy, `crates/lf/data/examples.md`, which a build of the package carries as `examples.md`. The authoring tools serve the lookup as `showExample`, and the front page's build loop points at it. The language search's ranking rule is now one function, `scoreFields`, which both lookups share.
- a354fd1: The handbook carries the chapters on the always-connected `cron` and `manual` (`system:cron`, `system:manual`, exported as `UNIT_CHAPTERS`). Its index and `listen-fire catalog` route a schedule's or a hand-started run's author to them, and only the platform had them: elsewhere the route answered "No chapter". `system:cron` shows a schedule listen in a zone and says what a tick carries (`Fired at`, `Schedule`, `Zone`); `system:manual`, a start reading its `Text`, and a backfill. Each example checks clean. The authoring tools read them with no host; a host's own chapter of the same id takes their place.
- Updated dependencies [9e0ee87]
- Updated dependencies [fa0d26d]
- Updated dependencies [56ba35d]
- Updated dependencies [c8e1bfe]
- Updated dependencies [c57e47c]
- Updated dependencies [01bfdd4]
- Updated dependencies [a354fd1]
- Updated dependencies [05d2f0c]
- Updated dependencies [b1e401b]
- Updated dependencies [0dcc4ec]
- Updated dependencies [3c4dbee]
  - @listen-fire/handbook@0.15.0

## 0.13.2

### Patch Changes

- Updated dependencies [d230f9c]
  - @listen-fire/handbook@0.14.0

## 0.13.1

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.

## 0.13.0

### Minor Changes

- 522f9cf: A save hands its host `listens`, the plan of each listen as the engine's check answers it against the tenant's catalog, replacing `listeners`; a host routes arrivals by them (`plannedListensOf`, `listenFires`). `runnable` means a listen on the manual unit (`listen to manual-[:Invocations]-> fire f`), a save whose traversal listens do not all check warns how many will not fire, and the digest spells a run host unit's listen as a traversal.

### Patch Changes

- 66d32d5: The digest of a connected system names an owned scalar by its name (`Cron`), where a module declares a field of kind `owned`. A root that cannot be listed (a write-only or listen-only collection) is no longer marked readable.
- Updated dependencies [c57641a]
- Updated dependencies [cf98af4]
- Updated dependencies [0801793]
- Updated dependencies [75ea8a3]
- Updated dependencies [28f6d44]
- Updated dependencies [16e3776]
- Updated dependencies [1e85960]
- Updated dependencies [1a80e92]
- Updated dependencies [37ad00c]
  - @listen-fire/handbook@0.13.0

## 0.12.8

### Patch Changes

- 73703f9: A new package, `@listen-fire/authoring-mcp`: the tools an agent uses to write, check, save and run movements (getStarted, searchLanguage, readHandbook, listConnections, describeConnection, validateAutomation, saveAutomation, editAutomation, getAutomation, readAutomation, grepAutomations, listAutomations, deleteAutomation, and runAutomation, checkRun, listRuns and inspectRun when the host supplies runs), served over MCP for one tenant. `createAuthoringHandler(host)` is one HTTP request handler (streamable HTTP, no sessions); the host's `tenant(request)` runs first on every request and hands the package that tenant's catalog, its store of saved movements and, optionally, its runs, checker and deeper describe. A save is checked first and refused while it would not go live (unless the agent passes the user's consent), and refused when the revision it read (`revisionOf`, the sha256 of the text) has moved. Diagnostics carry the handbook anchor that shows the fix. `@listen-fire/authoring-mcp/testing` is an in-memory host. It takes the core as a peer (`>=0.12.0 <1.0.0`). This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
