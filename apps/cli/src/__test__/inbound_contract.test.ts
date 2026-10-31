// The inbound doors' contract suite (movement-engine's inbound/contract.ts)
// against the Rust listen-fire's doors: `listen-fire --contract-doors` serves them
// over HTTP, and the suite's world is arranged, and what the doors did read
// back, over its stdio JSON-RPC bridge (`StdioRpcBridge`). The same
// cases the doors are held to.

import { test } from 'node:test';
import { z } from 'zod';
import { DELIVERY_RECEIPT_CONTRACT_CASES, INBOUND_CONTRACT_CASES, type DeliveryReceiptContractBackend } from 'movement-engine/public/inbound';
import { StdioRpcBridge } from './stdio_rpc';
import { lfBinary } from './lf_bin';

const Observations = z.object({
  captured: z.number(),
  enqueued: z.number(),
  checkpoints: z.array(z.unknown()),
  notified: z.number(),
});

const Deliveries = z.array(z.object({ externalId: z.string().nullable(), source: z.string(), eventCount: z.number() }));

async function backendOnLfHost(): Promise<{ backend: DeliveryReceiptContractBackend; stop(): Promise<void> }> {
  const bridge = new StdioRpcBridge(lfBinary(), ['--contract-doors']);
  const { baseUrl } = await bridge.call('doors.baseUrl', {}, z.object({ baseUrl: z.string() }));
  const backend: DeliveryReceiptContractBackend = {
    baseUrl,
    async arrange(world) {
      await bridge.call('doors.arrange', world, z.null());
    },
    async observed() {
      const seen = await bridge.call('doors.observed', {}, Observations);
      // listen-fire's doors queue no key wakes since 0.13: a module reports arrivals.
      return { ...seen, wakes: [], checkpoints: [...seen.checkpoints] };
    },
    async deliveries() {
      return bridge.call('doors.deliveries', {}, Deliveries);
    },
  };
  return { backend, stop: () => bridge.close() };
}

/** listen-fire has no synthetic (test-harness) subscription: every delivery is
 *  verified. Since 0.13 it wakes no awaits by key: a module reports arrivals,
 *  its wake door refuses a push naming keys, naming adapter protocol 2.5
 *  (await_edges.test.ts), and a delivery's `wakeKeys` are not asked for. The
 *  TypeScript doors still take keys. */
const NOT_ON_LF = new Set([
  'a synthetic subscription skips the signature and drains before the ack',
  'wake queues one wake per key: 202 accepted',
  'wake keys are queued whether or not any event came with them',
  'a receipt that cannot be queued is a 500 so the sender retries; the wakes still go in',
  'a wake door that fails is a 500 after the events are queued',
  'wakes that cannot be queued are a 500',
]);
const RECEIPTS_NOT_ON_LF = new Set(['a delivery whose wakes failed is kept without its id, so the retry is kept too']);

for (const entry of INBOUND_CONTRACT_CASES) {
  test(`inbound doors contract — listen-fire: ${entry.name}`, { skip: NOT_ON_LF.has(entry.name) }, async () => {
    const { backend, stop } = await backendOnLfHost();
    try {
      await entry.run(backend);
    } finally {
      await stop();
    }
  });
}

for (const entry of DELIVERY_RECEIPT_CONTRACT_CASES) {
  test(`delivery receipt contract — listen-fire: ${entry.name}`, { skip: RECEIPTS_NOT_ON_LF.has(entry.name) }, async () => {
    const { backend, stop } = await backendOnLfHost();
    try {
      await entry.run(backend);
    } finally {
      await stop();
    }
  });
}
