// The origin OAuth discovery documents point at: PUBLIC_URL, then
// API_BASE_URL, then the request's own Host header. One helper backs both
// oauth.ts and protected_resource.ts, so this is the single place the
// precedence is pinned down.

import { getOrigin } from '../origin';

function fakeRequest(headers: Record<string, string | undefined>, protocol = 'https') {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    protocol,
  } as unknown as import('express').Request;
}

describe('getOrigin', () => {
  const original = {
    publicUrl: process.env.PUBLIC_URL,
    apiBaseUrl: process.env.API_BASE_URL,
  };

  afterEach(() => {
    if (original.publicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = original.publicUrl;
    if (original.apiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = original.apiBaseUrl;
  });

  it('prefers PUBLIC_URL over everything else', () => {
    process.env.PUBLIC_URL = 'https://public.example.com';
    process.env.API_BASE_URL = 'https://api.example.com';
    expect(getOrigin(fakeRequest({ host: 'proxy.internal' }))).toBe('https://public.example.com');
  });

  it('falls back to API_BASE_URL when PUBLIC_URL is unset, stripping a trailing slash', () => {
    delete process.env.PUBLIC_URL;
    process.env.API_BASE_URL = 'https://api.example.com/';
    expect(getOrigin(fakeRequest({ host: 'proxy.internal' }))).toBe('https://api.example.com');
  });

  it('falls back to the request Host header when neither is set', () => {
    delete process.env.PUBLIC_URL;
    delete process.env.API_BASE_URL;
    expect(getOrigin(fakeRequest({ host: 'example.com' }))).toBe('https://example.com');
  });

  it('prefers x-forwarded-host and x-forwarded-proto over the direct host/protocol', () => {
    delete process.env.PUBLIC_URL;
    delete process.env.API_BASE_URL;
    expect(
      getOrigin(
        fakeRequest({ host: 'internal:3000', 'x-forwarded-host': 'public.example.com', 'x-forwarded-proto': 'https' }, 'http'),
      ),
    ).toBe('https://public.example.com');
  });
});
