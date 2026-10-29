#!/usr/bin/env node
// Starts the fake GitHub and the fake Slack, seeded, and points this
// project's credentials at them. Runs until Ctrl-C.
//
//   node demo/serve-fakes.cjs              (from examples/github-triage)
//
// `listen-fire` is taken from PATH, or from LF_BIN. The fakes are TypeScript
// from this repository, run by the tsx the fake Slack's package installs.

const { createRequire } = require('node:module');
const { resolve } = require('node:path');

createRequire(resolve(__dirname, '../../../packages/fake-channels/package.json'))('tsx/cjs');
const { startFakes, pointAtFakes } = require('./fakes.ts');

async function main() {
  const project = resolve(__dirname, '..');
  const fakes = await startFakes({ slackPort: Number(process.env.FAKE_CHANNELS_PORT ?? 5556) });
  await pointAtFakes(project, fakes, { lf: process.env.LF_BIN || 'listen-fire', log: (line) => console.log(line) });
  console.log(`fake GitHub: ${fakes.githubUrl} (5 unread: 2 review requests, 1 mention, 1 release, 1 CI run)`);
  console.log(`fake Slack:  ${fakes.slackUrl} (what the bot posted: node demo/posted.cjs)`);
  console.log('ready; Ctrl-C stops both');
  const stop = () => void fakes.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
