#!/usr/bin/env node
// Prints what the bot posted to the fake Slack that serve-fakes.cjs started.
//
//   node demo/posted.cjs              (from examples/github-triage)

const { createRequire } = require('node:module');
const { resolve } = require('node:path');

createRequire(resolve(__dirname, '../../../packages/fake-channels/package.json'))('tsx/cjs');
const { posted } = require('./fakes.ts');

posted(`http://127.0.0.1:${process.env.FAKE_CHANNELS_PORT ?? 5556}`).then(
  (messages) => console.log(messages.length === 0 ? '(nothing posted)' : messages.join('\n\n')),
  (error) => {
    console.error(`no fake Slack to ask (is node demo/serve-fakes.cjs running?): ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);
