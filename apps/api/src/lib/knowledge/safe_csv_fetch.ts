// SSRF-hardened fetch for the importCsv URL. The `csvUrl` is model-supplied, so
// a naive `fetch` could be steered at cloud metadata endpoints, internal
// services, or the loopback interface — directly or via a redirect. This module
// enforces https-only for external hosts, resolves each hop's hostname and
// rejects any address in a private/link-local/loopback/reserved range, follows
// redirects manually (re-validating each new host so a redirect can't slip past
// the check), and caps the body while streaming so an oversized response can't
// OOM the process.
//
// The one carve-out is our OWN exposed-file blob base: URLs we minted (which
// 302-redirect to our S3) are trusted and fetched normally. In the dev loop
// that base is `http://localhost:3500`, which the https-only + block-loopback
// rule would otherwise reject, breaking the upload→import loop.

import { isIP } from 'node:net';
import dns from 'node:dns';

const MAX_REDIRECTS = 3;

/** Reconstruct the exposed-file blob base exactly as `expose.ts` does. */
function ownBlobBase(): string {
  const base =
    process.env.EXPOSED_FILE_PUBLIC_BASE_URL ??
    process.env.OAUTH_REDIRECT_BASE_URL ??
    'http://localhost:3003';
  return `${base}/api/files/blob/`;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** True if `int` falls inside the CIDR block `base/prefix`. */
function inRange(int: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (int & mask) === (baseInt & mask);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function isBlockedIpv4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  if (int === null) return true; // unparseable → treat as blocked, fail closed
  return BLOCKED_IPV4.some(([base, prefix]) => inRange(int, base, prefix));
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) → run the IPv4 checks.
  const mappedPrefix = '::ffff:';
  if (lower.startsWith(mappedPrefix)) {
    const rest = lower.slice(mappedPrefix.length);
    if (rest.includes('.')) {
      return isBlockedIpv4(rest);
    }
    // ::ffff:xxxx:xxxx hextet form — reconstruct the dotted quad.
    const hextets = rest.split(':');
    if (hextets.length === 2) {
      const high = parseInt(hextets[0], 16);
      const low = parseInt(hextets[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low)) {
        const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isBlockedIpv4(dotted);
      }
    }
  }

  if (lower === '::1') return true; // loopback
  if (lower === '::') return true; // unspecified

  const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isNaN(firstHextet)) return true; // fail closed

  // fc00::/7 — unique local (first 7 bits are 1111110)
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local (first 10 bits are 1111111010)
  if ((firstHextet & 0xffc0) === 0xfe80) return true;

  return false;
}

/**
 * True if `ip` is a literal IP address in a private, loopback, link-local, or
 * otherwise reserved range that must not be reachable via a model-supplied URL.
 * Pure and network-free — the unit test exercises this directly.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP literal → fail closed
}

/** Resolve a hostname (or accept a literal IP) and reject any blocked address. */
async function assertHostAllowed(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error('URL resolves to a disallowed address.');
    }
    return;
  }
  const resolved = await dns.promises.lookup(hostname, { all: true });
  if (resolved.length === 0) {
    throw new Error('URL resolves to a disallowed address.');
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new Error('URL resolves to a disallowed address.');
    }
  }
}

/** Read a web ReadableStream body enforcing a byte cap; return decoded UTF-8. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error('CSV exceeds the size limit.');
  }

  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('CSV exceeds the size limit.');
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('CSV exceeds the size limit.');
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch CSV text from a (possibly model-supplied) URL with SSRF protections.
 * Trusts our own exposed-file blob base; enforces https + IP-range blocking +
 * manual redirect re-validation + a streamed size cap for everything else.
 */
export async function fetchCsvFromUrl(
  url: string,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<string> {
  // 1. Trusted own-origin carve-out (our minted blob URL 302s to our S3).
  if (url.startsWith(ownBlobBase())) {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Could not fetch csvUrl (HTTP ${res.status}).`);
    }
    return readBodyCapped(res, opts.maxBytes);
  }

  // 2-3. External URLs: https-only, block internal targets, follow redirects
  // manually while re-validating each hop.
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https URLs are allowed for import.');
    }
    await assertHostAllowed(parsed.hostname);

    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        // A 3xx with no Location isn't a redirect we can follow — treat as final.
        if (!res.ok) {
          throw new Error(`Could not fetch csvUrl (HTTP ${res.status}).`);
        }
        return readBodyCapped(res, opts.maxBytes);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    // 4-5. Final response.
    if (!res.ok) {
      throw new Error(`Could not fetch csvUrl (HTTP ${res.status}).`);
    }
    return readBodyCapped(res, opts.maxBytes);
  }

  throw new Error('Too many redirects.');
}
