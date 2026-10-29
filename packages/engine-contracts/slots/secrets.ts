// The secrets slot's methods (docs/contracts/secrets-slot.md): where listen-fire's
// credentials are kept. A module resolves and lists what it holds, takes a
// write-back by version, holds a credential under a lease while a refresh
// spends its token, and changes whole entries for `listen-fire connect` and
// `listen-fire credential`. Token refresh stays in listen-fire; a module only stores.

import { z } from 'zod';

export const SECRETS_METHODS = [
  'secrets.resolve',
  'secrets.writeBack',
  'secrets.list',
  'secrets.lock',
  'secrets.unlock',
  'secrets.assertWritable',
  'secrets.create',
  'secrets.replace',
  'secrets.delete',
] as const;

const Fields = z.record(z.string(), z.string());

/** What `secrets.resolve` answers (or null: nothing is stored under the ref). */
export const SecretsRecord = z.object({ fields: Fields, version: z.string().min(1) });

export const SecretsWriteBackAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('written'), record: SecretsRecord }),
  z.object({ kind: z.literal('not_persisted'), record: SecretsRecord, why: z.string() }),
  z.object({ kind: z.literal('conflict'), current: SecretsRecord }),
  z.object({ kind: z.literal('missing') }),
]);

/** How an entry is bound: an install of a module, a hand-written legacy
 *  entry, or a credential the module declares. */
export const SecretsBinding = z.union([z.literal('install'), z.literal('legacy'), z.object({ credential: z.string().min(1) })]);
export type SecretsBindingShape = z.infer<typeof SecretsBinding>;

export const SecretsListed = z.object({ ref: z.string().min(1), external: z.string().min(1), binding: SecretsBinding, version: z.string() });

/** `secrets.lock` answers a token, or null when another holds the lease. */
export const SecretsLockAnswer = z.object({ token: z.string().min(1) }).nullable();

/** What `secrets.assertWritable`, `create`, `replace` and `delete` answer
 *  besides null: the module keeps its credentials where listen-fire cannot change them. */
export const SecretsReadOnlyAnswer = z.object({ kind: z.literal('read_only'), reason: z.string().min(1) });
export const SecretsEntryAnswer = SecretsReadOnlyAnswer.nullable();

export const SecretsEntryRequest = z.object({ ref: z.string().min(1), external: z.string().min(1), binding: SecretsBinding, fields: Fields });
