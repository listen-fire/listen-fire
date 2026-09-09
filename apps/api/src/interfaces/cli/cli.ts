#!/usr/bin/env node
import path from 'node:path';

import { CLI, Shim } from 'clime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runningInTSNode = (process as any)[Symbol.for('ts-node.register.instance')] !== undefined;
if (runningInTSNode) {
  CLI.commandModuleExtension = '.ts';
}
const cli = new CLI('cli', path.join(__dirname, 'commands'));
const shim = new Shim(cli);

void shim.execute(process.argv).finally(() => {});
