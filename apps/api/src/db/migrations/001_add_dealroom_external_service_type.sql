SET search_path = public, pg_catalog;

-- Add DEALROOM to ExternalServiceType so the Dealroom adapter can store its
-- pasted API key (+ optional baseUrl) in automations.external_service_credentials.
-- Dealroom is a polled source: the trigger kind lives on automations.trigger.kind
-- (plain text), so no PipelineInputType value is needed.
--
-- Hand-written: the generator cannot diff an enum value.
ALTER TYPE automations."ExternalServiceType" ADD VALUE IF NOT EXISTS 'DEALROOM';
