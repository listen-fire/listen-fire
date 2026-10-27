# `lf --json`

Add `--json` to a command an agent inspects or drives and stdout is one JSON
document (one line). Human output without the flag is unchanged. Exit codes are
the same either way (`check`: 1 on any error; runs: 1 when any run failed).
A failure of the command itself is `{"error": "<message>"}` on stdout, exit 1.
Usage mistakes (a missing argument) still print to stderr, exit 2.

Keys are camelCase. A value that does not apply is `null`, never absent.

## `lf check --json`

```json
{ "ok": true, "files": 1, "errors": 0,
  "diagnostics": [{ "code": "MOV_PARSE", "severity": "error", "file": "/abs/movements/a.mvt",
    "span": { "line": 1, "column": 1, "endLine": 1, "endColumn": 9 },
    "message": "…", "fixes": [] }] }
```

- `severity`: `error`, `warning` or `info`. `ok` is true when no diagnostic is an error.
- `fixes`: the checker's exact rewrite (as `lf upgrade` applies it), at most one; empty when it offers none.
- A credential a movement imports that the secrets lack is a diagnostic, code `MISSING_CREDENTIAL`.

## `lf catalog --json`

The catalog snapshot (`{ "contractVersion", "adapters", … }`), as `lf catalog` already prints it.
When credentials are missing: `{ "error", "missingCredentials": [diagnostic…] }`, exit 1.

## `lf run <movement>`, `run --event`, `run --poll`, `run --webhook`, `resume [<run-id>]`

```json
{ "ok": true, "redelivered": ["…"],
  "runs": [{ "runId": "…", "file": "hello", "movement": "hello", "entry": "fired",
    "status": "completed", "writes": 0, "dryRunWrites": null, "traceEntries": 0, "error": null,
    "returned": { "value": "Hello, Ada!" } }] }
```

- `entry`: `fired`, `resumed` or `called`. `status`: `completed`, `parked`, `failed` or `leaseLost`.
- `ok` is false when any run failed. `dryRunWrites` is an array only under `--dry-run`.
- `redelivered`: lines for listens that had already seen the event's idempotency key.
- `returned`: what the movement returned, once the run has completed (`null` before then, or when it returned nothing). It is `{ "value" }`; `{ "truncated": true, "bytes", "preview" }` when its JSON is over 64 KiB (`preview` is the start of that JSON); or `{ "unwritable": "<why>" }` for a value with no plain form, such as a function. A file in the value is its reference (`__brand`, `name`, `contentType`, `size`, `source`: its owner and handle), never its bytes.
- `resume` with nothing parked, or nothing due in what is parked: `runs` is empty.

## `lf call <callback-id> [--body f]`

```json
{ "ok": true, "callback": "…", "result": "recorded", "message": null, "queued": false, "runs": [<run>] }
```

`result`: `recorded`, `refused` (`message` says why), `notFound`, `closed` or `expired`. `queued`: another lf process steps the run and runs the body. `runs` as above: one entry for the call (`entry`: `called`), its `writes` the body's and those of the run's continuation it woke.

## `lf cancel <run-id> [--reason t]`

`{ "ok": true, "runId": "…", "result": "cancelled" }`; `result` is `cancelRequested` when another lf process is stepping the run. A run that is neither running nor parked is an `{"error"}`.

## `lf runs --json`

`{ "runs": [{ "runId", "file", "movement", "status", "startedAt", "finishedAt", "attempt" }] }`, most recent first (50). `finishedAt` is when the run completed or failed, `null` while it runs or is parked. `status`, `startedAt` and `finishedAt` are the latest attempt's; `attempt` is its number, 1 unless the run was rerun.

## `lf runs show <run-id> --json`

```json
{ "run": { "runId", "file", "movement", "status", "startedAt", "finishedAt", "deliveryId", "firedAt", "languageVersion",
  "event": {…}, "writes": 0, "writeRecords": [ … ], "error": null, "returned": { "value": … }, "outcome": {…},
  "costMicrodollars": 0.0, "traceEntries": 0, "trace": [ … ],
  "parked": [{ "address": "…", "reason": "timer", "wakeAt": "…" }],
  "attempt": 1, "attempts": [{ "attempt": 1, "status", "startedAt", "finishedAt", "writes", "writeRecords", "error" }],
  "cancelRequested": false, "cancelReason": null } }
```

- `deliveryId`: the delivery the run came from (`lf deliveries show`), or `null` for a run started by `lf run`, a cron tick, a poll or a callback.
- `languageVersion`: the version string the run is pinned to (a store from before pins were versions, holding the integer 5, is read as this release's version).
- `event`: the event that fired the run. `outcome`: what the store recorded when the run last settled.
- `writes`: how many writes the run made, over every entry into it (a resume's and a callback continuation's included).
- `writeRecords`: each write, in order, as `{ "adapter", "recordType", "recordId", "action", "committed", "values" }` (`link` too, for a link: `{ "edgeName", "toRecordType", "toExternalId" }`). `action` is `create`, `update`, `attach` (an update that changed nothing), `noop`, `delete`, `link`, `unlink` or `match`; `committed` is false for a rehearsed write. `values` are the fields the write set, a file by its reference; over 2 KiB of JSON they are `{ "truncated": true, "bytes", "preview" }`. The first 100 writes are listed. `null` for a run settled before lf kept them. A failed run lists the writes it made before it failed, the failing step's included.
- `returned`: what the movement returned, as under `lf run` above. Every run records it, however it was started.
- `trace` is `null` when the run's store cannot hand entries back (a store module over its wire); `traceEntries` is always the count.
- `parked`: what the run waits on now; empty unless `status` is `parked`.
- `attempts`: every attempt of the run, oldest first, the latest (the run's own `status`, `writes`, `error`) last. A run that was never rerun has one.
- `lf runs show <id>` without `--json` prints the same document, indented.

## `lf runs rerun <run-id> [--force] --json`

A failed run run again as its next attempt: `{ "ok", "runs": [<run>], "redelivered": [], "attempt": 2 }`, the run as under `lf run` (`entry`: `rerun`). Exit 1 when the attempt failed.

Refused: `{ "ok": false, "runId", "refused", "error", "status", "attempt", "committedWrites" }`, exit 1. `refused` is:

- `notFailed`: the latest attempt did not fail (`status` says what it is, `attempt` which it is). `error` is `run <id> succeeded on attempt <n>; nothing to rerun` for a completed one.
- `busy`: another lf process holds the run (`status` and `attempt` are `null`).
- `committedWrites`: the failed attempt committed writes before it failed; `committedWrites` lists them as `writeRecords` does. `--force` reruns it anyway.

An unknown run, or a movement that no listen fires now or that does not check, is an `{"error"}`, exit 1.

## `lf deliveries --json`

`{ "deliveries": [{ "id", "subscriptionId", "externalId", "receivedAt", "source", "inline", "replayOf", "eventCount", "runs": [{ "id", "status" }] }] }`, most recent first (50). `--subscription <id>` keeps one subscription's; `--since` is an ISO instant, or `<n>h` or `<n>d` before now, and keeps those received at or after it. `source` is `webhook`, `hook`, `emit` or `cli`; `externalId` is the provider's delivery id, or `null`; `inline` is true when the events ran inside the request; `replayOf` names the delivery a replay repeats.

## `lf deliveries show <id> --json`

`{ "delivery": { …the listing's fields, "events": [{ "external", "event" }] } }`. `runs` is empty for a delivery no listen took. Without `--json` it prints the same document, indented. An unknown id is `{"error": "no delivery <id>"}`, exit 1.

## `lf deliveries replay <id> --json`

`{ "ok": true, "deliveryId": "<new id>", "replayOf": "<id>", "queued": 1 }`. Without `--json` it prints `delivery <new> replays <id>: <n> event(s) queued; lf serve or lf drain runs them`.

## `lf connect --json`

`{ "modules": [{ "name", "kind", … }] }`. `kind` is `external` (`state`, `how`, `installSetUp`, `install`, `credentials`: names), `core` (`slot`, `state`, `setUp`, `setupNote`) or `package` (`state`: `not installed`). Names only; no secrets.

## `lf credential list --json`

`{ "credentials": [{ "name", "module", "binding", "declaredCredential", "kept", "expiresAt" }] }`.
`binding`: `install`, `credential` or `legacy`; `declaredCredential` is set for `credential`. `kept`: the secrets file path and/or `environment`. `expiresAt`: a token's expiry or `null`. Never a value.
