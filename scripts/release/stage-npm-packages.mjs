#!/usr/bin/env node
// Stages every public package whose name@version npm does not have yet.
// `npm stage publish` uploads a release and holds it; a maintainer approves it
// on npmjs.com (2FA). CI runs this on main (.github/workflows/npm-stage.yml)
// and authenticates by trusted publishing, so no npm token exists anywhere.
//
//   node scripts/release/stage-npm-packages.mjs             stage
//   node scripts/release/stage-npm-packages.mjs --dry-run   pack, extract and `npm stage publish --dry-run`; stage nothing
//   node scripts/release/stage-npm-packages.mjs --list      print the names that are not on npm yet, one per line, and stop
//
// `npm stage publish` packs the directory it runs in and does not rewrite
// `workspace:` specifiers, as `pnpm pack` does. So each package is packed by
// pnpm, extracted to a scratch directory and staged from there; an extracted
// manifest that still carries a `workspace:` or `catalog:` specifier fails the
// package. One package's failure does not stop the others; the exit code names
// every failure. Run from the repository root.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOnNpm, mapConcurrently, publicPackages } from './npm-packages.mjs';

const dryRun = process.argv.includes('--dry-run');
const listOnly = process.argv.includes('--list');

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });

// A version staged but not yet approved is not on the registry, so a second push
// stages it again and npm answers with a conflict. The wording is not documented;
// the 409 status is what the registry answers a duplicate with.
const ALREADY_STAGED = /E409|409 Conflict|already staged|already exists in the staging/i;

function stage({ dir, name, version, tag }) {
  const scratch = mkdtempSync(join(tmpdir(), 'lf-stage-'));
  try {
    // `pnpm pack` runs the package's prepack (the build) and rewrites workspace: specifiers.
    const packed = run('pnpm', ['pack', '--pack-destination', scratch], { cwd: dir });
    if (packed.status !== 0) return { outcome: 'failed', detail: `pnpm pack: ${packed.stderr.trim() || packed.stdout.trim()}` };
    const tarball = readdirSync(scratch).find((file) => file.endsWith('.tgz'));
    if (tarball === undefined) return { outcome: 'failed', detail: 'pnpm pack produced no tarball' };
    const extracted = run('tar', ['-xzf', join(scratch, tarball), '-C', scratch]);
    if (extracted.status !== 0) return { outcome: 'failed', detail: `tar: ${extracted.stderr.trim()}` };

    const packageDir = join(scratch, 'package');
    const manifestText = readFileSync(join(packageDir, 'package.json'), 'utf8');
    const unrewritten = manifestText.match(/"[^"\n]+":\s*"(workspace|catalog):[^"\n]*"/g);
    if (unrewritten !== null) return { outcome: 'failed', detail: `packed manifest still carries ${unrewritten.join(', ')}` };
    const packed_ = JSON.parse(manifestText);
    if (packed_.name !== name || packed_.version !== version) return { outcome: 'failed', detail: `packed ${packed_.name}@${packed_.version}, expected ${name}@${version}` };

    // --ignore-scripts: the manifest still names the monorepo's prepack (a path into the repository), which has no meaning here.
    const args = ['stage', 'publish', '--access', 'public', '--tag', tag, '--ignore-scripts', ...(dryRun ? ['--dry-run'] : [])];
    const staged = run('npm', args, { cwd: packageDir });
    if (staged.status === 0) {
      const worth = `${staged.stdout}${staged.stderr}`.split('\n').filter((line) => /Staging to|has been staged|package size|total files|warn/.test(line));
      if (worth.length > 0) process.stdout.write(`${worth.map((line) => `    ${line}`).join('\n')}\n`);
      return { outcome: dryRun ? 'staged (dry run)' : 'staged' };
    }
    const output = `${staged.stderr}${staged.stdout}`;
    if (ALREADY_STAGED.test(output)) return { outcome: 'skipped (already staged)' };
    return { outcome: 'failed', detail: output.trim() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const failures = [];
const unreleased = [];
// Ask npm about every package at once; staging itself stays one at a time.
const presence = await mapConcurrently(publicPackages, async (pkg) => {
  try {
    return { present: await isOnNpm(pkg) };
  } catch (error) {
    return { error };
  }
});
for (const [index, pkg] of publicPackages.entries()) {
  const { present, error } = presence[index];
  if (error !== undefined) {
    failures.push(pkg.name);
    console.log(`failed: ${pkg.name}@${pkg.version}\n    ${error.message}`);
    continue;
  }
  if (present) {
    if (!listOnly) console.log(`skipped (already on npm): ${pkg.name}@${pkg.version}`);
    continue;
  }
  unreleased.push(pkg);
  if (listOnly) {
    console.log(pkg.name);
    continue;
  }
  const { outcome, detail } = stage(pkg);
  console.log(`${outcome}: ${pkg.name}@${pkg.version} (tag ${pkg.tag})${detail === undefined ? '' : `\n    ${detail.replace(/\n/g, '\n    ')}`}`);
  if (outcome === 'failed') failures.push(pkg.name);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
if (unreleased.length === 0 && !listOnly) console.log('nothing to stage: every version is already on npm');
