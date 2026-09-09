-- ============================================================================
-- Wind-down disposal backfill — APPLY (writes, transactional, idempotent)
-- ============================================================================
-- Completes the disposal the OLD wind-down missed for companies already wound
-- down before the fix: their SPV-profiled holdings and SPV-issued equity were
-- never marked down and nothing was ever transferred out of the holder's
-- inventory. This writes exactly what the new disposal service
-- (lib/valuations/commands/wind_down.ts `disposeTrackedHoldings`) now writes,
-- against each company's EXISTING liquidation event — NO new event, NO status
-- change:
--   • a per-asset price = 0 mark, keyed to the asset's issuer (so per-issuer
--     equity pricing zeroes SPV-issued equity too), stamped with the event;
--   • one disposal transaction per company, stamped with the existing event id
--     and dated at the event date;
--   • an asset_transfer per held position, holder → the asset's issuer, with no
--     currency counter-leg (a pure one-way outflow → ONE_WAY_TRANSACTION, so it
--     creates no realised proceeds).
--
-- Selection semantics mirror the service (see the .report.sql header). The
-- selection CTE is duplicated verbatim in both apply statements below and in
-- .report.sql — pure SQL can't share a CTE across statements. Keep them in
-- lockstep; wind_down.integration.test.ts is the drift tripwire.
--
-- Idempotent: after disposal a position's net balance is zero (the void
-- transfer is itself counted), so a re-run's `disposal` set is empty; the
-- NOT EXISTS guards are belt-and-braces (and honour price's (asset_id, date)
-- unique). Running against an already-clean DB is a no-op.
--
-- Run as a role that owns the tables / bypasses RLS (a normal prod backfill
-- role). The two statements are wrapped in one transaction — all or nothing.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 2026-07-23_wind_down_disposals.apply.sql
--
-- Scope to a single team or company by adding, to BOTH `liquidation` CTEs:
--   AND e.team_id = '<team-uuid>'     and/or     AND e.legal_entity_id = '<company-uuid>'
-- ============================================================================

BEGIN;

-- 1) Mark every disposed asset to zero (keyed to its issuer), stamped with the
--    existing liquidation event. Runs before the transfers so the balances it
--    reads are still the pre-disposal balances.
WITH liquidation AS MATERIALIZED (
  -- Earliest LIQUIDATION event per company (the true wind-down to attach to).
  -- The tiny driving set — everything below narrows off THIS, never the reverse.
  SELECT DISTINCT ON (e.legal_entity_id)
    e.id AS event_id, e.team_id, e.legal_entity_id AS company_id, e.date AS event_date
  FROM event e
  WHERE e.type = 'LIQUIDATION'
  ORDER BY e.legal_entity_id, e.date ASC, e.id
),
tracking_asset AS MATERIALIZED (
  -- Non-cash assets that track a wound-down company (issuer / issuer's underlying
  -- / SPV target). issuer_id falls back to the company when unknown, matching the
  -- service. Built as one UNION branch per tracking rule, each an INDEXED probe
  -- driven off the tiny `liquidation` set — never a per-company scan of every
  -- asset, and no correlated legal_entity subquery. UNION (not ALL) dedups an
  -- asset that matches two branches into the single row the old OR produced;
  -- issuer_id is a function of the asset alone, so the deduped rows are identical.
  SELECT l.event_id, l.team_id, l.company_id, l.event_date,
         a.id AS asset_id, a.name AS asset_name,
         COALESCE(a.issued_by_legal_entity_id, l.company_id) AS issuer_id
  FROM liquidation l
  JOIN asset a
    ON a.team_id = l.team_id
   AND a.type <> 'CURRENCY'
   AND a.issued_by_legal_entity_id = l.company_id       -- issuer IS the company
  UNION
  SELECT l.event_id, l.team_id, l.company_id, l.event_date,
         a.id AS asset_id, a.name AS asset_name,
         COALESCE(a.issued_by_legal_entity_id, l.company_id) AS issuer_id
  FROM liquidation l
  JOIN legal_entity le                                   -- issuer's underlying IS the company
    ON le.team_id = l.team_id
   AND le.underlying_company_id = l.company_id
  JOIN asset a
    ON a.team_id = l.team_id
   AND a.type <> 'CURRENCY'
   AND a.issued_by_legal_entity_id = le.id
  UNION
  SELECT l.event_id, l.team_id, l.company_id, l.event_date,
         a.id AS asset_id, a.name AS asset_name,
         COALESCE(a.issued_by_legal_entity_id, l.company_id) AS issuer_id
  FROM liquidation l
  JOIN asset a                                           -- SPV interest targeting the company
    ON a.team_id = l.team_id
   AND a.type = 'SPV_INTEREST_POINT'
   AND a.properties ->> 'spv_investment_target_company_id' = l.company_id::text
),
position AS (
  SELECT ta.event_id, ta.team_id, ta.company_id, ta.event_date,
         ta.asset_id, ta.asset_name, ta.issuer_id,
         h.id AS holder_id,
         SUM(CASE WHEN xf.to_legal_entity_id   = h.id THEN COALESCE(xf.num_assets, 0) ELSE 0 END)
       - SUM(CASE WHEN xf.from_legal_entity_id = h.id THEN COALESCE(xf.num_assets, 0) ELSE 0 END)
           AS net_balance
  FROM tracking_asset ta
  JOIN asset_transfer xf
    ON xf.asset_id = ta.asset_id
   AND xf.team_id = ta.team_id
  JOIN transaction t
    ON t.id = xf.transaction_id
   AND t.close_date <= ta.event_date
  JOIN legal_entity h
    ON h.team_id = ta.team_id
   AND (h.is_portfolio IS TRUE OR h.is_own_investing_entity IS TRUE)
   AND (h.id = xf.to_legal_entity_id OR h.id = xf.from_legal_entity_id)
  GROUP BY ta.event_id, ta.team_id, ta.company_id, ta.event_date,
           ta.asset_id, ta.asset_name, ta.issuer_id, h.id
),
disposal AS (
  SELECT * FROM position WHERE net_balance > 0
),
disposal_asset AS (
  SELECT DISTINCT event_id, team_id, event_date, asset_id, issuer_id FROM disposal
)
INSERT INTO price (id, team_id, date, price, currency, asset_id, event_id, type, legal_entity_id)
SELECT gen_random_uuid(), da.team_id, da.event_date, 0, 'USD', da.asset_id, da.event_id,
       'FROM_PRICED_ROUND', da.issuer_id
FROM disposal_asset da
WHERE NOT EXISTS (
        SELECT 1 FROM price p WHERE p.event_id = da.event_id AND p.asset_id = da.asset_id
      )
  AND NOT EXISTS (
        SELECT 1 FROM price p2 WHERE p2.asset_id = da.asset_id AND p2.date = da.event_date
      );

-- 2) Transfer each held position out to its issuer (the void), under one new
--    disposal transaction per event, stamped with the existing event.
WITH liquidation AS MATERIALIZED (
  -- Earliest LIQUIDATION event per company (the true wind-down to attach to).
  -- The tiny driving set — everything below narrows off THIS, never the reverse.
  SELECT DISTINCT ON (e.legal_entity_id)
    e.id AS event_id, e.team_id, e.legal_entity_id AS company_id, e.date AS event_date
  FROM event e
  WHERE e.type = 'LIQUIDATION'
  ORDER BY e.legal_entity_id, e.date ASC, e.id
),
tracking_asset AS MATERIALIZED (
  -- Non-cash assets that track a wound-down company (issuer / issuer's underlying
  -- / SPV target). issuer_id falls back to the company when unknown, matching the
  -- service. Built as one UNION branch per tracking rule, each an INDEXED probe
  -- driven off the tiny `liquidation` set — never a per-company scan of every
  -- asset, and no correlated legal_entity subquery. UNION (not ALL) dedups an
  -- asset that matches two branches into the single row the old OR produced;
  -- issuer_id is a function of the asset alone, so the deduped rows are identical.
  SELECT l.event_id, l.team_id, l.company_id, l.event_date,
         a.id AS asset_id, a.name AS asset_name,
         COALESCE(a.issued_by_legal_entity_id, l.company_id) AS issuer_id
  FROM liquidation l
  JOIN asset a
    ON a.team_id = l.team_id
   AND a.type <> 'CURRENCY'
   AND a.issued_by_legal_entity_id = l.company_id       -- issuer IS the company
  UNION
  SELECT l.event_id, l.team_id, l.company_id, l.event_date,
         a.id AS asset_id, a.name AS asset_name,
         COALESCE(a.issued_by_legal_entity_id, l.company_id) AS issuer_id
  FROM liquidation l
  JOIN legal_entity le                                   -- issuer's underlying IS the company
    ON le.team_id = l.team_id
   AND le.underlying_company_id = l.company_id
  JOIN asset a
    ON a.team_id = l.team_id
   AND a.type <> 'CURRENCY'
   AND a.issued_by_legal_entity_id = le.id
  UNION
  SELECT l.event_id, l.team_id, l.company_id, l.event_date,
         a.id AS asset_id, a.name AS asset_name,
         COALESCE(a.issued_by_legal_entity_id, l.company_id) AS issuer_id
  FROM liquidation l
  JOIN asset a                                           -- SPV interest targeting the company
    ON a.team_id = l.team_id
   AND a.type = 'SPV_INTEREST_POINT'
   AND a.properties ->> 'spv_investment_target_company_id' = l.company_id::text
),
position AS (
  SELECT ta.event_id, ta.team_id, ta.company_id, ta.event_date,
         ta.asset_id, ta.asset_name, ta.issuer_id,
         h.id AS holder_id,
         SUM(CASE WHEN xf.to_legal_entity_id   = h.id THEN COALESCE(xf.num_assets, 0) ELSE 0 END)
       - SUM(CASE WHEN xf.from_legal_entity_id = h.id THEN COALESCE(xf.num_assets, 0) ELSE 0 END)
           AS net_balance
  FROM tracking_asset ta
  JOIN asset_transfer xf
    ON xf.asset_id = ta.asset_id
   AND xf.team_id = ta.team_id
  JOIN transaction t
    ON t.id = xf.transaction_id
   AND t.close_date <= ta.event_date
  JOIN legal_entity h
    ON h.team_id = ta.team_id
   AND (h.is_portfolio IS TRUE OR h.is_own_investing_entity IS TRUE)
   AND (h.id = xf.to_legal_entity_id OR h.id = xf.from_legal_entity_id)
  GROUP BY ta.event_id, ta.team_id, ta.company_id, ta.event_date,
           ta.asset_id, ta.asset_name, ta.issuer_id, h.id
),
disposal AS (
  SELECT * FROM position WHERE net_balance > 0
),
missing_transfer AS (
  -- Positions without an already-recorded disposal transfer for this event.
  SELECT d.*
  FROM disposal d
  WHERE NOT EXISTS (
    SELECT 1
    FROM asset_transfer xf2
    JOIN transaction t2 ON t2.id = xf2.transaction_id
    WHERE t2.event_id = d.event_id
      AND xf2.asset_id = d.asset_id
      AND xf2.from_legal_entity_id = d.holder_id
  )
),
txn_group AS MATERIALIZED (
  -- One disposal transaction PER (event, issuer). Mirrors the service: the
  -- inventory walk anchors every transfer in a transaction under one investee,
  -- so a mixed-issuer transaction would leave SPV-issued holdings undecremented
  -- in their own bucket. MATERIALIZED pins one stable id per group so the
  -- transaction insert and the transfer join below agree on it.
  SELECT g.event_id, g.team_id, g.event_date, g.issuer_id, gen_random_uuid() AS txn_id
  FROM (SELECT DISTINCT event_id, team_id, event_date, issuer_id FROM missing_transfer) g
),
ins_txn AS (
  INSERT INTO transaction (id, team_id, close_date, event_id)
  SELECT txn_id, team_id, event_date, event_id FROM txn_group
  RETURNING id
)
INSERT INTO asset_transfer
  (id, team_id, asset_id, date, from_legal_entity_id, num_assets, to_legal_entity_id, transaction_id)
SELECT gen_random_uuid(), mt.team_id, mt.asset_id, mt.event_date,
       mt.holder_id, mt.net_balance, mt.issuer_id, tg.txn_id
FROM missing_transfer mt
JOIN txn_group tg ON tg.event_id = mt.event_id AND tg.issuer_id = mt.issuer_id;

COMMIT;
