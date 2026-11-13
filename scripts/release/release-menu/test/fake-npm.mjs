#!/usr/bin/env node
// Stands in for `npm` (LF_NPM) so approve-npm-stages.mjs can be driven without a registry.
// FAKE_STAGES: path to the JSON `stage list --json` prints. FAKE_MODE: ok | eotp | e401.
import { readFileSync } from 'node:fs';

const [, , group, verb, id] = process.argv;
const mode = process.env.FAKE_MODE ?? 'ok';
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
