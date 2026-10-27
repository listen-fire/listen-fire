# Embedding the engine

Your product can let its customers write movements and run them inside it. The engine runs in your own Node process, as WebAssembly: no server of ours, no network of its own. You give it what it needs: your product as a module, a place for each customer's secrets, the models it may call, and the limits it must keep.

A working example is in [`examples/embed-saas`](../examples/embed-saas): a small HTTP app where a customer saves a movement, the app checks it, and the app's own event runs it. Its tests run it end to end, with customers whose schemas differ and a ready-made module loaded for each.

## The packages

| package | what it is |
|---|---|
| `@listen-fire/engine` | The engine and its host contract. Reached only through its public entries, `@listen-fire/engine/public/<entry>`. |
| `@listen-fire/engine-contracts` | The data the engine is handed: a run's input, the tenant id, the event, the parked state, the module protocol. |
| `@listen-fire/module-kit` | How a module is defined (`defineModule`) and loaded, in your process or served as a process. |
| `@listen-fire/movement-lang` | The language: parser, checker, catalog types. The engine depends on it. |
| `@listen-fire/model-providers` | Chat vendors beyond Anthropic (OpenAI, Gemini, Claude on Vertex): the models slot. Optional. |
| `@listen-fire/embedding-providers`, `@listen-fire/image-providers`, `@listen-fire/transcription-providers` | Embeddings, image generation and transcription over OpenAI and Gemini, each its own package on `model-providers`' host type. Optional. |
| `@listen-fire/files-s3` | The files slot over S3 or any S3-compatible service. Optional. |
| `@listen-fire/ocr-google` | Scanned-PDF text through Google Document AI, for `file-text`'s `ocrPdf`. Optional. |
| `@listen-fire/file-text` | A file's text: PDF, decks, spreadsheets, audio. The file-reading slot's default module; leave it out and an `extract` over a file is refused by the file's name. Optional. |
| `@lf/<name>` | Ready-made modules: `@lf/attio`, `@lf/slack`, `@lf/google-sheets`, `@lf/web`, and the rest. |

Every package has the same version as the engine. The TypeScript engine is not part of the kit: the kit runs the language of its own release, which is also the pin a movement is saved with (`ENGINE_VERSION`). Node 22 or later. With TypeScript, use `moduleResolution` `node16`, `nodenext` or `bundler` (plain `node` works too, through the packages' `typesVersions`).

```sh
npm install @listen-fire/engine @listen-fire/module-kit
```

The public entries of `@listen-fire/engine` you will use:

| entry | for |
|---|---|
| `public/embed` | `createEmbeddedHost`: the whole host, from connections to parked runs. Underneath: `inProcessHost`, `introspectAdapter`, `collectFileListeners`, `pricedModels`, `MovementEngineError` |
| `public/catalog` | `buildCatalogSnapshot`: what a customer's movements are checked and run against |
| `public/movement-engine` | `runMovement`, `resumeMovement`, `checkPinnedInRust`, `parsePinned` |
| `public/inbound` | `listenerHearsDelivery`, `triggerEventOf`: from your event to a run |
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
- **A run that waits parks.** `await sleep(1h)` stores the run; a tick past its wake steps it on.

`createEmbeddedHost` (`public/embed`) does all of this. You write your module (its `describe`, its reads and writes), hand the host your events, and call its tick from a scheduler.

## 1. Your product as a module

A movement reaches your product through a module: an adapter over your own data. Define it once with the module kit.

```ts
import { defineModule } from '@listen-fire/module-kit';

export const crm = defineModule({
  kind: 'adapter',
  name: '@acme/crm',                     // answers to adapter type `crm`
  manifest: { adapterType: 'crm', displayName: 'CRM', supportedTriggers: ['webhook'], methods: [...], subscribableEvents: ['company.created'], declaredCredentials: ['crm'], introspectedSchema: true },
  credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] }],
  create: (ctx) => crmAdapter(ctx),      // the adapter methods, over ctx.config.tenant
});
```

`describe` answers for the tenant the module was loaded for (`ctx.config.tenant`), so each customer's schema can differ: one customer's `Stage` a select of `Lead | Customer`, another's `Prospect | Partner`. A value outside the customer's options is refused when its movement is saved (`MOV_ENUM_UNKNOWN_VALUE`). See `examples/embed-saas/src/crm.ts`.

## 2. The embedded host

```ts
import { createEmbeddedHost, pricedModels } from '@listen-fire/engine/public/embed';
import { slackModule } from '@listen-fire/slack';

const host = createEmbeddedHost({
  modules: [crm, slackModule],
  engine: { llm: pricedModels({ client: models }) },
  limits: { maxSteps: 100_000, costCapMicrodollars: 50_000 },
});

await host.connect('acme', { name: 'workspace', module: crm, credential: { api_key } });
await host.connect('acme', { name: 'slack_workspace', module: slackModule, credential: { accessToken } });

await host.save('acme', { name: 'welcome', source });    // { saved: true, listens: 1 } or { saved: false, problems }
await host.dispatch('acme', { adapterType: 'crm', event }); // one outcome per run it started
await host.tick();                                          // one outcome per parked run it stepped on
```

- **`connect(tenant, { name, module, credential })`.** `name` is what the customer's movement imports (`import { workspace } from credentials`). The credential is kept in the host's secrets, under an id only that tenant's runs may name; the module is loaded once per connection, its context built for you.
- **`save(tenant, { name, source })`.** Checks the movement against the tenant's catalog and keeps it, pinned to this release (`ENGINE_VERSION`), with its listens read off the source.
- **`dispatch(tenant, { adapterType, connection?, event })`.** Runs every listen of the tenant's saved movements that hears the event: a listen on that module, whose `events` (and Airtable's `table`) admit it. With `connection`, only the listens on that connection hear it, as lf and the hosted product route; without, it is the module's own event and every connection's listens hear it. `event` is your product's event (`{ payload, externalId, eventType, recordType, … }`).
- **`tick(now?)`.** Steps on every parked run whose timer is due. Call it from a scheduler.
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

The example, `examples/embed-saas/src/embedding.ts`, is this and nothing else: a customer connects its CRM and, optionally, Slack, and its HTTP routes call `save`, `dispatch` and `tick`.

## 3. The parts underneath

The embedded host is built from public parts, for a host that needs another shape:

- **Load a module:** `adapterInProcess(module, context)` (module kit), with `secretsCredential` for its credential and `memoryKv` for its state.
- **Build a catalog:** `introspectAdapter(adapter, manifest)` per connection, then `buildCatalogSnapshot` (`public/catalog`), each schema keyed by its connection's name.
- **Check and save:** `checkPinnedInRust({ source, catalog, languageVersion: ENGINE_VERSION })` throws `MovementEngineError` (`MOVENG_CHECK`, `MOVENG_PARSE`, `MOVENG_LANGUAGE_VERSION`) when the movement does not check; `collectFileListeners(parsePinned(…))` reads its listens.
- **Route an event:** `listenerHearsDelivery(listener, { adapterType, credentialName, event })` (`public/inbound`) is the whole routing rule; `triggerEventOf` turns your event into the run's event.
- **Run:** `runMovement({ source, languageVersion, movementName, event, teamId, catalog, credentialIds, limits, costCapMicrodollars, host })`, over `inProcessHost` (`public/embed`).
- **Park and resume:** `runParkSink` for each run's parks, then `drainDueTimers` under the run's lease (`withRunLease`) and `armTimerWake` for its next timer (`public/run-host`).

## 4. The host's slots

`lf.yaml`'s `core:` section has eight slots ([core slots](core-slots.md)): models, judge, store, files, limiter, loopGuard, browser and wake. An embedded engine has the first four; you fill each with your own part (`engine` on the embedded host, or `inProcessHost` directly). The rest belong to lf's run host.

| slot | what a run asks of it | how you fill it |
|---|---|---|
| models | `ai(…)` and `extract(…)` calls | `llm: pricedModels({ client, extractCall })`. A client answers `{ parsedJson }` and may report what it cost. The Anthropic clients are `makeAnthropicLlmClient` and `makeAnthropicExtractCallClient`, over `anthropicClient`, all from `@listen-fire/anthropic` (the models slot's module for Claude, which also holds the price table). |
| judge | whether a written record is one already there, when the rules alone cannot tell | `llm.arbitrateEntities`. Absent: such a write fails, naming it. |
| store | parks: `await`, `sleep`, callbacks | The embedded host's `store`. `memoryRunHostStore` holds parked runs for one process; a store that must outlive a restart implements `RunHostStore` over your database and must pass the contract suite in `public/testing`. The store keeps library texts too (`sources`: a text kept once under its hash, read back by it). In a Rust embedding (`listen-fire-engine`), `Store` requires `save_source` and `load_source` the same way: an implementation that omits them does not compile. |
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

## What the example leaves out

- Parks that outlive the process. The example uses the embedded host's in-memory store; a restart forgets its connections, movements and parked runs.
- A real vault and a database for write locks.
- Awaits and callbacks: the embedded host steps on timers only. It has no wake for an adapter's `await` or for a callback.
- The live Anthropic path is wired (`ANTHROPIC_API_KEY`) but the test uses the fake model.
