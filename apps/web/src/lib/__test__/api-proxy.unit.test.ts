import { API_PROXY_SOURCES, apiProxyRewrites, isProxiedApiPath, runtimeApiTarget } from '../api-proxy';

describe('api proxy path list', () => {
  it('sends every source to the API under the same path', () => {
    expect(apiProxyRewrites('http://api:3000')).toContainEqual({
      source: '/api/trpc/:path*',
      destination: 'http://api:3000/api/trpc/:path*',
    });
    expect(apiProxyRewrites('http://api:3000')).toHaveLength(API_PROXY_SOURCES.length);
  });

  it('recognises at run time exactly what the rewrites cover at build time', () => {
    expect(isProxiedApiPath('/api/trpc/team.list')).toBe(true);
    expect(isProxiedApiPath('/api/public/capabilities')).toBe(true);
    expect(isProxiedApiPath('/api/public/auth/static/login')).toBe(true);
    expect(isProxiedApiPath('/api/upload_retrievable')).toBe(true);
    // The whole versioned surface, not just MCP — the API explorer's copyable
    // curl points at /api/v1/knowledge/cypher.
    expect(isProxiedApiPath('/api/v1/knowledge/cypher')).toBe(true);
    expect(isProxiedApiPath('/api/v1/mcp/automation')).toBe(true);
    expect(isProxiedApiPath('/.well-known/oauth-protected-resource')).toBe(true);
    expect(isProxiedApiPath('/.well-known/oauth-protected-resource/api/v1/mcp/automation')).toBe(true);
  });

  it('leaves the app’s own routes alone', () => {
    expect(isProxiedApiPath('/login')).toBe(false);
    expect(isProxiedApiPath('/api/health')).toBe(false);
    // A page path that merely starts with a proxied prefix's characters.
    expect(isProxiedApiPath('/api/publications')).toBe(false);
  });

  it('treats an empty runtime target as no target, so the baked rewrites stand', () => {
    const real = process.env.API_INTERNAL_URL;
    try {
      process.env.API_INTERNAL_URL = '';
      expect(runtimeApiTarget()).toBeUndefined();
      process.env.API_INTERNAL_URL = 'http://api:3000';
      expect(runtimeApiTarget()).toBe('http://api:3000');
    } finally {
      if (real === undefined) delete process.env.API_INTERNAL_URL;
      else process.env.API_INTERNAL_URL = real;
    }
  });
});
