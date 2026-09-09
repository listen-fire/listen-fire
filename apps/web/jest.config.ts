import path from 'path';

export default {
  clearMocks: true,
  maxWorkers: 1,
  testMatch: ['**/*.unit.test.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        types: ['jest', 'node'],
        typeRoots: [
          path.resolve(__dirname, '../api/node_modules/@types'),
        ],
        target: 'ES2017',
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: true,
      },
    }],
  },
};
