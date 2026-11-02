// A loop guard a loop guard module serves: the slot's methods
// (docs/contracts/loop-guard-slot.md) carried as adapter protocol 2 calls
// over HTTP (a Unix socket on this box). How the contract suite
// (contract.ts) holds listen-fire's guard (`listen-fire --contract-guard`), and a guard module
// listen-fire drives, to the meaning every guard has.

import { z } from 'zod';
import { SlotClient, startModule, type SlotAddress } from 'module-runtime/module_wire/wire';
import type { LoopGuard, RecordWrite } from './loop_guard';

const Nothing = z.null();

export class RpcLoopGuard implements LoopGuard {
  private readonly started: Promise<{ client: SlotClient; close(): Promise<void> }>;

  /** The guard module `command` starts, or the one already at `address`. */
  constructor(command: string, args: readonly string[]);
  constructor(address: SlotAddress);
  constructor(target: string | SlotAddress, args: readonly string[] = []) {
    this.started =
      typeof target === 'string'
        ? startModule(target, args).then((module) => ({ client: new SlotClient(module.address), close: () => module.close() }))
        : Promise.resolve({ client: new SlotClient(target), close: async () => undefined });
    this.started.catch(() => undefined);
  }

  private async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    return (await this.started).client.read(method, params, schema);
  }

  async open(settings: Record<string, string> = {}): Promise<void> {
    await this.call('guard.open', { settings }, Nothing);
  }

  async recordWrite(write: RecordWrite): Promise<void> {
    await this.call('guard.recordWrite', write, Nothing);
  }

  async close(): Promise<void> {
    await (await this.started.catch(() => undefined))?.close();
  }
}
