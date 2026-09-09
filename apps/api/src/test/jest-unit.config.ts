// eslint-disable-next-line local-rules/bottom-exports
export default {
  // Automatically clear mock calls and instances between every test
  clearMocks: true,

  // The maximum amount of workers used to run your tests. Can be specified as % or a number. E.g. maxWorkers: 10% will use 10% of your CPU amount + 1 as the maximum worker number. maxWorkers: 2 will use a maximum of 2 workers.
  maxWorkers: 1,

  // The one worker runs every suite in ONE process, and this package's
  // ts-jest + Prisma footprint means a wide run walks off the heap partway
  // through and dies with a V8 stack trace instead of results — so "did the
  // suite pass" became unanswerable rather than answered wrongly.
  //
  // Recycling the worker when it crosses this bound changes neither
  // parallelism (still one worker) nor ordering (still sequential); it only
  // stops leaked module state from accumulating across hundreds of suites.
  // Raising the heap was the alternative and it only moves the cliff.
  workerIdleMemoryLimit: '1500MB',

  rootDir: '../../',

  // Inert env defaults so a suite whose import graph reaches an env-reading
  // module (prisma, kysely, the adapters) loads without an `apps/api/.env` and
  // without touching a real system. A developer's own `.env` still wins — see
  // the file header. Without this, a fresh clone could not run ANY scoped unit
  // test: the first import of `prisma/index.ts` threw at module load.
  setupFiles: ['<rootDir>/src/test/test-env-defaults.ts'],

  // The glob patterns Jest uses to detect test files
  testMatch: ['**/*.unit.test.ts'],
  // ts-jest required for Prisma >= 5.10.x
  preset: 'ts-jest',
  testEnvironment: 'node',
};
