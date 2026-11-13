// What the npm release scripts share: the public packages of this checkout, what
// npm already has of them, and which staged versions belong to this release.
// Used by stage-npm-packages.mjs, approve-npm-stages.mjs and npm-release-status.mjs.
// Run those from the repository root.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONCURRENCY = 8;

// `npm stage` needs npm 11.15.0 or later; the pinned npm is the one the trust script and CI use. LF_NPM replaces it for every npm call (tests, other installs).
const overridden = process.env.LF_NPM?.split(' ').filter((word) => word !== '');
const viewCommand = overridden ?? ['npm'];
export const stageCommand = overridden ?? ['npx', '-y', 'npm@11.21.2'];

/** The set RELEASING.md's verify step walks: every package.json outside apps/ and examples/, minus private ones. */
export const publicPackages = execFileSync('git', ['ls-files', '*/package.json'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '' && !/^(apps|examples)\//.test(file))
  .map((file) => ({ dir: file.slice(0, -'/package.json'.length), manifest: JSON.parse(readFileSync(file, 'utf8')) }))
  .filter(({ manifest }) => !manifest.private && manifest.name !== undefined)
  .map(({ dir, manifest }) => ({ dir, name: manifest.name, version: manifest.version, tag: manifest.publishConfig?.tag ?? 'latest' }));

const runNpm = (command, args) =>
  new Promise((resolve) => {
    execFile(command[0], [...command.slice(1), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr, error });
    });
  });

/** Runs `work` over the items with at most `limit` in flight, keeping the order. */
export async function mapConcurrently(items, work, limit = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** True when the registry has name@version. Anything but a plain 404 is an error, never "absent". */
export async function isOnNpm({ name, version }) {
  const result = await runNpm(viewCommand, ['view', `${name}@${version}`, 'version']);
  if (result.status === 0) return true;
  if (/E404/.test(result.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed: ${result.stderr.trim() || result.error}`);
}

/** The version npm's `latest` points at, or null for a package that is not on npm at all. */
export async function latestOnNpm({ name }) {
  const result = await runNpm(viewCommand, ['view', name, 'version']);
  if (result.status === 0) return result.stdout.trim();
  if (/E404/.test(result.stderr)) return null;
  throw new Error(`npm view ${name} failed: ${result.stderr.trim() || result.error}`);
}

/** The staged versions npm lists, as `{ id, packageName, version, tag, ... }`; or why it could not (`notSignedIn`). */
export async function listStaged() {
  const listed = await runNpm(stageCommand, ['stage', 'list', '--json']);
  if (listed.status === 0) {
    // stage list --json prints an array of { id, packageName, version, tag, status, ... } (npm lib/commands/stage/list.js, key-values.js).
    return { staged: JSON.parse(listed.stdout) };
  }
  const output = `${listed.stderr}${listed.stdout}`;
  return {
    notSignedIn: /E401|ENEEDAUTH/.test(output),
    detail: output.trim() || String(listed.error),
  };
}

/** The staged versions that belong to this release: name@version equals a public package in this checkout. */
export function belongsToRelease({ packageName, version }) {
  return publicPackages.some((pkg) => pkg.name === packageName && pkg.version === version);
}
