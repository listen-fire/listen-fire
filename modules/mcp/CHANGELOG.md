# @listen-fire/mcp

## 0.12.10

### Patch Changes

- 7eb4ba0: An MCP connection retries a request to its server that failed with a 429, a 5xx or a network error, with exponential backoff and jitter, honouring `Retry-After` and holding the connection on every instance. A call to a tool that changes things is sent again only when the server asked for the wait or was never reached; read-only tools, `initialize` and `tools/list` are retried freely. Four attempts and 20 seconds at most.

## 0.12.9

### Patch Changes

- 2a5e666: A read-only tool's required arguments are marked `pinned`, so `lf check` refuses a read that does not pin one in its `WHERE` with `==` (`MOV_HOP_PIN_REQUIRED`, naming the argument) instead of the run failing. The run still names a required argument that reaches the server without a value.

## 0.12.8

### Patch Changes

- a5f0479: A new module, `@lf/mcp`: any remote MCP server over streamable HTTP. Each connection names its server (`url`) and signs in with a token (`mcp_token`, as a bearer or under a header it names) or OAuth (`mcp`, with the install's endpoints and app). Its tools, read when the connection is described, become types: a tool that changes things is written, and its answer read off the handle; a read-only tool is read from the connection's root with its arguments pinned by the hop's `WHERE`. A refused call fails the run with the server's text. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
