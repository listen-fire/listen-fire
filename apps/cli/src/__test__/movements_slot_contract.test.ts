// The movements slot's conformance cases against a test movements module
// (movements_module/serve.ts) spoken to directly, and through lf's own client
// of it (`lf --contract-movements-slot`, the project's movements slot), so
// lf's side of the wire is held to the meaning the module is. lf's default
// module (`@lf/folder-movements`) is served and held the same way, so the
// runner is held to what it serves. The read-only cases run against a module
// that refuses every write, directly and through lf's client of it.

import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOVEMENTS_METHODS } from 'engine-contracts/slots';
import { SlotClient, commonSlotCases, movementsReadOnlySlotCases, movementsSlotCases, startModule, type SlotAddress } from 'movement-engine/public/module-wire';
import { lfBinary } from './lf_bin';
import { serveMovementsModule } from './movements_module/serve';

interface Reached {
  address: SlotAddress;
  settings: Record<string, string>;
  close(): Promise<void>;
}

const REASON = 'they live in the platform';

/** A project whose movements slot is filled by the module at `module` (its tenant setting in the environment, as the bootstrap rule has it), or the default folder module. */
function project(module: { url: string } | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-movements-slot-'));
  if (module === null) {
    mkdirSync(join(dir, 'movements'));
    writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\n');
    return dir;
  }
  mkdirSync(join(dir, 'externals/acme_movements'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/acme_movements/lf-external.yaml'),
    `name: acme_movements\nkind: core\nslot: movements\nurl: ${module.url}\nsettings:\n  - { name: tenant, label: the tenant whose movements these are }\n`,
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  movements: acme_movements\n');
  return dir;
}

const bridges: Array<{ over: string; readOnly: boolean; reach(options: { readOnly?: string }): Promise<Reached> }> = [
  {
    over: 'a movements module',
    readOnly: true,
    reach: async ({ readOnly }) => {
      const served = await serveMovementsModule({ listen: 0, ...(readOnly !== undefined ? { readOnly } : {}) });
      return { address: { baseUrl: served.url }, settings: { tenant: 't1' }, close: () => served.close() };
    },
  },
  {
    over: "lf's client of a movements module",
    readOnly: true,
    reach: async ({ readOnly }) => {
      const module = await serveMovementsModule({ listen: 0, ...(readOnly !== undefined ? { readOnly } : {}) });
      const served = await startModule(lfBinary(), ['--contract-movements-slot', '--dir', project(module)], {
        env: { LF_SECRET__ACME_MOVEMENTS__EXTERNAL: 'acme_movements', LF_SECRET__ACME_MOVEMENTS__TENANT: 't1' },
      });
      return {
        address: served.address,
        settings: {},
        close: async () => {
          await served.close();
          await module.close();
        },
      };
    },
  },
  {
    over: "lf's folder movements module",
    readOnly: false,
    reach: async () => {
      const served = await startModule(lfBinary(), ['--contract-movements-slot', '--dir', project(null)]);
      return { address: served.address, settings: {}, close: () => served.close() };
    },
  },
];

for (const bridge of bridges) {
  const withModule = async (options: { readOnly?: string }, body: (reached: Reached) => Promise<void>) => {
    const reached = await bridge.reach(options);
    try {
      await body(reached);
    } finally {
      await reached.close();
    }
  };

  for (const conformance of commonSlotCases('movements', MOVEMENTS_METHODS)) {
    test(`${bridge.over}: ${conformance.name}`, () => withModule({}, (reached) => conformance.run(new SlotClient(reached.address, reached.settings))));
  }
  for (const conformance of movementsSlotCases) {
    test(`${bridge.over}: ${conformance.name}`, () => withModule({}, (reached) => conformance.run(new SlotClient(reached.address, reached.settings))));
  }
  if (bridge.readOnly) {
    for (const conformance of movementsReadOnlySlotCases) {
      test(`${bridge.over}: ${conformance.name}`, () => withModule({ readOnly: REASON }, (reached) => conformance.run(new SlotClient(reached.address, reached.settings))));
    }
  }
}
