// One tenant cannot reach another's connection through the in-process host:
// before it builds an instance for the credential a run names, the host asks
// whether that credential is the segment's tenant's.

import { HOST_FAMILIES_VERSION, tenantIdOf } from 'engine-contracts';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { Adapter } from '../../translation_graph/adapter';
import { CredentialNotTenants } from '../../translation_graph/engine/adapter_table';
import { inProcessHost } from '../in_process_host';

const ACME = tenantIdOf('acme');
const GLOBEX = tenantIdOf('globex');

const OWNERS: Record<string, string> = { 'cred-acme': ACME, 'cred-globex': GLOBEX };

function crm(): Adapter {
  return {
    adapterType: 'crm',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'crm', externalId: 'r1', recordType: 'Company', data: {} }),
    updateRecord: async () => {
      throw new Error('not used');
    },
    deleteRecord: async () => ({}),
  };
}

async function segmentFor(host: ReturnType<typeof inProcessHost>, teamId: typeof ACME): Promise<string> {
  const { segmentId } = await host.segment.open({ teamId, languageVersion: LANGUAGE_VERSION, hostFamiliesVersion: HOST_FAMILIES_VERSION });
  return segmentId;
}

describe('the in-process host and a credential a run names', () => {
  it("builds an instance for the tenant's own credential, and refuses another tenant's before building anything", async () => {
    const built: Array<string | undefined> = [];
    const host = inProcessHost({
      adapters: {
        resolve: ({ credentialsId }) => {
          built.push(credentialsId);
          return crm();
        },
      },
      credentials: { belongsTo: ({ teamId, credentialsId }) => OWNERS[credentialsId] === teamId },
    });
    const segmentId = await segmentFor(host, ACME);
    await expect(host.adapters.resolve({ adapterType: 'crm', credentialsId: 'cred-acme', role: 'target', segmentId })).resolves.toMatchObject({
      adapterType: 'crm',
    });
    const refused = host.adapters.resolve({ adapterType: 'crm', credentialsId: 'cred-globex', role: 'target', segmentId });
    await expect(refused).rejects.toBeInstanceOf(CredentialNotTenants);
    await expect(refused).rejects.toThrow("credential 'cred-globex' does not belong to tenant 'acme'");
    expect(built).toEqual(['cred-acme']);
  });

  it('asks once per instance, not once per resolution of the same one', async () => {
    let asked = 0;
    const host = inProcessHost({
      adapters: { resolve: () => crm() },
      credentials: {
        belongsTo: () => {
          asked += 1;
          return true;
        },
      },
    });
    const segmentId = await segmentFor(host, ACME);
    await host.adapters.resolve({ adapterType: 'crm', credentialsId: 'cred-acme', role: 'target', segmentId });
    await host.adapters.resolve({ adapterType: 'crm', credentialsId: 'cred-acme', role: 'source', segmentId });
    expect(asked).toBe(1);
  });

  it('refuses by name a run that names a credential on a host told nothing about ownership', async () => {
    const host = inProcessHost({ adapters: { resolve: () => crm() } });
    const segmentId = await segmentFor(host, ACME);
    await expect(host.adapters.resolve({ adapterType: 'crm', credentialsId: 'cred-acme', role: 'target', segmentId })).rejects.toThrow(
      'EngineHost.credentials.belongsTo not provided',
    );
    // A connection with no credential asks nothing.
    await expect(host.adapters.resolve({ adapterType: 'crm', role: 'target', segmentId })).resolves.toMatchObject({ adapterType: 'crm' });
  });

  it('refuses a file by name on a host whose file-text slot is empty', async () => {
    const host = inProcessHost();
    const segmentId = await segmentFor(host, ACME);
    await expect(
      host.files.resolveFileText({ file: { name: 'deck.pdf' } as never, segmentId, budget: {} as never }),
    ).rejects.toThrow('EngineHost.files.resolveFileText not provided: this host has no file-text module, so it cannot read the file "deck.pdf"');
  });
});

describe('the in-process host and who acted on an arrival', () => {
  const arrived = {
    pipelineInputId: 'listen:chat:answer',
    adapterType: 'crm',
    triggerType: 'arrival' as const,
    arrival: {
      adapterType: 'crm',
      edge: 'Notes',
      landing: { recordId: 'n1', fields: {} },
      actor: { identifier: 'ada@acme.example', scheme: 'email' as const, email: 'ada@acme.example' },
    },
    occurredAt: '2026-11-02T08:00:00.000Z',
  };

  async function candidatesFor(adapter: Adapter): Promise<unknown> {
    let seen: unknown;
    const host = inProcessHost({
      adapters: { resolve: () => adapter },
      lookup: {
        resolveActingUser: async ({ getCandidates }) => {
          seen = await getCandidates();
          return null;
        },
      },
    });
    const segmentId = await segmentFor(host, ACME);
    const { instance } = await host.adapters.resolve({ adapterType: 'crm', role: 'source', segmentId });
    await host.lookup.resolveActingUser({ segmentId, instance, event: arrived });
    return seen;
  }

  it("resolves the acting user from the arrival's actor when the module offers no candidates of its own", async () => {
    expect(await candidatesFor(crm())).toEqual([{ identity: arrived.arrival.actor, source: 'originator' }]);
  });

  it("asks the module for its candidates where it offers them (an API lookup, a mail's relays)", async () => {
    const relayed = [{ identity: { identifier: 'ops@acme.example', scheme: 'email' as const }, source: 'relay' as const }];
    expect(await candidatesFor({ ...crm(), getActorCandidates: async () => relayed })).toEqual(relayed);
  });
});
