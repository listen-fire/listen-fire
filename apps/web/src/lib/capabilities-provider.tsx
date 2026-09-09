'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { parseCapabilities, type Capabilities } from './capabilities';

// Fetched ONCE per page load, at the root: the answer is a boot-time fact of the
// deployment, so re-asking it per component would be a request per nav render for
// a value that cannot change while the tab is open.
interface CapabilitiesState {
  capabilities: Capabilities | null;
  /** Has the probe finished, either way? `capabilities` is null both before the
   *  answer lands and forever after a failure, and a redirect that cannot tell
   *  those apart sends a signed-in user to the wrong page. */
  settled: boolean;
}

const CapabilitiesContext = createContext<CapabilitiesState>({
  capabilities: null,
  settled: false,
});

/** Long enough for a slow local API, short enough that nothing waits on it. */
const PROBE_TIMEOUT_MS = 5_000;

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CapabilitiesState>({ capabilities: null, settled: false });

  useEffect(() => {
    let cancelled = false;
    // The probe must always settle: an API that accepts the connection and then
    // never answers would otherwise leave every waiter hanging for good.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    fetch('/api/public/capabilities', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (!cancelled) setState({ capabilities: parseCapabilities(body), settled: true });
      })
      .catch(() => {
        // An unreachable probe leaves `null`, which shows everything — the same
        // behaviour as before this existed, rather than an empty app.
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

  return <CapabilitiesContext.Provider value={state}>{children}</CapabilitiesContext.Provider>;
}

/** Null until the answer lands, and null forever if it never does. */
export function useCapabilities(): Capabilities | null {
  return useContext(CapabilitiesContext).capabilities;
}

/** False only while the probe is still in flight. Wait on this before acting on
 *  a null answer; read `useCapabilities` alone when null already means "assume
 *  everything", which is most places. */
export function useCapabilitiesSettled(): boolean {
  return useContext(CapabilitiesContext).settled;
}
