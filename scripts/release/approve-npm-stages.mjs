#!/usr/bin/env node
// Approves the staged npm packages that belong to this checkout's release.
// CI stages them (.github/workflows/npm-stage.yml); `npm stage approve` publishes
// one, with 2FA. Only a stage whose name@version equals a public package's
// version in this checkout is approved; every other stage is named and left alone.
//
//   node scripts/release/approve-npm-stages.mjs --list   print the matching `name@version (tag)` lines and stop
//   npm_config_otp=<code> node scripts/release/approve-npm-stages.mjs   approve each match
//
// The authenticator code comes from the `npm_config_otp` environment variable,
// never from argv. With no terminal npm cannot prompt for one, so a missing or
// rejected code fails with EOTP. Run from the repository root.
//
// Exit status: 0 done (or nothing staged), 1 a stage failed, 2 usage,
// 3 npm wants a (fresh) authenticator code, 4 npm is not signed in.
// A rerun is safe: an approved stage leaves the list.
import { spawnSync } from 'node:child_process';
import { belongsToRelease, listStaged, stageCommand } from './npm-packages.mjs';

const EXIT_CODE_NEEDED = 3;
const EXIT_NOT_SIGNED_IN = 4;

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--list')) {
  console.error('usage: approve-npm-stages.mjs [--list]');
  process.exit(2);
}
const listOnly = args.includes('--list');

const npm = (npmArgs) => spawnSync(stageCommand[0], [...stageCommand.slice(1), ...npmArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Exits with the distinct status when npm's output says it is not signed in or wants a code. */
function exitOnAuth(result) {
  const output = `${result.stderr}${result.stdout}`;
  if (/EOTP/.test(output)) {
    console.error('npm wants an authenticator code (missing, wrong or expired)');
    process.exit(EXIT_CODE_NEEDED);
  }
  if (/E401|ENEEDAUTH/.test(output)) {
    console.error('npm on this machine is not signed in');
    process.exit(EXIT_NOT_SIGNED_IN);
  }
}

const listed = await listStaged();
if (listed.staged === undefined) {
  if (listed.notSignedIn) {
    console.error('npm on this machine is not signed in');
    process.exit(EXIT_NOT_SIGNED_IN);
  }
  console.error(`npm stage list failed: ${listed.detail}`);
  process.exit(1);
}
const { staged } = listed;
const matching = staged.filter(belongsToRelease);
for (const stage of staged) {
  if (!belongsToRelease(stage)) console.log(`left out: ${stage.packageName}@${stage.version} (${stage.tag}), not a version in this checkout`);
}

if (matching.length === 0) {
  console.log('nothing staged for this release');
  process.exit(0);
}
if (listOnly) {
  for (const { packageName, version, tag } of matching) console.log(`${packageName}@${version} (${tag})`);
  process.exit(0);
}

const failures = [];
for (const { id, packageName, version, tag } of matching) {
  const approved = npm(['stage', 'approve', id]);
  if (approved.status === 0) {
    console.log(`approved: ${packageName}@${version} (${tag})`);
    continue;
  }
  exitOnAuth(approved);
  failures.push(`${packageName}@${version}`);
  console.log(`failed: ${packageName}@${version}\n    ${(approved.stderr.trim() || approved.stdout.trim()).replace(/\n/g, '\n    ')}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} stage(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`approved ${matching.length} staged package(s)`);
