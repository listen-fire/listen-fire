// Which identity this process runs on. Read at the composition root, once.
//
// Kept apart from the wiring so choosing the mode costs nothing to test and
// nothing to import: an unrecognised value is a boot failure rather than a
// silent fall back to `core`, because the two modes are different security
// postures and a typo must not pick one.

type PrincipalMode = 'core' | 'static';

type Env = Record<string, string | undefined>;

function principalMode(env: Env = process.env): PrincipalMode {
  const raw = env.LISTEN_FIRE_PRINCIPAL;
  if (raw === undefined || raw === '' || raw === 'core') return 'core';
  if (raw === 'static') return 'static';
  throw new Error(`LISTEN_FIRE_PRINCIPAL must be "core" or "static" (got "${raw}").`);
}

export { type PrincipalMode, principalMode };
