// The nav→unit mapping and the capabilities parse. The mapping lives in one
// place so consumers agree, but nothing checks it at compile time: an href
// nobody mapped is treated as unclaimed and shows on every deployment.

import {
  NAV_UNITS,
  UNITS,
  firstMountedHref,
  loginMode,
  navIsMounted,
  parseCapabilities,
  unitIsMounted,
} from '../capabilities';

const KNOWLEDGE_ONLY = { products: ['knowledge'] as const, identity: 'static' as const };

describe('parseCapabilities', () => {
  it('reads the endpoint’s answer', () => {
    expect(
      parseCapabilities({
        products: ['knowledge', 'asks'],
        identity: 'static',
        mcp: { knowledge: 'https://listen-fire.example.com/api/v1/mcp/knowledge' },
      }),
    ).toEqual({
      products: ['knowledge', 'asks'],
      identity: 'static',
      mcp: { knowledge: 'https://listen-fire.example.com/api/v1/mcp/knowledge' },
    });
  });

  it('drops product names it does not know rather than trusting them', () => {
    expect(parseCapabilities({ products: ['knowledge', 'dealflow'], identity: 'core' })).toEqual({
      products: ['knowledge'],
      identity: 'core',
      mcp: {},
    });
  });

  it('falls back to no known connector URLs when mcp is missing or malformed', () => {
    expect(parseCapabilities({ products: ['knowledge'], identity: 'static' })!.mcp).toEqual({});
    expect(
      parseCapabilities({ products: ['knowledge'], identity: 'static', mcp: { automation: 3 } })!
        .mcp,
    ).toEqual({});
    expect(
      parseCapabilities({ products: ['knowledge'], identity: 'static', mcp: 'nope' })!.mcp,
    ).toEqual({});
  });

  it('returns null for anything that is not the contract', () => {
    expect(parseCapabilities(null)).toBeNull();
    expect(parseCapabilities({ products: 'knowledge', identity: 'static' })).toBeNull();
    expect(parseCapabilities({ products: [], identity: 'ldap' })).toBeNull();
  });
});

describe('unitIsMounted', () => {
  it('answers for a component that has no nav entry to name itself by', () => {
    expect(unitIsMounted('knowledge', KNOWLEDGE_ONLY)).toBe(true);
    expect(unitIsMounted('automations', KNOWLEDGE_ONLY)).toBe(false);
  });

  it('assumes everything while capabilities are still loading', () => {
    expect(unitIsMounted('automations', null)).toBe(true);
  });
});

describe('navIsMounted', () => {
  it('shows an entry whose unit is mounted', () => {
    expect(navIsMounted('/model', { products: ['knowledge'], identity: 'static' })).toBe(true);
  });

  it('hides an entry whose unit is absent', () => {
    expect(navIsMounted('/portfolio', { products: ['knowledge'], identity: 'static' })).toBe(false);
    expect(navIsMounted('/automations', { products: ['knowledge'], identity: 'static' })).toBe(false);
    expect(navIsMounted('/settings', { products: ['knowledge'], identity: 'static' })).toBe(false);
  });

  it('shows everything while capabilities are still loading', () => {
    for (const href of Object.keys(NAV_UNITS)) {
      expect(navIsMounted(href, null)).toBe(true);
    }
  });

  it('shows an href nobody claimed', () => {
    expect(navIsMounted('/some-future-page', KNOWLEDGE_ONLY)).toBe(true);
  });

  it('shows an entry either of whose units is mounted', () => {
    expect(navIsMounted('/library', KNOWLEDGE_ONLY)).toBe(true);
    expect(navIsMounted('/library', { products: ['automations'], identity: 'core' })).toBe(true);
    expect(navIsMounted('/library', { products: ['valuations'], identity: 'core' })).toBe(false);
  });
});

describe('firstMountedHref', () => {
  it('falls back to /home while capabilities are still loading', () => {
    expect(firstMountedHref(null)).toBe('/home');
  });

  it('lands on the first nav entry the deployment actually runs', () => {
    expect(firstMountedHref(KNOWLEDGE_ONLY)).toBe('/model');
  });

  it('lands on the first entry overall when everything is mounted', () => {
    expect(firstMountedHref({ products: UNITS, identity: 'core' })).toBe('/dashboard');
  });

  it('falls back to /home when no nav entry is mounted', () => {
    expect(firstMountedHref({ products: ['asks'], identity: 'static' })).toBe('/home');
  });
});

describe('loginMode', () => {
  const settled = (capabilities: Parameters<typeof loginMode>[0]['capabilities']) => ({
    capabilities,
    settled: true,
  });

  it('asks for the API key on a static install', () => {
    expect(loginMode(settled(KNOWLEDGE_ONLY))).toBe('static');
  });

  it('signs in the ordinary way on core identity', () => {
    expect(loginMode(settled({ products: UNITS, identity: 'core' }))).toBe('core');
  });

  it('holds the frame while the probe is still in flight', () => {
    expect(loginMode({ capabilities: null, settled: false })).toBe('pending');
  });

  it('falls back to the core reading once a failed probe has settled', () => {
    expect(loginMode(settled(null))).toBe('core');
  });
});
