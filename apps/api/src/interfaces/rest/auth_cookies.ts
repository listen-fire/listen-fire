// The session cookie pair, on its own so a door can set it without importing a
// login. Core's `auth.ts` reaches OAuth, JWKS and the user tables; the static
// login sits in the pre-auth router and has none of that — but both must set
// byte-identical cookies, so the cookies live here and neither owns them.

import type { CookieOptions, RequestHandler } from 'express';

import { AUTH_COOKIE, isProd } from '../../constants';

type Env = Record<string, string | undefined>;

/**
 * `Secure` follows the SCHEME this deployment is actually reached on, not
 * `NODE_ENV`. A self-host on a LAN address over plain http is a production
 * deployment by every other measure, and a `Secure` cookie there is set,
 * silently dropped by the browser, and the user is bounced back to the login
 * they just completed. Browsers exempt `localhost`, which is why this only ever
 * showed up off-box.
 *
 * The cookie is set on the origin the BROWSER is talking to, so `WEB_BASE_URL`
 * is the right answer wherever there is a web app; `API_BASE_URL` is it for a
 * headless install. Only the two schemes that can appear in a browser URL
 * settle it. Anything else — no base URL at all, or one written without a
 * scheme — is not evidence either way, so `NODE_ENV` remains the guess.
 */
function cookiesAreSecure(env: Env = process.env): boolean {
  const base = env.WEB_BASE_URL || env.API_BASE_URL || '';
  if (base.startsWith('https://')) return true;
  if (base.startsWith('http://')) return false;
  return isProd;
}

/** Per call, not per process: the base URL is read at request time so a
 *  deployment cannot bake in the wrong answer at import. */
function authCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: cookiesAreSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
  };
}

/** A JS-READABLE presence marker set alongside the httpOnly session cookie. The
 *  web client can't see the httpOnly `listen_fire_token` via `document.cookie`, so it
 *  checks THIS marker to know it's logged in (the token itself stays httpOnly).
 *  Same lifetime + scope as the session. */
const AUTH_MARKER_COOKIE = 'listen_fire_authed';

/** Set the session cookie (httpOnly) + the readable presence marker together. */
function setAuthCookies(res: Parameters<RequestHandler>[1], jwt: string): void {
  const options = authCookieOptions();
  res.cookie(AUTH_COOKIE, jwt, options);
  res.cookie(AUTH_MARKER_COOKIE, '1', { ...options, httpOnly: false });
}

/** Clear both the session cookie and the presence marker. */
function clearAuthCookies(res: Parameters<RequestHandler>[1]): void {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.clearCookie(AUTH_MARKER_COOKIE, { path: '/' });
}

export { clearAuthCookies, setAuthCookies };
