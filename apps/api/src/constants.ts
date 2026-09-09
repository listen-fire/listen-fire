/* eslint-disable local-rules/bottom-exports */
/*
Keep *exported* constants here to import from a type free module and avoid
importing unwanted modules across the codebase, e.g. importing setup.ts into
production which won't have testing types installed
*/

export const TESTING_TEAM_NAME = 'Testing';
export const TESTING_USER_EMAIL = 'testing@listen-fire.local';

export const HEALTH_CHECK_ENDPOINT = '/.well-known/health-check';

// The release this build is, baked into the image at build time
// (`--build-arg LISTEN_FIRE_VERSION`, which the release workflow sets from the
// git tag). A tree nobody tagged — a source build, a dev loop — is `dev`, and
// that is the honest answer rather than a version number nothing produced.
export const LISTEN_FIRE_VERSION = process.env.LISTEN_FIRE_VERSION || 'dev';

// Worker liveness per mounted product. Separate from the probe above, whose
// 201-with-no-body is a deploy platform's contract.
export const WORKERS_HEALTH_ENDPOINT = '/healthz/workers';

// One second in milliseconds. Following the convention of singular for unit names
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

// default prisma transaction timeout in ms
export const DEFAULT_TRANSACTION_TIMEOUT =
  process.env.NODE_ENV === 'development' ? String(5 * MINUTE) : String(1 * MINUTE);

export const INBOUND_PIPELINE_MESSAGE_BUFFER_WAIT =
  process.env.NODE_ENV === 'development' ? 0 : 30 * SECOND;

export const ADMIN_EMAIL = 'admin@listen-fire.local';

const KB = 1024;
export const MB = 1024 * KB;

export const OCR_START_PAGE_TAG = '>>PAGE_START<<';

export const HASHIDS_SALT = 'jgfGyPBtlMRP4R5FEDlykJVhGcSmWdHw';

export const isProd = process.env.NODE_ENV === 'production';


export const AUTH_COOKIE = 'listen_fire_token';
export const IMPERSONATE_COOKIE = 'listen_fire_impersonate';

export const MAGIC_LINK_EXPIRY = 5 * HOUR;

export const ADVISORY_LOCK_SCOPES = {
  LISTEN_FIRE_API_APPLICATION: 1,
  LISTEN_FIRE_API_INCOMPLETE_PIPELINE: 2,
} as const;

export const ADVISORY_LOCK_IDS = {
  LISTEN_FIRE_API_APPLICATION_BACKGROUND_PROCESSING: 1,
} as const;
