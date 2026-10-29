# The limiter slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A limiter module keeps a host's calls to modules and models inside the providers' limits. The host asks it before every call, and holds the call until it is granted. listen-fire ships one, `@lf/memory-limiter` (the default), which keeps the limits in listen-fire's own process. A limiter shared by many hosts (Redis, a database) is a third-party module listen-fire starts (or reaches at its URL) and calls over adapter protocol 2.

The engine knows nothing of limits. Only the host asks.

## What one acquire counts

- Usually one call from the host to a module.
- For a module that declares `hostLimits`, one request from the module to its provider, retries included. The module asks the host's [limits door](adapter-protocol.md#kinds-settings-spend-and-the-hosts-models) before each one, and the host asks this slot on its behalf, under the caller it resolved for the call. The host then does not count the call itself.
- Either way the limiter sees the same `acquire`, `release` and `throttle`. Nothing here changes for a limiter, and a module never reaches one.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_limits
kind: core
slot: limiter
command: [node, limiter.mjs]   # started in this folder
settings:                      # optional; prompted by `listen-fire connect acme_limits`
  - { name: url, label: the Redis URL, secret: true }
```

- `modules/postgres-limiter` (`@listen-fire/postgres-limiter`) is one such module: the limits kept in Postgres, in a schema of its own (setting `schema`, default `lf_postgres_limiter`, created when it is opened), so every worker sharing the database shares one count. Its `url` setting is secret. It reads the database's clock, so hosts with drifting clocks agree.
- lf.yaml names it for the slot: `core: { limiter: acme_limits }`.
- `listen-fire connect acme_limits` asks its settings and opens it once.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time. Instants are `Date.toISOString` strings.

## Methods

No method waits. A refusal says when to ask again; the host does the waiting.

| method | params | result |
|---|---|---|
| `limiter.open` | `{ settings: { [name]: string } }` | `null` |
| `limiter.acquire` | `{ key, cost, limits: [{ key, calls?, perMs?, concurrent? }], holdMs }` | `{ granted: true, permit }`, or `{ granted: false, retryAt }` |
| `limiter.release` | `{ permit }` | `null`; a permit released twice, or never given, changes nothing |
| `limiter.throttle` | `{ key, until }` | `null` |

- **`acquire`** is granted only when every one of `limits` has room and `key` is not throttled. Then the call counts in all of them at once. A refused call counts in none, so it spends no quota anywhere.
- **`limits[].key`** names the bucket a limit counts in. The host makes it from the module, the limit's scope and the scope's value (which credential, install or team). A limiter treats it as opaque.
- **`calls` per `perMs`**: at most that many calls (counting `cost` each) in any window of that length. The window is rolling: a call counts from the instant it is granted until `perMs` later, so no stretch of `perMs` ever holds more than `calls`, however the calls are spaced. (A token bucket refilled evenly would let a burst of `calls`, then one call every `perMs / calls`, put nearly twice `calls` in one window; a limiter may not do that.) A call costing more than `calls` counts as `calls`, so it waits for an empty window. The two go together.
- **`retryAt`** on a refusal is the earliest instant the call could be granted: for a rate limit, when enough of the oldest calls in the window have left it (for a call costing one in a full window, the oldest call's grant plus `perMs`); for a throttle, its end; for a concurrency limit, the soonest permit's lapse, or sooner when the limiter rechecks. Where several refuse, the latest stands. It is advice: a call asked again then may meet calls granted meanwhile.
- **`concurrent`**: at most that many permits held at once in the bucket.
- **`key`** (the request's own) is who the call is made as: where a provider's throttle lands.
- **`holdMs`**: a permit never released lapses after this long, so a crashed host frees its places.
- **`throttle`**: the provider asked for no call on `key` before `until`. Every `acquire` naming `key` is refused until then. It is how a vendor's wait reaches the limiter: a caller that meets a 429 throttles its own key for the wait the vendor asked (its `Retry-After`, seconds or an HTTP date, or Google's `RetryInfo`; `vendorWaitMs` in `@listen-fire/engine/public/limiter` reads them, clamped to 1–120 s), else for its own default (`throttleAfter`), and releases its permit rather than sleeping on it. The waiting is the host's, as for any refusal.
- **A vendor's budget on a success closes the key early.** Vendors also report what is left on a success: Anthropic's `anthropic-ratelimit-{requests,tokens}-{remaining,reset}` and OpenAI's `x-ratelimit-{remaining,reset}-{requests,tokens}`. `vendorBudget` reads either family (a reset as an ISO timestamp, a duration such as `6m0s`, or seconds; the binding limit when several report; the reset clamped to 120 s ahead) and `budgetAfter` throttles the caller's key until the reset when `remaining` is 0, exactly as a 429 would, but before it. A count above zero does nothing: the window a limiter keeps is the module's declared budget, set on purpose, and the vendor's count is advisory (the key's other clients spend from it, and it is stale when read), so it never reshapes that window. `@lf/anthropic` and listen-fire's Rust Anthropic client call it on every successful response. No method is added: it is the `throttle` already there.
- **A throttle closes a caller, not a request.** `key` is the caller's: the module, then its credential, else its install (`throttleKey`). One throttle refuses every call made as that caller, by every host sharing the limiter, whatever limits each call names. A provider whose limits differ per zone or endpoint (Bright Data's SERP and Web Unlocker zones) is called as a distinct caller per zone (`@lf/web/serp`, `@lf/web/unlocker`), so one zone's 429 leaves the other open.
- Every request carries its limits. A limiter reads no manifest and keeps no configuration, so a new module, or a new limit on one, needs nothing from the limiter.

## The contract suite

[`contract.ts`](../../packages/movement-engine/services/limiter/contract.ts) holds every limiter to the same cases. `apps/cli` runs it over `listen-fire --contract-limiter` (listen-fire's built-in) and `listen-fire --contract-limiter-slot` (a test module filling a project's slot, `apps/cli/src/__test__/limiter_module/serve.ts`), in `limiter_contract.test.ts`. The platform's built-in passes the same cases in `services/limiter/__test__`. The cases are public (`limiterContractCases` in `@listen-fire/engine/public/testing`) for a limiter built outside this repository.

## Changes

- **2026-10-23** (within adapter protocol 2): a vendor's exhausted budget, reported on a success, throttles the caller's key until its reset (`vendorBudget`, `budgetAfter`). `@lf/anthropic` and listen-fire's Anthropic client do it. The slot's methods are unchanged.
- **2026-10-22** (within adapter protocol 2): `calls` per `perMs` is a rolling window in every limiter (listen-fire's built-in, `@lf/memory-limiter` in the engine, `@listen-fire/postgres-limiter`), not a token bucket; `retryAt` is when enough of the oldest calls leave the window. The contract suite holds a limiter to it (`a rolling window never holds more than the declared calls`). The slot's methods are unchanged.
- **2026-10-22** (within adapter protocol 2): `throttle` is named as the intake for a vendor's wait, and the key's granularity is the caller's. `@lf/anthropic`, `@lf/affinity` and `@lf/web` throttle on a 429. The slot's methods are unchanged.
- **2026-10-20** (within adapter protocol 2): a module that declares `hostLimits` is counted per provider request at the host's limits door, not per call. The slot's methods are unchanged.
- **2026-10-19** (within adapter protocol 2): the methods ride adapter protocol 2's HTTP; the stdin/stdout JSON-RPC wire is retired.
- **2026-10-18** (within adapter protocol 2): the limiter slot, its wire, and process modules filling it.
