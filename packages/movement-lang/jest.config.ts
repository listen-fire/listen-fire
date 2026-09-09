export default {
  clearMocks: true,
  maxWorkers: 1,
  testMatch: ['**/*.unit.test.ts'],
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // Resolve TypeScript sources BEFORE any compiled `.js`. ts-jest's preset
  // default lists `.js` first, so a stray `tsc` build (the `build` script,
  // or apps/api's prod build run locally) would shadow the sources and make
  // tests run stale code. Sources are always the truth here.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
};
