---
name: schema-migration
description: The end-to-end database schema change procedure — schema.sql edit through applied migration with regenerated types, including the drift-trimming and audit-trigger gotchas. Use for any change to tables, columns, or enums.
---

# Schema migration

Schema-first: `schema.sql` is the source of truth; migrations are generated
from it, never written from scratch.

## Procedure

1. Edit `schema.sql` with the desired end state.
2. `pnpm -r schema:generate <migration-name>` — diffs schema.sql against the
   live dev DB and writes a migration file.
3. **Trim the generated migration.** The generator sweeps in unrelated drift
   (typically `id SET DEFAULT` churn from other work). Delete everything that
   isn't your change — a migration should read as exactly its name.
4. Add data backfills to the migration by hand if the change needs them.
5. `pnpm -r schema:apply` — applies migrations and regenerates Prisma + Kysely
   types (idempotent; safe to re-run).

## Gotchas (each has caused a real incident)

- **Every audited table MUST have an `id` column.** An id-less audited table
  silently breaks EVERY write to it — the audit trigger fails, not your query.
- Knowledge-domain tables live in the `knowledge` Postgres schema: query via
  `getKnowledgeQb()`, and Prisma autogen requires the multiSchema setting.
- Kysely: `.where()` on an enum column needs the enum value (not a string);
  ambiguous columns in subqueries need explicit aliases.
- New tRPC surface for the change? After router edits run `pnpm -r codegen:trpc`
  so `apps/web` sees the types. Queue-type imports into a router break this
  codegen — keep them out.
