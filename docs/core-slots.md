# Core slots

The engine and the run host's rules are fixed. What they lean on is not: it is a module in a slot, chosen per project in `lf.yaml` under `core:`.

```yaml
core:
  store: "@lf/postgres-store"   # a slot omitted keeps its default
```

## The slots

| slot | what it is | default | other built-in |
|---|---|---|---|
| `models` | the model calls a run makes: `ai(…)`, `extract(…)` | `@lf/anthropic` | none in lf; `@listen-fire/models` fills it with Gemini, OpenAI or Claude on Vertex |
| `judge` | settles whether a written record is one already there, when the rules cannot | `@lf/judge` (declines every question, so an ambiguous match creates a new record) | |
| `store` | where run state lives: runs, parks, callbacks, work to drain | `@lf/sqlite-store` (`.lf/state.db`) | `@lf/postgres-store` |
| `files` | where documents a run stores are kept | `@lf/local-files` (`.lf/files/`) | |
| `limiter` | keeps calls to modules and models inside the providers' limits | `@lf/memory-limiter` (in lf's own process) | |
| `loopGuard` | tells a movement's own write echoing back from a real change | none: the slot is empty and nothing is suppressed | `@lf/fingerprint-guard` (opt in) |
| `browser` | a real page a module drives: a gated deck, a viewer that draws with script ([browser-slot.md](contracts/browser-slot.md)) | none: lf has no browser, and a module asking for a page is refused by name | none in lf; the platform's api image fills it with `@lf/chromium` |
| `wake` | told when work is due, so whatever starts lf's workers starts one then ([wake-slot.md](contracts/wake-slot.md)) | none: nobody is told, and work waits for a scheduled `lf drain` | none in lf; `@listen-fire/wake-cloud-tasks` starts a Cloud Run job through Google Cloud Tasks ([its README](../modules/wake-cloud-tasks/README.md)) |
| `ocr` | the text of a scanned PDF or an image, for `extract(…)`, `File.read` and a plugin's `ctx.ocr` ([ocr-slot.md](contracts/ocr-slot.md)) | none: a file with no text layer is unreadable, saying the slot is empty | none in lf; `@listen-fire/document-ai` (Google Document AI) and `@listen-fire/models` on Gemini fill it |
| `secrets` | where credentials are kept: the ones a movement imports, each module's install, each core module's settings | `@lf/file-secrets` (the secrets file, plain or SOPS, and its lock file) | none in lf; a vault module (the platform's credential store, a cloud secret manager) fills it |
| `movements` | the project's movement files, by name | `@lf/folder-movements` (the movements folder `lf.yaml` names) | none in lf; the platform's per-tenant store fills it |

A slot accepts only a module of its own kind; `lf check` and `lf run` refuse anything else, naming the slots.

## Units: `cron` and `manual`

Two sources are the run host's own, not modules: every host has them, and a movement listens to them with no import and no `connect`.

```
function digest(t: <cron-[:Tick]->>) { … }
listen to cron { schedule: "0 9 * * 1", timezone: "Europe/London" } fire digest

function backfill(run: <manual-[:Invocation]->>) { … }
listen to manual fire backfill
```

- `manual` fires when you ask: `lf run backfill` here (`--text "…"` gives the Invocation its `Text`), "Run now" on the platform.
- `cron` fires on its schedule. `lf serve` and `lf drain` fire each due tick. A tick that came due while no worker ran fires once on the next drain (only the latest one missed), however many workers drain the store.

## Polled sources

A module with no webhooks declares `poll: { intervalSeconds }` in its manifest. The host then polls it for each listen on it:

- `lf serve` polls each listen on the module's interval; `lf drain` polls whatever is due.
- A poll missed while no worker ran is one poll on the next drain.
- The store keeps each listen's checkpoint, the module's own bookmark, so the next poll asks for what is new since it.
- One worker at a time polls a listen, however many drain the store (the poll is a row in the store's work queue, held under its lease).
- Each event runs the listen as a webhook's event does. An event the listen has run before (the same `idempotencyKey`) runs nothing.
- A listen sets its own interval with `every: <duration>` (`listen to feed { every: 5m } fire seen`); without it, the module's interval applies. The older spelling, `pollIntervalSeconds: 300`, is refused with the rewrite.
- `lf run --poll <movement>` polls now, once.

## The limiter

Before every call to a module and every model request, the host asks the limiter slot. The call waits until it is granted.

- A module declares its provider's limits in its manifest. Each counts per credential, per module, per install or per team:

  ```json
  "limits": [
    { "scope": "credential", "calls": 100, "per": "10s" },
    { "scope": "module", "concurrent": 4 }
  ]
  ```

- An answer may carry `retryAfter` (seconds): the provider asked for quiet. Every call as that credential then waits that long.
- `@lf/anthropic` declares its own limit: 8 requests in flight at once, held through each request's retries.
- `@lf/memory-limiter` keeps the limits in one lf process. Two lf workers draining one store each keep their own count.
- A limiter shared by all your workers is a module filling the slot over [its wire](contracts/limiter-slot.md). Name it in `core:`, like a store module.
- The engine never sees a limit. A movement means the same under any limiter; it only waits longer.

## The secrets module

Every credential lf reads, refreshes and writes goes through the secrets slot. The wire a module of your own speaks, and the cases it must pass: [secrets-slot.md](contracts/secrets-slot.md).

- `@lf/file-secrets` is the secrets file as it always was: `LF_SECRETS_FILE`, else `.lf/secrets.yaml`, else `~/.config/lf/secrets.yaml`; a SOPS file is read with `sops -d`. A refreshed token is written back in place, comments kept. Two lf processes take turns through the file's lock file.
- A module filling the slot holds them instead, over its wire: lf lists what it holds, reads and writes one back by version, and takes a lease on one while a refresh spends its token. Two lf processes on one module refresh a token once between them.
- `LF_SECRET__<CREDENTIAL>__<FIELD>` lies over what any module holds, field by field.
- An entry made from the environment names its owner as the file does. `LF_SECRET__<ENTRY>__EXTERNAL=<module>` is a hand-written entry (`external:`): a credential, which a connection names with `using`. `LF_SECRET__<ENTRY>__MODULE=<module>` is that module's install (`module:`): its server secret and its settings, as `lf connect` writes them. So a separately run adapter's key can come from the environment alone: `LF_SECRET__SYSTEM__MODULE=system` with `LF_SECRET__SYSTEM__KEY=…`, and `connect system` needs no `using`. Setting both for one entry is refused.
- `lf connect`, `lf credential` and a webhook's registration write whole entries through the module.
- A module that cannot persist (its credentials come from somewhere lf cannot write) answers those writes `read_only` with a reason. lf then refuses, exit 2, writing nothing: `<module> holds its credentials read-only: <reason>. Add it where it lives.` A webhook's registration adds `Register the webhook where the credentials live.` A token refresh is still written back; read-only is for whole entries only.
- `lf credential add` and `update` ask the module whether entries can be changed (`secrets.assertWritable`) before the provider's sign-in, so a read-only module refuses before the person is sent anywhere.
- A secrets module's own settings never come from itself. They come from `LF_SECRET__…` or the secrets file, so run `lf connect <module>` before naming it in `core:`. A project naming a secrets module whose settings neither holds is refused as it loads.
- Refreshing a token stays in lf. A module only stores.
- Signing in for a credential against a provider (`lf credential add`) runs in lf whichever module stores the result, and the provider's OAuth app must have lf's redirect URI registered. Under `--public` that URI is `<publicUrl>/oauth/callback`, answered by `lf serve`. When something else holds the registered callback (a platform in front of the fleet), set `oauth: { redirectUri: https://… }` in `lf.yaml`: lf sends that URI at authorize and at the token exchange, and the relay forwards the provider's `code` and `state` query on to `lf serve`'s `GET /oauth/callback`, which matches the waiting command by `state`. `lf connect` prints the URI to register.
- In a cloud deployment the module and its settings come from the environment, never a file: `core: { secrets: <module> }` in `lf.yaml`, `LF_SECRET__<MODULE>__EXTERNAL=<module>` and its settings as `LF_SECRET__<MODULE>__<SETTING>` ([deploy/lf](../deploy/lf/README.md#the-secrets-module)). The credentials themselves then live in the module, and `LF_SECRET__<CREDENTIAL>__<FIELD>` still lies over them.
- `lf --contract-secrets-slot --dir <project>` serves the project's secrets slot as a module for the conformance cases, as `--contract-wake-slot` does for the wake slot.

## The movements module

Every movement file lf reads goes through the movements slot. The wire a module of your own speaks, and the cases it must pass: [movements-slot.md](contracts/movements-slot.md). `lf.yaml` and the externals folder stay local files: `lf.yaml` is what names the slots.

- `@lf/folder-movements` is the movements folder `lf.yaml` names, read as it always was: every `.mvt` under it, each folder's entries in sorted order, folders depth first. With no `core: { movements: … }` nothing is different.
- A module filling the slot answers the files by their path under that folder (`orders/sync.mvt`): lf lists them, then reads each. No movements folder need exist on disk; messages still name each file as if it were in it. lf sorts the list itself, to the order of the walk.
- lf reads the files when a command opens its project. A file whose listed version lf already holds is not read again, so one command reads each file once. `lf serve` and `lf drain` follow the module's `movements.watch` events (the folder module uses the OS file watcher) and read only what moved; a module that does not answer `watch` is refused by name. `LF_MOVEMENTS_REFRESH_MS` (default 5000) is only the pause after a module that answers at once with no events.
- A refresh picks up changed, added and removed files and starts any new external they import, after checking the new set. An external no file imports any more leaves the set, and its process stops once the runs begun before the refresh are done with it. A set that does not check is kept out, its diagnostics printed once, and the running one stays. Under `lf serve`, a module's webhook follows the refresh: registered for the events the new listens name, removed once none needs it.
- `lf upgrade` and `lf init` write movement files through the module, by version. A file changed since lf read it is reported and left (`changed since lf read it; nothing written`), and `lf upgrade` then holds the project's pin. `lf init` writes its starter only when `lf.yaml` already names a movements module; otherwise it makes the folder as ever.
- A module that keeps the files where lf cannot change them answers the write `read_only` with a reason. `lf upgrade` and `lf init` then refuse, exit 2, writing nothing: `<module> holds the project's movements read-only: <reason>. Change them where they live.`
- A movements module's own settings never come from the secrets slot. They come from `LF_SECRET__…` or the secrets file, so run `lf connect <module>` before naming it in `core:`. A project naming a movements module whose settings neither holds is refused as it loads.
- lf has no tenant. A platform running lf for a tenant starts it per tenant and sets the tenant per process, `LF_SECRET__<MODULE>__TENANT=<id>` beside `LF_SECRET__<MODULE>__EXTERNAL=<module>`. The module declares `tenant` among its settings, lf sends the settings on every request, and the module scopes each call. In a cloud deployment the module and its settings come from the environment ([deploy/lf](../deploy/lf/README.md#the-movements-module)).
- `lf --contract-movements-slot --dir <project>` serves the project's movements slot as a module for the conformance cases, as `--contract-secrets-slot` does for the secrets slot.

## The loop guard

A movement that writes to the source it listens to hears its own write come back. By default nothing stops that: the echo runs the movement again. Name a guard to stop it:

```yaml
core:
  loopGuard: "@lf/fingerprint-guard"
```

- After a run writes a record to a source that sends webhooks or is polled (and can read a record back), the host reads the record back and tells the guard.
- An event naming a record is asked of the guard; if it is the echo of that movement's own write, none of that movement's listens fire.
- `@lf/fingerprint-guard` remembers a hash of the record as the write left it for an hour. While the record still hashes the same, the event is the echo. Someone else's edit changes the record, so it runs. Another movement's listens hear the write as usual.
- Its memory is a file of its own (`.lf/guard.db`), or a Postgres database every worker shares (`url` setting, `lf_guard` schema). It is not in the store slot.
- The platform's listen flag `suppress_self` is separate and unchanged.
- The wire a guard module of your own speaks: [loop-guard-slot.md](contracts/loop-guard-slot.md).

## The wake

On a scale-from-zero platform no worker runs between jobs. The wake slot tells a module when lf's work is due, so it can start a worker (`lf drain --until-idle`) then:

```yaml
core:
  wake: acme_wake
```

- lf tells it "ready now" when it queues an event or a wake, and "ready at T" when it parks a timer or schedules a poll or a retry.
- lf calls it after the work is written. A failed wake is logged and the work stays queued, so keep a scheduled worker (every minute) as the safety net.
- Pair it with `lf serve --doors-only`: the doors queue what arrives, and the wake starts a worker for it.
- lf builds none in. A module filling it speaks [its wire](contracts/wake-slot.md), and the conformance cases there hold it to the slot's meaning.
- `@listen-fire/wake-cloud-tasks` fills it on Google Cloud: each wake becomes a Cloud Tasks task that starts a Cloud Run drain job ([its README](../modules/wake-cloud-tasks/README.md)). With it, the scheduled worker becomes an hourly safety drain.

## OCR

A deck of screenshots compiled into a PDF has no text of its own. Name an OCR module and `extract(…)` reads it with no change to the movement:

```yaml
core:
  ocr: document_ai
```

- lf reads a born-digital PDF's own text first. Only a PDF whose text layer is too thin (fewer than 50 non-whitespace characters a page, so page numbers stamped on a scan do not count) goes to the slot. An image always does.
- `@listen-fire/document-ai` is the platform's own Google Document AI reader ([its README](../modules/document-ai/README.md)): install it as `externals/document_ai`, `lf connect document_ai`. A long file needs its `bucket`.
- `@listen-fire/models` reads files on Gemini as a second install entry, `models_ocr` ([its README](../modules/models/README.md#reading-scanned-files-the-ocr-slot)).
- Every read reports its cost, which counts against `maxRunCostUsd` as a model call does; a module that publishes its price per page has a read the run cannot afford refused before it is made.
- A plugin lf starts asks the slot through `ctx.ocr` (`@lf/web` reads the PDFs a dealflow message links to this way).
- With the slot empty, a scanned file is unreadable and says why; nothing is guessed.

## Filling a slot

1. Name the module in `lf.yaml`'s `core:` (not needed for a default).
2. Run `lf connect <module>`. It asks for the module's settings, keeps them in your secrets file, and runs the module's setup (the Postgres store creates and migrates its own `lf` schema).

```
lf connect                        # lists the modules lf knows, and which are set up
lf connect @lf/anthropic          # asks for api_key, and base_url for another Messages API endpoint
lf connect @lf/postgres-store     # asks for url (postgres://…?sslmode=verify-full), creates the schema
```

Settings sit under an entry named after the module without its scope (`@lf/postgres-store` is `postgres_store`). In containers and CI set them as environment variables instead of keeping a file:

```
LF_SECRET__POSTGRES_STORE__EXTERNAL=@lf/postgres-store
LF_SECRET__POSTGRES_STORE__URL=postgres://…?sslmode=verify-full
```

`lf --store <state.db | postgres://…>` overrides the store slot for one command.

## Models on another vendor

`@listen-fire/models` fills `models` with Gemini (a Gemini API key, or Google Cloud), OpenAI, Claude on Anthropic's API or Claude on Vertex, so a project needs no Anthropic key ([its README](../modules/models/README.md)). Install it as `externals/models`, name it (`core: { models: models }`), and `lf connect models` asks for `vendor` and its credentials.

- A movement keeps its model names (`sonnet`, `claude-opus-5`); the module sends each to its vendor's model the way the platform's `MODEL_MAP` does. Every name goes to one model (`model`, default `gemini-3.8-flash` or `gpt-5-mini`) unless `model_map` sends it elsewhere.
- Every answer is priced from the shared price table, and the module publishes its prices, so `maxRunCostUsd` counts its calls and lf refuses a call whose prompt alone costs more than the run has left.
- The judge needs no key either: `@lf/judge` asks no model, and `@listen-fire/judge-llm` (installed as `externals/judge_llm`, `core: { judge: judge_llm }`) asks lf for its model calls, which go to whatever fills `models`.

A module of your own, started from its `command` or reached at its `url`, fills any slot (`kind: core` in its `lf-external.yaml`; see each slot's wire in [the contracts](contracts/README.md), such as [the store's](contracts/store-slot.md), [the files slot's](contracts/files-slot.md) or [the wake's](contracts/wake-slot.md)). `@listen-fire/s3-files` fills `files` with a bucket on AWS S3, Google Cloud Storage, Cloudflare R2 or MinIO ([its README](../modules/s3-files/README.md)).

## Embedding

An embedded engine has four of these slots (models, judge, store, files); you fill each with your own part of the host. The limiter, loop guard, browser, wake and ocr slots are lf's (an embedder's file-to-text is its own, OCR included). See [`embedding.md`](embedding.md#5-the-host-filling-the-slots).
