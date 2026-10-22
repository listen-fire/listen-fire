// A third-party movements module for the tests: the movements slot's methods
// (crates/lf/src/movements_slot.rs) served as adapter protocol 2 over HTTP,
// over files held in memory. It stands for a platform's per-tenant store: its
// one setting, `tenant`, comes from the environment or the project's secrets
// file (the bootstrap rule), never from the secrets slot, and it records the
// tenant each request carried.
//
// Tests serve it in their own process (`serveMovementsModule`); run as a
// script it serves on the socket its host names, as a module lf starts.

import { SlotRefusal, serveSlot } from 'movement-engine/public/module-wire';
import { MOVEMENTS_METHODS, MovementsReadRequest, MovementsWriteRequest } from 'engine-contracts/slots';
import type { z } from 'zod';

export interface MovementsModule {
  url: string;
  /** What it holds now: text by path. */
  held(): Record<string, string>;
  /** Each call, as `method path`: never a text. */
  calls: string[];
  /** Each write request: the path and the version it expected, never a text. */
  writes: Array<{ path: string; expectedVersion: string | null }>;
  /** The `tenant` setting each request carried, in order. */
  tenants: string[];
  close(): Promise<void>;
}

/** `readOnly` is the reason it gives for refusing every write; `changeBeforeWrite`
 *  names a file whose version moves on once, just before its first write is
 *  answered (another writer got there first). */
export async function serveMovementsModule(
  options: { files?: Record<string, string>; listen?: string | number; print?: boolean; readOnly?: string; changeBeforeWrite?: string } = {},
): Promise<MovementsModule> {
  let counter = 0;
  const files = new Map<string, { text: string; version: string }>();
  const put = (path: string, text: string) => files.set(path, { text, version: `v${++counter}` });
  for (const [path, text] of Object.entries(options.files ?? {})) put(path, text);
  let toChange = options.changeBeforeWrite;
  const calls: string[] = [];
  const tenants: string[] = [];
  const writes: MovementsModule['writes'] = [];
  const parse = <T>(shape: z.ZodType<T>, method: string, params: unknown): T => {
    const parsed = shape.safeParse(params);
    if (!parsed.success) throw new SlotRefusal('bad_request', `${method}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  };

  const served = await serveSlot({
    manifest: { protocolVersion: 2, name: 'acme_movements', kind: 'core', slot: 'movements', methods: [...MOVEMENTS_METHODS] },
    ...(options.listen !== undefined ? { listen: options.listen } : {}),
    ...(options.print !== undefined ? { print: options.print } : {}),
    answer: async (method, params, settings) => {
      if (typeof settings.tenant !== 'string' || settings.tenant === '') throw new SlotRefusal('settings', 'the `tenant` setting is missing');
      tenants.push(settings.tenant);
      calls.push(`${method} ${typeof params.path === 'string' ? params.path : ''}`.trim());
      switch (method) {
        case 'movements.list':
          return [...files].map(([path, { version }]) => ({ path, version }));
        case 'movements.read': {
          const { path } = parse(MovementsReadRequest, method, params);
          const file = files.get(path);
          return file === undefined ? null : { text: file.text, version: file.version };
        }
        case 'movements.write': {
          const { path, text, expectedVersion } = parse(MovementsWriteRequest, method, params);
          writes.push({ path, expectedVersion });
          if (options.readOnly !== undefined) return { kind: 'read_only', reason: options.readOnly };
          if (toChange === path) {
            toChange = undefined;
            const file = files.get(path);
            if (file !== undefined) put(path, file.text);
          }
          const current = files.get(path)?.version ?? null;
          if (current !== expectedVersion) return { kind: 'conflict', current };
          put(path, text);
          return { kind: 'written', version: files.get(path)?.version };
        }
        default:
          throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
      }
    },
  });

  return {
    url: served.address.baseUrl,
    calls,
    tenants,
    writes,
    held: () => Object.fromEntries([...files].map(([path, { text }]) => [path, text])),
    close: () => served.close(),
  };
}

if (require.main === module) void serveMovementsModule({ print: true });
