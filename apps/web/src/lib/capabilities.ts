// Which units this deployment runs, and which nav entries that makes real.
//
// The API refuses an unmounted product's tRPC procedure with a 404 (its own
// product gate), so a nav entry for an absent unit is a link that breaks on
// click. The mapping lives HERE and only here, so consumers agree — but nothing
// checks it: an href nobody mapped is treated as unclaimed and shows on every
// deployment. Adding a nav entry without adding it here is a silent omission,
// not a compile error.
//
// The units are the server's own, and each entry below is the unit that owns
// the view router the page actually calls (`VIEW_ROUTER_UNITS` in
// apps/api/src/interfaces/trpc/product_gate.ts). Where they disagree, the
// server is right and this file is the bug.

const UNITS = ['core', 'valuations', 'automations', 'knowledge', 'asks'] as const;

type Unit = (typeof UNITS)[number];

/** Absolute MCP connector URLs this deployment serves, keyed by connector
 *  domain — present only for a unit that is actually mounted. */
interface McpConnectorUrls {
  automation?: string;
  knowledge?: string;
  valuations?: string;
}

interface Capabilities {
  products: readonly Unit[];
  identity: 'static' | 'core';
  /** Optional: a probe answer from before this field existed, or one that
   *  failed to parse it, still gets treated as "no connector URLs known"
   *  rather than failing the whole parse. */
  mcp?: McpConnectorUrls;
}

/**
 * Nav href → the unit whose absence hides it, or the units of which ANY will
 * do (the handbook shelf is forked, not shared, so either product serves it).
 * An href absent from this map is unclaimed, and unclaimed always shows.
 *
 * Declaration order is the sidebar's order, and `firstMountedHref` reads it as
 * such — keep them in step.
 */
const NAV_UNITS: Readonly<Record<string, Unit | readonly Unit[]>> = {
  '/dashboard': 'automations',
  '/automations': 'automations',
  '/runs': 'automations',
  // The asks pages read `views.controlTower`, which automations owns; there is
  // no asks view router. An asks-only deployment therefore shows no Asks nav.
  '/asks': 'automations',
  '/asks/history': 'automations',
  '/portfolio': 'valuations',
  '/model': 'knowledge',
  '/api-explorer': 'knowledge',
  '/credentials': 'automations',
  '/adapters': 'automations',
  '/plugins': 'automations',
  '/library': ['knowledge', 'automations'],
  '/settings': 'core',
};

/** Where a deployment with no nav entry of its own sends people. */
const FALLBACK_HREF = '/home';

function isUnit(value: unknown): value is Unit {
  return typeof value === 'string' && UNITS.some((unit) => unit === value);
}

/** The probe as the login page sees it: the answer, and whether it has landed.
 *  Null-and-unsettled is a different state from null-and-failed, and the page
 *  may only act on the second — see `loginMode`. */
interface CapabilitiesProbe {
  capabilities: Capabilities | null;
  settled: boolean;
}

/**
 * Which login page this deployment gets.
 *
 * `static` is decided by the deployment and NOT by what OAuth ids happen to be
 * baked into the image: a single-tenant install's whole credential is its API
 * key, so it needs the key form whatever the providers say. Reading the baked
 * ids first is what left a self-host with no door at all.
 *
 * There is no "no provider configured" answer, because there is no deployment
 * without one: core identity always serves the password and magic-link routes,
 * and the page always renders that form. The OAuth buttons are an addition to
 * it, never the only way in.
 */
type LoginMode = 'static' | 'core' | 'pending';

function loginMode({ capabilities, settled }: CapabilitiesProbe): LoginMode {
  if (capabilities?.identity === 'static') return 'static';
  if (capabilities === null && !settled) return 'pending';
  return 'core';
}

function isMcpConnectorUrls(value: unknown): value is McpConnectorUrls {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (['automation', 'knowledge', 'valuations'] as const).every(
    (key) => record[key] === undefined || typeof record[key] === 'string',
  );
}

/** The endpoint's answer, or null when it is not the contract. A null answer
 *  means "assume everything" — a broken probe must not empty the nav. A
 *  missing or malformed `mcp` is not that severe — it just means no connector
 *  URL is known, so it falls back to `{}` rather than failing the parse. */
function parseCapabilities(body: unknown): Capabilities | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  if (!('products' in body) || !('identity' in body)) return null;
  const { products, identity, mcp } = body as Record<string, unknown>;
  if (!Array.isArray(products)) return null;
  if (identity !== 'static' && identity !== 'core') return null;
  return {
    products: products.filter(isUnit),
    identity,
    mcp: isMcpConnectorUrls(mcp) ? mcp : {},
  };
}

/** Does this deployment run the unit — or, given several, any of them? For the
 *  call sites that are not a nav entry — a background subscription, a search
 *  box — and so have no href to name themselves by. A null answer means
 *  "assume everything", as above. */
function unitIsMounted(unit: Unit | readonly Unit[], capabilities: Capabilities | null): boolean {
  if (capabilities === null) return true;
  const { products } = capabilities;
  return typeof unit === 'string'
    ? products.includes(unit)
    : unit.some((candidate) => products.includes(candidate));
}

function navIsMounted(href: string, capabilities: Capabilities | null): boolean {
  const unit: Unit | readonly Unit[] | undefined = NAV_UNITS[href];
  if (unit === undefined) return true;
  return unitIsMounted(unit, capabilities);
}

/** Where to land someone who asked for no page in particular. The first nav
 *  entry this deployment actually runs, so a knowledge-only install opens on
 *  its data model rather than an automations home it does not have. */
function firstMountedHref(capabilities: Capabilities | null): string {
  if (capabilities === null) return FALLBACK_HREF;
  return Object.keys(NAV_UNITS).find((href) => navIsMounted(href, capabilities)) ?? FALLBACK_HREF;
}

export {
  UNITS,
  type Unit,
  type Capabilities,
  type McpConnectorUrls,
  type CapabilitiesProbe,
  type LoginMode,
  NAV_UNITS,
  parseCapabilities,
  unitIsMounted,
  navIsMounted,
  firstMountedHref,
  loginMode,
};
