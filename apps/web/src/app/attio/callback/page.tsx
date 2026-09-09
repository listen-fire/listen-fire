'use client';

import { useEffect, useRef } from 'react';

export default function AttioCallback() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const claimToken = params.get('claimToken');

    if (claimToken) {
      const ch = new BroadcastChannel('listen-fire-oauth');
      ch.postMessage({ claimToken });
      ch.close();
      window.close();
    } else {
      const url = new URL('/api/public/auth/attio/callback', window.location.origin);
      url.search = window.location.search;
      window.location.href = url.toString();
    }
  }, []);

  return <div className="flex h-screen items-center justify-center text-sm text-gray-400">Connecting...</div>;
}
