// Default jest config for `apps/api`.
//
// This exists as a GUARDRAIL. The real configs live under `src/test/`
// (`jest-{unit,integration,smoke}.config.ts`) and are selected explicitly by the
// `pnpm test:*` scripts via `--config`. But a bare `npx jest <file>` (no
// `--config`) finds no config and falls back to **babel-jest** — which can't
// load the Prisma client (`runtime.Types.Extensions` undefined) and rejects our
// `jest.mock()` hoist pattern. Both look like the test is
// "broken"; neither is. So make the default behave like `pnpm test:unit`
// (`preset: 'ts-jest'`, required for Prisma). Prefer
// `pnpm test:unit --testPathPattern '<file>'` for iteration; never run unscoped.

import unitConfig from './src/test/jest-unit.config';

// `rootDir` is re-anchored to this file's directory (apps/api). The unit config
// sets it to `'../../'` relative to `src/test/`, which is the same directory —
// spelling it `'.'` here keeps it correct now that the config lives one level up.
// eslint-disable-next-line local-rules/bottom-exports
export default { ...unitConfig, rootDir: '.' };
