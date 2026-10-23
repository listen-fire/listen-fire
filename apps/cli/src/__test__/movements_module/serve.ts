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
import { randomUUID } from 'node:crypto';

import { MOVEMENTS_METHODS, MovementsReadRequest, MovementsWriteRequest, WATCH_WAIT_CAP_MS, WatchRequest, type MovementsChangeShape } from 'engine-contracts/slots';
import type { z } from 'zod';

export interface MovementsModule {
  url: string;
  /** What it holds now: text by path. */
  held(): Record<string, string>;
  /** Another writer's change: `text` at `path`, at a new version. */
  put(path: string, text: string): void;
  /** Another writer's delete. */
  remove(path: string): void;
  /** Each call, as `method path`: never a text. */
  calls: string[];
  /** Each write request: the path and the version it expected, never a text. */
  writes: Array<{ path: string; expectedVersion: string | null }>;
  /** The `tenant` setting each request carried, in order. */
  tenants: string[];
  close(): Promise<void>;
}

/** `watches: false` leaves `movements.watch` out of the manifest (a module
 *  from before the method); `holds: false` answers every watch at once (a module that cannot wait);
 *  otherwise a watch is held until an event or `min(waitMs, 30000)`.
 *  `readOnly` is the reason it gives for refusing every write; `changeBeforeWrite`
 *  names a file whose version moves on once, just before its first write is
 *  answered (another writer got there first). */
export async function serveMovementsModule(
  options: { files?: Record<string, string>; listen?: string | number; print?: boolean; readOnly?: string; changeBeforeWrite?: string; holds?: boolean; watches?: boolean } = {},
): Promise<MovementsModule> {
  let counter = 0;
  const files = new Map<string, { text: string; version: string }>();
  // One log for every caller: a cursor is `<epoch>:<position>`, a position in
  // it, so each watcher holding a cursor sees every event after it.
  const epoch = randomUUID();
  const log: MovementsChangeShape[] = [];
  let waiters: Array<() => void> = [];
  const append = (change: MovementsChangeShape) => {
    log.push(change);
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake();
  };
  const put = (path: string, text: string) => {
    const existed = files.has(path);
    const version = `v${++counter}`;
    files.set(path, { text, version });
    append({ kind: existed ? 'changed' : 'added', path, version });
  };
  const remove = (path: string) => {
    if (files.delete(path)) append({ kind: 'removed', path });
  };
  const cursorAt = (position: number) => `${epoch}:${position}`;
  /** The position a cursor names, or null when this module never gave it. */
  const positionOf = (cursor: string): number | null => {
    const [from, position, ...rest] = cursor.split(':');
    if (from !== epoch || position === undefined || rest.length > 0 || !/^\d+$/.test(position)) return null;
    return Number(position) <= log.length ? Number(position) : null;
  };
  const holds = options.holds ?? true;
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
    manifest: { protocolVersion: 2, name: 'acme_movements', kind: 'core', slot: 'movements', methods: MOVEMENTS_METHODS.filter((method) => options.watches !== false || method !== 'movements.watch') },
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
        case 'movements.watch': {
          const { cursor, waitMs } = parse(WatchRequest, method, params);
          if (cursor === undefined) return { cursor: cursorAt(log.length), events: [] };
          const from = positionOf(cursor);
          if (from === null) return { resync: true };
          if (holds && waitMs > 0 && log.length === from) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, Math.min(waitMs, WATCH_WAIT_CAP_MS));
              function done() {
                clearTimeout(timer);
                waiters = waiters.filter((waiter) => waiter !== done);
                resolve();
              }
              waiters.push(done);
            });
          }
          return { cursor: cursorAt(log.length), events: log.slice(from) };
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
    put,
    remove,
    close: () => {
      for (const wake of waiters) wake();
      return served.close();
    },
  };
}

if (require.main === module) void serveMovementsModule({ print: true });
