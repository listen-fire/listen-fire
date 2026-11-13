#!/usr/bin/env node
// Stands in for `npm` (LF_NPM) so approve-npm-stages.mjs can be driven without a registry.
// FAKE_REGISTRY: path to JSON { "<name>": ["<version>", ...] } that `view` answers from (the last version is `latest`); a name not in it is E404.
// FAKE_STAGES: path to the JSON `stage list --json` prints. FAKE_MODE: ok | eotp | e401.
import { readFileSync } from 'node:fs';

const [, , group, verb, id] = process.argv;
const mode = process.env.FAKE_MODE ?? 'ok';
if (group === 'view') {
  const registry = JSON.parse(readFileSync(process.env.FAKE_REGISTRY, 'utf8'));
  const at = verb.lastIndexOf('@');
  const [name, version] = at > 0 ? [verb.slice(0, at), verb.slice(at + 1)] : [verb, undefined];
  const versions = registry[name] ?? [];
  if (versions.length === 0 || (version !== undefined && !versions.includes(version))) {
    console.error(`npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${name}`);
    process.exit(1);
  }
  console.log(version ?? versions.at(-1));
  process.exit(0);
}
if (mode === 'e401') {
  console.error('npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/-/stage');
  process.exit(1);
}
if (group === 'stage' && verb === 'list') {
  process.stdout.write(readFileSync(process.env.FAKE_STAGES, 'utf8'));
} else if (group === 'stage' && verb === 'approve') {
  if (mode === 'eotp' && process.env.npm_config_otp !== '123456') {
    console.error('npm error code EOTP\nnpm error This operation requires a one-time password.');
    process.exit(1);
  }
  console.log(`Staged package ${id} approved and published successfully.`);
} else {
  process.exit(9);
}
