// A third-party secrets module for the tests: the secrets slot's methods
// (crates/lf/src/secrets_slot.rs) served as adapter protocol 2 over HTTP,
// over the in-memory vault an embedder starts from. It stands for a vault a
// fleet of lf processes shares: every credential with its binding, a lease
// per credential that lapses after its ttl, and whole entries created,
// replaced and deleted. Its one setting, `vault`, comes from the project's
// secrets file or the environment (the bootstrap rule), never from itself.
//
// Tests serve it in their own process (`serveSecretsModule`) so two lf
// processes reach one vault at its url; run as a script it serves on the
// socket its host names, as a module lf starts.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createMemoryVault, type SecretFields } from 'movement-engine/public/secrets';
import { SECRETS_METHODS } from 'engine-contracts/slots';
import { SlotRefusal, serveSlot } from 'movement-engine/public/module-wire';

export type Binding = 'install' | 'legacy' | { credential: string };

export interface Seeded {
  external: string;
  binding: Binding;
  fields: SecretFields;
}

export interface SecretsModule {
  url: string;
  /** What it holds now: binding and fields, by ref. */
  held(): Promise<Record<string, Seeded>>;
  /** Each call, as `method ref`: never a value. */
  calls: string[];
  /** The refs whose lease is held now. */
  leased(): string[];
  close(): Promise<void>;
}

const Ref = z.object({ ref: z.string().min(1) });
const Fields = z.record(z.string(), z.string());
const WriteBack = Ref.extend({ fields: Fields, expectedVersion: z.string() });
const Lock = Ref.extend({ ttlMs: z.number().int().nonnegative() });
const Unlock = Ref.extend({ token: z.string() });
const BindingShape = z.union([z.literal('install'), z.literal('legacy'), z.object({ credential: z.string().min(1) })]);
const Entry = Ref.extend({ external: z.string().min(1), binding: BindingShape, fields: Fields });

/** `readOnly` (or the `SECRETS_READ_ONLY` environment variable, for the module run as a script) is the reason this vault gives for
 *  not changing whole entries: it answers `read_only` to assertWritable, create, replace and delete, and still resolves, lists, locks and writes back. */
export async function serveSecretsModule(
  options: { seed?: Record<string, Seeded>; listen?: string | number; print?: boolean; readOnly?: string } = {},
): Promise<SecretsModule> {
  const readOnly = options.readOnly ?? (process.env.SECRETS_READ_ONLY || undefined);
  const vault = createMemoryVault();
  const bindings = new Map<string, { external: string; binding: Binding }>();
  const leases = new Map<string, { token: string; until: number }>();
  const calls: string[] = [];
  const put = (ref: string, entry: Seeded) => {
    bindings.set(ref, { external: entry.external, binding: entry.binding });
    vault.put(ref, entry.fields);
  };
  for (const [ref, entry] of Object.entries(options.seed ?? {})) put(ref, entry);
  const resolve = async (ref: string) => (bindings.has(ref) ? vault.resolve(ref) : null);
  const parse = <T>(shape: z.ZodType<T>, method: string, params: unknown): T => {
    const parsed = shape.safeParse(params);
    if (!parsed.success) throw new SlotRefusal('bad_request', `${method}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  };

  const served = await serveSlot({
    manifest: {
      protocolVersion: 2,
      name: 'acme_vault',
      kind: 'core',
      slot: 'secrets',
      methods: [...SECRETS_METHODS],
    },
    ...(options.listen !== undefined ? { listen: options.listen } : {}),
    ...(options.print !== undefined ? { print: options.print } : {}),
    answer: async (method, params, settings) => {
      if (typeof settings.vault !== 'string' || settings.vault === '') throw new SlotRefusal('settings', 'the `vault` setting is missing');
      calls.push(`${method} ${typeof params.ref === 'string' ? params.ref : ''}`.trim());
      switch (method) {
        case 'secrets.resolve':
          return resolve(parse(Ref, method, params).ref);
        case 'secrets.writeBack': {
          const { ref, fields, expectedVersion } = parse(WriteBack, method, params);
          if (!bindings.has(ref)) return { kind: 'missing' };
          return vault.writeBack(ref, fields, expectedVersion);
        }
        case 'secrets.list':
          return Promise.all(
            [...bindings].map(async ([ref, { external, binding }]) => ({ ref, external, binding, version: (await vault.resolve(ref))?.version ?? '' })),
          );
        case 'secrets.lock': {
          const { ref, ttlMs } = parse(Lock, method, params);
          const now = Date.now();
          const lease = leases.get(ref);
          if (lease !== undefined && lease.until > now) return null;
          const token = randomUUID();
          leases.set(ref, { token, until: now + ttlMs });
          return { token };
        }
        case 'secrets.unlock': {
          const { ref, token } = parse(Unlock, method, params);
          if (leases.get(ref)?.token === token) leases.delete(ref);
          return null;
        }
        case 'secrets.assertWritable':
          parse(Ref, method, params);
          return readOnly !== undefined ? { kind: 'read_only', reason: readOnly } : null;
        case 'secrets.create': {
          const { ref, ...entry } = parse(Entry, method, params);
          if (readOnly !== undefined) return { kind: 'read_only', reason: readOnly };
          if (bindings.has(ref)) throw new SlotRefusal('exists', `the vault already has an entry "${ref}"`);
          put(ref, entry);
          return null;
        }
        case 'secrets.replace': {
          const { ref, ...entry } = parse(Entry, method, params);
          if (readOnly !== undefined) return { kind: 'read_only', reason: readOnly };
          put(ref, entry);
          return null;
        }
        case 'secrets.delete': {
          const { ref } = parse(Ref, method, params);
          if (readOnly !== undefined) return { kind: 'read_only', reason: readOnly };
          if (!bindings.delete(ref)) throw new SlotRefusal('missing', `the vault has no entry "${ref}"`);
          return null;
        }
        default:
          throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
      }
    },
  });

  return {
    url: served.address.baseUrl,
    calls,
    held: async () => {
      const out: Record<string, Seeded> = {};
      for (const [ref, { external, binding }] of bindings) out[ref] = { external, binding, fields: (await vault.resolve(ref))?.fields ?? {} };
      return out;
    },
    leased: () => [...leases].filter(([, lease]) => lease.until > Date.now()).map(([ref]) => ref),
    close: () => served.close(),
  };
}

if (require.main === module) void serveSecretsModule({ print: true });
