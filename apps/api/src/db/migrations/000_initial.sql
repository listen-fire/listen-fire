--
-- Initial schema. Regenerate with:
--   pg_dump --schema-only --no-owner --exclude-schema=_migrations <db>
-- against a database built from src/db/schema.sql, then strip the
-- `COMMENT ON EXTENSION` blocks (they need extension ownership, which the
-- application role does not have) and the `FOR ROLE <owner>` clause pg_dump
-- adds to `ALTER DEFAULT PRIVILEGES` (the owning role is deployment-specific;
-- without it the statement applies to whoever runs the migration).
--
--
--
-- PostgreSQL database dump
--

-- Dumped from database version 15.7 (Debian 15.7-1.pgdg120+1)
-- Dumped by pg_dump version 16.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: asks; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA asks;


--
-- Name: automations; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA automations;


--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: knowledge; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA knowledge;


--
-- Name: valuations; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA valuations;


--
-- Name: btree_gin; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: ExternalServiceType; Type: TYPE; Schema: automations; Owner: -
--

CREATE TYPE automations."ExternalServiceType" AS ENUM (
    'SLACK',
    'AFFINITY',
    'ATTIO',
    'PIPEDRIVE',
    'MAILGUN',
    'TWILIO',
    'AIRTABLE',
    'GOOGLE',
    'GOOGLE_GMAIL',
    'DROPBOX',
    'SLACK_QUERY',
    'GRANOLA',
    'NATIVE_VALUATIONS',
    'NATIVE_KNOWLEDGE',
    'TELEGRAM',
    'REMOTE',
    'EVERTRACE'
);


--
-- Name: NativeDatabaseOperation; Type: TYPE; Schema: automations; Owner: -
--

CREATE TYPE automations."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);


--
-- Name: OpsDetailLevel; Type: TYPE; Schema: automations; Owner: -
--

CREATE TYPE automations."OpsDetailLevel" AS ENUM (
    'low',
    'medium',
    'full'
);


--
-- Name: NativeDatabaseOperation; Type: TYPE; Schema: core; Owner: -
--

CREATE TYPE core."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);


--
-- Name: LinkedObjectSource; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge."LinkedObjectSource" AS ENUM (
    'retrieval',
    'output',
    'manual',
    'input'
);


--
-- Name: NativeDatabaseOperation; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);


--
-- Name: RawTextPartType; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge."RawTextPartType" AS ENUM (
    'LINE_NUMBER',
    'EMBEDDING_CHUNK'
);


--
-- Name: ResourceType; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge."ResourceType" AS ENUM (
    'URL',
    'EMAIL',
    'WHATSAPP',
    'FILE',
    'TEXT'
);


--
-- Name: change_kind; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.change_kind AS ENUM (
    'property_set',
    'property_cleared',
    'edge_created',
    'edge_removed',
    'edge_retargeted',
    'node_created',
    'node_removed'
);


--
-- Name: change_source; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.change_source AS ENUM (
    'pipeline',
    'user_edit',
    'agent',
    'api',
    'mcp'
);


--
-- Name: evaluation_strategy; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.evaluation_strategy AS ENUM (
    'latest',
    'llm'
);


--
-- Name: evidence_type; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.evidence_type AS ENUM (
    'extraction',
    'user_edit',
    'retrieval',
    'input_mapping',
    'arbitration'
);


--
-- Name: node_type_category; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.node_type_category AS ENUM (
    'message',
    'object',
    'scoped_object'
);


--
-- Name: property_cardinality; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.property_cardinality AS ENUM (
    'single',
    'multi'
);


--
-- Name: property_identity; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.property_identity AS ENUM (
    'unique',
    'fuzzy',
    'none'
);


--
-- Name: property_value_type; Type: TYPE; Schema: knowledge; Owner: -
--

CREATE TYPE knowledge.property_value_type AS ENUM (
    'text',
    'number',
    'date',
    'boolean',
    'json'
);


--
-- Name: DealflowPipelineStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DealflowPipelineStatus" AS ENUM (
    'PROCESSING',
    'COMPLETE',
    'CANCELLED',
    'BLOCKED'
);


--
-- Name: NativeDatabaseOperation; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);


--
-- Name: OpsEventType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OpsEventType" AS ENUM (
    'PORTFOLIO',
    'DEALFLOW',
    'DIRECTORY',
    'LIVE_FEED',
    'ONBOARDING',
    'SCHEDULED_COMMS',
    'SUPPORT',
    'SOCIAL',
    'METRICS',
    'OVI',
    'AUTOMATION'
);


--
-- Name: OpsRunStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OpsRunStatus" AS ENUM (
    'running',
    'parked',
    'completed',
    'failed'
);


--
-- Name: OpsSeverity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OpsSeverity" AS ENUM (
    'info',
    'notable',
    'warn',
    'critical'
);


--
-- Name: PipelineInputContentType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PipelineInputContentType" AS ENUM (
    'DEALFLOW',
    'INVESTOR_UPDATE',
    'REQUEST',
    'UNKNOWN',
    'COMPANY_INFO'
);


--
-- Name: PipelineInputType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PipelineInputType" AS ENUM (
    'MAILGUN',
    'TWILIO',
    'INBOUND_EMAIL',
    'INBOUND_WHATSAPP',
    'API',
    'WEB',
    'SLACK',
    'CUSTOM_EMAIL',
    'WEB_QUESTION',
    'AIRTABLE',
    'CHROME_EXTENSION',
    'GMAIL',
    'GRANOLA',
    'ATTIO',
    'AFFINITY',
    'PIPEDRIVE',
    'NATIVE_VALUATIONS'
);


--
-- Name: PipelineOutputMode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PipelineOutputMode" AS ENUM (
    'PER_COMPANY',
    'PER_MESSAGE'
);


--
-- Name: PipelineOutputType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PipelineOutputType" AS ENUM (
    'WEBHOOK',
    'INBOUND_EMAIL',
    'INBOUND_WHATSAPP',
    'MAILGUN',
    'TWILIO',
    'ATTIO',
    'AFFINITY',
    'PIPEDRIVE',
    'SLACK',
    'SLACK_REACTION',
    'AIRTABLE',
    'GOOGLE_SHEETS',
    'GOOGLE_DRIVE',
    'DROPBOX',
    'NATIVE',
    'NATIVE_VALUATIONS'
);


--
-- Name: AssetType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."AssetType" AS ENUM (
    'CONVERTIBLE',
    'CURRENCY',
    'EMPLOYEE_STOCK_OPTIONS',
    'EQUITY',
    'EQUITY_UNKNOWN_SHARES',
    'LP_INTEREST_POINT',
    'SPV_INTEREST_POINT',
    'UNKNOWN',
    'FUND_OUTSTANDING_COMMITMENT',
    'ACCRUED_INCOME'
);


--
-- Name: CompanyLegalStatus; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."CompanyLegalStatus" AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'DISSOLVED'
);


--
-- Name: ConvertibleType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."ConvertibleType" AS ENUM (
    'ASA',
    'BSA_AIR',
    'CONVERTIBLE_NOTE',
    'LOAN',
    'POST_MONEY_SAFE',
    'PRE_MONEY_SAFE',
    'SAFT',
    'SEEDFAST',
    'SEEDNOTE',
    'SLIP'
);


--
-- Name: CurrencyIsoCode; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."CurrencyIsoCode" AS ENUM (
    'CHF',
    'EUR',
    'GBP',
    'NOK',
    'SEK',
    'USD',
    'DKK'
);


--
-- Name: EquityRoundType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."EquityRoundType" AS ENUM (
    'PRE_PRE_SEED',
    'PRE_SEED',
    'SEED',
    'SEED_EXT',
    'SERIES_A',
    'SERIES_A_EXT',
    'SERIES_A2',
    'SERIES_B',
    'SERIES_B_EXT',
    'SERIES_C',
    'SERIES_C_EXT',
    'SERIES_D',
    'SERIES_E',
    'SERIES_F',
    'SERIES_G',
    'SERIES_H',
    'SERIES_I',
    'SERIES_J',
    'UNKNOWN'
);


--
-- Name: EventType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."EventType" AS ENUM (
    'FOUNDER_EQUITY_SPLIT',
    'INVESTMENT_ROUND',
    'SHARE_SPLIT',
    'SHARE_REVERSE_SPLIT',
    'SECONDARY_SALE',
    'DISTRIBUTION',
    'DIVIDEND',
    'MARKDOWN',
    'FUND_DISTRIBUTION',
    'FUND_CLOSE',
    'SHARE_PRICE',
    'LIQUIDATION'
);


--
-- Name: InvestmentRoundType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."InvestmentRoundType" AS ENUM (
    'EQUITY',
    'CONVERTIBLE',
    'OTHER'
);


--
-- Name: InvestmentStatus; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."InvestmentStatus" AS ENUM (
    'ACTIVE',
    'REALISED',
    'STEALTH'
);


--
-- Name: InvestmentType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."InvestmentType" AS ENUM (
    'CASH',
    'EQUITY_TRANSFER'
);


--
-- Name: LegalEntityType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."LegalEntityType" AS ENUM (
    'COMPANY',
    'ESOP',
    'FUND',
    'NATURAL_PERSON',
    'PORTFOLIO_COMPANY',
    'SPV'
);


--
-- Name: NativeDatabaseOperation; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);


--
-- Name: NoteType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."NoteType" AS ENUM (
    'TRANSACTION',
    'PRICE',
    'EVENT',
    'PROFILE',
    'INVESTMENT'
);


--
-- Name: PriceType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."PriceType" AS ENUM (
    'FROM_PRICED_ROUND',
    'FROM_ASSET_HOLDER',
    'CONVERSION'
);


--
-- Name: ValuationType; Type: TYPE; Schema: valuations; Owner: -
--

CREATE TYPE valuations."ValuationType" AS ENUM (
    'PRE_MONEY',
    'POST_MONEY'
);


--
-- Name: audit(); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO automations.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::automations."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: current_actor_id(); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.actor_id', TRUE), '');
$$;


--
-- Name: current_actor_type(); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.actor_type', TRUE), '');
$$;


--
-- Name: current_context_id(); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.context_id', TRUE), '');
$$;


--
-- Name: current_team_id(); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.team_id', TRUE), '');
$$;


--
-- Name: set_created_fields(); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = automations.current_actor_id();
  NEW.team_id = NULLIF(automations.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(automations.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;


--
-- Name: set_session_context(text, text, text, text); Type: FUNCTION; Schema: automations; Owner: -
--

CREATE FUNCTION automations.set_session_context(p_team_id text, p_actor_type text, p_actor_id text, p_context_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('automations.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('automations.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('automations.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('automations.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;


--
-- Name: audit(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO core.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::core."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: current_actor_id(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.actor_id', TRUE), '');
$$;


--
-- Name: current_actor_type(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.actor_type', TRUE), '');
$$;


--
-- Name: current_context_id(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.context_id', TRUE), '');
$$;


--
-- Name: current_team_id(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.team_id', TRUE), '');
$$;


--
-- Name: set_created_fields(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = core.current_actor_id();
  NEW.team_id = NULLIF(core.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(core.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;


--
-- Name: set_session_context(text, text, text, text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.set_session_context(p_team_id text, p_actor_type text, p_actor_id text, p_context_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('core.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('core.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('core.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('core.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;


--
-- Name: audit(); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO knowledge.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::knowledge."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: current_actor_id(); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.actor_id', TRUE), '');
$$;


--
-- Name: current_actor_type(); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.actor_type', TRUE), '');
$$;


--
-- Name: current_context_id(); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.context_id', TRUE), '');
$$;


--
-- Name: current_team_id(); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.team_id', TRUE), '');
$$;


--
-- Name: edge_prop(uuid, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.edge_prop(edge_id uuid, prop_name text) RETURNS text
    LANGUAGE sql STABLE
    AS $_$
    SELECT p.value_text
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.edge_id = $1 AND pt.name = $2
    LIMIT 1
$_$;


--
-- Name: edge_prop_num(uuid, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.edge_prop_num(edge_id uuid, prop_name text) RETURNS numeric
    LANGUAGE sql STABLE
    AS $_$
    SELECT p.value_number
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.edge_id = $1 AND pt.name = $2
    LIMIT 1
$_$;


--
-- Name: prop(uuid, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.prop(node_id uuid, prop_name text) RETURNS text
    LANGUAGE sql STABLE
    AS $_$
    SELECT p.value_text
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$_$;


--
-- Name: prop_bool(uuid, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.prop_bool(node_id uuid, prop_name text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $_$
    SELECT p.value_boolean
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$_$;


--
-- Name: prop_date(uuid, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.prop_date(node_id uuid, prop_name text) RETURNS timestamp without time zone
    LANGUAGE sql STABLE
    AS $_$
    SELECT p.value_date
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$_$;


--
-- Name: prop_num(uuid, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.prop_num(node_id uuid, prop_name text) RETURNS numeric
    LANGUAGE sql STABLE
    AS $_$
    SELECT p.value_number
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$_$;


--
-- Name: set_created_fields(); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = knowledge.current_actor_id();
  NEW.team_id = NULLIF(knowledge.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(knowledge.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;


--
-- Name: set_session_context(text, text, text, text); Type: FUNCTION; Schema: knowledge; Owner: -
--

CREATE FUNCTION knowledge.set_session_context(p_team_id text, p_actor_type text, p_actor_id text, p_context_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('knowledge.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('knowledge.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('knowledge.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('knowledge.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;


--
-- Name: ascii_rotate_decrypt(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ascii_rotate_decrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  c text;
  idx int;
  ch_code int;
  K int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    IF ch_code BETWEEN 32 AND 126 THEN
      K := ascii(substring(key_text, ((idx - 1) % key_len) + 1, 1));
      K := (K % 95);
      ch_code := 32 + ((ch_code - 32 - K + 95) % 95);
      out_text := out_text || chr(ch_code);
    ELSE
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


--
-- Name: ascii_rotate_encrypt(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ascii_rotate_encrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  c text;
  kcode int;
  i int := 1;
  idx int;
  ch_code int;
  K int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    -- Only rotate printable ASCII 32..126; keep other chars unchanged
    IF ch_code BETWEEN 32 AND 126 THEN
      K := ascii(substring(key_text, ((idx - 1) % key_len) + 1, 1));
      -- reduce K into 0..94 (printable count) using modulo
      K := (K % 95);
      -- rotate in printable range:
      ch_code := 32 + ((ch_code - 32 + K) % 95);
      out_text := out_text || chr(ch_code);
    ELSE
      -- leave non-printable or non-ASCII unchanged (or handle differently)
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


--
-- Name: audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::"NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: class_rotate_decrypt(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.class_rotate_decrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  idx int;
  c text;
  ch_code int;
  key_char text;
  k_val int;
  k_mod int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    key_char := substring(key_text, ((idx - 1) % key_len) + 1, 1);

    -- same k_val logic as encrypt
    k_val := get_byte(convert_to(key_char, 'UTF8'), 0);

    IF ch_code BETWEEN 65 AND 90 THEN
      k_mod := k_val % 26;
      out_text := out_text || chr(65 + ((ch_code - 65 - k_mod + 26) % 26));

    ELSIF ch_code BETWEEN 97 AND 122 THEN
      k_mod := k_val % 26;
      out_text := out_text || chr(97 + ((ch_code - 97 - k_mod + 26) % 26));

    ELSIF ch_code BETWEEN 48 AND 57 THEN
      k_mod := k_val % 10;
      out_text := out_text || chr(48 + ((ch_code - 48 - k_mod + 10) % 10));

    ELSE
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


--
-- Name: class_rotate_encrypt(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.class_rotate_encrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  idx int;
  c text;
  ch_code int;
  key_char text;
  k_val int;
  k_mod int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    key_char := substring(key_text, ((idx - 1) % key_len) + 1, 1);

    -- use the first byte of the key char (works predictable for ASCII keys)
    k_val := get_byte(convert_to(key_char, 'UTF8'), 0);

    IF ch_code BETWEEN 65 AND 90 THEN
      -- Uppercase A..Z
      k_mod := k_val % 26;
      out_text := out_text || chr(65 + ((ch_code - 65 + k_mod) % 26));

    ELSIF ch_code BETWEEN 97 AND 122 THEN
      -- Lowercase a..z
      k_mod := k_val % 26;
      out_text := out_text || chr(97 + ((ch_code - 97 + k_mod) % 26));

    ELSIF ch_code BETWEEN 48 AND 57 THEN
      -- Digits 0..9
      k_mod := k_val % 10;
      out_text := out_text || chr(48 + ((ch_code - 48 + k_mod) % 10));

    ELSE
      -- Leave special / non-ASCII chars unchanged
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


--
-- Name: current_api_key_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_api_key_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_api_key_id', TRUE), '');
$$;


--
-- Name: current_context_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_context_id', TRUE), '');
$$;


--
-- Name: current_team_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_team_id', TRUE), '');
$$;


--
-- Name: current_user_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_user_id', TRUE), '');
$$;


--
-- Name: execute_agent_query(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_agent_query(query_text text) RETURNS SETOF json
    LANGUAGE plpgsql
    SET search_path TO 'public', 'valuations', 'pg_catalog'
    AS $$
BEGIN
    -- Verify context is set
    IF current_team_id() IS NULL THEN
        RAISE EXCEPTION 'Security violation: team context must be set before executing agent queries';
    END IF;

    -- Execute the query with RLS applied (agent role has NOBYPASSRLS)
    -- Wrapping in subquery prevents multiple statements
    RETURN QUERY EXECUTE format('SELECT row_to_json(_r) FROM (%s) _r', query_text);
END;
$$;


--
-- Name: set_created_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = current_user_id();
  NEW.team_id = current_team_id();
  NEW.context_id = current_context_id();
  RETURN NEW;
END;
$$;


--
-- Name: set_current_api_key_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_current_api_key_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_api_key_id', id, TRUE);
$$;


--
-- Name: set_current_context_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_current_context_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_context_id', id, TRUE);
$$;


--
-- Name: set_current_team_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_current_team_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_team_id', id, TRUE);
$$;


--
-- Name: set_current_user_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_current_user_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_user_id', id, TRUE);
$$;


--
-- Name: audit(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO valuations.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::valuations."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: current_actor_id(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.actor_id', TRUE), '');
$$;


--
-- Name: current_actor_type(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.actor_type', TRUE), '');
$$;


--
-- Name: current_context_id(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.context_id', TRUE), '');
$$;


--
-- Name: current_team_id(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.team_id', TRUE), '');
$$;


--
-- Name: legal_entity_search_vector_update(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.legal_entity_search_vector_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.legal_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.also_known_as, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.other_names, ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.personal_website, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.country, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D') ||
    to_tsvector('english', coalesce(array_to_string(ARRAY_CAT(ARRAY_CAT(NEW.business_model, NEW.customers), ARRAY_CAT(NEW.markets,NEW.themes)), ' '), ''));
  RETURN NEW;
END
$$;


--
-- Name: set_created_fields(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = valuations.current_actor_id();
  NEW.team_id = NULLIF(valuations.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(valuations.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;


--
-- Name: set_session_context(text, text, text, text); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.set_session_context(p_team_id text, p_actor_type text, p_actor_id text, p_context_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('valuations.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('valuations.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('valuations.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('valuations.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;


--
-- Name: valuations_outbox_capture(); Type: FUNCTION; Schema: valuations; Owner: -
--

CREATE FUNCTION valuations.valuations_outbox_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_actor_type text;
  v_actor_id uuid;
  v_team_id uuid;
  v_row_id uuid;
BEGIN
  -- V-17: the actor arrives on the unit's own GUCs, set from the Principal.
  -- Absent them (a worker, a migration) the write is the system's.
  v_actor_type := COALESCE(valuations.current_actor_type(), 'system');
  v_actor_id := NULLIF(valuations.current_actor_id(), '')::uuid;

  IF TG_OP = 'DELETE' THEN
    v_team_id := OLD.team_id;
    v_row_id := OLD.id;
  ELSE
    v_team_id := NEW.team_id;
    v_row_id := NEW.id;
  END IF;

  -- Shared rows (team_id IS NULL) have no webhook subscribers, and the outbox
  -- requires a team_id; capturing them would abort the parent write.
  IF v_team_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO valuations.valuations_change_outbox (
    entity,
    change_type,
    row_id,
    team_id,
    actor_type,
    actor_id,
    context_id,
    "before",
    "after"
  ) VALUES (
    TG_TABLE_NAME,
    TG_OP::valuations."NativeDatabaseOperation",
    v_row_id,
    v_team_id,
    v_actor_type,
    v_actor_id,
    valuations.current_context_id(),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ask; Type: TABLE; Schema: asks; Owner: -
--

CREATE TABLE asks.ask (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    family text NOT NULL,
    answer_type text,
    prompt text NOT NULL,
    detail text,
    options jsonb,
    rows jsonb,
    state text DEFAULT 'open'::text NOT NULL,
    answer jsonb,
    token text NOT NULL,
    token_expires_at timestamp with time zone NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    callback_url text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    answered_at timestamp with time zone,
    expired_at timestamp with time zone,
    CONSTRAINT ask_answer_type_check CHECK (((answer_type IS NULL) OR (answer_type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'boolean'::text])))),
    CONSTRAINT ask_family_check CHECK ((family = ANY (ARRAY['Check'::text, 'Provide'::text, 'Choose'::text, 'Select'::text, 'Review'::text, 'Correct'::text, 'Draft'::text, 'Form'::text]))),
    CONSTRAINT ask_state_check CHECK ((state = ANY (ARRAY['open'::text, 'answered'::text, 'expired'::text])))
);


--
-- Name: ask_webhook_delivery; Type: TABLE; Schema: asks; Owner: -
--

CREATE TABLE asks.ask_webhook_delivery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ask_id uuid NOT NULL,
    url text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT ask_webhook_delivery_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text])))
);


--
-- Name: worker_heartbeat; Type: TABLE; Schema: asks; Owner: -
--

CREATE TABLE asks.worker_heartbeat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker text NOT NULL,
    last_beat_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_success_at timestamp with time zone,
    last_error text,
    detail jsonb
);


--
-- Name: adapter_await; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.adapter_await (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    adapter_type text NOT NULL,
    correlation_key text NOT NULL,
    run_id uuid NOT NULL,
    team_id uuid NOT NULL,
    address text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op automations."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);


--
-- Name: audit_log_version_seq; Type: SEQUENCE; Schema: automations; Owner: -
--

CREATE SEQUENCE automations.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_version_seq; Type: SEQUENCE OWNED BY; Schema: automations; Owner: -
--

ALTER SEQUENCE automations.audit_log_version_seq OWNED BY automations.audit_log.version;


--
-- Name: callback; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.callback (
    id text NOT NULL,
    team_id uuid NOT NULL,
    run_id uuid NOT NULL,
    address text NOT NULL,
    params jsonb DEFAULT '[]'::jsonb NOT NULL,
    state jsonb NOT NULL,
    calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    single_use boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    status text DEFAULT 'live'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    fired_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT callback_status_check CHECK ((status = ANY (ARRAY['live'::text, 'fired'::text, 'revoked'::text])))
);


--
-- Name: connect_token; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.connect_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    adapter_slug text NOT NULL,
    credential_name text NOT NULL,
    credentials_id uuid,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: exposed_file; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.exposed_file (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    object_uri text NOT NULL,
    content_type text,
    filename text,
    expires_at timestamp(3) without time zone NOT NULL
);


--
-- Name: external_service_credentials; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.external_service_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    type automations."ExternalServiceType" NOT NULL,
    credentials bytea,
    reconnect_required_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    identifier text,
    app_id text
);


--
-- Name: google_granted_item; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.google_granted_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credentials_id uuid NOT NULL,
    item_id text NOT NULL,
    mime_type text NOT NULL,
    name text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: inbound_email_route; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.inbound_email_route (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    address public.citext NOT NULL,
    team_id uuid NOT NULL,
    is_service_email boolean DEFAULT false NOT NULL,
    accepts_plus_addressing boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: join_branch_export; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.join_branch_export (
    run_id uuid NOT NULL,
    frame_address text NOT NULL,
    branch_address text NOT NULL,
    branch_index integer NOT NULL,
    exports jsonb NOT NULL,
    decremented boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: join_pending; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.join_pending (
    run_id uuid NOT NULL,
    frame_address text NOT NULL,
    pending integer NOT NULL,
    closed_by_address text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT join_pending_pending_nonneg CHECK ((pending >= 0))
);


--
-- Name: movement; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.movement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    source text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    trigger_id uuid,
    current_version_id uuid,
    created_by_user_id uuid,
    validity_status text,
    validity_reason jsonb,
    validity_source_hash text,
    validity_checked_at timestamp with time zone,
    validity_consented_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT movement_validity_status_check CHECK ((validity_status = ANY (ARRAY['valid'::text, 'invalid'::text, 'unverified'::text])))
);


--
-- Name: movement_issue; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.movement_issue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    movement_id uuid NOT NULL,
    fingerprint text NOT NULL,
    failure_class text NOT NULL,
    message text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    threshold_alerted boolean DEFAULT false NOT NULL,
    sample_run_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT movement_issue_state_check CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text])))
);


--
-- Name: movement_story_token; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.movement_story_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movement_id uuid NOT NULL,
    team_id uuid NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: movement_version; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.movement_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movement_id uuid NOT NULL,
    team_id uuid NOT NULL,
    version_number integer NOT NULL,
    source text NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: outbound_email; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.outbound_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid,
    recipient_email text NOT NULL,
    subject text NOT NULL,
    kind text,
    provider text NOT NULL,
    success boolean NOT NULL,
    error text,
    CONSTRAINT outbound_email_provider_check CHECK ((provider = ANY (ARRAY['mailgun'::text, 'fake'::text, 'unconfigured'::text])))
);


--
-- Name: parked_run; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.parked_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    address text NOT NULL,
    status text DEFAULT 'parked'::text NOT NULL,
    state jsonb,
    result jsonb,
    park_reason text DEFAULT 'ask'::text NOT NULL,
    wake_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT parked_run_park_reason_check CHECK ((park_reason = ANY (ARRAY['ask'::text, 'timer'::text, 'await'::text]))),
    CONSTRAINT parked_run_status_check CHECK ((status = ANY (ARRAY['parked'::text, 'completed'::text])))
);


--
-- Name: phone_number; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.phone_number (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    phone_number text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_test_number boolean DEFAULT false NOT NULL,
    name text,
    word_identifier text,
    emoji_code text,
    verified_at timestamp(3) without time zone,
    CONSTRAINT user_phone_number_phone_number_whitespace_check CHECK ((TRIM(BOTH FROM phone_number) = phone_number))
);


--
-- Name: phone_verification; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.phone_verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone_number text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    consumed_at timestamp(3) without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    send_count integer DEFAULT 1 NOT NULL,
    last_sent_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: platform_owned_token; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.platform_owned_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    adapter_type text NOT NULL,
    external_token_id text NOT NULL,
    description text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp(3) without time zone
);


--
-- Name: record_binding; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.record_binding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    a_adapter_type text NOT NULL,
    a_instance_key text NOT NULL,
    a_type_id text NOT NULL,
    a_record_id text NOT NULL,
    b_adapter_type text NOT NULL,
    b_instance_key text NOT NULL,
    b_type_id text NOT NULL,
    b_record_id text NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: remote_adapter; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.remote_adapter (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    adapter_type text NOT NULL,
    base_url text NOT NULL,
    auth_strategy jsonb NOT NULL,
    credentials_id uuid,
    manifest jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: team_settings; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.team_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    ops_detail_level automations."OpsDetailLevel" DEFAULT 'low'::automations."OpsDetailLevel" NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_identity; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.telegram_identity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    telegram_user_id text NOT NULL,
    email text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_token; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.telegram_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    native_user_id uuid NOT NULL,
    team_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trigger; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.trigger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    pipeline_configuration_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    credentials_id uuid,
    movement_id uuid,
    fired_movement_name text,
    run_mode text DEFAULT 'live'::text NOT NULL,
    cron_last_fired_at timestamp with time zone,
    poll_checkpoint jsonb,
    poll_last_at timestamp with time zone,
    resolved_address jsonb,
    guard_paused_at timestamp with time zone,
    guard_paused_reason text,
    guard_paused_signal text,
    notes text DEFAULT ''::text NOT NULL,
    provisioned_by_setup_agent boolean DEFAULT false NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: trigger_event; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.trigger_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    trigger_id text NOT NULL,
    adapter_type text NOT NULL,
    trigger_type text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    dispatched_at timestamp(3) with time zone,
    failure_reason text,
    dropped_reason text,
    external_event_id text,
    occurred_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: trigger_run; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.trigger_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    trigger_id text NOT NULL,
    trigger_type text NOT NULL,
    status text NOT NULL,
    record_id text,
    movement_version_id uuid,
    trigger_payload jsonb,
    changed_fields text[],
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    diagnostics jsonb DEFAULT '{}'::jsonb NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    nodes_written integer DEFAULT 0 NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    started_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp(3) with time zone,
    failed_at timestamp(3) with time zone,
    failure_reason text,
    cancel_requested_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ops_run_id uuid
);


--
-- Name: webhook_subscription; Type: TABLE; Schema: automations; Owner: -
--

CREATE TABLE automations.webhook_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    provider text NOT NULL,
    credentials_id uuid,
    external_webhook_id text,
    webhook_secret text NOT NULL,
    subscriptions jsonb DEFAULT '[]'::jsonb NOT NULL,
    inbound_checkpoint jsonb,
    scope jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    provisioned_by text,
    deleted_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: api_key; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.api_key (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    scopes text[] DEFAULT ARRAY['ingest'::text] NOT NULL,
    last_used_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone,
    revoked_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    pipeline_input_id uuid
);


--
-- Name: TABLE api_key; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.api_key IS 'API keys for authenticated external API access. Keys are hashed and shown only once on creation.';


--
-- Name: COLUMN api_key.key_hash; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.api_key.key_hash IS 'SHA-256 hash of the full API key';


--
-- Name: COLUMN api_key.key_prefix; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.api_key.key_prefix IS 'First 12 characters of the key for identification in UI (e.g., "lf_live_abc1")';


--
-- Name: COLUMN api_key.scopes; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.api_key.scopes IS 'Permissions granted to this key, e.g., ["ingest"], ["ingest", "ask"]';


--
-- Name: COLUMN api_key.pipeline_input_id; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.api_key.pipeline_input_id IS 'Optional link to a specific pipeline input. When set, API requests using this key will be routed to this input instead of the default API input.';


--
-- Name: audit_log; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op core."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);


--
-- Name: audit_log_version_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_version_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.audit_log_version_seq OWNED BY core.audit_log.version;


--
-- Name: magic_link_token; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.magic_link_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pending_signup; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.pending_signup (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    terms_accepted boolean DEFAULT true NOT NULL,
    token_hash text NOT NULL,
    source text,
    attribution jsonb,
    name text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: team; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.team (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    auto_add_company_to_portfolio_via_update boolean DEFAULT true NOT NULL,
    active_pipeline_configuration_id uuid,
    default_user_id uuid,
    domain text
);


--
-- Name: team_invite; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.team_invite (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    email public.citext NOT NULL,
    invited_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: team_membership; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.team_membership (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid NOT NULL,
    access text NOT NULL,
    is_personal boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    default_team_id uuid NOT NULL,
    is_platform_admin boolean DEFAULT false NOT NULL,
    username public.citext NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    public_profile_id uuid,
    last_reminded_at timestamp(3) without time zone,
    completed_registration_at timestamp(3) without time zone,
    first_opened_connections_at timestamp(3) without time zone,
    granted_access_at timestamp(3) without time zone,
    sent_demo_deck_at timestamp(3) without time zone,
    recommendation_list_active boolean DEFAULT false NOT NULL,
    recommendation_list_dismissed boolean DEFAULT false NOT NULL,
    recommendation_list_dismissed_by_user_at timestamp(3) without time zone,
    is_internal boolean DEFAULT false NOT NULL,
    invitation_code text,
    password_hash text,
    password_updated_at timestamp with time zone,
    terms_accepted_at timestamp with time zone,
    name text
);


--
-- Name: user_email; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.user_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    email public.citext NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_service_email boolean DEFAULT false NOT NULL,
    accepts_plus_addressing boolean DEFAULT false NOT NULL,
    is_billing_contact boolean DEFAULT false NOT NULL,
    CONSTRAINT user_email_email_whitespace_check CHECK ((TRIM(BOTH FROM email) = (email)::text))
);


--
-- Name: audit_log; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op knowledge."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);


--
-- Name: audit_log_version_seq; Type: SEQUENCE; Schema: knowledge; Owner: -
--

CREATE SEQUENCE knowledge.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_version_seq; Type: SEQUENCE OWNED BY; Schema: knowledge; Owner: -
--

ALTER SEQUENCE knowledge.audit_log_version_seq OWNED BY knowledge.audit_log.version;


--
-- Name: change; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.change (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    request_id uuid NOT NULL,
    source knowledge.change_source NOT NULL,
    kind knowledge.change_kind NOT NULL,
    node_id uuid,
    property_id uuid,
    edge_id uuid,
    evidence_id uuid,
    old_value jsonb,
    new_value jsonb,
    created_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: document; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.document (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    description text NOT NULL,
    object_uri text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid,
    checksum text,
    raw_text_id uuid
);


--
-- Name: edge; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.edge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    edge_type_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: edge_type; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.edge_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    outbound_name text NOT NULL,
    inbound_name text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source_node_type_id uuid NOT NULL,
    target_node_type_id uuid NOT NULL,
    required boolean DEFAULT false NOT NULL,
    scopes boolean DEFAULT false NOT NULL,
    filters jsonb DEFAULT '[]'::jsonb NOT NULL,
    edge_group text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: evidence; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    property_id uuid,
    edge_id uuid,
    source_ref jsonb,
    linked_object_id uuid,
    linked_object_field text,
    type knowledge.evidence_type NOT NULL,
    description text NOT NULL,
    excerpt text,
    mutation_context jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT evidence_target_check CHECK ((((property_id IS NOT NULL) AND (edge_id IS NULL)) OR ((property_id IS NULL) AND (edge_id IS NOT NULL))))
);


--
-- Name: extraction_fact; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.extraction_fact (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    message_node_id uuid NOT NULL,
    resource_id uuid,
    subject text NOT NULL,
    predicate text NOT NULL,
    object text NOT NULL,
    embedding public.vector(256),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: extraction_graph; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.extraction_graph (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    root_node_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: extraction_graph_edge; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.extraction_graph_edge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    extraction_graph_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    edge_type_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: extraction_graph_node; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.extraction_graph_node (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    extraction_graph_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    property_overrides jsonb,
    edge_property_overrides jsonb,
    sort_order integer DEFAULT 0 NOT NULL,
    instructions text,
    expand boolean DEFAULT false NOT NULL,
    gather boolean DEFAULT false NOT NULL,
    filters jsonb DEFAULT '[]'::jsonb NOT NULL,
    content_plugins jsonb,
    entity_plugins jsonb,
    default_property_mappings jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: linked_object; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.linked_object (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_id uuid NOT NULL,
    source knowledge."LinkedObjectSource" DEFAULT 'retrieval'::knowledge."LinkedObjectSource" NOT NULL,
    adapter_type text DEFAULT ''::text NOT NULL,
    external_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    retrieval_source_id uuid,
    output_id uuid,
    action_node_id text,
    external_object_type text,
    fetched_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: mutation_outbox; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.mutation_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    node_id uuid,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    delivered_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_error text
);


--
-- Name: node; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.node (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    start_date timestamp(3) without time zone DEFAULT '-infinity'::timestamp without time zone NOT NULL,
    end_date timestamp(3) without time zone DEFAULT 'infinity'::timestamp without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    summary text,
    summary_tsvector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(summary, ''::text))) STORED
);


--
-- Name: node_resource; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.node_resource (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    start_offset integer,
    end_offset integer,
    excerpt text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: node_type; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.node_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category knowledge.node_type_category NOT NULL,
    icon_svg text,
    icon_metaphor text,
    display_name_template text,
    display_name_expression jsonb,
    sort_order integer DEFAULT 0 NOT NULL,
    uniqueness_constraints jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: output_run; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.output_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    pipeline_output_id uuid NOT NULL,
    action_node_id text NOT NULL,
    context_node_id uuid,
    adapter_type text NOT NULL,
    external_id text,
    external_object_type text,
    status text DEFAULT 'success'::text NOT NULL,
    error text,
    field_values jsonb,
    run_group_id uuid,
    created boolean,
    dealflow_pipeline_id uuid,
    root_node_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: plugin; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.plugin (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    name text NOT NULL,
    description text,
    type text DEFAULT 'bundled'::text NOT NULL,
    endpoint text,
    method text DEFAULT 'POST'::text NOT NULL,
    auth jsonb,
    headers jsonb,
    stages text[] DEFAULT '{content,entity}'::text[] NOT NULL,
    config_schema jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: property; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.property (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_id uuid,
    edge_id uuid,
    property_type_id uuid NOT NULL,
    value_text text,
    value_text_array text[],
    value_number numeric,
    value_date timestamp(3) without time zone,
    value_boolean boolean,
    value_json jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    value_text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(value_text, ''::text))) STORED,
    CONSTRAINT property_owner_check CHECK ((((node_id IS NOT NULL) AND (edge_id IS NULL)) OR ((node_id IS NULL) AND (edge_id IS NOT NULL))))
);


--
-- Name: property_arbitration; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.property_arbitration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    property_id uuid NOT NULL,
    enqueued_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    resolved_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_error text
);


--
-- Name: property_type; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.property_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_type_id uuid,
    edge_type_id uuid,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    value_type knowledge.property_value_type NOT NULL,
    identity knowledge.property_identity NOT NULL,
    evaluation_strategy knowledge.evaluation_strategy NOT NULL,
    cardinality knowledge.property_cardinality DEFAULT 'single'::knowledge.property_cardinality NOT NULL,
    enum_values text[],
    writable_by knowledge.evidence_type[],
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT property_type_owner_check CHECK ((((node_type_id IS NOT NULL) AND (edge_type_id IS NULL)) OR ((node_type_id IS NULL) AND (edge_type_id IS NOT NULL))))
);


--
-- Name: raw_text; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.raw_text (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content text NOT NULL,
    checksum text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid NOT NULL,
    embedding public.vector(3072),
    is_chunked boolean DEFAULT false NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED
);


--
-- Name: raw_text_part; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.raw_text_part (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    raw_text_id uuid NOT NULL,
    type knowledge."RawTextPartType" NOT NULL,
    start integer NOT NULL,
    "end" integer NOT NULL,
    compressed_content text,
    content text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    classifications text[] DEFAULT ARRAY[]::text[],
    embedding public.vector(3072),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED
);


--
-- Name: recipe; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.recipe (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    instructions text NOT NULL,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: resource; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.resource (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    type knowledge."ResourceType" NOT NULL,
    url text,
    document_id uuid,
    raw_text_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "retrievedAt" timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    name text NOT NULL,
    created_by uuid,
    inbound_payload_id uuid,
    external_id text,
    external_adapter_type text
);


--
-- Name: saved_filter; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.saved_filter (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    filters jsonb DEFAULT '[]'::jsonb NOT NULL,
    conjunction text DEFAULT 'and'::text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: team_agent_settings; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.team_agent_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    style_preferences text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_endpoint; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.webhook_endpoint (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    url text NOT NULL,
    event_types text[] DEFAULT '{}'::text[] NOT NULL,
    secret text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: worker_heartbeat; Type: TABLE; Schema: knowledge; Owner: -
--

CREATE TABLE knowledge.worker_heartbeat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker text NOT NULL,
    last_beat_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_success_at timestamp with time zone,
    last_error text,
    detail jsonb
);


--
-- Name: agent_conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_conversation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    agent_type text DEFAULT 'knowledge_query'::text NOT NULL,
    active_agent text DEFAULT 'query'::text NOT NULL,
    handoff_depth integer DEFAULT 0 NOT NULL,
    working_document_uri text,
    working_document_title text,
    document_mode text DEFAULT 'collaborating'::text NOT NULL,
    funnel_context jsonb,
    navigation_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    navigation_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: agent_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_message (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    context text,
    agent text,
    message_type text DEFAULT 'chat'::text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op public."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);


--
-- Name: audit_log_version_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_version_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_version_seq OWNED BY public.audit_log.version;


--
-- Name: context_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    team_id uuid NOT NULL,
    request_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: dealflow_pipeline; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dealflow_pipeline (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    status public."DealflowPipelineStatus" DEFAULT 'PROCESSING'::public."DealflowPipelineStatus" NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    request_id uuid NOT NULL,
    errors jsonb,
    numeric_id bigint NOT NULL,
    final_graph jsonb
);


--
-- Name: dealflow_pipeline_numeric_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dealflow_pipeline_numeric_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dealflow_pipeline_numeric_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dealflow_pipeline_numeric_id_seq OWNED BY public.dealflow_pipeline.numeric_id;


--
-- Name: dropped_inbound_email; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dropped_inbound_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid NOT NULL,
    request_id text NOT NULL,
    reason text NOT NULL,
    recipients text[] NOT NULL,
    body jsonb NOT NULL,
    replayed_at timestamp(3) without time zone
);


--
-- Name: inbound_payload; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbound_payload (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel public."PipelineInputType",
    data jsonb NOT NULL,
    message_type text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    team_id uuid NOT NULL,
    request_id uuid NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    "isContext" boolean,
    "isContextRequest" boolean,
    "isInjection" boolean,
    pipeline_input_id uuid,
    dedup_id text
);


--
-- Name: integration_suggestion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_suggestion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext,
    tool_name text NOT NULL,
    note text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: inventory_delta_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_delta_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    investment_id uuid NOT NULL,
    close_date date NOT NULL,
    has_non_cash_investment boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: inventory_delta_holding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_delta_holding (
    event_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    asset_type valuations."AssetType" NOT NULL,
    degree integer NOT NULL,
    is_inflow boolean NOT NULL,
    num_assets double precision NOT NULL,
    tracks_investee boolean DEFAULT true NOT NULL
);


--
-- Name: llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    call_type text NOT NULL,
    label text,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL,
    cost_microdollars integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    pipeline_id uuid,
    conversation_id uuid,
    trigger_run_id uuid,
    byot boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: log_version_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notion_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notion_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    token text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ops_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    type public."OpsEventType" NOT NULL,
    severity public."OpsSeverity" DEFAULT 'notable'::public."OpsSeverity" NOT NULL,
    team_id uuid,
    title text NOT NULL,
    detail jsonb,
    entity_refs jsonb,
    request_id text,
    parent_run_id uuid,
    status public."OpsRunStatus",
    updated_at timestamp(3) without time zone,
    resolved_at timestamp with time zone
);


--
-- Name: pipeline_configuration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_configuration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone
);


--
-- Name: pipeline_input; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_input (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_configuration_id uuid NOT NULL,
    type public."PipelineInputType" NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone,
    content_type public."PipelineInputContentType" NOT NULL,
    credentials_id uuid,
    knowledge_enabled boolean DEFAULT false NOT NULL,
    dealflow_enabled boolean DEFAULT true NOT NULL,
    default_for public."PipelineInputType",
    poll_interval_minutes integer,
    poll_checkpoint jsonb,
    poll_enabled boolean DEFAULT false NOT NULL,
    poll_last_at timestamp(3) with time zone,
    poll_consecutive_failures integer DEFAULT 0 NOT NULL,
    poll_last_error text,
    tg_event_body jsonb,
    provisioned_by_setup_agent boolean DEFAULT false NOT NULL
);


--
-- Name: pipeline_input_message_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_input_message_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_input_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    property_mappings jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pipeline_output; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_output (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_configuration_id uuid NOT NULL,
    type public."PipelineOutputType" NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone,
    credentials_id uuid,
    mode public."PipelineOutputMode" DEFAULT 'PER_COMPANY'::public."PipelineOutputMode" NOT NULL,
    config_version integer DEFAULT 1 NOT NULL,
    run_mode text DEFAULT 'live'::text NOT NULL,
    trigger_node_type_id uuid,
    trigger_event text,
    trigger jsonb,
    "position" integer DEFAULT 0 NOT NULL,
    tg_event_body jsonb,
    provisioned_by_setup_agent boolean DEFAULT false NOT NULL
);


--
-- Name: portfolio_company_metric; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_company_metric (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    investor_id uuid NOT NULL,
    company_id uuid NOT NULL,
    owned double precision,
    markdown_date date,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: profile_email; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    email public.citext NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid
);


--
-- Name: profile_public_round; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_public_round (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    round_type valuations."EquityRoundType" NOT NULL,
    announced_date date,
    announced_amount double precision,
    announced_currency valuations."CurrencyIsoCode",
    announced_valuation double precision,
    valuation_type valuations."ValuationType",
    press_release_url text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source text,
    lead_investor_id uuid,
    raw_text text
);


--
-- Name: profile_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    description text,
    entity_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone
);


--
-- Name: push_subscription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    admin_user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    device_label text
);


--
-- Name: resource_payload; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_payload (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    resource_id uuid NOT NULL,
    inbound_payload_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: resource_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_source (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legal_entity_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    team_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: signup_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signup_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    team_id uuid NOT NULL,
    channel text NOT NULL,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    utm_term text,
    utm_content text,
    referrer text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: team_journey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_journey (
    team_id uuid NOT NULL,
    first_automation_saved_at timestamp with time zone,
    first_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_usage_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_usage_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    max_weekly_pipeline_runs integer NOT NULL,
    max_weekly_query_inputs integer NOT NULL,
    additional_pipeline_runs integer DEFAULT 0 NOT NULL,
    additional_query_inputs integer DEFAULT 0 NOT NULL,
    alert_threshold_pct integer DEFAULT 80 NOT NULL,
    week_starts_on integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: usage_alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_alert (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    alert_kind text NOT NULL,
    period_start timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: usage_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    reference_id uuid,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_journey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_journey (
    user_id uuid NOT NULL,
    mcp_connected_at timestamp with time zone,
    first_mcp_call_at timestamp with time zone,
    first_mcp_tool text,
    first_automation_saved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    issued_by_legal_entity_id uuid,
    name text NOT NULL,
    properties jsonb NOT NULL,
    type valuations."AssetType" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    annualised_interest_rate double precision,
    conversion_date date,
    conversion_price double precision,
    convertible_amount double precision,
    convertible_currency valuations."CurrencyIsoCode",
    convertible_investor_id uuid,
    convertible_type valuations."ConvertibleType",
    discount_rate double precision,
    interest double precision,
    issued_at date,
    maturity_date date,
    valuation_cap double precision
);


--
-- Name: asset_transfer; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.asset_transfer (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    date date NOT NULL,
    from_legal_entity_id uuid NOT NULL,
    num_assets double precision,
    to_legal_entity_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op valuations."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);


--
-- Name: audit_log_version_seq; Type: SEQUENCE; Schema: valuations; Owner: -
--

CREATE SEQUENCE valuations.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_version_seq; Type: SEQUENCE OWNED BY; Schema: valuations; Owner: -
--

ALTER SEQUENCE valuations.audit_log_version_seq OWNED BY valuations.audit_log.version;


--
-- Name: currency_asset; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.currency_asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    iso_code valuations."CurrencyIsoCode" NOT NULL,
    name text NOT NULL,
    symbol text NOT NULL,
    pair_order smallint NOT NULL,
    type valuations."AssetType" DEFAULT 'CURRENCY'::valuations."AssetType" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: event; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    date date NOT NULL,
    legal_entity_id uuid NOT NULL,
    name text NOT NULL,
    type valuations."EventType" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    data jsonb,
    acquirer_id uuid,
    asset_type valuations."AssetType",
    investment_round_type valuations."InvestmentRoundType" DEFAULT 'EQUITY'::valuations."InvestmentRoundType",
    public_round_id uuid,
    raised_amount double precision,
    raised_currency valuations."CurrencyIsoCode",
    round_type valuations."EquityRoundType",
    url_press_release text,
    valuation double precision,
    valuation_currency valuations."CurrencyIsoCode",
    valuation_type valuations."ValuationType"
);


--
-- Name: exchange_rate; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.exchange_rate (
    date date NOT NULL,
    from_currency valuations."CurrencyIsoCode" NOT NULL,
    rate double precision NOT NULL,
    to_currency valuations."CurrencyIsoCode" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: funding_changelog; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.funding_changelog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    legal_entity_id uuid NOT NULL,
    user_id uuid,
    description text NOT NULL,
    category text,
    event_date date,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: funding_changelog_fund; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.funding_changelog_fund (
    changelog_id uuid NOT NULL,
    fund_id uuid NOT NULL
);


--
-- Name: investment; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.investment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    investor_profile_id uuid NOT NULL,
    investment_profile_id uuid NOT NULL,
    round_type valuations."EquityRoundType",
    invested_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid,
    verified boolean DEFAULT false NOT NULL,
    public_round_id uuid,
    event_id uuid,
    fully_exited_at timestamp(3) without time zone,
    exit_event_id uuid,
    type valuations."InvestmentType" DEFAULT 'CASH'::valuations."InvestmentType" NOT NULL
);


--
-- Name: investment_attribution; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.investment_attribution (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    investment_id uuid NOT NULL,
    legal_entity_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: legal_entity; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.legal_entity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text,
    image_url text,
    description text,
    country text,
    city text,
    personal_website text,
    type valuations."LegalEntityType",
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    inferred_thesis text,
    locations text[] DEFAULT ARRAY[]::text[],
    public_profile_id uuid,
    stages text[] DEFAULT ARRAY[]::text[],
    team_id uuid,
    themes text[] DEFAULT ARRAY[]::text[],
    linkedin text,
    operated_by_profile_id uuid,
    business_model text[] DEFAULT ARRAY[]::text[],
    customers text[] DEFAULT ARRAY[]::text[],
    markets text[] DEFAULT ARRAY[]::text[],
    short_description text,
    investment_status valuations."InvestmentStatus" DEFAULT 'ACTIVE'::valuations."InvestmentStatus" NOT NULL,
    descriptors_geo text[] DEFAULT ARRAY[]::text[],
    descriptors_investor_type text[] DEFAULT ARRAY[]::text[],
    descriptors_misc_tags text[] DEFAULT ARRAY[]::text[],
    descriptors_stage text[] DEFAULT ARRAY[]::text[],
    email text,
    identifiers text[] DEFAULT ARRAY[]::text[],
    summary_for_similarity_search text,
    market_short text,
    linkedin_data jsonb,
    is_own_investing_entity boolean,
    company_metrics_id uuid,
    company_profile_id uuid,
    investing_entity_id uuid,
    is_deprecated boolean,
    is_portfolio boolean,
    legal_name text,
    name text NOT NULL,
    also_known_as text,
    acquired_by_legal_entity_id uuid,
    search_vector tsvector,
    underlying_company_id uuid,
    custom_values jsonb DEFAULT '{}'::jsonb,
    point_of_contact_user_id uuid,
    acquired_at timestamp(3) without time zone,
    acquired_event_id uuid,
    legal_status valuations."CompanyLegalStatus" DEFAULT 'ACTIVE'::valuations."CompanyLegalStatus" NOT NULL,
    other_names text[] DEFAULT ARRAY[]::text[],
    sentiment_score double precision,
    visibility_score double precision,
    invitation_code text,
    sectors text[] DEFAULT ARRAY[]::text[],
    experiments_active text[] DEFAULT ARRAY[]::text[],
    word_identifier text,
    CONSTRAINT investor_profile_slug_whitespace_check CHECK ((TRIM(BOTH FROM slug) = slug))
);


--
-- Name: TABLE legal_entity; Type: COMMENT; Schema: valuations; Owner: -
--

COMMENT ON TABLE valuations.legal_entity IS 'A legal entity represents a company, person, fund, or other organization. "legal_entity" is used interchangeably with "profile" in the application.';


--
-- Name: COLUMN legal_entity.type; Type: COMMENT; Schema: valuations; Owner: -
--

COMMENT ON COLUMN valuations.legal_entity.type IS 'The type of legal entity, such as company, fund, or natural person. See valuations."LegalEntityType" for possible values.';


--
-- Name: note; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.note (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    message text NOT NULL,
    note_type valuations."NoteType" NOT NULL,
    reference_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid,
    source text
);


--
-- Name: outbound_delivery; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.outbound_delivery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    delivered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: price; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.price (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    date date NOT NULL,
    price double precision NOT NULL,
    currency valuations."CurrencyIsoCode" NOT NULL,
    asset_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    event_id uuid,
    type valuations."PriceType" NOT NULL,
    legal_entity_id uuid
);


--
-- Name: team_settings; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.team_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    own_entity_id uuid,
    default_investing_entity_id uuid,
    reporting_currency valuations."CurrencyIsoCode",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transaction; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.transaction (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    close_date date NOT NULL,
    event_id uuid,
    converted_to_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    investment_id uuid,
    due_to_rights_from_asset_id uuid
);


--
-- Name: valuations_change_outbox; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.valuations_change_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity text NOT NULL,
    change_type valuations."NativeDatabaseOperation" NOT NULL,
    row_id uuid NOT NULL,
    team_id uuid NOT NULL,
    actor_type text,
    actor_id uuid,
    context_id text,
    before jsonb,
    after jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: webhook_subscription; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.webhook_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    url text NOT NULL,
    event_type text NOT NULL,
    secret text,
    name text NOT NULL,
    disabled_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: worker_heartbeat; Type: TABLE; Schema: valuations; Owner: -
--

CREATE TABLE valuations.worker_heartbeat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker text NOT NULL,
    last_beat_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_success_at timestamp with time zone,
    last_error text,
    detail jsonb
);


--
-- Name: audit_log version; Type: DEFAULT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.audit_log ALTER COLUMN version SET DEFAULT nextval('automations.audit_log_version_seq'::regclass);


--
-- Name: audit_log version; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.audit_log ALTER COLUMN version SET DEFAULT nextval('core.audit_log_version_seq'::regclass);


--
-- Name: audit_log version; Type: DEFAULT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.audit_log ALTER COLUMN version SET DEFAULT nextval('knowledge.audit_log_version_seq'::regclass);


--
-- Name: audit_log version; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN version SET DEFAULT nextval('public.audit_log_version_seq'::regclass);


--
-- Name: dealflow_pipeline numeric_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dealflow_pipeline ALTER COLUMN numeric_id SET DEFAULT nextval('public.dealflow_pipeline_numeric_id_seq'::regclass);


--
-- Name: audit_log version; Type: DEFAULT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.audit_log ALTER COLUMN version SET DEFAULT nextval('valuations.audit_log_version_seq'::regclass);


--
-- Name: ask ask_pkey; Type: CONSTRAINT; Schema: asks; Owner: -
--

ALTER TABLE ONLY asks.ask
    ADD CONSTRAINT ask_pkey PRIMARY KEY (id);


--
-- Name: ask ask_token_unique; Type: CONSTRAINT; Schema: asks; Owner: -
--

ALTER TABLE ONLY asks.ask
    ADD CONSTRAINT ask_token_unique UNIQUE (token);


--
-- Name: ask_webhook_delivery ask_webhook_delivery_pkey; Type: CONSTRAINT; Schema: asks; Owner: -
--

ALTER TABLE ONLY asks.ask_webhook_delivery
    ADD CONSTRAINT ask_webhook_delivery_pkey PRIMARY KEY (id);


--
-- Name: worker_heartbeat worker_heartbeat_pkey; Type: CONSTRAINT; Schema: asks; Owner: -
--

ALTER TABLE ONLY asks.worker_heartbeat
    ADD CONSTRAINT worker_heartbeat_pkey PRIMARY KEY (id);


--
-- Name: adapter_await adapter_await_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.adapter_await
    ADD CONSTRAINT adapter_await_pkey PRIMARY KEY (id);


--
-- Name: adapter_await adapter_await_run_address_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.adapter_await
    ADD CONSTRAINT adapter_await_run_address_unique UNIQUE (run_id, address);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: callback callback_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.callback
    ADD CONSTRAINT callback_pkey PRIMARY KEY (id);


--
-- Name: connect_token connect_token_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.connect_token
    ADD CONSTRAINT connect_token_pkey PRIMARY KEY (id);


--
-- Name: connect_token connect_token_token_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.connect_token
    ADD CONSTRAINT connect_token_token_unique UNIQUE (token);


--
-- Name: exposed_file exposed_file_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.exposed_file
    ADD CONSTRAINT exposed_file_pkey PRIMARY KEY (id);


--
-- Name: external_service_credentials external_service_credentials_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.external_service_credentials
    ADD CONSTRAINT external_service_credentials_pkey PRIMARY KEY (id);


--
-- Name: external_service_credentials external_service_credentials_team_name_key; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.external_service_credentials
    ADD CONSTRAINT external_service_credentials_team_name_key UNIQUE (team_id, name);


--
-- Name: google_granted_item google_granted_item_credentials_id_item_id_key; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.google_granted_item
    ADD CONSTRAINT google_granted_item_credentials_id_item_id_key UNIQUE (credentials_id, item_id);


--
-- Name: google_granted_item google_granted_item_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.google_granted_item
    ADD CONSTRAINT google_granted_item_pkey PRIMARY KEY (id);


--
-- Name: inbound_email_route inbound_email_route_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.inbound_email_route
    ADD CONSTRAINT inbound_email_route_pkey PRIMARY KEY (id);


--
-- Name: join_branch_export join_branch_export_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.join_branch_export
    ADD CONSTRAINT join_branch_export_pkey PRIMARY KEY (run_id, frame_address, branch_address);


--
-- Name: join_pending join_pending_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.join_pending
    ADD CONSTRAINT join_pending_pkey PRIMARY KEY (run_id, frame_address);


--
-- Name: movement_issue movement_issue_movement_fingerprint_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_issue
    ADD CONSTRAINT movement_issue_movement_fingerprint_unique UNIQUE (movement_id, fingerprint);


--
-- Name: movement_issue movement_issue_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_issue
    ADD CONSTRAINT movement_issue_pkey PRIMARY KEY (id);


--
-- Name: movement movement_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_pkey PRIMARY KEY (id);


--
-- Name: movement_story_token movement_story_token_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_story_token
    ADD CONSTRAINT movement_story_token_pkey PRIMARY KEY (id);


--
-- Name: movement_story_token movement_story_token_token_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_story_token
    ADD CONSTRAINT movement_story_token_token_unique UNIQUE (token);


--
-- Name: movement movement_team_name_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_team_name_unique UNIQUE (team_id, name);


--
-- Name: movement_version movement_version_number_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_version
    ADD CONSTRAINT movement_version_number_unique UNIQUE (movement_id, version_number);


--
-- Name: movement_version movement_version_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_version
    ADD CONSTRAINT movement_version_pkey PRIMARY KEY (id);


--
-- Name: outbound_email outbound_email_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.outbound_email
    ADD CONSTRAINT outbound_email_pkey PRIMARY KEY (id);


--
-- Name: parked_run parked_run_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.parked_run
    ADD CONSTRAINT parked_run_pkey PRIMARY KEY (id);


--
-- Name: parked_run parked_run_run_address_unique; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.parked_run
    ADD CONSTRAINT parked_run_run_address_unique UNIQUE (run_id, address);


--
-- Name: phone_number phone_number_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.phone_number
    ADD CONSTRAINT phone_number_pkey PRIMARY KEY (id);


--
-- Name: phone_verification phone_verification_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.phone_verification
    ADD CONSTRAINT phone_verification_pkey PRIMARY KEY (id);


--
-- Name: platform_owned_token platform_owned_token_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.platform_owned_token
    ADD CONSTRAINT platform_owned_token_pkey PRIMARY KEY (id);


--
-- Name: record_binding record_binding_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.record_binding
    ADD CONSTRAINT record_binding_pkey PRIMARY KEY (id);


--
-- Name: remote_adapter remote_adapter_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.remote_adapter
    ADD CONSTRAINT remote_adapter_pkey PRIMARY KEY (id);


--
-- Name: remote_adapter remote_adapter_team_id_adapter_type_key; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.remote_adapter
    ADD CONSTRAINT remote_adapter_team_id_adapter_type_key UNIQUE (team_id, adapter_type);


--
-- Name: team_settings team_settings_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.team_settings
    ADD CONSTRAINT team_settings_pkey PRIMARY KEY (id);


--
-- Name: telegram_identity telegram_identity_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.telegram_identity
    ADD CONSTRAINT telegram_identity_pkey PRIMARY KEY (id);


--
-- Name: telegram_identity telegram_identity_team_user_key; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.telegram_identity
    ADD CONSTRAINT telegram_identity_team_user_key UNIQUE (team_id, telegram_user_id);


--
-- Name: telegram_token telegram_token_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.telegram_token
    ADD CONSTRAINT telegram_token_pkey PRIMARY KEY (id);


--
-- Name: telegram_token telegram_token_token_key; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.telegram_token
    ADD CONSTRAINT telegram_token_token_key UNIQUE (token);


--
-- Name: trigger_event trigger_event_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.trigger_event
    ADD CONSTRAINT trigger_event_pkey PRIMARY KEY (id);


--
-- Name: trigger trigger_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.trigger
    ADD CONSTRAINT trigger_pkey PRIMARY KEY (id);


--
-- Name: trigger_run trigger_run_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.trigger_run
    ADD CONSTRAINT trigger_run_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscription webhook_subscription_pkey; Type: CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (id);


--
-- Name: api_key api_key_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: magic_link_token magic_link_token_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.magic_link_token
    ADD CONSTRAINT magic_link_token_pkey PRIMARY KEY (id);


--
-- Name: pending_signup pending_signup_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pending_signup
    ADD CONSTRAINT pending_signup_pkey PRIMARY KEY (id);


--
-- Name: team_invite team_invite_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team_invite
    ADD CONSTRAINT team_invite_pkey PRIMARY KEY (id);


--
-- Name: team_membership team_membership_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team_membership
    ADD CONSTRAINT team_membership_pkey PRIMARY KEY (id);


--
-- Name: team team_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (id);


--
-- Name: user_email user_email_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.user_email
    ADD CONSTRAINT user_email_pkey PRIMARY KEY (id);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: change change_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_pkey PRIMARY KEY (id);


--
-- Name: document document_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.document
    ADD CONSTRAINT document_pkey PRIMARY KEY (id);


--
-- Name: edge edge_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_pkey PRIMARY KEY (id);


--
-- Name: edge_type edge_type_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge_type
    ADD CONSTRAINT edge_type_pkey PRIMARY KEY (id);


--
-- Name: evidence evidence_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_pkey PRIMARY KEY (id);


--
-- Name: extraction_fact extraction_fact_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_fact
    ADD CONSTRAINT extraction_fact_pkey PRIMARY KEY (id);


--
-- Name: extraction_graph_edge extraction_graph_edge_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_pkey PRIMARY KEY (id);


--
-- Name: extraction_graph_edge extraction_graph_edge_unique; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_unique UNIQUE (extraction_graph_id, source_node_id, edge_type_id, target_node_id);


--
-- Name: extraction_graph_node extraction_graph_node_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_node
    ADD CONSTRAINT extraction_graph_node_pkey PRIMARY KEY (id);


--
-- Name: extraction_graph extraction_graph_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph
    ADD CONSTRAINT extraction_graph_pkey PRIMARY KEY (id);


--
-- Name: linked_object linked_object_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.linked_object
    ADD CONSTRAINT linked_object_pkey PRIMARY KEY (id);


--
-- Name: mutation_outbox mutation_outbox_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.mutation_outbox
    ADD CONSTRAINT mutation_outbox_pkey PRIMARY KEY (id);


--
-- Name: node node_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.node
    ADD CONSTRAINT node_pkey PRIMARY KEY (id);


--
-- Name: node_resource node_resource_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.node_resource
    ADD CONSTRAINT node_resource_pkey PRIMARY KEY (id);


--
-- Name: node_type node_type_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.node_type
    ADD CONSTRAINT node_type_pkey PRIMARY KEY (id);


--
-- Name: output_run output_run_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.output_run
    ADD CONSTRAINT output_run_pkey PRIMARY KEY (id);


--
-- Name: plugin plugin_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.plugin
    ADD CONSTRAINT plugin_pkey PRIMARY KEY (id);


--
-- Name: property_arbitration property_arbitration_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property_arbitration
    ADD CONSTRAINT property_arbitration_pkey PRIMARY KEY (id);


--
-- Name: property property_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_pkey PRIMARY KEY (id);


--
-- Name: property_type property_type_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_pkey PRIMARY KEY (id);


--
-- Name: raw_text_part raw_text_part_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.raw_text_part
    ADD CONSTRAINT raw_text_part_pkey PRIMARY KEY (id);


--
-- Name: raw_text raw_text_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.raw_text
    ADD CONSTRAINT raw_text_pkey PRIMARY KEY (id);


--
-- Name: recipe recipe_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.recipe
    ADD CONSTRAINT recipe_pkey PRIMARY KEY (id);


--
-- Name: resource resource_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.resource
    ADD CONSTRAINT resource_pkey PRIMARY KEY (id);


--
-- Name: saved_filter saved_filter_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.saved_filter
    ADD CONSTRAINT saved_filter_pkey PRIMARY KEY (id);


--
-- Name: team_agent_settings team_agent_settings_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.team_agent_settings
    ADD CONSTRAINT team_agent_settings_pkey PRIMARY KEY (id);


--
-- Name: webhook_endpoint webhook_endpoint_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.webhook_endpoint
    ADD CONSTRAINT webhook_endpoint_pkey PRIMARY KEY (id);


--
-- Name: worker_heartbeat worker_heartbeat_pkey; Type: CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.worker_heartbeat
    ADD CONSTRAINT worker_heartbeat_pkey PRIMARY KEY (id);


--
-- Name: agent_conversation agent_conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversation
    ADD CONSTRAINT agent_conversation_pkey PRIMARY KEY (id);


--
-- Name: agent_message agent_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_message
    ADD CONSTRAINT agent_message_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: context_logs context_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_logs
    ADD CONSTRAINT context_logs_pkey PRIMARY KEY (id);


--
-- Name: dealflow_pipeline dealflow_pipeline_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dealflow_pipeline
    ADD CONSTRAINT dealflow_pipeline_pkey PRIMARY KEY (id);


--
-- Name: dropped_inbound_email dropped_inbound_email_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dropped_inbound_email
    ADD CONSTRAINT dropped_inbound_email_pkey PRIMARY KEY (id);


--
-- Name: inbound_payload inbound_payload_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_payload
    ADD CONSTRAINT inbound_payload_pkey PRIMARY KEY (id);


--
-- Name: integration_suggestion integration_suggestion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_suggestion
    ADD CONSTRAINT integration_suggestion_pkey PRIMARY KEY (id);


--
-- Name: inventory_delta_event inventory_delta_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_delta_event
    ADD CONSTRAINT inventory_delta_event_pkey PRIMARY KEY (id);


--
-- Name: inventory_delta_holding inventory_delta_holding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_delta_holding
    ADD CONSTRAINT inventory_delta_holding_pkey PRIMARY KEY (event_id, asset_id, degree, tracks_investee, is_inflow);


--
-- Name: llm_usage llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);


--
-- Name: notion_token notion_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notion_token
    ADD CONSTRAINT notion_token_pkey PRIMARY KEY (id);


--
-- Name: ops_event ops_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_event
    ADD CONSTRAINT ops_event_pkey PRIMARY KEY (id);


--
-- Name: pipeline_configuration pipeline_configuration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_configuration
    ADD CONSTRAINT pipeline_configuration_pkey PRIMARY KEY (id);


--
-- Name: pipeline_input_message_type pipeline_input_message_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_pkey PRIMARY KEY (id);


--
-- Name: pipeline_input_message_type pipeline_input_message_type_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_unique UNIQUE (pipeline_input_id, node_type_id);


--
-- Name: pipeline_input pipeline_input_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_input
    ADD CONSTRAINT pipeline_input_pkey PRIMARY KEY (id);


--
-- Name: pipeline_output pipeline_output_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_output
    ADD CONSTRAINT pipeline_output_pkey PRIMARY KEY (id);


--
-- Name: portfolio_company_metric portfolio_company_metric_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_company_metric
    ADD CONSTRAINT portfolio_company_metric_pkey PRIMARY KEY (id);


--
-- Name: profile_email profile_email_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_email
    ADD CONSTRAINT profile_email_pkey PRIMARY KEY (id);


--
-- Name: profile_public_round profile_public_round_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_public_round
    ADD CONSTRAINT profile_public_round_pkey PRIMARY KEY (id);


--
-- Name: profile_role profile_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_role
    ADD CONSTRAINT profile_role_pkey PRIMARY KEY (id);


--
-- Name: push_subscription push_subscription_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscription
    ADD CONSTRAINT push_subscription_pkey PRIMARY KEY (id);


--
-- Name: resource_payload resource_payload_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_payload
    ADD CONSTRAINT resource_payload_pkey PRIMARY KEY (id);


--
-- Name: resource_source resource_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_source
    ADD CONSTRAINT resource_source_pkey PRIMARY KEY (id);


--
-- Name: signup_event signup_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_event
    ADD CONSTRAINT signup_event_pkey PRIMARY KEY (id);


--
-- Name: team_journey team_journey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_journey
    ADD CONSTRAINT team_journey_pkey PRIMARY KEY (team_id);


--
-- Name: team_usage_config team_usage_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_usage_config
    ADD CONSTRAINT team_usage_config_pkey PRIMARY KEY (id);


--
-- Name: usage_alert usage_alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_alert
    ADD CONSTRAINT usage_alert_pkey PRIMARY KEY (id);


--
-- Name: usage_event usage_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event
    ADD CONSTRAINT usage_event_pkey PRIMARY KEY (id);


--
-- Name: user_journey user_journey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_journey
    ADD CONSTRAINT user_journey_pkey PRIMARY KEY (user_id);


--
-- Name: asset asset_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (id);


--
-- Name: asset_transfer asset_transfer_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: currency_asset currency_asset_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.currency_asset
    ADD CONSTRAINT currency_asset_pkey PRIMARY KEY (id);


--
-- Name: event event_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.event
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);


--
-- Name: exchange_rate exchange_rate_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.exchange_rate
    ADD CONSTRAINT exchange_rate_pkey PRIMARY KEY (id);


--
-- Name: funding_changelog_fund funding_changelog_fund_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.funding_changelog_fund
    ADD CONSTRAINT funding_changelog_fund_pkey PRIMARY KEY (changelog_id, fund_id);


--
-- Name: funding_changelog funding_changelog_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.funding_changelog
    ADD CONSTRAINT funding_changelog_pkey PRIMARY KEY (id);


--
-- Name: investment_attribution investment_attribution_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment_attribution
    ADD CONSTRAINT investment_attribution_pkey PRIMARY KEY (id);


--
-- Name: investment investment_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_pkey PRIMARY KEY (id);


--
-- Name: legal_entity legal_entity_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_pkey PRIMARY KEY (id);


--
-- Name: note note_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.note
    ADD CONSTRAINT note_pkey PRIMARY KEY (id);


--
-- Name: outbound_delivery outbound_delivery_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.outbound_delivery
    ADD CONSTRAINT outbound_delivery_pkey PRIMARY KEY (id);


--
-- Name: price price_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_pkey PRIMARY KEY (id);


--
-- Name: team_settings team_settings_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.team_settings
    ADD CONSTRAINT team_settings_pkey PRIMARY KEY (id);


--
-- Name: transaction transaction_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_pkey PRIMARY KEY (id);


--
-- Name: valuations_change_outbox valuations_change_outbox_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.valuations_change_outbox
    ADD CONSTRAINT valuations_change_outbox_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscription webhook_subscription_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (id);


--
-- Name: worker_heartbeat worker_heartbeat_pkey; Type: CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.worker_heartbeat
    ADD CONSTRAINT worker_heartbeat_pkey PRIMARY KEY (id);


--
-- Name: ask_state_idx; Type: INDEX; Schema: asks; Owner: -
--

CREATE INDEX ask_state_idx ON asks.ask USING btree (state);


--
-- Name: ask_team_id_idx; Type: INDEX; Schema: asks; Owner: -
--

CREATE INDEX ask_team_id_idx ON asks.ask USING btree (team_id);


--
-- Name: ask_webhook_delivery_ask_id_idx; Type: INDEX; Schema: asks; Owner: -
--

CREATE INDEX ask_webhook_delivery_ask_id_idx ON asks.ask_webhook_delivery USING btree (ask_id);


--
-- Name: ask_webhook_delivery_pending_idx; Type: INDEX; Schema: asks; Owner: -
--

CREATE INDEX ask_webhook_delivery_pending_idx ON asks.ask_webhook_delivery USING btree (created_at) WHERE (status = 'pending'::text);


--
-- Name: asks_worker_heartbeat_worker_idx; Type: INDEX; Schema: asks; Owner: -
--

CREATE UNIQUE INDEX asks_worker_heartbeat_worker_idx ON asks.worker_heartbeat USING btree (worker);


--
-- Name: adapter_await_correlation_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX adapter_await_correlation_idx ON automations.adapter_await USING btree (adapter_type, correlation_key, team_id);


--
-- Name: adapter_await_run_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX adapter_await_run_id_idx ON automations.adapter_await USING btree (run_id);


--
-- Name: automations_audit_log_context_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX automations_audit_log_context_id_idx ON automations.audit_log USING btree (context_id);


--
-- Name: automations_audit_log_created_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX automations_audit_log_created_at_idx ON automations.audit_log USING btree (created_at);


--
-- Name: automations_audit_log_model_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX automations_audit_log_model_id_idx ON automations.audit_log USING btree (model_id);


--
-- Name: automations_audit_log_version_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX automations_audit_log_version_idx ON automations.audit_log USING btree (version);


--
-- Name: callback_run_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX callback_run_id_idx ON automations.callback USING btree (run_id);


--
-- Name: callback_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX callback_team_id_idx ON automations.callback USING btree (team_id);


--
-- Name: connect_token_expires_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX connect_token_expires_at_idx ON automations.connect_token USING btree (expires_at);


--
-- Name: connect_token_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX connect_token_team_id_idx ON automations.connect_token USING btree (team_id);


--
-- Name: exposed_file_expires_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX exposed_file_expires_at_idx ON automations.exposed_file USING btree (expires_at);


--
-- Name: exposed_file_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX exposed_file_team_id_idx ON automations.exposed_file USING btree (team_id);


--
-- Name: inbound_email_route_address_key; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX inbound_email_route_address_key ON automations.inbound_email_route USING btree (address);


--
-- Name: inbound_email_route_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX inbound_email_route_team_id_idx ON automations.inbound_email_route USING btree (team_id);


--
-- Name: join_branch_export_frame_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX join_branch_export_frame_idx ON automations.join_branch_export USING btree (run_id, frame_address);


--
-- Name: movement_issue_movement_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX movement_issue_movement_id_idx ON automations.movement_issue USING btree (movement_id);


--
-- Name: movement_issue_team_state_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX movement_issue_team_state_idx ON automations.movement_issue USING btree (team_id, state);


--
-- Name: movement_story_token_movement_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX movement_story_token_movement_id_idx ON automations.movement_story_token USING btree (movement_id);


--
-- Name: movement_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX movement_team_id_idx ON automations.movement USING btree (team_id);


--
-- Name: movement_version_movement_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX movement_version_movement_id_idx ON automations.movement_version USING btree (movement_id);


--
-- Name: outbound_email_created_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX outbound_email_created_at_idx ON automations.outbound_email USING btree (created_at);


--
-- Name: outbound_email_failures_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX outbound_email_failures_idx ON automations.outbound_email USING btree (created_at) WHERE (success = false);


--
-- Name: outbound_email_team_id_created_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX outbound_email_team_id_created_at_idx ON automations.outbound_email USING btree (team_id, created_at);


--
-- Name: parked_run_run_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX parked_run_run_id_idx ON automations.parked_run USING btree (run_id);


--
-- Name: parked_run_timer_wake_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX parked_run_timer_wake_idx ON automations.parked_run USING btree (wake_at) WHERE ((park_reason = 'timer'::text) AND (status = 'parked'::text));


--
-- Name: phone_number_emoji_code_key; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX phone_number_emoji_code_key ON automations.phone_number USING btree (emoji_code);


--
-- Name: phone_number_phone_number_key; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX phone_number_phone_number_key ON automations.phone_number USING btree (phone_number);


--
-- Name: phone_number_user_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX phone_number_user_id_idx ON automations.phone_number USING btree (user_id);


--
-- Name: phone_number_word_identifier_key; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX phone_number_word_identifier_key ON automations.phone_number USING btree (word_identifier);


--
-- Name: phone_verification_active_key; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX phone_verification_active_key ON automations.phone_verification USING btree (user_id, phone_number) WHERE (consumed_at IS NULL);


--
-- Name: phone_verification_phone_number_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX phone_verification_phone_number_idx ON automations.phone_verification USING btree (phone_number);


--
-- Name: platform_owned_token_team_adapter_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX platform_owned_token_team_adapter_idx ON automations.platform_owned_token USING btree (team_id, adapter_type);


--
-- Name: platform_owned_token_unique_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX platform_owned_token_unique_idx ON automations.platform_owned_token USING btree (team_id, adapter_type, external_token_id) WHERE (revoked_at IS NULL);


--
-- Name: record_binding_a_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX record_binding_a_idx ON automations.record_binding USING btree (team_id, a_adapter_type, a_instance_key, a_type_id, a_record_id);


--
-- Name: record_binding_b_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX record_binding_b_idx ON automations.record_binding USING btree (team_id, b_adapter_type, b_instance_key, b_type_id, b_record_id);


--
-- Name: record_binding_pair_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX record_binding_pair_idx ON automations.record_binding USING btree (team_id, a_adapter_type, a_instance_key, a_type_id, a_record_id, b_adapter_type, b_instance_key, b_type_id, b_record_id);


--
-- Name: team_settings_team_id_key; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX team_settings_team_id_key ON automations.team_settings USING btree (team_id);


--
-- Name: telegram_identity_telegram_user_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX telegram_identity_telegram_user_id_idx ON automations.telegram_identity USING btree (telegram_user_id);


--
-- Name: trigger_event_created_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_event_created_at_idx ON automations.trigger_event USING btree (created_at);


--
-- Name: trigger_event_delivery_idempotency_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE UNIQUE INDEX trigger_event_delivery_idempotency_idx ON automations.trigger_event USING btree (trigger_id, external_event_id) WHERE (external_event_id IS NOT NULL);


--
-- Name: trigger_event_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_event_team_id_idx ON automations.trigger_event USING btree (team_id);


--
-- Name: trigger_event_trigger_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_event_trigger_id_idx ON automations.trigger_event USING btree (trigger_id);


--
-- Name: trigger_kind_config_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_kind_config_idx ON automations.trigger USING btree (kind, ((config ->> 'key'::text))) WHERE ((config ->> 'key'::text) IS NOT NULL);


--
-- Name: trigger_movement_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_movement_id_idx ON automations.trigger USING btree (movement_id);


--
-- Name: trigger_run_created_at_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_run_created_at_idx ON automations.trigger_run USING btree (created_at);


--
-- Name: trigger_run_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_run_team_id_idx ON automations.trigger_run USING btree (team_id);


--
-- Name: trigger_run_trigger_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_run_trigger_id_idx ON automations.trigger_run USING btree (trigger_id);


--
-- Name: trigger_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX trigger_team_id_idx ON automations.trigger USING btree (team_id);


--
-- Name: webhook_subscription_provider_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX webhook_subscription_provider_idx ON automations.webhook_subscription USING btree (provider);


--
-- Name: webhook_subscription_team_id_idx; Type: INDEX; Schema: automations; Owner: -
--

CREATE INDEX webhook_subscription_team_id_idx ON automations.webhook_subscription USING btree (team_id);


--
-- Name: api_key_key_hash_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX api_key_key_hash_idx ON core.api_key USING btree (key_hash);


--
-- Name: api_key_pipeline_input_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX api_key_pipeline_input_id_idx ON core.api_key USING btree (pipeline_input_id) WHERE (pipeline_input_id IS NOT NULL);


--
-- Name: api_key_team_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX api_key_team_id_idx ON core.api_key USING btree (team_id);


--
-- Name: core_audit_log_context_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX core_audit_log_context_id_idx ON core.audit_log USING btree (context_id);


--
-- Name: core_audit_log_created_at_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX core_audit_log_created_at_idx ON core.audit_log USING btree (created_at);


--
-- Name: core_audit_log_model_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX core_audit_log_model_id_idx ON core.audit_log USING btree (model_id);


--
-- Name: core_audit_log_version_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX core_audit_log_version_idx ON core.audit_log USING btree (version);


--
-- Name: magic_link_token_token_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX magic_link_token_token_key ON core.magic_link_token USING btree (token);


--
-- Name: pending_signup_token_hash_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX pending_signup_token_hash_idx ON core.pending_signup USING btree (token_hash);


--
-- Name: team_active_pipeline_configuration_id_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX team_active_pipeline_configuration_id_key ON core.team USING btree (active_pipeline_configuration_id);


--
-- Name: team_default_user_id_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX team_default_user_id_key ON core.team USING btree (default_user_id);


--
-- Name: team_domain_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX team_domain_key ON core.team USING btree (domain);


--
-- Name: team_invite_email_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX team_invite_email_idx ON core.team_invite USING btree (email);


--
-- Name: team_invite_team_id_email_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX team_invite_team_id_email_key ON core.team_invite USING btree (team_id, email);


--
-- Name: team_invite_team_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX team_invite_team_id_idx ON core.team_invite USING btree (team_id);


--
-- Name: team_membership_team_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX team_membership_team_id_idx ON core.team_membership USING btree (team_id);


--
-- Name: team_membership_user_id_team_id_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX team_membership_user_id_team_id_key ON core.team_membership USING btree (user_id, team_id);


--
-- Name: user_email_email_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX user_email_email_key ON core.user_email USING btree (email);


--
-- Name: user_email_email_unique_primary_for_user; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX user_email_email_unique_primary_for_user ON core.user_email USING btree (user_id, is_primary) WHERE (is_primary = true);


--
-- Name: user_email_user_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX user_email_user_id_idx ON core.user_email USING btree (user_id);


--
-- Name: user_invitation_code_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX user_invitation_code_key ON core."user" USING btree (invitation_code);


--
-- Name: change_edge_id_created_at_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX change_edge_id_created_at_idx ON knowledge.change USING btree (edge_id, created_at DESC);


--
-- Name: change_node_id_created_at_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX change_node_id_created_at_idx ON knowledge.change USING btree (node_id, created_at DESC);


--
-- Name: change_request_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX change_request_id_idx ON knowledge.change USING btree (request_id);


--
-- Name: change_team_id_created_at_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX change_team_id_created_at_idx ON knowledge.change USING btree (team_id, created_at DESC);


--
-- Name: document_checksum_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX document_checksum_idx ON knowledge.document USING btree (checksum);


--
-- Name: edge_edge_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_edge_type_id_idx ON knowledge.edge USING btree (edge_type_id);


--
-- Name: edge_source_node_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_source_node_id_idx ON knowledge.edge USING btree (source_node_id);


--
-- Name: edge_target_node_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_target_node_id_idx ON knowledge.edge USING btree (target_node_id);


--
-- Name: edge_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_team_id_idx ON knowledge.edge USING btree (team_id);


--
-- Name: edge_type_source_node_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_type_source_node_type_id_idx ON knowledge.edge_type USING btree (source_node_type_id);


--
-- Name: edge_type_target_node_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_type_target_node_type_id_idx ON knowledge.edge_type USING btree (target_node_type_id);


--
-- Name: edge_type_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX edge_type_team_id_idx ON knowledge.edge_type USING btree (team_id);


--
-- Name: evidence_edge_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_edge_id_idx ON knowledge.evidence USING btree (edge_id);


--
-- Name: evidence_mutation_context_adapter_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_mutation_context_adapter_idx ON knowledge.evidence USING btree ((((mutation_context -> 'source'::text) ->> 'adapterType'::text)));


--
-- Name: evidence_mutation_context_linked_object_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_mutation_context_linked_object_idx ON knowledge.evidence USING btree ((((mutation_context -> 'source'::text) ->> 'linkedObjectId'::text)));


--
-- Name: evidence_mutation_context_translation_graph_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_mutation_context_translation_graph_idx ON knowledge.evidence USING btree ((((mutation_context -> 'source'::text) ->> 'translationGraphId'::text)));


--
-- Name: evidence_property_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_property_id_idx ON knowledge.evidence USING btree (property_id);


--
-- Name: evidence_source_ref_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_source_ref_id_idx ON knowledge.evidence USING btree (((source_ref ->> 'id'::text)));


--
-- Name: evidence_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX evidence_team_id_idx ON knowledge.evidence USING btree (team_id);


--
-- Name: extraction_fact_message_node_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_fact_message_node_id_idx ON knowledge.extraction_fact USING btree (message_node_id);


--
-- Name: extraction_fact_object_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_fact_object_idx ON knowledge.extraction_fact USING gin (to_tsvector('english'::regconfig, object));


--
-- Name: extraction_fact_predicate_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_fact_predicate_idx ON knowledge.extraction_fact USING gin (to_tsvector('english'::regconfig, predicate));


--
-- Name: extraction_fact_resource_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_fact_resource_id_idx ON knowledge.extraction_fact USING btree (resource_id);


--
-- Name: extraction_fact_subject_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_fact_subject_idx ON knowledge.extraction_fact USING gin (to_tsvector('english'::regconfig, subject));


--
-- Name: extraction_fact_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_fact_team_id_idx ON knowledge.extraction_fact USING btree (team_id);


--
-- Name: extraction_graph_edge_extraction_graph_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_graph_edge_extraction_graph_id_idx ON knowledge.extraction_graph_edge USING btree (extraction_graph_id);


--
-- Name: extraction_graph_edge_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_graph_edge_team_id_idx ON knowledge.extraction_graph_edge USING btree (team_id);


--
-- Name: extraction_graph_node_extraction_graph_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_graph_node_extraction_graph_id_idx ON knowledge.extraction_graph_node USING btree (extraction_graph_id);


--
-- Name: extraction_graph_node_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_graph_node_team_id_idx ON knowledge.extraction_graph_node USING btree (team_id);


--
-- Name: extraction_graph_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX extraction_graph_team_id_idx ON knowledge.extraction_graph USING btree (team_id);


--
-- Name: knowledge_audit_log_context_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX knowledge_audit_log_context_id_idx ON knowledge.audit_log USING btree (context_id);


--
-- Name: knowledge_audit_log_created_at_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX knowledge_audit_log_created_at_idx ON knowledge.audit_log USING btree (created_at);


--
-- Name: knowledge_audit_log_model_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX knowledge_audit_log_model_id_idx ON knowledge.audit_log USING btree (model_id);


--
-- Name: knowledge_audit_log_version_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX knowledge_audit_log_version_idx ON knowledge.audit_log USING btree (version);


--
-- Name: linked_object_node_adapter_external_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX linked_object_node_adapter_external_idx ON knowledge.linked_object USING btree (node_id, adapter_type, external_id);


--
-- Name: linked_object_node_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX linked_object_node_id_idx ON knowledge.linked_object USING btree (node_id);


--
-- Name: linked_object_retrieval_source_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX linked_object_retrieval_source_id_idx ON knowledge.linked_object USING btree (retrieval_source_id);


--
-- Name: linked_object_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX linked_object_team_id_idx ON knowledge.linked_object USING btree (team_id);


--
-- Name: mutation_outbox_team_id_created_at_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX mutation_outbox_team_id_created_at_idx ON knowledge.mutation_outbox USING btree (team_id, created_at DESC);


--
-- Name: mutation_outbox_undelivered_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX mutation_outbox_undelivered_idx ON knowledge.mutation_outbox USING btree (created_at) WHERE (delivered_at IS NULL);


--
-- Name: node_node_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_node_type_id_idx ON knowledge.node USING btree (node_type_id);


--
-- Name: node_resource_node_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_resource_node_id_idx ON knowledge.node_resource USING btree (node_id);


--
-- Name: node_resource_node_resource_unique; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX node_resource_node_resource_unique ON knowledge.node_resource USING btree (node_id, resource_id);


--
-- Name: node_resource_resource_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_resource_resource_id_idx ON knowledge.node_resource USING btree (resource_id);


--
-- Name: node_resource_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_resource_team_id_idx ON knowledge.node_resource USING btree (team_id);


--
-- Name: node_summary_tsvector_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_summary_tsvector_idx ON knowledge.node USING gin (summary_tsvector);


--
-- Name: node_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_team_id_idx ON knowledge.node USING btree (team_id);


--
-- Name: node_team_type_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_team_type_idx ON knowledge.node USING btree (team_id, node_type_id);


--
-- Name: node_type_category_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_type_category_idx ON knowledge.node_type USING btree (team_id, category);


--
-- Name: node_type_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX node_type_team_id_idx ON knowledge.node_type USING btree (team_id);


--
-- Name: output_run_created_at_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX output_run_created_at_idx ON knowledge.output_run USING btree (created_at);


--
-- Name: output_run_pipeline_output_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX output_run_pipeline_output_id_idx ON knowledge.output_run USING btree (pipeline_output_id);


--
-- Name: output_run_run_group_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX output_run_run_group_id_idx ON knowledge.output_run USING btree (run_group_id);


--
-- Name: property_arbitration_pending_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX property_arbitration_pending_idx ON knowledge.property_arbitration USING btree (property_id) WHERE (resolved_at IS NULL);


--
-- Name: property_arbitration_queue_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_arbitration_queue_idx ON knowledge.property_arbitration USING btree (enqueued_at) WHERE (resolved_at IS NULL);


--
-- Name: property_edge_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_edge_id_idx ON knowledge.property USING btree (edge_id);


--
-- Name: property_node_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_node_id_idx ON knowledge.property USING btree (node_id);


--
-- Name: property_node_type_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_node_type_idx ON knowledge.property USING btree (node_id, property_type_id);


--
-- Name: property_property_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_property_type_id_idx ON knowledge.property USING btree (property_type_id);


--
-- Name: property_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_team_id_idx ON knowledge.property USING btree (team_id);


--
-- Name: property_type_edge_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_type_edge_type_id_idx ON knowledge.property_type USING btree (edge_type_id);


--
-- Name: property_type_node_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_type_node_type_id_idx ON knowledge.property_type USING btree (node_type_id);


--
-- Name: property_type_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_type_team_id_idx ON knowledge.property_type USING btree (team_id);


--
-- Name: property_value_text_array_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_value_text_array_idx ON knowledge.property USING gin (value_text_array);


--
-- Name: property_value_text_search_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_value_text_search_idx ON knowledge.property USING gin (value_text_search);


--
-- Name: property_value_text_trgm_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX property_value_text_trgm_idx ON knowledge.property USING gin (lower(value_text) public.gin_trgm_ops);


--
-- Name: raw_text_part_search_vector_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX raw_text_part_search_vector_idx ON knowledge.raw_text_part USING gin (search_vector);


--
-- Name: raw_text_search_vector_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX raw_text_search_vector_idx ON knowledge.raw_text USING gin (search_vector);


--
-- Name: raw_text_team_id_checksum_key; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX raw_text_team_id_checksum_key ON knowledge.raw_text USING btree (team_id, checksum);


--
-- Name: recipe_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX recipe_team_id_idx ON knowledge.recipe USING btree (team_id);


--
-- Name: resource_document_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX resource_document_id_idx ON knowledge.resource USING btree (document_id);


--
-- Name: resource_inbound_payload_id_key; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX resource_inbound_payload_id_key ON knowledge.resource USING btree (inbound_payload_id);


--
-- Name: resource_raw_text_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX resource_raw_text_id_idx ON knowledge.resource USING btree (raw_text_id);


--
-- Name: resource_team_adapter_external_id_key; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX resource_team_adapter_external_id_key ON knowledge.resource USING btree (team_id, external_adapter_type, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: resource_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX resource_team_id_idx ON knowledge.resource USING btree (team_id);


--
-- Name: saved_filter_node_type_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX saved_filter_node_type_id_idx ON knowledge.saved_filter USING btree (node_type_id);


--
-- Name: saved_filter_team_id_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE INDEX saved_filter_team_id_idx ON knowledge.saved_filter USING btree (team_id);


--
-- Name: team_agent_settings_team_id_key; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX team_agent_settings_team_id_key ON knowledge.team_agent_settings USING btree (team_id);


--
-- Name: webhook_endpoint_team_id_url_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX webhook_endpoint_team_id_url_idx ON knowledge.webhook_endpoint USING btree (team_id, url);


--
-- Name: worker_heartbeat_worker_idx; Type: INDEX; Schema: knowledge; Owner: -
--

CREATE UNIQUE INDEX worker_heartbeat_worker_idx ON knowledge.worker_heartbeat USING btree (worker);


--
-- Name: agent_conversation_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversation_team_id_idx ON public.agent_conversation USING btree (team_id);


--
-- Name: agent_conversation_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversation_user_id_idx ON public.agent_conversation USING btree (user_id);


--
-- Name: agent_message_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_message_conversation_id_idx ON public.agent_message USING btree (conversation_id);


--
-- Name: audit_log_context_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_context_id_idx ON public.audit_log USING btree (context_id);


--
-- Name: audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_at_idx ON public.audit_log USING btree (created_at);


--
-- Name: audit_log_model_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_model_id_idx ON public.audit_log USING btree (model_id);


--
-- Name: audit_log_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_version_idx ON public.audit_log USING btree (version);


--
-- Name: context_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX context_logs_created_at_idx ON public.context_logs USING btree (created_at);


--
-- Name: context_logs_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX context_logs_key_idx ON public.context_logs USING btree (key);


--
-- Name: context_logs_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX context_logs_request_id_idx ON public.context_logs USING btree (request_id);


--
-- Name: context_logs_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX context_logs_team_id_idx ON public.context_logs USING btree (team_id);


--
-- Name: dealflow_pipeline_numeric_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dealflow_pipeline_numeric_id_key ON public.dealflow_pipeline USING btree (numeric_id);


--
-- Name: dropped_inbound_email_team_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dropped_inbound_email_team_pending_idx ON public.dropped_inbound_email USING btree (team_id) WHERE (replayed_at IS NULL);


--
-- Name: idx_usage_event_team_type_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_team_type_date ON public.usage_event USING btree (team_id, event_type, created_at);


--
-- Name: inbound_payload_team_dedup_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inbound_payload_team_dedup_unique ON public.inbound_payload USING btree (team_id, dedup_id) WHERE (dedup_id IS NOT NULL);


--
-- Name: integration_suggestion_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_suggestion_created_at_idx ON public.integration_suggestion USING btree (created_at);


--
-- Name: inventory_delta_event_investment_id_close_date_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inventory_delta_event_investment_id_close_date_key ON public.inventory_delta_event USING btree (investment_id, close_date);


--
-- Name: inventory_delta_event_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_delta_event_team_id_idx ON public.inventory_delta_event USING btree (team_id);


--
-- Name: inventory_delta_holding_asset_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_delta_holding_asset_id_idx ON public.inventory_delta_holding USING btree (asset_id);


--
-- Name: llm_usage_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_conversation_id_idx ON public.llm_usage USING btree (conversation_id);


--
-- Name: llm_usage_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_created_at_idx ON public.llm_usage USING btree (created_at);


--
-- Name: llm_usage_pipeline_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_pipeline_id_idx ON public.llm_usage USING btree (pipeline_id);


--
-- Name: llm_usage_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_team_id_idx ON public.llm_usage USING btree (team_id);


--
-- Name: llm_usage_trigger_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_trigger_run_id_idx ON public.llm_usage USING btree (trigger_run_id);


--
-- Name: notion_token_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notion_token_token_key ON public.notion_token USING btree (token);


--
-- Name: ops_event_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_event_created_at_idx ON public.ops_event USING btree (created_at);


--
-- Name: ops_event_parent_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_event_parent_run_id_idx ON public.ops_event USING btree (parent_run_id);


--
-- Name: ops_event_roots_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_event_roots_created_at_idx ON public.ops_event USING btree (created_at) WHERE (parent_run_id IS NULL);


--
-- Name: pipeline_configuration_team_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pipeline_configuration_team_id_name_key ON public.pipeline_configuration USING btree (team_id, name);


--
-- Name: pipeline_input_default_for_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pipeline_input_default_for_unique ON public.pipeline_input USING btree (default_for, pipeline_configuration_id) WHERE ((default_for IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: pipeline_input_message_type_pipeline_input_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipeline_input_message_type_pipeline_input_id_idx ON public.pipeline_input_message_type USING btree (pipeline_input_id);


--
-- Name: portfolio_company_metric_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portfolio_company_metric_company_id_idx ON public.portfolio_company_metric USING btree (company_id);


--
-- Name: portfolio_company_metric_investor_id_company_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portfolio_company_metric_investor_id_company_id_key ON public.portfolio_company_metric USING btree (investor_id, company_id);


--
-- Name: portfolio_company_metric_investor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portfolio_company_metric_investor_id_idx ON public.portfolio_company_metric USING btree (investor_id);


--
-- Name: profile_public_round_lead_investor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profile_public_round_lead_investor_id_idx ON public.profile_public_round USING btree (lead_investor_id);


--
-- Name: profile_public_round_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profile_public_round_profile_id_idx ON public.profile_public_round USING btree (profile_id);


--
-- Name: profile_role_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profile_role_entity_id_idx ON public.profile_role USING btree (entity_id);


--
-- Name: profile_role_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profile_role_profile_id_idx ON public.profile_role USING btree (profile_id);


--
-- Name: push_subscription_endpoint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX push_subscription_endpoint_idx ON public.push_subscription USING btree (endpoint);


--
-- Name: resource_payload_inbound_payload_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_payload_inbound_payload_id_idx ON public.resource_payload USING btree (inbound_payload_id);


--
-- Name: resource_payload_resource_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_payload_resource_id_idx ON public.resource_payload USING btree (resource_id);


--
-- Name: resource_payload_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_payload_team_id_idx ON public.resource_payload USING btree (team_id);


--
-- Name: resource_source_legal_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_source_legal_entity_id_idx ON public.resource_source USING btree (legal_entity_id);


--
-- Name: resource_source_resource_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_source_resource_id_idx ON public.resource_source USING btree (resource_id);


--
-- Name: resource_source_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_source_team_id_idx ON public.resource_source USING btree (team_id);


--
-- Name: signup_event_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signup_event_created_at_idx ON public.signup_event USING btree (created_at);


--
-- Name: team_usage_config_team_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_usage_config_team_id_key ON public.team_usage_config USING btree (team_id);


--
-- Name: usage_alert_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX usage_alert_dedup ON public.usage_alert USING btree (team_id, event_type, alert_kind, period_start);


--
-- Name: asset_issued_by_legal_entity_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_issued_by_legal_entity_id_idx ON valuations.asset USING btree (issued_by_legal_entity_id);


--
-- Name: asset_name_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_name_idx ON valuations.asset USING btree (name);


--
-- Name: asset_transfer_asset_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_transfer_asset_id_idx ON valuations.asset_transfer USING btree (asset_id);


--
-- Name: asset_transfer_date_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_transfer_date_idx ON valuations.asset_transfer USING btree (date);


--
-- Name: asset_transfer_from_legal_entity_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_transfer_from_legal_entity_id_idx ON valuations.asset_transfer USING btree (from_legal_entity_id);


--
-- Name: asset_transfer_to_legal_entity_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_transfer_to_legal_entity_id_idx ON valuations.asset_transfer USING btree (to_legal_entity_id);


--
-- Name: asset_transfer_transaction_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_transfer_transaction_id_idx ON valuations.asset_transfer USING btree (transaction_id);


--
-- Name: asset_type_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX asset_type_idx ON valuations.asset USING btree (type);


--
-- Name: currency_asset_asset_id_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX currency_asset_asset_id_key ON valuations.currency_asset USING btree (asset_id);


--
-- Name: currency_asset_iso_code_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX currency_asset_iso_code_key ON valuations.currency_asset USING btree (iso_code);


--
-- Name: event_date_legal_entity_id_type_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX event_date_legal_entity_id_type_idx ON valuations.event USING btree (date, legal_entity_id, type);


--
-- Name: exchange_rate_date_from_currency_to_currency_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX exchange_rate_date_from_currency_to_currency_key ON valuations.exchange_rate USING btree (date, from_currency, to_currency);


--
-- Name: idx_funding_changelog_fund_fund; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX idx_funding_changelog_fund_fund ON valuations.funding_changelog_fund USING btree (fund_id);


--
-- Name: idx_funding_changelog_team_entity; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX idx_funding_changelog_team_entity ON valuations.funding_changelog USING btree (team_id, legal_entity_id, created_at DESC);


--
-- Name: investment_attribution_investment_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX investment_attribution_investment_id_idx ON valuations.investment_attribution USING btree (investment_id);


--
-- Name: investment_attribution_legal_entity_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX investment_attribution_legal_entity_id_idx ON valuations.investment_attribution USING btree (legal_entity_id);


--
-- Name: investment_investment_profile_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX investment_investment_profile_id_idx ON valuations.investment USING btree (investment_profile_id);


--
-- Name: investment_investor_profile_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX investment_investor_profile_id_idx ON valuations.investment USING btree (investor_profile_id);


--
-- Name: investment_public_round_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX investment_public_round_id_idx ON valuations.investment USING btree (public_round_id);


--
-- Name: legal_entity_acquired_by_legal_entity_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX legal_entity_acquired_by_legal_entity_id_idx ON valuations.legal_entity USING btree (acquired_by_legal_entity_id);


--
-- Name: legal_entity_company_metrics_id_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX legal_entity_company_metrics_id_key ON valuations.legal_entity USING btree (company_metrics_id);


--
-- Name: legal_entity_identifiers_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX legal_entity_identifiers_idx ON valuations.legal_entity USING gin (identifiers);


--
-- Name: legal_entity_invitation_code_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX legal_entity_invitation_code_key ON valuations.legal_entity USING btree (invitation_code);


--
-- Name: legal_entity_search_vector_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX legal_entity_search_vector_idx ON valuations.legal_entity USING gin (search_vector);


--
-- Name: legal_entity_slug_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX legal_entity_slug_key ON valuations.legal_entity USING btree (slug);


--
-- Name: legal_entity_word_identifier_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX legal_entity_word_identifier_key ON valuations.legal_entity USING btree (word_identifier);


--
-- Name: note_note_type_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX note_note_type_idx ON valuations.note USING btree (note_type);


--
-- Name: note_reference_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX note_reference_id_idx ON valuations.note USING btree (reference_id);


--
-- Name: outbound_delivery_undelivered_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX outbound_delivery_undelivered_idx ON valuations.outbound_delivery USING btree (created_at) WHERE (delivered_at IS NULL);


--
-- Name: price_asset_id_date_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX price_asset_id_date_key ON valuations.price USING btree (asset_id, date);


--
-- Name: price_date_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX price_date_idx ON valuations.price USING btree (date);


--
-- Name: price_legal_entity_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX price_legal_entity_id_idx ON valuations.price USING btree (legal_entity_id);


--
-- Name: team_settings_team_id_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX team_settings_team_id_key ON valuations.team_settings USING btree (team_id);


--
-- Name: transaction_close_date_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX transaction_close_date_idx ON valuations.transaction USING btree (close_date);


--
-- Name: transaction_converted_to_id_key; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX transaction_converted_to_id_key ON valuations.transaction USING btree (converted_to_id);


--
-- Name: transaction_event_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX transaction_event_id_idx ON valuations.transaction USING btree (event_id);


--
-- Name: transaction_investment_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX transaction_investment_id_idx ON valuations.transaction USING btree (investment_id);


--
-- Name: valuations_audit_log_context_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_audit_log_context_id_idx ON valuations.audit_log USING btree (context_id);


--
-- Name: valuations_audit_log_created_at_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_audit_log_created_at_idx ON valuations.audit_log USING btree (created_at);


--
-- Name: valuations_audit_log_model_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_audit_log_model_id_idx ON valuations.audit_log USING btree (model_id);


--
-- Name: valuations_audit_log_version_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_audit_log_version_idx ON valuations.audit_log USING btree (version);


--
-- Name: valuations_change_outbox_occurred_at_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_change_outbox_occurred_at_idx ON valuations.valuations_change_outbox USING btree (occurred_at);


--
-- Name: valuations_change_outbox_team_id_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_change_outbox_team_id_idx ON valuations.valuations_change_outbox USING btree (team_id);


--
-- Name: valuations_change_outbox_unprocessed_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX valuations_change_outbox_unprocessed_idx ON valuations.valuations_change_outbox USING btree (occurred_at) WHERE (processed_at IS NULL);


--
-- Name: valuations_worker_heartbeat_worker_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE UNIQUE INDEX valuations_worker_heartbeat_worker_idx ON valuations.worker_heartbeat USING btree (worker);


--
-- Name: webhook_subscription_team_event_idx; Type: INDEX; Schema: valuations; Owner: -
--

CREATE INDEX webhook_subscription_team_event_idx ON valuations.webhook_subscription USING btree (team_id, event_type) WHERE (deleted_at IS NULL);


--
-- Name: audit_log audit_log_set_created_fields; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON automations.audit_log FOR EACH ROW EXECUTE FUNCTION automations.set_created_fields();


--
-- Name: external_service_credentials external_service_credentials_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER external_service_credentials_audit AFTER INSERT OR DELETE OR UPDATE ON automations.external_service_credentials FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: inbound_email_route inbound_email_route_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER inbound_email_route_audit AFTER INSERT OR DELETE OR UPDATE ON automations.inbound_email_route FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: movement movement_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER movement_audit AFTER INSERT OR DELETE OR UPDATE ON automations.movement FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: phone_verification phone_verification_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER phone_verification_audit AFTER INSERT OR DELETE OR UPDATE ON automations.phone_verification FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: remote_adapter remote_adapter_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER remote_adapter_audit AFTER INSERT OR DELETE OR UPDATE ON automations.remote_adapter FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: team_settings team_settings_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER team_settings_audit AFTER INSERT OR DELETE OR UPDATE ON automations.team_settings FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: trigger trigger_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER trigger_audit AFTER INSERT OR DELETE OR UPDATE ON automations.trigger FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: phone_number user_phone_number_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER user_phone_number_audit AFTER INSERT OR DELETE OR UPDATE ON automations.phone_number FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: webhook_subscription webhook_subscription_audit; Type: TRIGGER; Schema: automations; Owner: -
--

CREATE TRIGGER webhook_subscription_audit AFTER INSERT OR DELETE OR UPDATE ON automations.webhook_subscription FOR EACH ROW EXECUTE FUNCTION automations.audit();


--
-- Name: api_key api_key_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER api_key_audit AFTER INSERT OR DELETE OR UPDATE ON core.api_key FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: audit_log audit_log_set_created_fields; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON core.audit_log FOR EACH ROW EXECUTE FUNCTION core.set_created_fields();


--
-- Name: magic_link_token magic_link_token_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER magic_link_token_audit AFTER INSERT OR DELETE OR UPDATE ON core.magic_link_token FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: team team_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER team_audit AFTER INSERT OR DELETE OR UPDATE ON core.team FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: team_invite team_invite_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER team_invite_audit AFTER INSERT OR DELETE OR UPDATE ON core.team_invite FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: team_membership team_membership_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER team_membership_audit AFTER INSERT OR DELETE OR UPDATE ON core.team_membership FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: user user_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER user_audit AFTER INSERT OR DELETE OR UPDATE ON core."user" FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: user_email user_email_audit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER user_email_audit AFTER INSERT OR DELETE OR UPDATE ON core.user_email FOR EACH ROW EXECUTE FUNCTION core.audit();


--
-- Name: audit_log audit_log_set_created_fields; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON knowledge.audit_log FOR EACH ROW EXECUTE FUNCTION knowledge.set_created_fields();


--
-- Name: document document_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER document_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.document FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: edge edge_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER edge_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.edge FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: edge_type edge_type_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER edge_type_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.edge_type FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: evidence evidence_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER evidence_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.evidence FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: extraction_fact extraction_fact_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER extraction_fact_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_fact FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: extraction_graph extraction_graph_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER extraction_graph_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_graph FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: extraction_graph_edge extraction_graph_edge_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER extraction_graph_edge_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_graph_edge FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: extraction_graph_node extraction_graph_node_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER extraction_graph_node_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_graph_node FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: linked_object linked_object_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER linked_object_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.linked_object FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: node node_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER node_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.node FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: node_resource node_resource_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER node_resource_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.node_resource FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: node_type node_type_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER node_type_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.node_type FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: output_run output_run_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER output_run_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.output_run FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: plugin plugin_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER plugin_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.plugin FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: property property_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER property_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.property FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: property_type property_type_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER property_type_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.property_type FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: raw_text_part raw_text_part_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER raw_text_part_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.raw_text_part FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: recipe recipe_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER recipe_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.recipe FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: resource resource_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER resource_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.resource FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: saved_filter saved_filter_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER saved_filter_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.saved_filter FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: team_agent_settings team_agent_settings_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER team_agent_settings_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.team_agent_settings FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: webhook_endpoint webhook_endpoint_audit; Type: TRIGGER; Schema: knowledge; Owner: -
--

CREATE TRIGGER webhook_endpoint_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.webhook_endpoint FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


--
-- Name: agent_conversation agent_conversation_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_conversation_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_conversation FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: agent_message agent_message_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_message_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_message FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: audit_log audit_log_set_created_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.set_created_fields();


--
-- Name: notion_token notion_token_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notion_token_audit AFTER INSERT OR DELETE OR UPDATE ON public.notion_token FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: pipeline_configuration pipeline_configuration_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pipeline_configuration_audit AFTER INSERT OR DELETE OR UPDATE ON public.pipeline_configuration FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: pipeline_input pipeline_input_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pipeline_input_audit AFTER INSERT OR DELETE OR UPDATE ON public.pipeline_input FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: pipeline_output pipeline_output_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pipeline_output_audit AFTER INSERT OR DELETE OR UPDATE ON public.pipeline_output FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: portfolio_company_metric portfolio_company_metric_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portfolio_company_metric_audit AFTER INSERT OR DELETE OR UPDATE ON public.portfolio_company_metric FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: profile_email profile_email_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profile_email_audit AFTER INSERT OR DELETE OR UPDATE ON public.profile_email FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: profile_public_round profile_public_round_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profile_public_round_audit AFTER INSERT OR DELETE OR UPDATE ON public.profile_public_round FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: profile_role profile_role_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profile_role_audit AFTER INSERT OR DELETE OR UPDATE ON public.profile_role FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: resource_payload resource_payload_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_payload_audit AFTER INSERT OR DELETE OR UPDATE ON public.resource_payload FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: resource_source resource_source_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_source_audit AFTER INSERT OR DELETE OR UPDATE ON public.resource_source FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: team_usage_config team_usage_config_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_usage_config_audit AFTER INSERT OR DELETE OR UPDATE ON public.team_usage_config FOR EACH ROW EXECUTE FUNCTION public.audit();


--
-- Name: asset asset_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER asset_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.asset FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: asset_transfer asset_transfer_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER asset_transfer_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.asset_transfer FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: asset_transfer asset_transfer_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER asset_transfer_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.asset_transfer FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: asset asset_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER asset_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.asset FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: audit_log audit_log_set_created_fields; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON valuations.audit_log FOR EACH ROW EXECUTE FUNCTION valuations.set_created_fields();


--
-- Name: currency_asset currency_asset_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER currency_asset_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.currency_asset FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: event event_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER event_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.event FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: event event_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER event_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.event FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: exchange_rate exchange_rate_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER exchange_rate_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.exchange_rate FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: investment_attribution investment_attribution_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER investment_attribution_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.investment_attribution FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: investment investment_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER investment_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.investment FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: investment investment_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER investment_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.investment FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: legal_entity legal_entity_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER legal_entity_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.legal_entity FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: legal_entity legal_entity_search_vector_update; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER legal_entity_search_vector_update BEFORE INSERT OR UPDATE ON valuations.legal_entity FOR EACH ROW EXECUTE FUNCTION valuations.legal_entity_search_vector_update();


--
-- Name: legal_entity legal_entity_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER legal_entity_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.legal_entity FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: note note_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER note_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.note FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: price price_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER price_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.price FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: price price_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER price_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.price FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: team_settings team_settings_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER team_settings_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.team_settings FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: transaction transaction_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER transaction_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.transaction FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: transaction transaction_valuations_outbox; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER transaction_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.transaction FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


--
-- Name: webhook_subscription webhook_subscription_audit; Type: TRIGGER; Schema: valuations; Owner: -
--

CREATE TRIGGER webhook_subscription_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.webhook_subscription FOR EACH ROW EXECUTE FUNCTION valuations.audit();


--
-- Name: ask_webhook_delivery ask_webhook_delivery_ask_id_fkey; Type: FK CONSTRAINT; Schema: asks; Owner: -
--

ALTER TABLE ONLY asks.ask_webhook_delivery
    ADD CONSTRAINT ask_webhook_delivery_ask_id_fkey FOREIGN KEY (ask_id) REFERENCES asks.ask(id) ON DELETE CASCADE;


--
-- Name: adapter_await adapter_await_run_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.adapter_await
    ADD CONSTRAINT adapter_await_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: callback callback_run_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.callback
    ADD CONSTRAINT callback_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: connect_token connect_token_credentials_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.connect_token
    ADD CONSTRAINT connect_token_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: google_granted_item google_granted_item_credentials_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.google_granted_item
    ADD CONSTRAINT google_granted_item_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: join_branch_export join_branch_export_run_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.join_branch_export
    ADD CONSTRAINT join_branch_export_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: join_pending join_pending_run_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.join_pending
    ADD CONSTRAINT join_pending_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: movement movement_current_version_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES automations.movement_version(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: movement_issue movement_issue_movement_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_issue
    ADD CONSTRAINT movement_issue_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: movement_story_token movement_story_token_movement_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_story_token
    ADD CONSTRAINT movement_story_token_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: movement movement_trigger_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES automations.trigger(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: movement_version movement_version_movement_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.movement_version
    ADD CONSTRAINT movement_version_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: parked_run parked_run_run_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.parked_run
    ADD CONSTRAINT parked_run_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: remote_adapter remote_adapter_credentials_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.remote_adapter
    ADD CONSTRAINT remote_adapter_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trigger trigger_credentials_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.trigger
    ADD CONSTRAINT trigger_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trigger trigger_movement_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.trigger
    ADD CONSTRAINT trigger_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trigger_run trigger_run_movement_version_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.trigger_run
    ADD CONSTRAINT trigger_run_movement_version_id_fkey FOREIGN KEY (movement_version_id) REFERENCES automations.movement_version(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: webhook_subscription webhook_subscription_credentials_id_fkey; Type: FK CONSTRAINT; Schema: automations; Owner: -
--

ALTER TABLE ONLY automations.webhook_subscription
    ADD CONSTRAINT webhook_subscription_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: api_key api_key_created_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.api_key
    ADD CONSTRAINT api_key_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: api_key api_key_team_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.api_key
    ADD CONSTRAINT api_key_team_id_fkey FOREIGN KEY (team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: magic_link_token magic_link_token_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.magic_link_token
    ADD CONSTRAINT magic_link_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: team team_default_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team
    ADD CONSTRAINT team_default_user_id_fkey FOREIGN KEY (default_user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: team_invite team_invite_invited_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team_invite
    ADD CONSTRAINT team_invite_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: team_invite team_invite_team_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team_invite
    ADD CONSTRAINT team_invite_team_id_fkey FOREIGN KEY (team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: team_membership team_membership_team_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team_membership
    ADD CONSTRAINT team_membership_team_id_fkey FOREIGN KEY (team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: team_membership team_membership_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.team_membership
    ADD CONSTRAINT team_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: user user_default_team_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core."user"
    ADD CONSTRAINT user_default_team_id_fkey FOREIGN KEY (default_team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: user_email user_email_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.user_email
    ADD CONSTRAINT user_email_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: change change_edge_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES knowledge.edge(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: change change_evidence_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES knowledge.evidence(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: change change_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: change change_property_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_property_id_fkey FOREIGN KEY (property_id) REFERENCES knowledge.property(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: document document_raw_text_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.document
    ADD CONSTRAINT document_raw_text_id_fkey FOREIGN KEY (raw_text_id) REFERENCES knowledge.raw_text(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: edge edge_edge_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_edge_type_id_fkey FOREIGN KEY (edge_type_id) REFERENCES knowledge.edge_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: edge edge_source_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: edge edge_target_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_target_node_id_fkey FOREIGN KEY (target_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: edge_type edge_type_source_node_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge_type
    ADD CONSTRAINT edge_type_source_node_type_id_fkey FOREIGN KEY (source_node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: edge_type edge_type_target_node_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.edge_type
    ADD CONSTRAINT edge_type_target_node_type_id_fkey FOREIGN KEY (target_node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: evidence evidence_edge_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES knowledge.edge(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: evidence evidence_linked_object_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_linked_object_id_fkey FOREIGN KEY (linked_object_id) REFERENCES knowledge.linked_object(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: evidence evidence_property_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_property_id_fkey FOREIGN KEY (property_id) REFERENCES knowledge.property(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_fact extraction_fact_message_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_fact
    ADD CONSTRAINT extraction_fact_message_node_id_fkey FOREIGN KEY (message_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_fact extraction_fact_resource_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_fact
    ADD CONSTRAINT extraction_fact_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES knowledge.resource(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: extraction_graph_edge extraction_graph_edge_edge_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_edge_type_id_fkey FOREIGN KEY (edge_type_id) REFERENCES knowledge.edge_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_graph_edge extraction_graph_edge_extraction_graph_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_extraction_graph_id_fkey FOREIGN KEY (extraction_graph_id) REFERENCES knowledge.extraction_graph(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_graph_edge extraction_graph_edge_source_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES knowledge.extraction_graph_node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_graph_edge extraction_graph_edge_target_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_target_node_id_fkey FOREIGN KEY (target_node_id) REFERENCES knowledge.extraction_graph_node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_graph_node extraction_graph_node_extraction_graph_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_node
    ADD CONSTRAINT extraction_graph_node_extraction_graph_id_fkey FOREIGN KEY (extraction_graph_id) REFERENCES knowledge.extraction_graph(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_graph_node extraction_graph_node_node_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph_node
    ADD CONSTRAINT extraction_graph_node_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: extraction_graph extraction_graph_root_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.extraction_graph
    ADD CONSTRAINT extraction_graph_root_node_id_fkey FOREIGN KEY (root_node_id) REFERENCES knowledge.extraction_graph_node(id) ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: linked_object linked_object_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.linked_object
    ADD CONSTRAINT linked_object_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: node node_node_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.node
    ADD CONSTRAINT node_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: node_resource node_resource_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.node_resource
    ADD CONSTRAINT node_resource_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: node_resource node_resource_resource_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.node_resource
    ADD CONSTRAINT node_resource_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES knowledge.resource(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: output_run output_run_context_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.output_run
    ADD CONSTRAINT output_run_context_node_id_fkey FOREIGN KEY (context_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: output_run output_run_root_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.output_run
    ADD CONSTRAINT output_run_root_node_id_fkey FOREIGN KEY (root_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: property_arbitration property_arbitration_property_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property_arbitration
    ADD CONSTRAINT property_arbitration_property_id_fkey FOREIGN KEY (property_id) REFERENCES knowledge.property(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: property property_edge_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES knowledge.edge(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: property property_node_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: property property_property_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_property_type_id_fkey FOREIGN KEY (property_type_id) REFERENCES knowledge.property_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: property_type property_type_edge_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_edge_type_id_fkey FOREIGN KEY (edge_type_id) REFERENCES knowledge.edge_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: property_type property_type_node_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: raw_text_part raw_text_part_raw_text_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.raw_text_part
    ADD CONSTRAINT raw_text_part_raw_text_id_fkey FOREIGN KEY (raw_text_id) REFERENCES knowledge.raw_text(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: resource resource_document_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.resource
    ADD CONSTRAINT resource_document_id_fkey FOREIGN KEY (document_id) REFERENCES knowledge.document(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: resource resource_raw_text_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.resource
    ADD CONSTRAINT resource_raw_text_id_fkey FOREIGN KEY (raw_text_id) REFERENCES knowledge.raw_text(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: saved_filter saved_filter_node_type_id_fkey; Type: FK CONSTRAINT; Schema: knowledge; Owner: -
--

ALTER TABLE ONLY knowledge.saved_filter
    ADD CONSTRAINT saved_filter_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: agent_message agent_message_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_message
    ADD CONSTRAINT agent_message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversation(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: inbound_payload inbound_payload_pipeline_input_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_payload
    ADD CONSTRAINT inbound_payload_pipeline_input_id_fkey FOREIGN KEY (pipeline_input_id) REFERENCES public.pipeline_input(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: inventory_delta_holding inventory_delta_holding_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_delta_holding
    ADD CONSTRAINT inventory_delta_holding_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.inventory_delta_event(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: llm_usage llm_usage_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversation(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: llm_usage llm_usage_pipeline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES public.dealflow_pipeline(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: pipeline_input_message_type pipeline_input_message_type_node_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pipeline_input_message_type pipeline_input_message_type_pipeline_input_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_pipeline_input_id_fkey FOREIGN KEY (pipeline_input_id) REFERENCES public.pipeline_input(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pipeline_input pipeline_input_pipeline_configuration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_input
    ADD CONSTRAINT pipeline_input_pipeline_configuration_id_fkey FOREIGN KEY (pipeline_configuration_id) REFERENCES public.pipeline_configuration(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: pipeline_output pipeline_output_pipeline_configuration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_output
    ADD CONSTRAINT pipeline_output_pipeline_configuration_id_fkey FOREIGN KEY (pipeline_configuration_id) REFERENCES public.pipeline_configuration(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: pipeline_output pipeline_output_trigger_node_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_output
    ADD CONSTRAINT pipeline_output_trigger_node_type_id_fkey FOREIGN KEY (trigger_node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: resource_payload resource_payload_inbound_payload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_payload
    ADD CONSTRAINT resource_payload_inbound_payload_id_fkey FOREIGN KEY (inbound_payload_id) REFERENCES public.inbound_payload(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: asset asset_convertible_investor_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset
    ADD CONSTRAINT asset_convertible_investor_id_fkey FOREIGN KEY (convertible_investor_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: asset asset_issued_by_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset
    ADD CONSTRAINT asset_issued_by_legal_entity_id_fkey FOREIGN KEY (issued_by_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: asset_transfer asset_transfer_asset_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: asset_transfer asset_transfer_from_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_from_legal_entity_id_fkey FOREIGN KEY (from_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: asset_transfer asset_transfer_to_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_to_legal_entity_id_fkey FOREIGN KEY (to_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: asset_transfer asset_transfer_transaction_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES valuations.transaction(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: currency_asset currency_asset_asset_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.currency_asset
    ADD CONSTRAINT currency_asset_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: event event_acquirer_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.event
    ADD CONSTRAINT event_acquirer_id_fkey FOREIGN KEY (acquirer_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: event event_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.event
    ADD CONSTRAINT event_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: funding_changelog_fund funding_changelog_fund_changelog_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.funding_changelog_fund
    ADD CONSTRAINT funding_changelog_fund_changelog_id_fkey FOREIGN KEY (changelog_id) REFERENCES valuations.funding_changelog(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: funding_changelog_fund funding_changelog_fund_fund_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.funding_changelog_fund
    ADD CONSTRAINT funding_changelog_fund_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: funding_changelog funding_changelog_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.funding_changelog
    ADD CONSTRAINT funding_changelog_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: investment_attribution investment_attribution_investment_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment_attribution
    ADD CONSTRAINT investment_attribution_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES valuations.investment(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: investment_attribution investment_attribution_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment_attribution
    ADD CONSTRAINT investment_attribution_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: investment investment_event_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_event_id_fkey FOREIGN KEY (event_id) REFERENCES valuations.event(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: investment investment_investment_profile_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_investment_profile_id_fkey FOREIGN KEY (investment_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: investment investment_investor_profile_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_investor_profile_id_fkey FOREIGN KEY (investor_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: legal_entity legal_entity_acquired_by_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_acquired_by_legal_entity_id_fkey FOREIGN KEY (acquired_by_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: legal_entity legal_entity_investing_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_investing_entity_id_fkey FOREIGN KEY (investing_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: legal_entity legal_entity_operated_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_operated_by_profile_id_fkey FOREIGN KEY (operated_by_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: legal_entity legal_entity_public_profile_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_public_profile_id_fkey FOREIGN KEY (public_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: legal_entity legal_entity_underlying_company_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_underlying_company_id_fkey FOREIGN KEY (underlying_company_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: outbound_delivery outbound_delivery_subscription_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.outbound_delivery
    ADD CONSTRAINT outbound_delivery_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES valuations.webhook_subscription(id) ON DELETE CASCADE;


--
-- Name: price price_asset_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: price price_event_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_event_id_fkey FOREIGN KEY (event_id) REFERENCES valuations.event(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: price price_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: team_settings team_settings_default_investing_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.team_settings
    ADD CONSTRAINT team_settings_default_investing_entity_id_fkey FOREIGN KEY (default_investing_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: team_settings team_settings_own_entity_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.team_settings
    ADD CONSTRAINT team_settings_own_entity_id_fkey FOREIGN KEY (own_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transaction transaction_converted_to_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_converted_to_id_fkey FOREIGN KEY (converted_to_id) REFERENCES valuations.transaction(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transaction transaction_due_to_rights_from_asset_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_due_to_rights_from_asset_id_fkey FOREIGN KEY (due_to_rights_from_asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transaction transaction_event_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_event_id_fkey FOREIGN KEY (event_id) REFERENCES valuations.event(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transaction transaction_investment_id_fkey; Type: FK CONSTRAINT; Schema: valuations; Owner: -
--

ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES valuations.investment(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: movement agent_team_isolation; Type: POLICY; Schema: automations; Owner: -
--

CREATE POLICY agent_team_isolation ON automations.movement FOR SELECT TO agent USING (((team_id)::text = automations.current_team_id()));


--
-- Name: trigger agent_team_isolation; Type: POLICY; Schema: automations; Owner: -
--

CREATE POLICY agent_team_isolation ON automations.trigger FOR SELECT TO agent USING (((team_id)::text = automations.current_team_id()));


--
-- Name: movement; Type: ROW SECURITY; Schema: automations; Owner: -
--

ALTER TABLE automations.movement ENABLE ROW LEVEL SECURITY;

--
-- Name: movement non_agent_full_access; Type: POLICY; Schema: automations; Owner: -
--

CREATE POLICY non_agent_full_access ON automations.movement USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: trigger non_agent_full_access; Type: POLICY; Schema: automations; Owner: -
--

CREATE POLICY non_agent_full_access ON automations.trigger USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: trigger; Type: ROW SECURITY; Schema: automations; Owner: -
--

ALTER TABLE automations.trigger ENABLE ROW LEVEL SECURITY;

--
-- Name: change agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.change FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: edge agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.edge FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: edge_type agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.edge_type FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: evidence agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.evidence FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: extraction_graph agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.extraction_graph FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: extraction_graph_edge agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.extraction_graph_edge FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: extraction_graph_node agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.extraction_graph_node FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: linked_object agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.linked_object FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: node agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.node FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: node_resource agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.node_resource FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: node_type agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.node_type FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: property agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.property FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: property_type agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.property_type FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: raw_text agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.raw_text FOR SELECT TO agent USING (((team_id IS NULL) OR ((team_id)::text = knowledge.current_team_id())));


--
-- Name: raw_text_part agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.raw_text_part FOR SELECT TO agent USING (((team_id)::text = knowledge.current_team_id()));


--
-- Name: resource agent_team_isolation; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY agent_team_isolation ON knowledge.resource FOR SELECT TO agent USING (((team_id IS NULL) OR ((team_id)::text = knowledge.current_team_id())));


--
-- Name: change; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.change ENABLE ROW LEVEL SECURITY;

--
-- Name: edge; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.edge ENABLE ROW LEVEL SECURITY;

--
-- Name: edge_type; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.edge_type ENABLE ROW LEVEL SECURITY;

--
-- Name: evidence; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_graph; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.extraction_graph ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_graph_edge; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.extraction_graph_edge ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_graph_node; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.extraction_graph_node ENABLE ROW LEVEL SECURITY;

--
-- Name: linked_object; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.linked_object ENABLE ROW LEVEL SECURITY;

--
-- Name: node; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.node ENABLE ROW LEVEL SECURITY;

--
-- Name: node_resource; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.node_resource ENABLE ROW LEVEL SECURITY;

--
-- Name: node_type; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.node_type ENABLE ROW LEVEL SECURITY;

--
-- Name: change non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.change USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: edge non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.edge USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: edge_type non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.edge_type USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: evidence non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.evidence USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: extraction_graph non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.extraction_graph USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: extraction_graph_edge non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.extraction_graph_edge USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: extraction_graph_node non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.extraction_graph_node USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: linked_object non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.linked_object USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: node non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.node USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: node_resource non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.node_resource USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: node_type non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.node_type USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: property non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.property USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: property_type non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.property_type USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: raw_text non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.raw_text USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: raw_text_part non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.raw_text_part USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: resource non_agent_full_access; Type: POLICY; Schema: knowledge; Owner: -
--

CREATE POLICY non_agent_full_access ON knowledge.resource USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: property; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.property ENABLE ROW LEVEL SECURITY;

--
-- Name: property_type; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.property_type ENABLE ROW LEVEL SECURITY;

--
-- Name: raw_text; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.raw_text ENABLE ROW LEVEL SECURITY;

--
-- Name: raw_text_part; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.raw_text_part ENABLE ROW LEVEL SECURITY;

--
-- Name: resource; Type: ROW SECURITY; Schema: knowledge; Owner: -
--

ALTER TABLE knowledge.resource ENABLE ROW LEVEL SECURITY;

--
-- Name: profile_role agent_team_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_team_isolation ON public.profile_role FOR SELECT TO agent USING ((EXISTS ( SELECT 1
   FROM valuations.legal_entity le
  WHERE ((le.id = profile_role.profile_id) AND ((le.team_id IS NULL) OR ((le.team_id)::text = valuations.current_team_id()))))));


--
-- Name: profile_role non_agent_full_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY non_agent_full_access ON public.profile_role USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: profile_role; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profile_role ENABLE ROW LEVEL SECURITY;

--
-- Name: event agent_team_isolation; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY agent_team_isolation ON valuations.event FOR SELECT TO agent USING (((team_id IS NULL) OR ((team_id)::text = valuations.current_team_id())));


--
-- Name: investment agent_team_isolation; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY agent_team_isolation ON valuations.investment FOR SELECT TO agent USING (((team_id IS NULL) OR ((team_id)::text = valuations.current_team_id())));


--
-- Name: investment_attribution agent_team_isolation; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY agent_team_isolation ON valuations.investment_attribution FOR SELECT TO agent USING ((EXISTS ( SELECT 1
   FROM valuations.investment i
  WHERE ((i.id = investment_attribution.investment_id) AND ((i.team_id IS NULL) OR ((i.team_id)::text = valuations.current_team_id()))))));


--
-- Name: legal_entity agent_team_isolation; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY agent_team_isolation ON valuations.legal_entity FOR SELECT TO agent USING (((team_id IS NULL) OR ((team_id)::text = valuations.current_team_id())));


--
-- Name: event; Type: ROW SECURITY; Schema: valuations; Owner: -
--

ALTER TABLE valuations.event ENABLE ROW LEVEL SECURITY;

--
-- Name: investment; Type: ROW SECURITY; Schema: valuations; Owner: -
--

ALTER TABLE valuations.investment ENABLE ROW LEVEL SECURITY;

--
-- Name: investment_attribution; Type: ROW SECURITY; Schema: valuations; Owner: -
--

ALTER TABLE valuations.investment_attribution ENABLE ROW LEVEL SECURITY;

--
-- Name: legal_entity; Type: ROW SECURITY; Schema: valuations; Owner: -
--

ALTER TABLE valuations.legal_entity ENABLE ROW LEVEL SECURITY;

--
-- Name: event non_agent_full_access; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY non_agent_full_access ON valuations.event USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: investment non_agent_full_access; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY non_agent_full_access ON valuations.investment USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: investment_attribution non_agent_full_access; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY non_agent_full_access ON valuations.investment_attribution USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: legal_entity non_agent_full_access; Type: POLICY; Schema: valuations; Owner: -
--

CREATE POLICY non_agent_full_access ON valuations.legal_entity USING ((CURRENT_USER <> 'agent'::name));


--
-- Name: SCHEMA asks; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA asks TO readonly;


--
-- Name: SCHEMA automations; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA automations TO agent;
GRANT USAGE ON SCHEMA automations TO readonly;


--
-- Name: SCHEMA core; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA core TO readonly;


--
-- Name: SCHEMA knowledge; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA knowledge TO agent;
GRANT USAGE ON SCHEMA knowledge TO readonly;


--
-- Name: SCHEMA valuations; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA valuations TO agent;
GRANT USAGE ON SCHEMA valuations TO readonly;


--
-- Name: FUNCTION edge_prop(edge_id uuid, prop_name text); Type: ACL; Schema: knowledge; Owner: -
--

GRANT ALL ON FUNCTION knowledge.edge_prop(edge_id uuid, prop_name text) TO agent;


--
-- Name: FUNCTION edge_prop_num(edge_id uuid, prop_name text); Type: ACL; Schema: knowledge; Owner: -
--

GRANT ALL ON FUNCTION knowledge.edge_prop_num(edge_id uuid, prop_name text) TO agent;


--
-- Name: FUNCTION prop(node_id uuid, prop_name text); Type: ACL; Schema: knowledge; Owner: -
--

GRANT ALL ON FUNCTION knowledge.prop(node_id uuid, prop_name text) TO agent;


--
-- Name: FUNCTION prop_bool(node_id uuid, prop_name text); Type: ACL; Schema: knowledge; Owner: -
--

GRANT ALL ON FUNCTION knowledge.prop_bool(node_id uuid, prop_name text) TO agent;


--
-- Name: FUNCTION prop_date(node_id uuid, prop_name text); Type: ACL; Schema: knowledge; Owner: -
--

GRANT ALL ON FUNCTION knowledge.prop_date(node_id uuid, prop_name text) TO agent;


--
-- Name: FUNCTION prop_num(node_id uuid, prop_name text); Type: ACL; Schema: knowledge; Owner: -
--

GRANT ALL ON FUNCTION knowledge.prop_num(node_id uuid, prop_name text) TO agent;


--
-- Name: FUNCTION execute_agent_query(query_text text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_agent_query(query_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_agent_query(query_text text) TO agent;


--
-- Name: TABLE ask; Type: ACL; Schema: asks; Owner: -
--

GRANT SELECT ON TABLE asks.ask TO readonly;


--
-- Name: TABLE ask_webhook_delivery; Type: ACL; Schema: asks; Owner: -
--

GRANT SELECT ON TABLE asks.ask_webhook_delivery TO readonly;


--
-- Name: TABLE worker_heartbeat; Type: ACL; Schema: asks; Owner: -
--

GRANT SELECT ON TABLE asks.worker_heartbeat TO readonly;


--
-- Name: TABLE adapter_await; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.adapter_await TO readonly;


--
-- Name: TABLE audit_log; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.audit_log TO readonly;


--
-- Name: TABLE callback; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.callback TO readonly;


--
-- Name: TABLE connect_token; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.connect_token TO readonly;


--
-- Name: TABLE exposed_file; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.exposed_file TO readonly;


--
-- Name: TABLE external_service_credentials; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.external_service_credentials TO readonly;


--
-- Name: TABLE google_granted_item; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.google_granted_item TO readonly;


--
-- Name: TABLE inbound_email_route; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.inbound_email_route TO readonly;


--
-- Name: TABLE join_branch_export; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.join_branch_export TO readonly;


--
-- Name: TABLE join_pending; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.join_pending TO readonly;


--
-- Name: TABLE movement; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.movement TO agent;
GRANT SELECT ON TABLE automations.movement TO readonly;


--
-- Name: TABLE movement_issue; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.movement_issue TO readonly;


--
-- Name: TABLE movement_story_token; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.movement_story_token TO readonly;


--
-- Name: TABLE movement_version; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.movement_version TO readonly;


--
-- Name: TABLE outbound_email; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.outbound_email TO readonly;


--
-- Name: TABLE parked_run; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.parked_run TO readonly;


--
-- Name: TABLE phone_number; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.phone_number TO readonly;


--
-- Name: TABLE phone_verification; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.phone_verification TO readonly;


--
-- Name: TABLE platform_owned_token; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.platform_owned_token TO readonly;


--
-- Name: TABLE record_binding; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.record_binding TO readonly;


--
-- Name: TABLE remote_adapter; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.remote_adapter TO readonly;


--
-- Name: TABLE team_settings; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.team_settings TO readonly;


--
-- Name: TABLE telegram_identity; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.telegram_identity TO readonly;


--
-- Name: TABLE telegram_token; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.telegram_token TO readonly;


--
-- Name: TABLE trigger; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.trigger TO agent;
GRANT SELECT ON TABLE automations.trigger TO readonly;


--
-- Name: TABLE trigger_event; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.trigger_event TO readonly;


--
-- Name: TABLE trigger_run; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.trigger_run TO readonly;


--
-- Name: TABLE webhook_subscription; Type: ACL; Schema: automations; Owner: -
--

GRANT SELECT ON TABLE automations.webhook_subscription TO readonly;


--
-- Name: TABLE api_key; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.api_key TO readonly;


--
-- Name: TABLE audit_log; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.audit_log TO readonly;


--
-- Name: TABLE magic_link_token; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.magic_link_token TO readonly;


--
-- Name: TABLE pending_signup; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.pending_signup TO readonly;


--
-- Name: TABLE team; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.team TO readonly;


--
-- Name: TABLE team_invite; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.team_invite TO readonly;


--
-- Name: TABLE team_membership; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.team_membership TO readonly;


--
-- Name: TABLE "user"; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core."user" TO readonly;


--
-- Name: TABLE user_email; Type: ACL; Schema: core; Owner: -
--

GRANT SELECT ON TABLE core.user_email TO readonly;


--
-- Name: TABLE audit_log; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.audit_log TO readonly;


--
-- Name: TABLE change; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.change TO agent;
GRANT SELECT ON TABLE knowledge.change TO readonly;


--
-- Name: TABLE document; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.document TO readonly;


--
-- Name: TABLE edge; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.edge TO agent;
GRANT SELECT ON TABLE knowledge.edge TO readonly;


--
-- Name: TABLE edge_type; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.edge_type TO agent;
GRANT SELECT ON TABLE knowledge.edge_type TO readonly;


--
-- Name: TABLE evidence; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.evidence TO agent;
GRANT SELECT ON TABLE knowledge.evidence TO readonly;


--
-- Name: TABLE extraction_fact; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.extraction_fact TO readonly;


--
-- Name: TABLE extraction_graph; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.extraction_graph TO agent;
GRANT SELECT ON TABLE knowledge.extraction_graph TO readonly;


--
-- Name: TABLE extraction_graph_edge; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.extraction_graph_edge TO agent;
GRANT SELECT ON TABLE knowledge.extraction_graph_edge TO readonly;


--
-- Name: TABLE extraction_graph_node; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.extraction_graph_node TO agent;
GRANT SELECT ON TABLE knowledge.extraction_graph_node TO readonly;


--
-- Name: TABLE linked_object; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.linked_object TO agent;
GRANT SELECT ON TABLE knowledge.linked_object TO readonly;


--
-- Name: TABLE mutation_outbox; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.mutation_outbox TO readonly;


--
-- Name: TABLE node; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.node TO agent;
GRANT SELECT ON TABLE knowledge.node TO readonly;


--
-- Name: TABLE node_resource; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.node_resource TO agent;
GRANT SELECT ON TABLE knowledge.node_resource TO readonly;


--
-- Name: TABLE node_type; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.node_type TO agent;
GRANT SELECT ON TABLE knowledge.node_type TO readonly;


--
-- Name: TABLE output_run; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.output_run TO readonly;


--
-- Name: TABLE plugin; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.plugin TO readonly;


--
-- Name: TABLE property; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.property TO agent;
GRANT SELECT ON TABLE knowledge.property TO readonly;


--
-- Name: TABLE property_arbitration; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.property_arbitration TO readonly;


--
-- Name: TABLE property_type; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.property_type TO agent;
GRANT SELECT ON TABLE knowledge.property_type TO readonly;


--
-- Name: TABLE raw_text; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.raw_text TO agent;
GRANT SELECT ON TABLE knowledge.raw_text TO readonly;


--
-- Name: TABLE raw_text_part; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.raw_text_part TO agent;
GRANT SELECT ON TABLE knowledge.raw_text_part TO readonly;


--
-- Name: TABLE recipe; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.recipe TO readonly;


--
-- Name: TABLE resource; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.resource TO agent;
GRANT SELECT ON TABLE knowledge.resource TO readonly;


--
-- Name: TABLE saved_filter; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.saved_filter TO readonly;


--
-- Name: TABLE team_agent_settings; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.team_agent_settings TO readonly;


--
-- Name: TABLE webhook_endpoint; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.webhook_endpoint TO readonly;


--
-- Name: TABLE worker_heartbeat; Type: ACL; Schema: knowledge; Owner: -
--

GRANT SELECT ON TABLE knowledge.worker_heartbeat TO readonly;


--
-- Name: TABLE profile_role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.profile_role TO agent;


--
-- Name: TABLE asset; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.asset TO readonly;


--
-- Name: TABLE asset_transfer; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.asset_transfer TO readonly;


--
-- Name: TABLE audit_log; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.audit_log TO readonly;


--
-- Name: TABLE currency_asset; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.currency_asset TO readonly;


--
-- Name: TABLE event; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.event TO agent;
GRANT SELECT ON TABLE valuations.event TO readonly;


--
-- Name: TABLE exchange_rate; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.exchange_rate TO readonly;


--
-- Name: TABLE funding_changelog; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.funding_changelog TO readonly;


--
-- Name: TABLE funding_changelog_fund; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.funding_changelog_fund TO readonly;


--
-- Name: TABLE investment; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.investment TO agent;
GRANT SELECT ON TABLE valuations.investment TO readonly;


--
-- Name: TABLE investment_attribution; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.investment_attribution TO agent;
GRANT SELECT ON TABLE valuations.investment_attribution TO readonly;


--
-- Name: TABLE legal_entity; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.legal_entity TO agent;
GRANT SELECT ON TABLE valuations.legal_entity TO readonly;


--
-- Name: TABLE note; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.note TO readonly;


--
-- Name: TABLE outbound_delivery; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.outbound_delivery TO readonly;


--
-- Name: TABLE price; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.price TO readonly;


--
-- Name: TABLE team_settings; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.team_settings TO readonly;


--
-- Name: TABLE transaction; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.transaction TO readonly;


--
-- Name: TABLE valuations_change_outbox; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.valuations_change_outbox TO readonly;


--
-- Name: TABLE webhook_subscription; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.webhook_subscription TO readonly;


--
-- Name: TABLE worker_heartbeat; Type: ACL; Schema: valuations; Owner: -
--

GRANT SELECT ON TABLE valuations.worker_heartbeat TO readonly;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: asks; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA asks GRANT SELECT ON TABLES TO readonly;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: automations; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA automations GRANT SELECT ON TABLES TO readonly;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: core; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO readonly;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: knowledge; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge GRANT SELECT ON TABLES TO readonly;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: valuations; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA valuations GRANT SELECT ON TABLES TO readonly;


--
-- PostgreSQL database dump complete
--

