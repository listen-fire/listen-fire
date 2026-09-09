# Integration-test harness

Real-Postgres integration tests for the `apps/api` codebase. Landed in
W3-A2 (`plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W3-A2-integration-test-harness.md`)
to operationalise the standing rule from W3-A1: every wave-3-forward
chunk that touches the batcher → KG-adapter contract must include an
integration test against real Postgres.

## How to run

```bash
# Once: ensure the test DB exists. The dev-loop Postgres (port 9432)
# ships with a `test` database under the `test` role.
PGPASSWORD=test psql -h localhost -p 9432 -U test -d test -c "SELECT 1"

# Run all integration tests.
cd apps/api
pnpm test:integration

# Run just the worked example.
pnpm test:integration -- wave1-golden-path.integration.test.ts
```

`globalSetup.ts` applies migrations to the test DB on the first run.
The migrations are tracked in `_migrations.migrations`, so subsequent
runs are no-ops.

## Architecture

### Test database lifecycle

A **dedicated test database** (`DATABASE_URL_TEST`) is used. The
trade-offs (per the W3-A2 brief):

- ✅ Reproducible starting state — never tangles with dev-loop state.
- ✅ Future-proof — wave-3-forward chunks rely on predictable schema.
- ❌ Slower than transactional rollback — each test cleans up via
   `DELETE FROM ... WHERE team_id = ...` after running.

We pick dedicated test DB over transactional rollback because Kysely's
connection pooling interacts subtly with `BEGIN/ROLLBACK` (one pool
connection serves many tests; nested transactions inside the harness
would need careful pinning).

### Schema and connection plumbing

The production code (`lib/kysely.ts`) instantiates its connection pool
at module load. When `NODE_ENV === 'test'`, `prisma/index.ts`
synthesises a per-process random schema and appends `?schema=<uuid>`
to the connection URL — that's a unit-test convenience that doesn't
compose with our "real `public` + real `knowledge` schema" requirement.

`harness/env.ts` (wired via `setupFiles`) sets `NODE_ENV=integration`
and redirects `DATABASE_URL` → `DATABASE_URL_TEST` before any
production module loads. The production Kysely pool then connects to
the test DB, with `public` (default) and `knowledge` (via
`withSchema`) as the live schemas.

### Per-test cleanup

`harness/cleanup.ts:cleanupTeam(teamId)` deletes every row tagged with
the team across both schemas. Tests use the pattern:

```ts
let seed: SeedShape;
beforeEach(async () => { seed = await seedX(); });
afterEach(async () => { await cleanupTeam(seed.teamId); });
```

The list of team-scoped tables is hand-curated — extend it when new
write paths are integration-tested. The cleanup order matches FK
constraints (children before parents).

## How to write a new integration test

1. **Pick a fixture or write one.** `harness/wave1GoldenPath.ts` is
   the canonical example — it seeds team + ontology (node_types +
   property_types + edge_types). Fixtures return stable references to
   every row the test cares about.

2. **Compose the test file.** Filename must end in
   `.integration.test.ts` so the jest config picks it up. Place near
   the production code under test (e.g.
   `services/translation_graph/__test__/foo.integration.test.ts`).

3. **Set up + tear down per test.** Use `beforeEach` to seed,
   `afterEach` to `cleanupTeam(seed.teamId)`. The harness does NOT
   reset the DB between tests — only the team-scoped rows. Anything
   that writes outside a team's scope must be cleaned manually.

4. **Drive the production code under test.** Import production
   modules directly. They'll see the test DB through the env override.
   For tests that need to bypass an LLM client or other external I/O,
   construct the production class manually with stubbed dependencies
   (the LLM client is injected into `BatchedExtractionBatcher`'s
   constructor — see `wave1-golden-path.integration.test.ts`).

5. **Assert against Postgres directly.** Use `getQb([...])` and
   `getKnowledgeQb([...])` from `lib/kysely` to read back state.
   Treating the DB as the source of truth catches contract
   violations the unit tests miss.

## What this harness does NOT do

- **No application-server bootstrap.** Tests don't spin up the API
  server, Redis, fake-channels, or any out-of-process dependency. If
  a test needs those, use the dev:loop instead.

- **No HTTP layer.** Tests bypass the REST router and call services
  directly. To integration-test webhook flows end-to-end, dispatch
  via `routeTrigger` directly with synthetic events.

- **No external services.** Anthropic, S3, OpenAI calls remain
  stubbed at the dependency-injection boundary. The harness's value
  is in the DB-touching contract.

## Worked-example test

`apps/api/src/services/translation_graph/__test__/wave1-golden-path.integration.test.ts`
is the canonical pattern wave-3-forward chunks must copy from. It
exercises:

- Real `KnowledgeGraphAdapter.writeResource` against real Postgres
- Real `finaliseExtractEvidence` → `KnowledgeGraphAdapter.writeEvidence`
  with `ephemeralRef → real NodeId` resolution (W3-A1.1 acceptance)
- Direct DB assertions over the wave-1 golden-path state (1 Opp + 1 FR
  + 2 RPs + Participants edges + facts + evidence-with-real-UUIDs)

See the file header comment for what's in scope vs. out of scope.
