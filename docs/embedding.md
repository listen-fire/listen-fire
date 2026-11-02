# Embedding the engine

Your product can let its customers write movements and run them inside it. The engine runs in your own Node process, as WebAssembly: no server of ours, no network of its own. You give it what it needs: your product as a module, a place for each customer's secrets, the models it may call, and the limits it must keep.

A working example is in [`examples/embed-saas`](../examples/embed-saas): a small HTTP app where a customer saves a movement, the app checks it, and a company created in the app runs it. Its tests run it end to end, with customers whose schemas differ and a ready-made module loaded for each.

## The packages

| package | what it is |
|---|---|
| `@listen-fire/engine` | The engine and its host contract. Reached only through its public entries, `@listen-fire/engine/public/<entry>`. |
| `@listen-fire/engine-contracts` | The data the engine is handed: a run's input, the tenant id, the event, the parked state, the module protocol. |
| `@listen-fire/module-kit` | How a module is defined (`defineModule`) and loaded, in your process or served as a process. |
| `@listen-fire/embed` | The embedded host, `createEmbeddedHost`: connections, checking, routing and parked runs in one call, over the engine's public entries and the module kit. |
| `@listen-fire/authoring-mcp` | The authoring tools an agent writes, checks, saves and runs movements with, over MCP for one of your tenants (section 7). Optional. |
| `@listen-fire/movement-lang` | The language: parser, checker, catalog types. The engine depends on it. |
| `@listen-fire/model-providers` | Chat vendors beyond Anthropic (OpenAI, Gemini, Claude on Vertex): the models slot. Optional. |
| `@listen-fire/embedding-providers`, `@listen-fire/image-providers`, `@listen-fire/transcription-providers` | Embeddings, image generation and transcription over OpenAI and Gemini, each its own package on `model-providers`' host type. Optional. |
| `@listen-fire/files-s3` | The files slot over S3 or any S3-compatible service. Optional. |
| `@listen-fire/ocr-google` | Scanned-PDF text through Google Document AI, for `file-text`'s `ocrPdf`. Optional. |
| `@listen-fire/file-text` | A file's text: PDF, decks, spreadsheets, audio. The file-reading slot's default module; leave it out and an `extract` over a file is refused by the file's name. Optional. |
| `@lf/<name>` | Ready-made modules: `@lf/attio`, `@lf/slack`, `@lf/google-sheets`, `@lf/web`, and the rest. |

The core packages (`engine`, `engine-contracts`, `movement-lang`) share one version; every other package (`embed`, `module-kit`, the modules) has its own, and takes any core from 0.12 up to 1.0. The TypeScript engine is not part of the kit: the kit runs the language of its own release, which is also the pin a movement is saved with (`ENGINE_VERSION`). Node 22 or later. With TypeScript, use `moduleResolution` `node16`, `nodenext` or `bundler` (plain `node` works too, through the packages' `typesVersions`).

```sh
npm install @listen-fire/embed @listen-fire/engine @listen-fire/engine-contracts @listen-fire/module-kit
```

The public entries of `@listen-fire/engine` you will use:

| entry | for |
|---|---|
| `public/embed` | `inProcessHost`, `introspectAdapter`, `pricedModels`, `MovementEngineError` |
| `public/catalog` | `buildCatalogSnapshot`: what a customer's movements are checked and run against |
| `public/movement-engine` | `runMovement`, `resumeMovement`, `checkPinnedInRust`, `parsePinned` |
| `public/inbound` | `listenPlansOf`, `plannedListensOf`, `listenFires`, `listenPipeline`, `arrivalReceiptKey`, `triggerAwaitsOf`, `landingNode`, `landingMisfits`, `arrivalTriggerOf`: from what arrived to a run |
| `public/secrets` | the secrets family, and an in-memory vault to start from |
| `public/adapter` | what an adapter is |
| `public/models` | the model registry and map, the run's spend and cost cap |
| `public/run-host` | the store and rules for runs that park (`await`, `sleep`) |
| `public/log` | the engine's log lines: `routeEngineLogsTo` hands them to your own logger (the default prints to the console) |
| `public/testing` | for your tests: the store contract suite your own store must pass |

## The shape of it

- **One customer is one tenant.** Every run names its tenant, and everything the run reaches is answered for that tenant only.
- **A customer connects modules.** Your product is one module; a ready-made one (`@lf/slack`, …) is another. Each connection is loaded for that customer over that customer's credential.
- **A customer's movement is checked when it is saved.** The checker reads the customer's catalog: the modules it connected, as that customer sees them.
- **A movement says what it listens for.** When something happens in your product, the movements that listen for it run.
- **A run that waits parks.** `await sleep(1h)` stores the run; a tick past its wake steps it on. `await note-[:Comments]->` stores it until a comment arrives (`dispatch`).

`createEmbeddedHost` (`@listen-fire/embed`) does all of this. You write your module (its `describe`, its reads and writes), hand the host what arrives on its listenable edges, and call its tick from a scheduler.

## 1. Your product as a module

A movement reaches your product through a module: an adapter over your own data. Define it once with the module kit.

```ts
import { defineModule } from '@listen-fire/module-kit';

export const crm = defineModule({
  kind: 'adapter',
  name: '@acme/crm',                     // answers to adapter type `crm`
  manifest: { adapterType: 'crm', displayName: 'CRM', supportedTriggers: ['webhook'], methods: [...], declaredCredentials: ['crm'], introspectedSchema: true },
  credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] }],
  create: (ctx) => crmAdapter(ctx),      // the adapter methods, over ctx.config.tenant
});
```

An entry point a listen may end on declares `listenable: true` and how its arrivals come (`delivery: 'connection'`: your product reports them, section 2). `describe` answers for the tenant the module was loaded for (`ctx.config.tenant`), so each customer's schema can differ: one customer's `Stage` a select of `Lead | Customer`, another's `Prospect | Partner`. A value outside the customer's options is refused when its movement is saved (`MOV_ENUM_UNKNOWN_VALUE`). See `examples/embed-saas/src/crm.ts`.

## 2. The embedded host

```ts
import { createEmbeddedHost } from '@listen-fire/embed';
import { pricedModels } from '@listen-fire/engine/public/embed';
import { slackModule } from '@listen-fire/slack';

const host = createEmbeddedHost({
  modules: [crm, { module: slackModule, package: '@lf/slack' }],
  engine: { llm: pricedModels({ client: models }) },
  limits: { maxSteps: 100_000, costCapMicrodollars: 50_000 },
});

await host.connect('acme', { name: 'workspace', module: crm, credential: { api_key } });
await host.connect('acme', { name: 'slack_workspace', module: slackModule, credential: { accessToken } });

await host.save('acme', { name: 'welcome', source });    // { saved: true, listens: 1 } or { saved: false, problems }
await host.dispatch('acme', { adapterType: 'crm', arrivals }); // { runs: one outcome per run it started or woke, notJudged }
await host.tick();                                          // one outcome per parked run it stepped on
```

- **`modules`.** You install the modules you embed, so you choose the name a movement connects each by. Registered bare, a module is connected as `#` and its adapter type (`app = connect #crm using workspace`). Registered with a package (`{ module: slackModule, package: '@lf/slack' }`), it is connected by that package's name (``team = connect `@lf/slack` using slack_workspace``), as `listen-fire` connects it, so a movement written for `listen-fire` runs here unchanged. Whichever you choose, the handbook and guidance your customers' agents read should show those names.
- **`connect(tenant, { name, module, credential })`.** `name` is what the customer's movement names after `using` (`app = connect #crm using workspace`). The credential is kept in the host's secrets, under an id only that tenant's runs may name; the module is loaded once per connection, its context built for you.
- **`save(tenant, { name, source })`.** Checks the movement against the tenant's catalog and keeps it, pinned to this release (`ENGINE_VERSION`), with the check's plan of each listen (`listen to workspace-[c:Companies WHERE c.Stage == "Lead"]-> fire welcome`). It refuses, by name, a listen this host would not fire as written: one in the retired settings form (`listen to workspace { events: [...] }`); one whose earlier hop has a WHERE the module's arrivals do not carry the record for, which only listen-fire lists members to judge.
- **`dispatch(tenant, { adapterType, connection?, id?, arrivals })`.** One delivery: what one of the tenant's modules says arrived (adapter protocol 2.6: `{ edge, identity, version?, landing: { recordId?, recordType?, fields }, key?, parents?, notFor?, takenApplied? }`, or `{ edge, key, gone: true }`). Hand each delivery to this one call, once; it is everything listen-fire does with one:
  - **The listens it fires.** Each arrival runs every listen of the tenant's saved movements on that module whose last edge it landed on, of the record type that edge lands on (a landing and each parent state their `recordType`; one that states none runs no listen), and whose WHERE the engine's judge says it meets, with the landing as the fired function's parameter, as listen-fire runs it. With `connection`, only the listens on that connection are judged; without, it is the module's own install's and every connection's are. An arrival whose `notFor` names a listen's pipeline (`listenPipeline`, the same name listen-fire gives it) skips that listen.
  - **One write.** The delivery is kept in one store write (`keepDelivery`): its arrivals logged for the runs awaiting them, a work row for each run it starts, and a wait opened for each such run on each edge the fired function awaits off its parameter, and off each record the trigger's arrival carries (its `parents`), from the log's mark before the delivery's arrivals. So a later item of the same delivery (a note, then a comment on it; a ticket's question, then another comment on that ticket) answers the run's `await new`, and the arrival that started a run never answers it. Then the call starts each run from its row, from that mark, and the runs the arrivals woke step on.
  - **A run that does not start in the call is not lost.** Its row stays queued, its waits with it, and `tick` starts it once a run lease has passed since the delivery (the call has that long to start it itself). A failed write throws from `dispatch`, naming each run that did not start; a delivery with an `id` then has its id forgotten, so the provider's retry is kept again, and its receipts still run each arrival once. A run whose receipt was taken before its process died is started by its row, never stranded.
  - **Once per arrival.** A listen runs an arrival once: its receipt (`arrivalReceiptKey`: the edge, the record, the identity and the version) is taken in the write that starts the run, so a provider's redelivery runs nothing, said through `log`. A delivery under an `id` already kept (the provider's delivery id) runs nothing at all.
  - **What a listen could not judge is answered.** `dispatch` answers `{ runs, notJudged }`. Each entry of `notJudged` is an arrival a listen's judge could not decide (a field its module could not read, a record the arrival does not carry, a record that does not state its record type): `{ program, movement, pipeline, arrival, edge, identity, recordId?, reason, deliveryId }`, the fact listen-fire keeps as `Arrival Not Judged`. It ran nothing for that listen; alert on it, or deliver the arrival again once its cause is mended.
  - **What it refuses.** A delivery it cannot route throws, naming why, and keeps nothing: from a module the host was not given, for a `connection` the tenant does not hold (or, naming none, from a module the tenant has no connection of), with an arrival that does not parse, or with one that names no `key` on an edge that is no root of the module's schema (a wait on the record it landed on would never hear it).
  - **What runs nothing, said once per delivery** (the `log` option): an arrival the judge cannot decide (above); one that fits no node the listens on its edge state (`listen to stripe-[:Requests]-><Payment> fire paid` runs only on an arrival whose fields fit `Payment`), as listen-fire says it; a listen this host does not fire as written, when your store holds one all the same (an authoring tool's save, or a store written by hand); and a program it cannot read (saved before 0.13 without its listens' plans, or pinned to a release this one refuses), with the remedy: save it again. The tenant's other programs run regardless.
  - **What it does not do, unlike listen-fire.** There is no loop breaker: a listen whose run writes what it listens to fires again on what it wrote. A listen whose earlier hop only listen-fire lists members for is refused, not re-resolved.
- **`run(tenant, { program, text? })`.** Runs one movement now: an Invocation lands on the run host's manual unit (`listen to manual-[:Invocations]-> fire f`), `text` its `Text`.
- **`tick(now?)`.** Starts every run a delivery queued that its `dispatch` did not, and steps on every parked run whose timer is due, and every run an arrival woke. It first forgets the logged arrivals no live wait reads and no running step could still read, and the identities whose module's re-send window has passed, so the log does not grow without end. Call it from a scheduler. The mark a run's first segment reads its waits from is held in the process running it, not in the store: with several processes on one store, sweep from one process only, the one that dispatches, or a sweep elsewhere may forget an arrival that run was about to wait on.
- **The catalog** is built per tenant from its connections, by asking each module its entry points and describing each one, and kept until the tenant's connections change. When a tenant's schema changes another way (a field added in your product), call `schemaChanged(tenant)`.
- **An outcome** is `{ runId, tenant, program, movement, outcome }`: `outcome` is `{ ok: true, writes, spentMicrodollars, parked }` or `{ ok: false, error }`.

Options beyond `modules`:

| option | default | what it is |
|---|---|---|
| `store` | in memory | Connections, saved movements, run records, and the run host's store (`RunHostStore`, for parked runs). Over your database, each is a table; the run host's store must pass the contract suite in `public/testing`. |
| `secrets` | in memory | Your vault: a `SecretsBackend` (`public/secrets`) with a `put` to store a new credential. |
| `engine` | none | The engine's other slots: models (`llm`), files, write locks, a trace (section 4). |
| `limits` | the engine's | Each run's limits and cost cap (section 5). |
| `now` | the wall clock | The clock runs read and timers are due by. |
| `moduleHost` | quiet log, no files, state in memory | What a loaded module's context holds besides its tenant and credential. |
| `log` | the console's warnings | Where the host says what it did not run: an arrival a listen's judge could not decide. |

The example, `examples/embed-saas/src/embedding.ts`, is this and nothing else: a customer connects its CRM and, optionally, Slack, and its HTTP routes call `save`, `dispatch` and `tick`.

## 3. The parts underneath

The embedded host is built from the engine's public parts, for a host that needs another shape:

- **Load a module:** `adapterInProcess(module, context)` (module kit), with `secretsCredential` for its credential and `memoryKv` for its state.
- **Build a catalog:** `introspectAdapter(adapter, manifest)` per connection, then `buildCatalogSnapshot` (`public/catalog`), each schema keyed by its connection's name.
- **Check and save:** `checkAnswerInRust({ source, catalog, languageVersion: ENGINE_VERSION })` throws `MovementEngineError` (`MOVENG_CHECK`, `MOVENG_PARSE`, `MOVENG_LANGUAGE_VERSION`) when the movement does not check; `listenPlansOf(answer)` reads the plan of each listen.
- **Route an arrival:** `plannedListensOf({ file, program, plans })` names each listen (`listenPipeline`) and reads its connection's credential; `listenFires(listen, arrival, { adapterType, credentialName }, nowMs)` (`public/inbound`) is the whole routing rule: null when the arrival is not the listen's to judge, else the judge's verdict (`{ fires: true }`, `{ skips, reason? }` with a reason when the arrival is of another record type, `{ undecided }`); `arrivalTriggerOf` turns the arrival into the run's event: its landing, carried parents, `about` and `actor`, stamped with its `occurredAt`. In a Rust embedding (`listen-fire-engine`), `RunInput::new` takes an `Arrival` (`Arrival::new(adapter, edge, Landing::new(recordType, fields))`, then `.by(Actor::new(id, scheme))`, `.about(..)`, `.occurred_at(..)`); `Adapters::acting_user` is handed the event, whose `arrival.actor` names who acted.
- **Run:** `runMovement({ source, languageVersion, movementName, event, teamId, catalog, credentialIds, limits, costCapMicrodollars, host })`, over `inProcessHost` (`public/embed`).
- **Park and resume:** `runParkHost` for each segment's parks, waits and wakes (its `sink`, `waits` and `wake` are the engine's `park` group); `drainDueTimers` under the run's lease (`withRunLease`) and `armTimerWake` for its next timer; `logArrivals` for what a module says arrived (the log and its `wake_await` rows in one write), `sweepArrivals` on your schedule to forget what no live wait reads and no running step could still read (without it the log only grows), `wakeWait` for each of those rows, and `drainOwedRaces` for each `settle_race` row (`public/run-host`). A row whose drain lost the run's lease (`wakeWait`'s `busy`, a drain's `leaseLost`) goes back due rather than done: the leaf it claimed is parked again for the run's next holder, and only that row's retry steps it on. Step only a run that is still parked, read again under its lease (one that ended steps nothing, and its timer row is not armed again; one not yet marked parked retries). A step that ends its run answers the run's settle (`StepOutcome`'s `settle`), and the drain writes it in that step's end, so a crash never leaves a run parked with nothing left to wake it. A row released because its run was held elsewhere, or never stepped, is released `busy` (`WorkQueue.release`'s `why`), which a store that counts attempts does not count. Each park is its own write as the engine makes it: unlike listen-fire's run host, this one does not hold a segment's parks to its end. Each step ends in one write (`parks.commitSegment`) that finishes the leaf it resumed and owes the races its arm won, so a drain that dies before settling a race leaves it to the run's next.

## 4. The host's slots

`lf.yaml`'s `core:` section has ten slots ([core slots](core-slots.md)): models, judge, store, files, limiter, browser, wake, ocr, secrets and movements. An embedded engine has the first four; you fill each with your own part (`engine` on the embedded host, or `inProcessHost` directly). The rest belong to listen-fire's run host.

| slot | what a run asks of it | how you fill it |
|---|---|---|
| models | `ai(…)` and `extract(…)` calls | `llm: pricedModels({ client, extractCall })`. A client answers `{ parsedJson }` and may report what it cost. The Anthropic clients are `makeAnthropicLlmClient` and `makeAnthropicExtractCallClient`, over `anthropicClient`, all from `@listen-fire/anthropic` (the models slot's module for Claude, which also holds the price table). |
| judge | whether a written record is one already there, when the rules alone cannot tell | `llm.arbitrateEntities`. Absent: such a write fails, naming it. |
| store | parks: `await`, `sleep` | The embedded host's `store`. `memoryRunHostStore` holds parked runs for one process; a store that must outlive a restart implements `RunHostStore` over your database and must pass the contract suite in `public/testing`, and the waits cases every store runs (`storeWaitsCases`, there too, with the run rows listen-fire's stores keep beside it, `RunRowStore`). The embedded host's `runHost` serves more: a delivery's one write (`keepDelivery`, `DeliveryRowStore`), its run rows done once they ran (`completeKey`) and its provider id forgotten when they did not (`forgetDeliveryId`); and a run an arrival starts with its receipt and its run row, what it started with (`startArrivalRun`, `ArrivalRunStore`: false, and no run, for a receipt its team took before). The store keeps library texts too (`sources`: a text kept once under its hash, read back by it). In a Rust embedding (`listen-fire-engine`), `Store` requires `save_source` and `load_source` the same way: an implementation that omits them does not compile. A run that awaits an adapter's listenable edge also needs the store's waits (`wait_mark`, `open_wait`, `wait_arrivals`, `note_arrival`, `commit_wait_park`, `wake_wait`: an arrival log and a wait per run and record, as listen-fire's run host keeps them, docs/contracts/host-families.md `park.waits`); a store that keeps parks without them fails such a run where the awaited record enters it (the mark is taken before the record's write or read), not at the await. Hand a run started by a delivery its mark (`RunInput.trigger_mark`) so its trigger's waits read what arrived since. |
| files | reading a file's text, rendering a file | `files.resolveFileText` (`@listen-fire/file-text` reads PDFs, decks and sheets), `files.render`. |

Two more pieces are yours and have safe defaults:

- **Secrets.** One entry per connection, never shared between tenants. `createMemoryVault` (`public/secrets`) is the in-memory one; a real vault implements `SecretsBackend` (resolve, write back at a version, a lock), and the contract cases in `public/secrets-testing` hold it. The embedded host refreshes an OAuth 2 credential by its module's declaration, with the credential's own `client_id` and `client_secret`: before a call when it is about to expire, and when the provider refuses its token, one refresh at a time. Loading a module yourself, `secretsCredential` (module kit) takes `oauth2: { declaration, client }` for your own app at the provider.
- **Write locks.** Two runs writing the same record take turns. The default is in memory, which holds within one process; across processes, supply `locks` over your database.

## 5. Limits and the cost cap

A customer's movement is code you did not write. Set every limit, and a cost cap on every run: the embedded host's `limits` takes all of them, flat, and puts them on each run's input.

- **`limits`** on the run's input: steps (statements and expressions, the CPU bound), one text's size, one collection's size, and the result's size. Past one, the run fails with `MOVENG_LIMIT_STEPS`, `MOVENG_LIMIT_TEXT_SIZE`, `MOVENG_LIMIT_COLLECTION_SIZE` or `MOVENG_LIMIT_RESULT_SIZE`. Nothing in the movement can catch it. Absent, each is the engine's default, which is generous.
- **`costCapMicrodollars`** on the run's input: the most the run may spend on model calls and priced plugins. Past it, the engine refuses the next priced call itself. One call already under way may overshoot by its own cost.
- **`maxSegmentSeconds`** on the run's input: how long one segment may take, waits on your host included (default 900, or `MOVEMENT_MAX_SEGMENT_SECONDS`). The engine reads no clock, so the host keeps this one. Past it, the calls already at your host finish, nothing more is asked, and the run fails with `MOVENG_LIMIT_WALL_CLOCK`.
- **Calls your modules make are not priced.** A module that pays for a service counts against the cap only if it reports its cost.

The full table is [docs/contracts/run-limits.md](contracts/run-limits.md).

## 6. One tenant cannot reach another

- Every run names its tenant, and the host answers every call for the tenant of the segment it was made in.
- A tenant's catalog holds that tenant's connections only, and each credential is kept under an id of its own.
- Before it builds an instance for the credential a run names, the host asks whether that credential is the run's tenant's; one that is not is refused (`CredentialNotTenants`). The embedded host answers from the tenant's connections. On `inProcessHost` directly, you answer (`credentials.belongsTo`), and a host told nothing refuses every run that names one.
- A movement reaches the network only through modules. The engine has no network code, and no family takes a URL from a movement.

## 7. Serving the authoring tools

An agent (Claude, or any MCP client) can author your customers' movements for them: read the handbook, see the customer's systems and fields, save a movement (checked first), fix it, and run it. `@listen-fire/authoring-mcp` serves those tools over MCP. You mount one handler; it asks you which customer each request is for.

```ts
import { createAuthoringHandler } from '@listen-fire/authoring-mcp';

const authoring = createAuthoringHandler({
  // Your own auth, on every request, before any tool is listed.
  tenant: async (request) => {
    const tenant = customerOf(request);
    if (tenant === undefined) return { ok: false, status: 401, message: 'sign in first' };
    return {
      ok: true,
      tenant: {
        catalog: async ({ fresh }) => ({ snapshot: await host.catalog(tenant), connections: await connectionsOf(tenant) }),
        programs: programStoreFor(tenant),
        runs: runsFor(tenant), // optional: without it, the four run tools are not offered
      },
    };
  },
});

http.createServer((req, res) => void authoring(req, res));
```

- **The handler.** Streamable HTTP, no sessions: each request is answered on its own. Mount it at any path, for POST, GET and DELETE.
- **The tenant.** `tenant(request)` runs first, every time. It returns that customer's functions, or a refusal with a status; a refused request sees no tools. The package is handed one customer's functions per request, so it has no way to ask about another.
- **The catalog.** What `host.catalog(tenant)` returns, and the customer's connections with the system each serves. `fresh: true` asks for the schema as it is now (describeConnection asks, so a field the customer just added shows).
- **The programs.** List, get by id or by name, save and delete. A save carries the revision the agent read (`revisionOf`, the sha256 of the text): refuse it, in the same atomic step as the write, when the stored text's revision differs, and return the stored program. A save also carries the plan of each listen the text declares (`listens`), so you can route arrivals without checking it again.
- **The runs (optional).** Start a run of one program on text or files (with a request id, so a retry returns the first run), read its status, list a program's runs, and read its trace. On the embedded host, `run(tenant, { program, text })` fires a program's `listen to manual-[:Invocations]->`.
- **Also optional:** a checker of your own (the default is this release's), a deeper describe from live adapter calls (the default answers from the catalog snapshot), handbook chapters for your own systems, tools of your own, and one paragraph of instructions.

The package does the rest: the handbook and its search, the digest of the customer's systems, the check (a save is refused while it has errors, unless the agent passes the user's consent), and diagnostics that name the handbook section showing the fix. The tool names and descriptions are the hosted product's, so an agent or skill written against one works against the other.

The example mounts it at `/customers/:tenant/mcp`, the customer's API key as a bearer token (`src/authoring.ts`, `test/authoring.test.ts`: getStarted, a save refused with `MOV_ENUM_UNKNOWN_VALUE`, the fix through `editAutomation`, a run and `checkRun`).

## What the example leaves out

- Parks that outlive the process. The example uses the embedded host's in-memory store; a restart forgets its connections, movements and parked runs.
- A real vault and a database for write locks.
- Arrivals off a provider's webhook: the example's CRM reports each company it creates (`companyArrived`); no module of its reports arrivals from outside.
- Real auth on the MCP endpoint: the customer's API key stands in for it.
- The live Anthropic path is wired (`ANTHROPIC_API_KEY`) but the test uses the fake model.
