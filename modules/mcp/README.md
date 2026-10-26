# @listen-fire/mcp

Any remote [MCP](https://modelcontextprotocol.io) server as a Listen-Fire module (`@lf/mcp`, bundled with `lf`). The module is fixed: a connection carries only data, the server's URL and how to sign in. Nothing a connection says starts a process: the module reaches servers over streamable HTTP only.

## What a movement sees

Each connection's types are its server's tools, read from the server (`tools/list`) when the connection is described: at `lf check`, and when a run's files are loaded. A changed tool list takes effect at the next describe.

- **A tool that changes things** (anything its server does not mark `readOnlyHint`, or marks `destructiveHint`) is a type a movement writes. Its arguments are the written fields; the call's answer is read off the write's handle.
- **A read-only tool** is a type a movement reads from the connection's root. Its arguments are the `==` tests of the hop's `WHERE`; the call answers one record holding the arguments and the answer.
- Every type has `text` (the answer's text parts, joined by new lines) and `content` (every part, as json). A tool with an `outputSchema` adds `structured` (the whole structured answer) and one field per top-level output property. A result field an argument already names is left out.
- A call the server refuses (`isError`) fails the run with the server's text.

```
import { acme_crm, mcp } from adapters
import { acme, linear } from credentials

crm = connect acme_crm using acme
tracker = connect mcp using linear

function triage(company: <crm-[:Company]->>) {
  issue = write tracker-[:create_issue]-> { title: "Follow up ${company.Name}", team: "ENG" }
  tracker-[r:search_issues WHERE r.query == company.Name]-> {
    write crm-[:Company]-> { Name: "${r.count} open; ${issue.text}" }
  }
}

listen to crm { events: ["company.created"] } fire triage
```

### Types

A property of a tool's input or output schema is typed as:

| JSON Schema | field |
|---|---|
| `string` | text |
| `string` with `format: date` | date |
| `number`, `integer` | number |
| `boolean` | boolean |
| a `string` `enum` | a choice of those values |
| an `array` of one of the above | a list of it |
| anything else (an object, a union, a mixed list) | json |

A property's `null` alternative (`["string", "null"]`) is dropped. `lf check` refuses a written argument of the wrong type, a value outside an enum, a field the tool does not have, and a `WHERE` comparing an argument to a value of another type.

## Connecting

Install it once per project, then add one credential per server. `lf connect` asks whether to set up an OAuth app (no by default; `--yes` sets none up), since a token needs none.

```sh
lf connect @lf/mcp
lf credential add --module @lf/mcp linear --credential mcp_token
```

- `mcp_token` holds the server `url`, a `token`, and optionally a `header`. Without a header the token is sent as `Authorization: Bearer <token>`; with one, the token is sent under that header as written (`X-Api-Key`). Any number of servers can be connected this way.
- `mcp` is an OAuth sign-in. Its `url` is the server's. The authorization server's endpoints and your app there belong to the install: `lf connect @lf/mcp --oauth-authorize-url <…/authorize> --oauth-token-url <…/token>`, then `lf credential add --module @lf/mcp <name> --credential mcp`. Without an OAuth app, adding an `mcp` credential is refused, naming that command. The sign-in uses PKCE. OAuth therefore reaches one server's authorization server per project.

`lf check` describes each connection the movement files import, once each, as that connection.

## Not in this version

- Resources, prompts, sampling and elicitation; listening to the server's notifications; stdio servers.
- A read that leaves out a required argument passes `lf check` and fails the run, naming the argument. Nothing marks a field the `WHERE` must pin yet.
- OAuth endpoints found from the server's protected-resource metadata, per-connection OAuth endpoints, and dynamic client registration.
