#!/usr/bin/env node
// What is waiting for a release: the packages whose version npm does not have yet
// (CI can upload them), and the staged versions waiting for the maintainer to publish.
//
//   node scripts/release/npm-release-status.mjs          a readable summary
//   node scripts/release/npm-release-status.mjs --json   { signedIn, ready: [{ name, version, onNpm }], staged: [{ id, name, version, tag }] | null }
//
// `npm view` needs no login; `npm stage list` does. Signed out, `staged` is null and
// `ready` is still filled. Run from the repository root.
import { belongsToRelease, isOnNpm, latestOnNpm, listStaged, mapConcurrently, publicPackages } from './npm-packages.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--json')) {
  console.error('usage: npm-release-status.mjs [--json]');
  process.exit(2);
}

const [readyOrNot, stages] = await Promise.all([
  mapConcurrently(publicPackages, async (pkg) => ((await isOnNpm(pkg)) ? null : { name: pkg.name, version: pkg.version, onNpm: await latestOnNpm(pkg) })),
  listStaged(),
]);
const ready = readyOrNot.filter((entry) => entry !== null);

if (stages.staged === undefined && !stages.notSignedIn) {
  console.error(`npm stage list failed: ${stages.detail}`);
  process.exit(1);
}
const status = {
  signedIn: stages.staged !== undefined,
  ready,
  staged: stages.staged?.filter(belongsToRelease).map(({ id, packageName, version, tag }) => ({ id, name: packageName, version, tag })) ?? null,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(status));
} else {
  console.log(`ready (newer here than on npm): ${ready.length === 0 ? 'none' : ''}`);
  for (const { name, version, onNpm } of ready) console.log(`  ${name}  ${onNpm ?? 'new'} -> ${version}`);
  console.log(`staged (waiting to be published): ${status.staged === null ? 'unknown, npm is not signed in' : status.staged.length === 0 ? 'none' : ''}`);
  for (const { name, version, tag } of status.staged ?? []) console.log(`  ${name}  ${version}${tag === 'latest' ? '' : ` (${tag})`}`);
}
