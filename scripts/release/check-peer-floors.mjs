#!/usr/bin/env node
// A package's peer range on the core says which cores it works with. What a
// package ships that a core reads (the handbook's chapters, a module's handbook
// section) must check under the OLDEST core the range admits, or a host on that
// core installs the package cleanly and then fails on its content.
//
// This installs that release of @listen-fire/movement-lang from npm (into
// node_modules/.cache/peer-floors, so the first run needs the network) and runs
// every package's shipped programs through its checker. It ends with two
// self-tests that show the check can fail. A failure names the package and the
// program: raise that package's core peer floor in its own changeset
// (RELEASING.md). The check and its helper are
// packages/handbook/__test__/peer_floors.{check,}.ts; they stay out of the
// handbook's unit tests because those run offline.
// Run from the repository root: node scripts/release/check-peer-floors.mjs
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const result = spawnSync(join(root, 'node_modules/.bin/jest'), ['--config', 'jest.peer_floors.config.cjs'], {
  cwd: join(root, 'packages/handbook'),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
