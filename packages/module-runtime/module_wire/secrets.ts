// A secrets module spoken to over the wire as the secrets family's store
// (`SecretsBackend`, secrets/family.ts): how the family's contract cases
// (movement-engine services/secrets/contract.ts) hold any module of the
// secrets slot to the meaning every store has, whether the module is served
// by listen-fire (`listen-fire --contract-secrets-slot`) or is a third party's.

import { SecretsLockAnswer, SecretsWriteBackAnswer, SecretsRecord } from 'engine-contracts/slots';

import type { SecretFields, SecretRecord, SecretsBackend, WriteBackOutcome } from '../secrets/family';
import { SlotClient, type SlotAddress } from './wire';

const LOCK_POLL_MS = 20;
const LEASE_TTL_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export class SecretsSlotBackend implements SecretsBackend {
  private readonly client: SlotClient;

  constructor(address: SlotAddress, settings: Record<string, string> = {}) {
    this.client = new SlotClient(address, settings);
  }

  resolve(ref: string): Promise<SecretRecord | null> {
    return this.client.read('secrets.resolve', { ref }, SecretsRecord.nullable());
  }

  async writeBack(ref: string, fields: SecretFields, expectedVersion: string): Promise<WriteBackOutcome> {
    return this.client.read('secrets.writeBack', { ref, fields, expectedVersion }, SecretsWriteBackAnswer);
  }

  /** The module's lease, asked for again until it is free, held for `body`. */
  async exclusive<T>(ref: string, body: (store: SecretsBackend) => Promise<T>): Promise<T> {
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const lease = await this.client.read('secrets.lock', { ref, ttlMs: LEASE_TTL_MS }, SecretsLockAnswer);
      if (lease !== null) {
        try {
          return await body(this);
        } finally {
          await this.client.call('secrets.unlock', { ref, token: lease.token });
        }
      }
      if (Date.now() > until) throw new Error(`the secrets module kept credential "${ref}" locked for ${LOCK_WAIT_MS / 1000}s`);
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  }

  /** A write-back is not what `read_only` answers for: only a refusal fails here. */
  async assertWritable(ref: string): Promise<void> {
    await this.client.call('secrets.assertWritable', { ref });
  }

  /** Store a new credential (a legacy entry bound to `external`). */
  async seed(ref: string, external: string, fields: SecretFields): Promise<void> {
    await this.client.call('secrets.create', { ref, external, binding: 'legacy', fields });
  }
}
