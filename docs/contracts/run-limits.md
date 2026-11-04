# Run limits

What keeps a movement someone else wrote from harming the host that runs it. An embedder can let its customers write movements; these are the bounds it relies on.

- Every limit is set by the host, per segment, with a safe default.
- Exceeding one ends the segment with a coded error (`MovementEngineError`, code below).
- Nothing in the movement can forgive or catch a limit error: a collection op's `onError` passes it through.
- No limit changes what a movement means. A movement under its limits runs exactly as before.

## The limits

| limit | kept by | default | the host sets it with | code when exceeded |
|---|---|---|---|---|
| Steps: statements run plus expressions evaluated, per segment | engine | 10,000,000 | `limits.maxSteps` (TypeScript: `RunInput.limits`) | `MOVENG_LIMIT_STEPS` |
| One text's size, in UTF-8 bytes | engine | 16 MiB | `limits.maxTextBytes` | `MOVENG_LIMIT_TEXT_SIZE` |
| One list's members, or one map's keys | engine | 1,000,000 | `limits.maxCollectionItems` | `MOVENG_LIMIT_COLLECTION_SIZE` |
| The segment's result, as JSON text | engine | 64 MiB | `limits.maxResultBytes` | `MOVENG_LIMIT_RESULT_SIZE` |
| Call depth: named calls nested in one run | engine | 32 | `maxCallDepth` | `CallDepthExceeded` (listen-fire prints `MOVENG_CALL_DEPTH`) |
| Wall clock per segment, waits included | run host | 900 s | `MOVEMENT_MAX_SEGMENT_SECONDS` (TypeScript: also `RunInput.maxSegmentSeconds`) | `MOVENG_LIMIT_WALL_CLOCK` |
| Cost per run: model calls and priced plugins | engine and run host | no cap | `spend.capMicrodollars` (listen-fire: `maxRunCostUsd` in lf.yaml) | `RunCostCapExceeded` (the flow suspends where the host can park it) |
| Module calls per run | run host | 2,000 | listen-fire: `REMOTE_ADAPTER_MAX_CALLS_PER_RUN` | `AdapterCallCeilingExceeded` |

```ts
type SegmentLimits = {          // on the segment's input, beside maxCallDepth
  maxSteps?: number;            // whole and positive; absent: the default
  maxTextBytes?: number;
  maxCollectionItems?: number;
  maxResultBytes?: number;
};
```

listen-fire and the TypeScript host read each engine limit from the environment, as they read the call depth: `MOVEMENT_MAX_STEPS`, `MOVEMENT_MAX_TEXT_BYTES`, `MOVEMENT_MAX_COLLECTION_ITEMS`, `MOVEMENT_MAX_RESULT_BYTES`. A value that is set but is not a positive whole number refuses the run; it is never read as no limit. On the TypeScript host a run's own `limits` override the environment's, one limit at a time.

## Provider limits

Separate from the bounds above: what keeps a host's calls to modules and models inside what the provider allows. These never fail a run. They make a call wait.

- A module declares its provider's limits in its manifest (`limits`: at most `calls` per `per`, at most `concurrent` at once, counted per credential, module, install or team). See [the adapter protocol](adapter-protocol.md#kinds-settings-spend-and-the-hosts-models).
- An answer's `retryAfter` (seconds) holds every later call made as that credential (or install) until then.
- The host keeps them through its limiter slot, not the engine ([the limiter slot's wire](limiter-slot.md)). listen-fire's default, `@lf/memory-limiter`, counts in one process; a shared limiter is a module filling the slot.
- A refused call waits in the host's process, holding its segment's place. The segment's wall clock still runs, so a long wait can end the segment with `MOVENG_LIMIT_WALL_CLOCK`.
- Model requests: `@lf/anthropic` allows 8 in flight at once per process, on listen-fire and on the platform alike.

## How each is kept

- **Steps are the CPU bound.** The engine reads no clock (it runs as WASM, and must stay deterministic), so it counts work instead: one step per statement, one per expression evaluated. Members of a collection op are expressions, so a loop over a list pays per member.
- **The wall clock is the host's.** The engine hands control back to its host at every statement (the cancel gate asks the host). So the host checks its deadline between requests, and the step budget bounds the work between two of them. Past the deadline the host feeds the engine nothing more, and no write is cut off half-sent; then the segment fails.
  - listen-fire: what is still in flight gets a five-second grace to finish. After the grace, a read or a model call still waiting is dropped, and a write to an external system (a record created, updated, deleted, linked or unlinked, or an event subscription changed) is waited for to its end.
  - The TypeScript host: the requests already at the host finish first.
- **Sizes are checked on every value an expression produces.** A value is checked for its own size, not its members' (each member was checked when it was produced). So a text doubled in a loop fails as soon as it passes the limit.
- **The result size is checked once, as the segment ends.** It replaces the result with the limit error; the cost lines still go back, because that money is spent.
- **Call depth is the one limit a call has to reach.** Named calls nest, wherever they are written: as a statement, inside an expression, in a condition, through a closure, a `map`, an `all` or a `race`, or in a walk's body.
  - Stack does not end a run first. The native engine runs on more stack as the calls nest, so `listen-fire` reaches the limit at any setting, on any program, on a release or a debug build.
  - The WASM engine has a fixed stack, and no way to add to it. So it can end a run short of the limit, with the same `CallDepthExceeded` and a message saying its stack ran out (`stackRanOut` on the error). It holds about 240 calls of a plain recursion and 8 of one that nests its next call 120 levels into an expression; a limit it holds, it keeps. It checks at every statement and call, and stops with 1 MiB left, more than any one statement takes (at most 546 KiB across every form of nesting tried at the parser's limit, measured 2026-11-04). V8's own stack can run out first, deepest in a value or a parse: the host then ends the run with the same error, naming no calls, and what the run had done is not reported with it. A genuine crash of the engine stays its host's error for a crashed engine.
  - **Setting it costs memory and time, and a host should size it knowing that.** Each open call holds its frames, so the limit bounds that memory: about 90 KiB a call on a release build (920 MiB at a limit of 10,000 on a plain recursion, measured 2026-11-04). Through a `map` or an `all` each flow keeps a copy of the calls above it, so memory grows with the square of the depth (1.2 GiB at 3,000). Nothing else bounds it, so a limit too high for the machine runs it out of memory; the operating system ends the process then, not the engine.
  - Each host answer polls every open call again, so a run's time grows with the square of its depth: a second to reach 300, three to 1,000, forty to 3,000, twelve minutes to 10,000 (release build, on the machine this was measured on). Far enough up, the wall clock ends the run first, with its own code.
- **A value crosses to its host only up to 3,000 levels of nesting.** A value handed to a host call deeper than that ends the segment with `MOVENG_RUNTIME`; one returned is recorded as a value it could not write, and the run completes. Written out, a value is a tree of JSON, and what reads and writes one recurses where nothing can ask for more stack. `listen-fire` carries a value all the way to that cap. The WASM engine holds about 2,600 levels on Node's default stack, and deeper than that V8's stack runs out, which ends the run with `CallDepthExceeded` as above. Inside a segment a value can nest as deep as its size limits allow, on the WASM engine as deep as that stack allows.

## The cost cap is the same on every host

- The engine holds the run's spend account (prior spend, plus this segment's charges).
- Every priced host call is handed the remaining budget, and reports what it spent.
- A model call (`AI()`, `extract`, the identity judge) and a priced plugin are refused by the engine itself once the run has spent its cap. The host is never asked. Before this release a model call relied on the host refusing past its budget, so a host that ignored the budget could overspend.
- A call already under way can overshoot the cap by what that one call costs. The next priced call is refused.
- A module call is priced only by what the module reports it spent (`ctx.spend.charge`, carried back as its answer's `cost`). The host charges that to the run, whether the call succeeded or failed. The cap sees it once the segment the call ran in ends, so a module's spend can overshoot within one segment. A module that reports nothing is not counted.

## A movement reaches the network only through modules

Reviewed for this release:

- **The engine makes no request of its own.** It has no network code: everything it needs it asks its host for, by family (adapters, llm, files, park, trace, clock, ids, check, log, lookup, locks, control).
- **No family takes a URL from the movement.** Adapter calls go to the module the movement connected. Model calls go to the host's configured provider. Plugins go to the plugin's module.
- **A file's bytes are fetched only from a URL a module gave.** A file value names its owner module and handle; listen-fire asks that module to resolve it, and fetches the URL the module answered. A movement can forge a file value, but only the named module decides what is fetched.
- **A stored document is read only inside the project's own folder.** A handle with `..` or an empty part is refused, and a handle outside the team's folder is not this project's.
- **listen-fire's other outbound requests are the host's, not the movement's:** a credential's token refresh, a provider's OAuth exchange, the model provider.

## Measured peaks, and why the defaults stand

Measured 2026-10-18 by instrumenting the engine (a counter beside each check, not kept): every program the repository's tests run on the Rust engine. That is the Rust crates' tests (the oracle and frozen programs, listen-fire, the embedding example), the TypeScript engine package's tests and the platform's `movement_engine` tests (both on the WASM build), 3,378 + 743 + 721 tests. The listen-fire examples were not run: they need a live external system.

| limit | highest observed in one segment | default | default over peak |
|---|---|---|---|
| Steps | 198 | 10,000,000 | about 50,000 times |
| One text | 902 bytes | 16 MiB | about 18,000 times |
| One list or map | 5 members | 1,000,000 | about 200,000 times |
| Result as JSON | 34,396 bytes | 64 MiB | about 2,000 times |
| Wall clock | not measured (the tests run in milliseconds) | 900 s | not applicable |

- The defaults are kept. The corpus is small test programs, so its peaks say only that no repository program comes near a limit.
- Setting each default 10 to 100 times over these peaks would put steps near 20,000 and a list near 500, below ordinary real work (a loop over a few thousand records). A limit that low would refuse legitimate movements.
- A default should be tightened from production runs (the largest real segments), not from tests. Until there are such runs, the defaults stay generous: they stop a runaway, and never a real workload.

## Not covered

- **Memory as a whole.** The size limits bound each value, not their sum. A movement could still hold many values each under the limits; the step budget bounds how many it can build. Open calls take memory too; the call depth bounds those.
- **One step's own work.** A single step can still do work proportional to its input (sorting a list of a million). The collection limit bounds that input.
