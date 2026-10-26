---
"@listen-fire/mcp": patch
---

A new module, `@lf/mcp`: any remote MCP server over streamable HTTP. Each connection names its server (`url`) and signs in with a token (`mcp_token`, as a bearer or under a header it names) or OAuth (`mcp`, with the install's endpoints and app). Its tools, read when the connection is described, become types: a tool that changes things is written, and its answer read off the handle; a read-only tool is read from the connection's root with its arguments pinned by the hop's `WHERE`. A refused call fails the run with the server's text. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
