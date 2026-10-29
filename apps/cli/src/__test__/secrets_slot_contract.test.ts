// The secrets slot's conformance cases against a test vault module
// (secrets_module/serve.ts) spoken to directly, and through listen-fire's own client
// of it (`listen-fire --contract-secrets-slot`, the project's secrets slot), so listen-fire's
// side of the wire is held to the meaning the module is. Both are held to the
// family's eleven contract cases (movement-engine services/secrets/
// contract.ts) as a store, and to the slot's own cases (module-runtime
// `module_wire/conformance.ts`): the list, the lease, whole entries, and the
// read-only answer. listen-fire's default module (`@lf/file-secrets`) is served and
// held the same way, so the runner is held to what it serves.

import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { SECRETS_METHODS } from 'engine-contracts/slots';
import { SecretsSlotBackend, SlotClient, commonSlotCases, secretsReadOnlySlotCases, secretsSlotCases, startModule, type SlotAddress } from 'movement-engine/public/module-wire';
import { secretsContractCases, type SecretsContractBackend } from 'movement-engine/public/secrets-testing';
import { lfBinary } from './lf_bin';
import { serveSecretsModule } from './secrets_module/serve';

interface Reached {
  address: SlotAddress;
  settings: Record<string, string>;
  close(): Promise<void>;
}

const REASON = 'it is filled from the platform';

/** A project whose secrets slot is filled by the vault at `url` (settings in the environment, as the bootstrap rule has it), or the default file module. */
function project(vault: { url: string } | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-secrets-slot-'));
  mkdirSync(join(dir, '.lf'));
  if (vault === null) {
    writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\n');
    writeFileSync(join(dir, '.lf/secrets.yaml'), stringify({ seed: { external: 'acme_crm', api_key: 'k' } }), { mode: 0o600 });
    return dir;
  }
  mkdirSync(join(dir, 'externals/acme_vault'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/acme_vault/lf-external.yaml'),
    `name: acme_vault\nkind: core\nslot: secrets\nurl: ${vault.url}\nsettings:\n  - { name: vault, label: the vault credentials are kept in }\n`,
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  secrets: acme_vault\n');
  return dir;
}

const bridges: Array<{ over: string; readOnly: boolean; reach(options: { readOnly?: string }): Promise<Reached> }> = [
  {
    over: 'a secrets module',
    readOnly: true,
    reach: async ({ readOnly }) => {
      const vault = await serveSecretsModule({ listen: 0, ...(readOnly !== undefined ? { readOnly } : {}) });
      return { address: { baseUrl: vault.url }, settings: { vault: 'test' }, close: () => vault.close() };
    },
  },
  {
    over: "listen-fire's client of a secrets module",
    readOnly: true,
    reach: async ({ readOnly }) => {
      const vault = await serveSecretsModule({ listen: 0, ...(readOnly !== undefined ? { readOnly } : {}) });
      const served = await startModule(lfBinary(), ['--contract-secrets-slot', '--dir', project(vault)], {
        env: { LF_SECRET__ACME_VAULT__EXTERNAL: 'acme_vault', LF_SECRET__ACME_VAULT__VAULT: 'test' },
      });
      return {
        address: served.address,
        settings: {},
        close: async () => {
          await served.close();
          await vault.close();
        },
      };
    },
  },
  {
    over: "listen-fire's file secrets module",
    readOnly: false,
    reach: async () => {
      const served = await startModule(lfBinary(), ['--contract-secrets-slot', '--dir', project(null)]);
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

  for (const conformance of commonSlotCases('secrets', SECRETS_METHODS)) {
    test(`${bridge.over}: ${conformance.name}`, () => withModule({}, (reached) => conformance.run(new SlotClient(reached.address, reached.settings))));
  }
  for (const conformance of secretsSlotCases) {
    test(`${bridge.over}: ${conformance.name}`, () => withModule({}, (reached) => conformance.run(new SlotClient(reached.address, reached.settings))));
  }
  if (bridge.readOnly) {
    for (const conformance of secretsReadOnlySlotCases) {
      test(`${bridge.over}: ${conformance.name}`, () => withModule({ readOnly: REASON }, (reached) => conformance.run(new SlotClient(reached.address, reached.settings))));
    }
  }
  for (const contractCase of secretsContractCases) {
    test(`${bridge.over}, as a store: ${contractCase.name}`, () =>
      withModule({}, async (reached) => {
        const handle = () => new SecretsSlotBackend(reached.address, reached.settings);
        const backend: SecretsContractBackend = {
          backend: handle(),
          sibling: handle,
          seed: async (fields) => {
            const ref = `c${randomUUID().replaceAll('-', '').slice(0, 12)}`;
            await handle().seed(ref, 'acme_crm', fields);
            return ref;
          },
          missingRef: () => `missing_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
        };
        await contractCase.run(backend);
      }));
  }
}
