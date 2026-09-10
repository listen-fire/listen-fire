// What this deployment runs, answered BEFORE authentication.
//
// A frontend cannot know which units are mounted, and a nav entry for an absent
// unit is a link that 404s on click (the tRPC product gate refuses the
// procedure). So this answers with the same pair of facts, read through the
// same code the server itself uses — `compose` for the products,
// `principalMode` for the identity.
//
// It composes them per request rather than reading the boot-time composition
// the gate froze, because the function stays callable on an arbitrary
// environment (that is what its tests do). Same inputs and same code, so the
// two agree in any process whose environment does not change underneath it.
//
// It mounts BEFORE `createAuthenticationHandler` on purpose. Core identity
// exempts `/public/` URLs from credential resolution; the static provider does
// not, and must not, so a route that tells an anonymous caller how to log in
// has to sit in front of the funnel rather than inside it.

import { Router, type RequestHandler } from 'express';
import { secretsMatch, staticConfigFromEnv } from 'principal';

import { PRODUCTS, compose, type Product } from '../../products';
import { principalMode, type PrincipalMode } from '../../services/principal/mode';
import { mintStaticSessionToken } from '../../services/auth/static_session';
import { clearAuthCookies, setAuthCookies } from './auth_cookies';
import { AUTOMATION_MCP_PATH, KNOWLEDGE_MCP_PATH, VALUATIONS_MCP_PATH } from '../mcp/paths';
import { publicConfigHandler } from './public_config';

type Env = Record<string, string | undefined>;

/** Absolute MCP connector URLs, keyed by the connector's own domain name —
 *  present only for a unit this deployment actually mounts, so a frontend
 *  never offers to connect to something that isn't there. */
interface McpConnectorUrls {
  automation?: string;
  knowledge?: string;
  valuations?: string;
}

interface Capabilities {
  products: Product[];
  identity: PrincipalMode;
  mcp: McpConnectorUrls;
}

/**
 * The origin every MCP connector URL is built on. Mirrors the dev default the
 * server's own icon URLs use (`server.ts`'s `serverIcons`), but reads the
 * `env` parameter rather than `process.env` directly so this stays testable
 * against an arbitrary environment the way `compose`/`principalMode` already
 * are.
 */
function apiBaseUrl(env: Env): string {
  const configured = env.API_BASE_URL;
  if (configured !== undefined) return configured.replace(/\/$/, '');
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'The API_BASE_URL environment variable is required to advertise MCP connector URLs',
    );
  }
  return `http://localhost:${env.PORT ?? 3000}`;
}

function mcpUrls(products: ReadonlySet<Product>, env: Env): McpConnectorUrls {
  const base = apiBaseUrl(env);
  const urls: McpConnectorUrls = {};
  if (products.has('automations')) urls.automation = `${base}${AUTOMATION_MCP_PATH}`;
  if (products.has('knowledge')) urls.knowledge = `${base}${KNOWLEDGE_MCP_PATH}`;
  if (products.has('valuations')) urls.valuations = `${base}${VALUATIONS_MCP_PATH}`;
  return urls;
}

/** Declaration order, not the order the operator happened to type. */
function capabilitiesFrom(env: Env): Capabilities {
  const { products } = compose(env);
  return {
    products: PRODUCTS.filter((product) => products.has(product)),
    identity: principalMode(env),
    mcp: mcpUrls(products, env),
  };
}

const capabilitiesHandler: RequestHandler = (_req, res) => {
  res.status(200).json(capabilitiesFrom(process.env));
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presentedApiKey(body: unknown): string {
  if (!isRecord(body)) return '';
  const { apiKey } = body;
  return typeof apiKey === 'string' ? apiKey : '';
}

/**
 * Trade the installation's API key for the session cookie the UI runs on. The
 * comparison is the provider's own (`secretsMatch` — digest-then-timing-safe),
 * so the login door and the API door can never disagree about what the key is.
 */
const staticLoginHandler: RequestHandler = (req, res) => {
  const config = staticConfigFromEnv(process.env);
  const presented = presentedApiKey(req.body);

  if (config.apiKey === undefined || presented === '' || !secretsMatch(presented, config.apiKey)) {
    res.status(401).send({ error: 'Invalid API key' });
    return;
  }

  setAuthCookies(res, mintStaticSessionToken({ teamId: config.teamId, apiKey: config.apiKey }));
  res.status(200).send({ teamId: config.teamId });
};

/** The mirror of the login. A static install keeps no session state to expire
 *  — the cookie IS the session — so dropping both cookies is the whole logout. */
const staticLogoutHandler: RequestHandler = (_req, res) => {
  clearAuthCookies(res);
  res.status(204).send();
};

const preAuthRouter: ReturnType<typeof Router> = Router();

preAuthRouter.get('/capabilities', capabilitiesHandler);
// Which sign-in providers exist, for the one page that has no session yet.
preAuthRouter.get('/config', publicConfigHandler);

// Only where it is the login: core mounts its own family on `publicRouter`, and
// two live login doors on one deployment is a second way in nobody chose.
if (principalMode() === 'static') {
  preAuthRouter.post('/auth/static/login', staticLoginHandler);
  preAuthRouter.post('/auth/static/logout', staticLogoutHandler);
}

export {
  type Capabilities,
  type McpConnectorUrls,
  capabilitiesFrom,
  capabilitiesHandler,
  preAuthRouter,
  staticLoginHandler,
  staticLogoutHandler,
};
