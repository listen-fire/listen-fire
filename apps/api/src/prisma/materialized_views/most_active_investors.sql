CREATE MATERIALIZED VIEW most_active_investors AS
WITH ranked_entities AS (
  SELECT 
    le.id::text,
    le.created_at,
    le.slug,
    le.name,
    le.personal_website,
    le.short_description,
    le.country,
    le.description,
    COUNT(i.id) AS investment_count,
    ROW_NUMBER() OVER (PARTITION BY le.personal_website ORDER BY le.created_at) as rn
  FROM legal_entity le
  JOIN investment i ON le.id = i.investor_profile_id
  JOIN profile_public_round ppr ON i.investment_profile_id = ppr.profile_id
  WHERE le.type = 'FUND'
    AND le.personal_website IS NOT NULL
    AND le.team_id IS NULL
    AND ppr.announced_date >= NOW() - INTERVAL '12 months'
    AND le.personal_website NOT LIKE '%wikipedia.org%'
    AND le.personal_website NOT LIKE '%linkedin.com%'
    AND le.personal_website NOT LIKE '%crunchbase.com%'
    AND le.personal_website NOT LIKE '%angelinvestmentnetwork.us%'
  GROUP BY 
    le.id,
    le.created_at,
    le.slug,
    le.name,
    le.personal_website,
    le.short_description,
    le.country,
    le.description
)
SELECT 
  (ARRAY_AGG(id ORDER BY created_at))[1]::uuid as id,
  (ARRAY_AGG(created_at ORDER BY created_at DESC) FILTER (WHERE created_at IS NOT NULL))[1] as created_at,
  (ARRAY_AGG(slug ORDER BY created_at DESC) FILTER (WHERE slug IS NOT NULL))[1] as slug,
  (ARRAY_AGG(name ORDER BY created_at DESC) FILTER (WHERE name IS NOT NULL))[1] as name,
  personal_website,
  (ARRAY_AGG(short_description ORDER BY created_at DESC) FILTER (WHERE short_description IS NOT NULL))[1] as short_description,
  (ARRAY_AGG(country ORDER BY created_at DESC) FILTER (WHERE country IS NOT NULL))[1] as country,
  (ARRAY_AGG(description ORDER BY created_at DESC) FILTER (WHERE description IS NOT NULL))[1] as description,
  SUM(investment_count) as total_investment_count
FROM ranked_entities
GROUP BY personal_website
ORDER BY total_investment_count DESC;