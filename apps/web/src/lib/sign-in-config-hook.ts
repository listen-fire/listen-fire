'use client';

import { useEffect, useState } from 'react';

import { parseSignInConfig, type SignInConfig } from './sign-in-config';

/** Long enough for a slow local API, short enough that nothing waits on it —
 *  the same budget the capabilities probe runs on. */
const PROBE_TIMEOUT_MS = 5_000;

interface SignInConfigState {
  config: SignInConfig;
  /** Has the probe finished, either way? The login page holds its frame until
   *  it has, so a provider button never appears a beat after the form. */
  settled: boolean;
}

/**
 * The deployment's OAuth client ids, fetched once. Same-origin, so the web
 * app's own proxy to the API carries it and the page needs no session — which
 * is the point, since this is the page nobody has one on yet.
 */
export function useSignInConfig(): SignInConfigState {
  const [state, setState] = useState<SignInConfigState>({ config: {}, settled: false });

  useEffect(() => {
    let cancelled = false;
    // The probe must always settle: an API that accepts the connection and then
    // never answers would otherwise hold the login page for good.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    fetch('/api/public/config', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (!cancelled) setState({ config: parseSignInConfig(body), settled: true });
      })
      .catch(() => {
        // Unreachable leaves no providers, which is email and password — the
        // doors that do not depend on a third party being configured.
      })
      .finally(() => {
        clearTimeout(timer);
        if (!cancelled) setState((current) => ({ ...current, settled: true }));
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return state;
}
