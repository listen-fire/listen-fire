# @listen-fire/authoring-mcp

The tools an agent uses to write, check, save and run movements, served over MCP for one tenant of your product.

- One HTTP handler: `createAuthoringHandler(host)`. Streamable HTTP, no sessions. Mount it at any path, for POST, GET and DELETE.
- Your `host.tenant(request)` runs first on every request. It returns that tenant's functions, or a refusal (a refused request sees no tools).
- A tenant's functions: its catalog snapshot and connections, its store of saved movements (with an atomic revision check), and optionally its runs, a checker of its own and a deeper describe. The types and their rules are in `host.ts`.
- The language half is this package's: the handbook and its search, the checker, the digest of connected systems, and the save rules (check first; refuse what would not go live unless the agent has the user's consent; refuse a stale revision).
- `@listen-fire/authoring-mcp/testing` is an in-memory host for tests.

docs/embedding.md ("Serving the authoring tools") shows the embed example serving it.
