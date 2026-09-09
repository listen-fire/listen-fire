# Listen-Fire on Render

Render runs the API as one always-on web service from the image in `deploy/Dockerfile`, with a managed Postgres and a managed Redis beside it, and the web app as a second service. The API sits behind a stable hostname and is probed at `/.well-known/health-check`. `deploy/render.yaml` is a ready-made Blueprint for exactly this shape.

Read [`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) first — it is the runbook for every shape, and this guide only translates it onto Render. Everything about identity, third-party app registration and honest limitations lives there.

Render's own dashboard, plan names and settings move around. Where this guide describes something on Render's side rather than this software's, it says "as of this writing" and points you at Render's documentation, because a screenshot-level instruction here would be wrong within a quarter.

---

## The shape

| # | What | Render resource | Notes |
|---|---|---|---|
| 1 | the API and its workers | a **web service**, Docker runtime, `deploy/Dockerfile` | the only always-on process; one instance |
| 2 | the database | **Render Postgres 16** | run the roles file by hand before the first deploy |
| 3 | Redis | **Render Key Value** (Render's managed Redis) | host and port only — read the caveat below |
| 4 | object storage | not a native Render resource | the Blueprint runs MinIO as a Render web service on a disk; any S3-compatible bucket works, needed only for file features |
| 5 | the web app | a second **web service**, from `deploy/Dockerfile.web` or the Node runtime on `apps/web` | the sign-in surface and the authoring UI |

The background workers run inside the API process. There is no worker service to add, and adding one would be wrong — see "One instance" below.

## 1. The database, before anything else

Create a managed Postgres. Version 16; the composed shape genuinely needs the `pgvector` and `pg_trgm` extensions and every shape needs `citext`, because the migration set is monolithic and creates all five schemas whatever you mount.

Then run `deploy/postgres-init/00-roles.sql` against it, by hand, **before the first deploy**:

```bash
psql "$DATABASE_URL" -f deploy/postgres-init/00-roles.sql
```

This is not optional and it is not a nicety. The migration set carries 51 `GRANT … TO agent` / `TO readonly` statements, the first of them early, and a database without those two roles dies partway through the first migration having built almost nothing. The compose file mounts that file into the bundled Postgres, which runs it automatically on an empty data directory; **a managed database has no such hook.** The file's own header says the same thing.

It creates roles, so the user you run it as needs the privilege to do that. If your managed database's default user cannot `CREATE ROLE`, that is the first thing to check rather than the last — check Render's documentation for what their default database user is granted.

Extensions are created by the migration set itself, but a managed provider may require you to allow-list them first. `vector`, `pg_trgm` and `citext` are the union; check Render's supported-extensions list as of this writing before you assume.

## 2. The API service

Create a web service from your repository with the **Docker** runtime, pointing at `deploy/Dockerfile`. The build context is the **repository root**, not `deploy/` — the Dockerfile says so in its own header, and a context set to `deploy/` cannot see `package.json`.

The image runs `node build/server.js`. It listens on whatever `PORT` says and defaults to 3000, so Render's injected port works without any change from you.

**Health check path: `/.well-known/health-check`.** It answers **201**, and that is its contract, not a quirk — do not widen it and do not point the probe at a route that returns 200 instead. Render treats a 2xx as healthy as of this writing; if you ever see a platform that insists on exactly 200, that is a platform problem to solve on the platform, because this endpoint's status is pinned in code.

`/healthz/workers` is the other surface, and it is what you actually alert on: it reports every worker this deployment mounts, whether this process started it, its last tick, and a reason for any worker that is deliberately idle. It is unauthenticated and carries no free text, deliberately.

### Migrations

The compose file runs migrations as a one-shot service that must exit 0 before the API starts, so a restart never races the schema. Render has no such service, so you have to reproduce that ordering yourself. Two ways, in preference order:

**A pre-deploy command**, if your Render plan has one as of this writing (check their documentation — it is not available on every plan):

```
pnpm schema:migrate "$DATABASE_URL"
```

The migration runner takes the database as an **argument**. It does not read the ambient environment, which is why the URL is passed explicitly here and in the compose file.

**Or by hand**, from a shell on the service, before the first deploy and before every upgrade. Migrations are forward-only, applied by file name, tracked in `_migrations.migrations`. Back up before an upgrade; there is no down-migration path.

Whichever you choose, the ordering is the point: the schema must be current before the new process serves a request.

### One instance

Keep the instance count at **one**.

Running two is safe — each product's workers take a per-product advisory lock, so every background loop runs on exactly one instance — but you lose the unambiguous reading of `startedHere: false` on `/healthz/workers`. On a single instance that flag means "wedged, page me". On two it could also mean "the other instance holds the lock", and only the workers that keep a heartbeat can tell those apart.

Do not add a second service running the same image as a "worker". The workers are in the API process; a second copy would contend for the same locks and give you nothing.

## 3. Redis

Create a Render Key Value instance and point the API at it with `MESSAGE_QUEUE_REDIS_HOSTNAME` and `MESSAGE_QUEUE_REDIS_PORT`. There is no `REDIS_URL`; the code never reads one.

**Read this before you pick a Redis.** The client is constructed from a hostname and a port and nothing else — no username, no password, no TLS. A managed Redis that requires AUTH or an encrypted connection cannot be configured through these two variables. Use the provider's **internal / private-network** connection details, which on some providers are unauthenticated, and confirm that before you commit to one.

What breaks without Redis depends on what you mount. Core keeps its in-flight MCP OAuth state there, so a connect that spans a deploy fails after the user has already consented. Automations keeps the runaway-loop guard's counters there; the guard fails **open** if Redis is unreachable, so automations keep running unguarded rather than stopping — but a production process with the two variables unset throws the first time it reaches for the pool.

## 4. Object storage

Render has no native object storage, and Listen-Fire has no local-filesystem storage driver. Any file feature — an inbound email attachment, WhatsApp media, a Drive or Dropbox write, a generated document, a valuations attachment — needs an S3-compatible bucket.

**The Blueprint's default: MinIO as a Render service.** `deploy/render.yaml` runs `listen-fire-minio` — a single Render web service built from the `cgr.dev/chainguard/minio` image, storing its data on a persistent disk — and wires the API's `AWS_*` variables to it automatically (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` read MinIO's generated root credentials via `fromService`; region, bucket name, endpoint and path-style are literals). This is a single-node service: Render disks don't support zero-downtime deploys or horizontal scaling for the service that owns them, which is fine here because it isn't the API's always-on process. Render's automatic disk snapshots are the backup story for it.

**The bucket does not create itself.** Once `listen-fire-minio` is deployed, create the bucket the Blueprint expects, once, using [`mc`](https://min.io/docs/minio/linux/reference/minio-mc.html). Its public URL is on the service's page in the Render dashboard and its root credentials are on that service's Environment tab:

```bash
mc alias set listen-fire "$MINIO_PUBLIC_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb listen-fire/listen-fire
```

Other options, all equivalent to the code — remove `listen-fire-minio` from the Blueprint and its two `fromService` references first:

- **AWS S3.** Set the four `AWS_*` variables and leave `AWS_S3_ENDPOINT` unset.
- **Cloudflare R2, Supabase Storage, GCS's own S3-interoperability HMAC keys, or anything else speaking the protocol.** Same four variables plus `AWS_S3_ENDPOINT`.
- **Nothing at all.** The process boots normally and only the file-touching steps fail, naming the variables they wanted.

`AWS_S3_FORCE_PATH_STYLE` is compared to the literal lowercase `true`. `TRUE` and `1` read as false. This bites MinIO and Ceph, which need path-style addressing, and it fails in a way that looks like a bucket-name problem.

## 5. The web app

The web app is a Next.js application, built by `deploy/Dockerfile.web` (target `web`) for the compose stack and deployable on its own anywhere that runs Node. `deploy/Dockerfile` is the API and its workers alone.

Deploy it as a second Render web service — either from `deploy/Dockerfile.web` with the Docker runtime, or with the Node runtime and the root directory `apps/web`, installing the workspace filtered to the web app and running its build. The Blueprint does the latter, because Blueprint YAML has no way to select a Docker build target and the Docker route needs `Dockerfile.web`'s `web` target. It needs to be told where the API is, and there are two ways: `API_INTERNAL_URL` makes the Next server proxy `/api/*` to that origin at run time, so the browser stays same-origin; `NEXT_PUBLIC_API_URL` bakes the API origin into the client bundle instead, which is the split-deployment shape and needs the API's CORS to allow the web origin. `API_INTERNAL_URL` is an origin — a scheme and a host, no path.

Two things do not survive being proxied through the web app, and the code already knows it:

- **WebSocket upgrades.** Live run updates connect straight to the API origin, which is why the API needs its own public hostname with TLS and correct CORS rather than merely being reachable from the web service.
- **Long authoring-agent requests.** They outlive most proxy timeouts and should go to the API origin directly.

You need the web app if you run `core` (login links point at it, and without it nobody can sign in) or if you want the authoring UI. You also need it for OAuth connections: the callback paths every OAuth adapter except Slack is registered against are pages in the web app, which hand the authorization code back to the API. See `vercel-plus-container.md` for the URL triangle, which is the same on Render.

## 6. Environment

Copy `deploy/.env.example` and set the same keys in the Render dashboard — plus, off compose, the secrets the compose stack would have generated for itself on first boot (`SELF_HOSTING.md`, "What the installation generates for itself", lists them). Two rules that are easy to miss:

- **`LISTEN_FIRE_PRODUCTS` and `LISTEN_FIRE_PRINCIPAL` are composition, not operator input:** `deploy/up.sh` sets them from the units you name, and the process checks the two against each other at boot in both directions. On Render you set the same two variables on the service, and treat them as part of the service definition rather than as something an operator tunes.
- **`API_BASE_URL` must be stable forever.** Every inbound webhook you register with a third party is built from it, and every capability link Listen-Fire hands out — an approval link, a file link, a callback — is absolute at it and already sitting in somebody else's inbox. Render gives every service a hostname on a domain of its own; put a custom domain on the service before you register anything or send anything, because renaming later breaks both and there is no rewrite mechanism.

The full variable reference, with what each one does when unset, is the environment section of [`SELF_HOSTING.md`](../SELF_HOSTING.md). Two shortcuts that save a support round-trip:

| variable | on Render |
|---|---|
| `DATABASE_URL` | the managed database's connection string |
| `DATABASE_URL_READONLY` | set it **equal to** `DATABASE_URL` when you have no replica; it must be set |
| `MESSAGE_QUEUE_REDIS_HOSTNAME` / `_PORT` | the Key Value instance's internal host and port; there is no URL form |
| `PORT` | leave it to Render |
| `NODE_ENV` | `production`; the image already sets it |

## 7. Upgrading

Push, let Render build, and make sure the migration step runs to completion before the new process serves. Back up the database first — migrations are forward-only.

Back up `ENCRYPTION_MASTER_KEY` and `ENCRYPTION_SALT_BASE64` somewhere separate from the database, and never rotate them casually. They encrypt every stored third-party credential; without the original values those credentials are unreadable and every connection has to be made again by hand.

## Blueprint

`deploy/render.yaml` encodes this whole guide — the API and web app as two web services, managed Postgres 16, a managed Key Value (Redis) instance, a MinIO service for object storage, and every environment variable a deployment needs, either fixed, wired up with `fromDatabase`/`fromService`, or left for the dashboard to prompt for (`sync: false`). Its own header comment carries the Render facts it was checked against and the choices it leaves you: the region is commented out, so pick one before you deploy, and the plan sizes are starting points to resize rather than guesses at what your load needs. `LISTEN_FIRE_PRODUCTS` there names the units this deployment runs; change it and `LISTEN_FIRE_PRINCIPAL` together, because the process checks the two against each other at boot.

### What the Blueprint leaves to you

A Blueprint does not do everything, and does not do it for you automatically on every push. Before or immediately after the first deploy:

- **Database roles.** Run `deploy/postgres-init/00-roles.sql` against `listen-fire-postgres` by hand, as a superuser, before the first deploy — see "1. The database, before anything else" above. A Blueprint has no hook for this.
- **Extensions.** Allow-list `citext`, `pg_trgm` and `vector` on the Postgres instance if Render requires that step for your plan; the migration set creates the extensions themselves but some managed providers gate which ones a database may request.
- **Custom domains.** Put a stable custom domain on both `listen-fire-api` and `listen-fire-web` *before* you register anything or send anything — `API_BASE_URL` is stable forever once webhooks and links are built from it, and the hostname Render hands a new service is not what you want permanently.
- **Slack app.** Register your own Slack app and set the five `SLACK_MOVEMENTS_*` variables together (`deploy/render.yaml` declares all five as operator-set; the state secret is minted by Render). Three URLs, the same as `SELF_HOSTING.md` lists: Event Subscriptions → `<API_BASE_URL>/api/public/slack/events`; Interactivity → `<API_BASE_URL>/api/public/slack-actions`; OAuth Redirect URL → `<WEB_BASE_URL>/slack/callback`, which is also exactly the value of `SLACK_MOVEMENTS_REDIRECT_URI` (it is passed through verbatim).
- **Email.** Pick one provider and set its credentials plus `OUTBOUND_EMAIL_FROM` and `INBOUND_EMAIL_ADDRESS`; the Blueprint declares both providers as operator-set so either works. For Resend, point its inbound route and webhook at `<API_BASE_URL>/api/resend/callback`; for Mailgun, at `<API_BASE_URL>/api/mailgun/callback`. Without a working outbound path on a `core` installation nobody can sign in.
- **MinIO bucket.** Once `listen-fire-minio` is deployed, create the `listen-fire` bucket by hand — see "4. Object storage" above. Nothing does this on your behalf, and file-touching features fail until it exists.
- **`AWS_S3_ENDPOINT` and `API_INTERNAL_URL`.** Both are operator-set because Render appends a suffix of its own to the service names a Blueprint creates, so no literal hostname in the file would survive contact with a real account. Read the two service names off the dashboard once the Blueprint has run, then fill both in.
- **Connecting Claude.** The onboarding screen walks through it, pointing Claude's custom-connector dialog at `<API_BASE_URL>/api/v1/mcp/automation` — see "Connecting Claude" in [`SELF_HOSTING.md`](../SELF_HOSTING.md).

## What this guide does not cover

Registering your own Slack app, Google OAuth client, WhatsApp number and the rest is the long pole of any real deployment, and it is platform-independent. [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Registering your own third-party apps", is the system-by-system runbook, and it belongs at the start of a cutover rather than the end.
