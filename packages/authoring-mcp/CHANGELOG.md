# @listen-fire/authoring-mcp

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
