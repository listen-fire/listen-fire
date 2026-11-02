# @listen-fire/mcp

## 0.12.13

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.12.12

### Patch Changes

- fd83888: The module's description and README show a listen as a traversal (`listen to crm-[:Company]-> fire triage`), the 0.13 form; the retired `listen to crm { events: [...] }` is gone from them.
- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.11

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.
- 93e4f6f: `retryingFetch` no longer retries a request the host refused by policy: an error carrying the code `LF_POLICY_REFUSAL` (`POLICY_REFUSAL_CODE`, `isPolicyRefusal`) is thrown at once with its own message, not retried as a network error. `@lf/mcp` benefits through its wrapped fetch.

## 0.12.10

### Patch Changes

- 7eb4ba0: An MCP connection retries a request to its server that failed with a 429, a 5xx or a network error, with exponential backoff and jitter, honouring `Retry-After` and holding the connection on every instance. A call to a tool that changes things is sent again only when the server asked for the wait or was never reached; read-only tools, `initialize` and `tools/list` are retried freely. Four attempts and 20 seconds at most.

## 0.12.9

### Patch Changes

- 2a5e666: A read-only tool's required arguments are marked `pinned`, so `lf check` refuses a read that does not pin one in its `WHERE` with `==` (`MOV_HOP_PIN_REQUIRED`, naming the argument) instead of the run failing. The run still names a required argument that reaches the server without a value.

## 0.12.8

### Patch Changes

- a5f0479: A new module, `@lf/mcp`: any remote MCP server over streamable HTTP. Each connection names its server (`url`) and signs in with a token (`mcp_token`, as a bearer or under a header it names) or OAuth (`mcp`, with the install's endpoints and app). Its tools, read when the connection is described, become types: a tool that changes things is written, and its answer read off the handle; a read-only tool is read from the connection's root with its arguments pinned by the hop's `WHERE`. A refused call fails the run with the server's text. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
