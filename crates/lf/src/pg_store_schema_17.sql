-- @lf/postgres-store, migration 17: a listen that could not judge an
-- arrival keeps what landed, as its module reported it, and the module it
-- came from (`unjudged.note`'s `landing` and `adapter`), so a module can
-- recognise its own landings by their fields: `@lf/system` never reports an
-- arrival that is itself one of its `Arrival Not Judged` events. Null on a
-- fact kept before.
ALTER TABLE lf.arrival_unjudged ADD COLUMN adapter text;
ALTER TABLE lf.arrival_unjudged ADD COLUMN landing jsonb;
