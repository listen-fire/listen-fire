// A project whose loopGuard slot is filled by the test loop guard module (serve.ts).

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVE = resolve(__dirname, 'serve.ts');

export function guardModuleProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-guard-slot-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.13.0\n');
  fillGuardSlot(dir);
  return dir;
}

/** Install the test guard module in `dir`'s externals folder and name it in
 *  its lf.yaml's `core:` (which must have none yet). With `calls`, the module
 *  logs each call there (serve.ts). */
export function fillGuardSlot(dir: string, calls?: string): void {
  mkdirSync(join(dir, 'externals/acme_guard'), { recursive: true });
  const command = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), SERVE];
  writeFileSync(
    join(dir, 'externals/acme_guard/lf-external.yaml'),
    [
      'name: acme_guard',
      'kind: core',
      'slot: loopGuard',
      `command: [${command.map((part) => JSON.stringify(part)).join(', ')}]`,
      ...(calls !== undefined ? [`env: { GUARD_CALLS: ${JSON.stringify(calls)} }`] : []),
      '',
    ].join('\n'),
  );
  appendFileSync(join(dir, 'lf.yaml'), 'core:\n  loopGuard: acme_guard\n');
}
