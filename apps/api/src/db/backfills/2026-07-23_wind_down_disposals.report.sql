-- ============================================================================
-- Wind-down disposal backfill — DRY-RUN REPORT (read-only)
-- ============================================================================
-- Lists every position the apply script WOULD dispose: companies that already
-- have a LIQUIDATION event but still hold positive-balance, non-cash assets
-- that TRACK the wound-down company. Eyeball this against prod before running
-- `2026-07-23_wind_down_disposals.apply.sql`.
--
-- "Tracks the company" mirrors the valuation engine's resolution exactly
-- (getAssetTrackedEntities): the company is the asset's issuer, OR the issuer's
-- legal_entity.underlying_company_id, OR (for an SPV interest) the asset's
-- properties.spv_investment_target_company_id. Holders are is_portfolio /
-- is_own_investing_entity entities. Balance = net asset_transfers in − out up to
-- the event date.
--
-- Run (read-only, safe):
--   psql "$DATABASE_URL" -f 2026-07-23_wind_down_disposals.report.sql
--
-- The selection CTE below is DUPLICATED verbatim in the .apply.sql file (pure
-- SQL can't share a CTE across files/statements). They must stay in lockstep;
-- wind_down.integration.test.ts asserts the SQL and the service produce an
-- identical end state and is the tripwire if they drift.
-- ============================================================================

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
  -- Net balance of each tracking asset per portfolio/own-investing holder, as of
  -- the event date. Sum of transfers in minus out — equal to the service's total
  -- holding (fromInvestment + fromOtherTransactions), which the classification
  -- only splits into buckets, never changes in total. Driven off the asset's
  -- transfers (indexed on asset_id): each transfer contributes to its to-holder
  -- (+) and from-holder (−), so we join only the ≤2 entities a transfer actually
  -- touches — never a cross product of every holder against every tracking asset.
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
)
SELECT
  co.name        AS company,
  d.company_id,
  d.event_id,
  d.event_date,
  h.name         AS holder,
  d.holder_id,
  d.asset_name   AS asset,
  d.asset_id,
  d.issuer_id,
  d.net_balance
FROM disposal d
JOIN legal_entity co ON co.id = d.company_id
JOIN legal_entity h  ON h.id  = d.holder_id
ORDER BY co.name, h.name, d.asset_name;
