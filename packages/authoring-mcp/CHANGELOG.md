# @listen-fire/authoring-mcp

## 0.12.8

### Patch Changes

- 73703f9: A new package, `@listen-fire/authoring-mcp`: the tools an agent uses to write, check, save and run movements (getStarted, searchLanguage, readHandbook, listConnections, describeConnection, validateAutomation, saveAutomation, editAutomation, getAutomation, readAutomation, grepAutomations, listAutomations, deleteAutomation, and runAutomation, checkRun, listRuns and inspectRun when the host supplies runs), served over MCP for one tenant. `createAuthoringHandler(host)` is one HTTP request handler (streamable HTTP, no sessions); the host's `tenant(request)` runs first on every request and hands the package that tenant's catalog, its store of saved movements and, optionally, its runs, checker and deeper describe. A save is checked first and refused while it would not go live (unless the agent passes the user's consent), and refused when the revision it read (`revisionOf`, the sha256 of the text) has moved. Diagnostics carry the handbook anchor that shows the fix. `@listen-fire/authoring-mcp/testing` is an in-memory host. It takes the core as a peer (`>=0.12.0 <1.0.0`). This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
