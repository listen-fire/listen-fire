# Listen-Fire on a Google Cloud VM

One Compute Engine VM running the compose stack, behind a reverse proxy with TLS. That is the whole architecture, and it is the same `docker compose` every other self-hoster runs.

It is the honest shape because the API is one long-running process: its schedulers, resume loops and delivery workers live inside it, its live-update fan-out is an in-process emitter, and its restart sweep assumes it is the only instance. Cloud Run can host that, with minimum and maximum instances both pinned to one and CPU always allocated, but then nothing Cloud Run exists for is available and the bill is a permanent instance either way. A VM says the same thing without the ceremony.

Read [`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) first. It is the runbook for every shape, and this guide only translates it onto Google Cloud.

Then, when you want a managed datastore, the second half of this page is a runbook per store. Postgres, Redis and the object store move independently, and each move is data plus one variable. Nothing about the VM changes.

---

## The shape

| # | What | On GCP | Notes |
|---|---|---|---|
| 1 | everything | one **Compute Engine VM**, `e2-standard-2` or larger | the API, the web app, and the bundled datastores |
| 2 | the data | a **persistent disk** mounted under Docker's data root | the database, the object store and the config volume all live there |
| 3 | the front door | **nginx or Caddy on the VM**, TLS on 443 | two hostnames, one for the web app and one for the API |
| 4 | backups | **disk snapshot schedule** plus a `pg_dump` to a bucket | the snapshot is the machine, the dump is the database |
| 5 | DNS | two A records at the VM's static external IP | `API_BASE_URL` is permanent, so choose the API's name carefully |

## 1. The VM

**`e2-standard-2` (2 vCPU, 8 GB) is the floor.** Memory is the lever, not CPU. The API alone wants 1 to 2 GB at rest and more on an extraction or an authoring-agent request, and the bundled Postgres, Redis, MinIO and the web app sit beside it on the same machine. `e2-medium` (4 GB) runs a demo and runs out of memory under real use. Move up to `e2-standard-4` before you move anything off the box, because it is one line and a reboot.

**Boot image: Debian 12, or Container-Optimized OS.** Debian is the easier first VM: `psql`, `gcloud` and a reverse proxy install as packages, and the runbooks below use all three on the machine itself. Container-Optimized OS is the smaller attack surface, updates itself, and ships Docker already, but it has no package manager, so anything the runbooks call for has to run in a container. Either works. Install Docker Engine and the Compose plugin on Debian from Docker's own repository; the version in Debian's archive is older than this stack expects.

**Give it a static external IP** and put both hostnames on it before you configure anything else, for the reason in section 3.

**Reserve nothing else on the machine.** The stack publishes 8080, 8081 and 8082 for your proxy to reach; those ports must be free.

## 2. The disk the data lives on

Every piece of state is a Docker named volume: `pgdata`, `redisdata`, `miniodata` and `listen-fire-config`. They all live under Docker's data root, so putting that directory on its own persistent disk puts all of them there at once, and lets the disk be snapshotted and resized without touching the VM.

Attach a `pd-balanced` disk (100 GB is a reasonable start; it grows online), format it once, and mount it at `/var/lib/docker` **before Docker first starts**. Add it to `/etc/fstab` with `discard,defaults,nofail` so a missing disk does not stop the machine from booting, and turn **auto-delete off** on the attachment so deleting the VM does not delete the data.

On Container-Optimized OS the stateful partition already holds `/var/lib/docker`; there the equivalent is to grow the boot disk rather than attach a second one.

**`listen-fire-config` is the volume that must survive everything.** It holds the encryption keys every stored third-party credential is encrypted under, and a database restored without the matching config volume is unreadable. Back it up separately, as well as in the disk snapshot: [`SELF_HOSTING.md`](../SELF_HOSTING.md), "What the installation generates for itself", has the one-line `tar` for it.

## 3. TLS, and why the API needs its own hostname

**Two hostnames, two DNS records, one IP.** `app.example.com` for the web app and `api.example.com` for the API. The API is not something the web app hides behind: the browser opens a WebSocket straight to the API origin for live run updates, and authoring-agent requests run longer than a proxy in front of the web app will hold a connection open. Both go to the API's own name.

**`API_BASE_URL` must be stable forever.** Every webhook you register with a third party and every capability link the product hands out is absolute at it, and by the time you want to rename it those URLs are in other people's inboxes and other systems' configuration. There is no rewrite mechanism.

Terminate TLS on the VM with nginx or Caddy, proxying `app.example.com` to `127.0.0.1:8080` and `api.example.com` to `127.0.0.1:8081`. Two settings are not defaults:

- **WebSocket upgrades must pass through** on the API host. In nginx that is `proxy_http_version 1.1` with the `Upgrade` and `Connection` headers set.
- **Raise the proxy read timeout** on the API host, to several minutes. The default of 60 seconds cuts off live subscriptions and long agent requests.

The health probe is `GET /.well-known/health-check`, and **it answers `201`**, which is its contract. Anything that checks for exactly `200` will report a healthy stack as down.

**Firewall: 80 and 443 from anywhere, and nothing else.** The public surface is deliberate rather than incidental: inbound webhook doors for Slack events, Slack interactivity, Telegram, WhatsApp and your mail provider all land on `API_BASE_URL`, and they come from those vendors' addresses rather than yours. Port 22 is best reached through IAP TCP forwarding rather than opened.

**Bind the stack's own ports to loopback**, so the firewall is not the only thing standing between the internet and a plain-HTTP port. The port variables are interpolated into the compose port mapping whole, so an address in front of the number is carried through:

```
WEB_PORT=127.0.0.1:8080
API_PORT=127.0.0.1:8081
ADMIN_PORT=127.0.0.1:8082
```

The proxy reaches them on `127.0.0.1`, and nothing else can.

Once TLS is on, set `API_BASE_URL` and `WEB_BASE_URL` to the `https` names. They also decide cookie security: the session cookie is marked `Secure` only when those URLs are `https`, and a `Secure` cookie on a plain-http address is set, dropped by the browser, and the person is bounced back to the login they just completed.

## 4. Bringing it up

```bash
git clone <this repo> && cd <this repo>/deploy
cp .env.example .env
```

In `.env`, at minimum:

```
ANTHROPIC_API_KEY=…
LISTEN_FIRE_VERSION=v0.1.0
LISTEN_FIRE_PRODUCTS=core,automations
LISTEN_FIRE_PRINCIPAL=core
API_BASE_URL=https://api.example.com
WEB_BASE_URL=https://app.example.com
LISTEN_FIRE_ADMIN_EMAIL=you@example.com
COMPOSE_PROFILES=postgres,redis,minio,admin
```

Then, from `deploy/`:

```bash
docker compose pull
docker compose up -d
```

**Use `docker compose` rather than `up.sh` here.** `up.sh` is the door for a trial on your own machine and pins the public URLs to `http://localhost:<port>`, which is exactly wrong behind a real hostname.

**`LISTEN_FIRE_VERSION` is what this installation runs**, and it moves only when you edit that line. Leave it unset and every pull takes `latest`, which moves under you.

**Login needs a mail provider** on an installation with `core`: the sign-in link is genuinely emailed, so `RESEND_API_KEY` or `MAILGUN_API_KEY` plus `OUTBOUND_EMAIL_FROM` is not optional. Nobody can sign in until it is set.

Every long-running service in the file carries `restart: unless-stopped`, so the stack comes back after a reboot as long as Docker starts at boot (`systemctl enable docker`). The one-shot services that mint secrets and run migrations do not restart, which is what they should do. Nothing here needs a systemd unit of its own.

## 5. Backups

**Two backups, because they protect different things.**

A **snapshot schedule** on the data disk is the machine: the database files, the object store, and the config volume with the encryption keys. Attach a resource policy to the disk with a daily schedule and a retention you can live with. Restoring it is creating a disk from the snapshot and attaching it to a VM.

A **`pg_dump`** is the database on its own, which is what an upgrade rollback needs and what a snapshot is clumsy for:

```bash
# from deploy/
docker compose exec -T postgres pg_dump -U listenfire -Fc listenfire \
  > listenfire-$(date +%Y%m%d-%H%M).dump
gsutil cp listenfire-*.dump gs://your-backup-bucket/
```

Run it on a cron, and run it by hand before every upgrade. Once the database is on Cloud SQL, its own automated backups and point-in-time recovery replace this and the `exec` no longer has a container to reach.

## 6. Upgrading

The runbook is [`UPGRADING.md`](../UPGRADING.md) and it is the same everywhere: snapshot the database, edit `LISTEN_FIRE_VERSION` in `deploy/.env`, `docker compose pull && docker compose up -d`, check that `/healthz/workers` reports the version you asked for, and roll back by restoring the snapshot and re-pinning the previous tag. Migrations run as a one-shot service to completion before the new API starts, and they are forward-only.

Do it on a copy first. A VM created from yesterday's snapshot is a copy.

---

# Moving a datastore to a managed service

The three sections below are independent. Move the database and leave Redis and the object store bundled, or any other combination; nothing here assumes you will do all three, and nothing about the VM changes when you do.

Each one is the same two steps: move the data, then name the new store in `deploy/.env`. Naming it is the whole switch. The bundled service leaves the composition on the next `docker compose up -d`, because its compose profile is keyed on that variable being absent. What each store needs in general is in [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Bringing your own datastores"; below is only what is specifically Google Cloud.

Run `docker compose up -d --remove-orphans` after each flip, so the parked container is removed rather than left running beside its replacement.

## Cloud SQL for PostgreSQL 16

**Create the instance** with PostgreSQL 16, a **private IP on the same VPC** as the VM, and no public IP. A private IP is simpler than the Cloud SQL Auth proxy here: the API is a container on a Docker bridge network, and it reaches a VPC address through the VM's own routing with nothing to install.

**Confirm the six extensions first.** The migration set creates `vector`, `pg_trgm`, `citext`, `pgcrypto`, `unaccent` and `btree_gin`, and it is monolithic, so every installation needs all six whatever units it mounts. All six are on Cloud SQL's supported-extensions list for PostgreSQL 16 (checked 2026-09-09); check it again against your instance before you build anything on top, because the alternative is discovering it halfway through a first migration.

**Run the roles file before anything else touches the database**, as the `postgres` user:

```bash
psql "postgresql://postgres:…@10.x.x.x:5432/listenfire" \
  -f deploy/postgres-init/00-roles.sql
```

The migration set carries more than a hundred `GRANT … TO agent` and `TO readonly` statements, the first early enough that a database without those roles dies having built almost nothing. Compose runs that file from the bundled Postgres image's init hook; **a managed database has no such hook.** Run it as the instance's `postgres` user, which is a `cloudsqlsuperuser` and can create roles; a least-privilege application user cannot. What it creates needs no elevated attribute of its own: `agent` is deliberately powerless, with no `BYPASSRLS`, because Cloud SQL would refuse to grant it and the design does not want it.

**Move the data.** Stop the API so nothing writes during the copy, dump, restore, and leave the old container in place until you have checked the new one:

```bash
# from deploy/
docker compose stop api
docker compose exec -T postgres pg_dump -U listenfire -Fc listenfire > move.dump
pg_restore -d "postgresql://postgres:…@10.x.x.x:5432/listenfire" --no-owner move.dump
```

`--no-owner` because the roles that own objects in the bundled database are not the roles that will own them in Cloud SQL. Restore into a database that already has the roles file applied and is otherwise empty.

**Then flip the switch**, in `deploy/.env`:

```
DATABASE_URL=postgresql://listenfire:…@10.x.x.x:5432/listenfire
```

Leave `DATABASE_URL_READONLY` unset unless you have a genuine read replica: on compose it follows `DATABASE_URL` when unset, and the process is never allowed to see it absent. If you do run a replica, that is what the variable is for.

**Session-level pooling only.** The API takes a Postgres advisory lock per mounted unit and holds it on a dedicated session for the life of the process, which is what guarantees each background loop runs on exactly one instance. A pooler in transaction mode hands those sessions around between clients and the guarantee is gone, silently. Cloud SQL's own connection pooling, PgBouncer or any other pooler must be in session mode, or absent.

**Count the connections.** Roughly six long-held connections for the locks, plus the read and write pools, plus whatever you connect with by hand. A `db-f1-micro` instance's connection limit is small enough to matter; check the instance's `max_connections` against that before you size down.

Once the API is answering against Cloud SQL, `docker volume rm listen-fire_pgdata` reclaims the old data. Not before.

## Memorystore for Redis, Basic tier

**Basic tier, AUTH disabled, TLS disabled, on the same VPC** as the VM, with no public address.

That is not a shortcut, it is the only reachable configuration: the client is built from a hostname and a port and nothing else. There is no username, no password, no TLS and no URL form anywhere in it, so an instance with AUTH or in-transit encryption on cannot be spoken to through these two variables at all. Private network access is the boundary. Standard tier adds replication and costs more; nothing here needs it, for the reason below.

**Nothing has to be moved.** Everything in Redis is rebuilt by use, and the two things that live there are worth knowing by name:

- **Core's in-flight MCP OAuth state.** A connection someone is in the middle of authorising, at the moment you switch, fails after they have consented. They start it again. Nothing else is affected.
- **Automations' runaway-loop counters.** The guard that stops an automation triggering itself in a cycle. It fails **open**: with Redis unreachable, automations keep running unguarded rather than stopping. This is why an empty cache is fine and an unreachable one is not.

There is no persistence to preserve and no keyspace to export. Flush nothing, copy nothing.

**Flip the switch**, in `deploy/.env`:

```
MESSAGE_QUEUE_REDIS_HOSTNAME=10.x.x.x
MESSAGE_QUEUE_REDIS_PORT=6379
```

Then `docker volume rm listen-fire_redisdata` once the API is answering.

## Cloud Storage, through the S3-compatible XML API

Cloud Storage speaks S3 well enough for the API's storage adapter, which is a plain S3 client: put, get, delete and presign, with a configurable endpoint. There is no GCS-native code path and none is needed.

**Create the bucket** in the same region as the VM, with uniform bucket-level access, and no public access.

**Create an HMAC key** for a service account that has `roles/storage.objectAdmin` on that bucket, and nothing wider. The access id and secret it gives you are what the S3 client authenticates with; a GCP service-account JSON key is not usable here.

**Move the objects.** Both ends speak S3, so one tool talks to both. From the VM, with the bundled MinIO still running:

```bash
docker compose run --rm --no-deps --entrypoint sh minio -c '
  mc alias set src http://minio:9000 listenfire "$(cat /config/minio_password)" &&
  mc alias set dst https://storage.googleapis.com <hmac-access-id> <hmac-secret> --api S3v4 &&
  mc mirror src/listen-fire dst/<your-bucket>'
```

`gsutil -m rsync -r` does the same job if you would rather copy the objects out of the volume to the VM's disk first and push them up from there. Either way, do it before you flip the variable: links already handed to a third party are absolute at the old origin and do not follow the data.

**Flip the switch**, in `deploy/.env`:

```
AWS_S3_ENDPOINT=https://storage.googleapis.com
AWS_DOCUMENT_S3_BUCKET=your-bucket
AWS_REGION=auto
AWS_ACCESS_KEY_ID=<hmac-access-id>
AWS_SECRET_ACCESS_KEY=<hmac-secret>
```

All five together. **Leave `AWS_S3_FORCE_PATH_STYLE` unset**: it exists for MinIO and Ceph, it is compared to the literal lowercase `true`, and Cloud Storage does not need it.

**Do not upgrade `@aws-sdk/client-s3` without re-testing an upload against this bucket.** The version pinned here, `3.649.0`, predates the SDK release that started sending integrity-checksum headers on every request by default, and Cloud Storage's XML API rejects those. A routine dependency bump breaks uploads to GCS and to nothing else, so it will not look like a storage change.

Moving to Cloud Storage is also what makes file links work for people outside the VM. The bundled MinIO is reachable only on the compose network, so a presigned link handed to a browser or a third party does not resolve; a Cloud Storage presigned URL does.

Then `docker volume rm listen-fire_miniodata` once you have confirmed a file downloads.
