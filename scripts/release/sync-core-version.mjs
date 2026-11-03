#!/usr/bin/env node
// The core (parser, checker, language and engine crates, `listen-fire`, and
// the movement-lang, engine and engine-contracts packages) moves on one
// version: the language's. changesets sets it in packages/movement-lang/package.json;
// this writes it to the places a changeset cannot reach:
//   Cargo.toml                       [workspace.package] version
//   crates/*/Cargo.toml              the `version = "…"` of each core path dependency
//   packages/movement-lang/language_version_value.ts
//   README.md                        the `cargo install listen-fire --version` line
//   docs/contracts/README.md         the language row's compatibility key
// `--check` writes nothing and exits 1 on any drift (CI's gate). It also exits 1 when a
// committed lf.yaml pins a version this release does not read: a pin moves only by
// `listen-fire upgrade`, so the script never writes one, and a run without --check only says so.
// Run from the repository root: node scripts/release/sync-core-version.mjs [--check]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const check = process.argv.includes('--check');
const version = JSON.parse(readFileSync('packages/movement-lang/package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`movement-lang's version is not semver: ${version}`);

const CORE_CRATES = ['listen-fire-parser', 'listen-fire-checker', 'listen-fire-language', 'listen-fire-engine'];
// The rule of docs/contracts/language-versions.md: the minor under 0.x, the major from 1.0.
const [major, minor] = version.split('.');
const key = major === '0' ? `0.${minor}` : major;

// [file, pattern with capture groups around the value, how many matches it must have, the value (default: the version)]
const edits = [
  ['Cargo.toml', /(\[workspace\.package\]\nversion = ")[^"]+(")/, 1],
  ['packages/movement-lang/language_version_value.ts', /(export const PACKAGE_VERSION = ')[^']+(')/, 1],
  ['README.md', /(cargo install listen-fire --version )\d[^\s`;,)]*()/, 1],
  ['docs/contracts/README.md', /(\| language-versions \|.*\| the release's compatibility key \()[^)]+(\))/, 1, key],
];
for (const dir of readdirSync('crates')) {
  const file = join('crates', dir, 'Cargo.toml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = CORE_CRATES.map((name) => text.match(new RegExp(`package = "${name}", version = "[^"]+"`, 'g'))?.length ?? 0).reduce((a, b) => a + b, 0);
  if (lines > 0) edits.push([file, new RegExp(`(package = "(?:${CORE_CRATES.join('|')})", version = ")[^"]+(")`, 'g'), lines]);
}

// The repository's own projects (examples, the deploy image's default) are saved movements too:
// at a new compatibility key they refuse to run until `listen-fire upgrade` moves their pins.
const keyOf = (pin) => {
  const [pinMajor, pinMinor] = pin.split('.');
  return pinMajor === '0' ? `0.${pinMinor}` : pinMajor;
};
const stalePins = execFileSync('git', ['ls-files', '--', 'lf.yaml', '**/lf.yaml'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .flatMap((file) => {
    const pin = readFileSync(file, 'utf8').match(/^engine:\s*['"]?(\d+\.\d+\.\d+[^\s'"#]*)/m)?.[1];
    return pin !== undefined && keyOf(pin) !== key ? [`${file} pins engine ${pin}`] : [];
  });

const drift = [];
for (const [file, pattern, expected, value = version] of edits) {
  const before = readFileSync(file, 'utf8');
  const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== expected) throw new Error(`${file}: expected ${expected} place(s) for ${pattern}, found ${matches.length}`);
  const after = before.replace(pattern, (_all, head, tail = '') => `${head}${value}${tail}`);
  if (after === before) continue;
  drift.push(file);
  if (!check) writeFileSync(file, after);
}

const staleMessage = `this release (${version}) does not read these pins; run \`listen-fire upgrade --dir <project folder>\` on each:\n  ${stalePins.join('\n  ')}`;

if (check) {
  if (stalePins.length > 0) {
    console.error(staleMessage);
    process.exit(1);
  }
  if (drift.length > 0) {
    console.error(`core version ${version} (packages/movement-lang/package.json) is not in: ${drift.join(', ')}\nrun: node scripts/release/sync-core-version.mjs`);
    process.exit(1);
  }
  console.log(`core version ${version}: in sync`);
} else {
  console.log(drift.length === 0 ? `core version ${version}: already in sync` : `core version ${version}: wrote ${drift.join(', ')}`);
  if (stalePins.length > 0) console.warn(staleMessage);
}
