// The sign-in providers this deployment offers, answered BEFORE authentication.
//
// The login page is the one page nobody has a session on, and it has to know
// which OAuth client ids exist before it can draw a Google or a Microsoft
// button. It used to read them from `NEXT_PUBLIC_*`, which Next inlines at
// `next build` — so a PUBLISHED image carries whatever the release build had,
// which is nothing, and no operator running from images could ever get those
// buttons however they set their environment.
//
// So the ids come from here, at run time, and they are the SAME variables the
// API already validates tokens against: `GOOGLE_AUTH_CLIENT_ID` is the audience
// `verifyGoogleToken` requires, `MICROSOFT_CLIENT_ID` the one the Microsoft
// door requires. One value each, server-side, and the button can no longer
// offer a provider the API would then refuse.
//
// A client id is a PUBLIC value — it is in the URL of every OAuth consent
// screen — so serving it unauthenticated gives nothing away. The secrets that
// sit beside it (`GOOGLE_AUTH_CLIENT_SECRET`) never appear here.

import { type RequestHandler } from 'express';

import { LISTEN_FIRE_VERSION } from '../../constants';

type Env = Record<string, string | undefined>;

interface PublicConfig {
  /** Absent, rather than empty, when this deployment has no such client: the
   *  login page renders a provider's button only for an id that is present. */
  googleClientId?: string;
  microsoftClientId?: string;
  /** The release answering. Same value `/healthz/workers` reports. */
  version: string;
}

/** Reads the `env` parameter rather than `process.env` so it stays checkable
 *  against an arbitrary environment, the way `capabilitiesFrom` already is. */
function publicConfigFrom(env: Env): PublicConfig {
  const config: PublicConfig = { version: LISTEN_FIRE_VERSION };
  // A variable set to the empty string is not a client id. Treating it as one
  // would draw a button whose OAuth request the provider rejects.
  if (env.GOOGLE_AUTH_CLIENT_ID) config.googleClientId = env.GOOGLE_AUTH_CLIENT_ID;
  if (env.MICROSOFT_CLIENT_ID) config.microsoftClientId = env.MICROSOFT_CLIENT_ID;
  return config;
}

const publicConfigHandler: RequestHandler = (_req, res) => {
  res.status(200).json(publicConfigFrom(process.env));
};

export { type PublicConfig, publicConfigFrom, publicConfigHandler };
