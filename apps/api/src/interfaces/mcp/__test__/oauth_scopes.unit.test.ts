// The OAuth consent grant decides which scopes a Claude MCP connector key
// carries. The cardinal rule after the connector-scope split: a key minted for
// one connector must carry ONLY that connector's scope, even though claude.ai
// reads our authorization-server metadata and requests the union of every
// advertised scope. These tests lock that narrowing — and the legacy
// degradation paths — so the "connecting Automation grants Valuations+Knowledge"
// regression can't return.

import { resolveGrantedScopes, authServerMetadata, SCOPE_LABELS, CONNECTOR_SCOPES } from '../oauth';

const ORIGIN = 'https://api.listen-fire.test';
const resourceFor = (connector: string) => `${ORIGIN}/api/v1/mcp/${connector}`;
// What claude.ai actually sends today: every advertised scope at once.
const UNION = 'automation knowledge valuations';

describe('resolveGrantedScopes', () => {
  it('narrows a union request to the connector\'s own bundle (no cross-connector leak)', () => {
    expect(resolveGrantedScopes({ resource: resourceFor('automation'), scope: UNION })).toEqual([
      'automation',
    ]);
    expect(resolveGrantedScopes({ resource: resourceFor('knowledge'), scope: UNION })).toEqual([
      'knowledge',
    ]);
    expect(resolveGrantedScopes({ resource: resourceFor('valuations'), scope: UNION })).toEqual([
      'valuations',
    ]);
  });

  it('falls back to the connector bundle when the client sends no scope at all', () => {
    expect(resolveGrantedScopes({ resource: resourceFor('automation') })).toEqual(['automation']);
  });

  it('tolerates `+`-decoded and padded scope strings', () => {
    expect(
      resolveGrantedScopes({ resource: resourceFor('automation'), scope: '  automation   knowledge ' }),
    ).toEqual(['automation']);
  });

  it('ignores a trailing slash / query on the resource URI', () => {
    expect(
      resolveGrantedScopes({ resource: `${resourceFor('automation')}?foo=1`, scope: UNION }),
    ).toEqual(['automation']);
  });

  it('honors the requested scopes when the resource is absent/unrecognized', () => {
    expect(resolveGrantedScopes({ scope: 'automation knowledge' })).toEqual([
      'automation',
      'knowledge',
    ]);
    expect(resolveGrantedScopes({ resource: `${ORIGIN}/api/v1/mcp/bogus`, scope: 'automation' })).toEqual(
      ['automation'],
    );
  });

  it('drops unsupported scope tokens entirely', () => {
    expect(resolveGrantedScopes({ scope: 'automation wat openid' })).toEqual(['automation']);
  });

  it('falls back to the legacy pair only when neither resource nor scope is usable', () => {
    expect(resolveGrantedScopes({})).toEqual(['valuations', 'knowledge']);
  });
});

describe('authServerMetadata', () => {
  it('advertises every scope on the global document', () => {
    const meta = authServerMetadata(ORIGIN);
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.scopes_supported).toEqual(['automation', 'knowledge', 'valuations']);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
  });

  it('advertises only the connector scope on a per-connector document, with the resource as issuer', () => {
    const meta = authServerMetadata(ORIGIN, {
      issuer: resourceFor('automation'),
      scopes: ['automation'],
    });
    expect(meta.issuer).toBe(resourceFor('automation'));
    expect(meta.scopes_supported).toEqual(['automation']);
    // Endpoints stay shared at the origin root regardless of issuer.
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
  });
});

// The consent screen renders one chip per granted scope via SCOPE_LABELS,
// falling back to the raw scope token when a label is missing. A reviewer sees
// this screen mid-OAuth, so every scope a connector can grant must carry a
// friendly, jargon-free label — the `account` chip once rendered raw, and the
// automation label once said "movements" (internal jargon).
describe('SCOPE_LABELS consent coverage', () => {
  const grantable = [...new Set(Object.values(CONNECTOR_SCOPES).flat())];

  it.each(grantable)('has a consent label for every connector-grantable scope: %s', (scope) => {
    expect(SCOPE_LABELS[scope]).toBeTruthy();
  });

  it('never leaks internal jargon into a consent label', () => {
    for (const label of Object.values(SCOPE_LABELS)) {
      expect(label.toLowerCase()).not.toMatch(/movement|\bkg\b|schemaref|\btg\b/);
    }
  });
});
