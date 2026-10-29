// A third-party wake module for the tests: the wake slot's methods
// (docs/contracts/wake-slot.md) served as adapter protocol 2 over HTTP, on
// the socket its host names (`MODULE_SOCKET`). It stands for a cloud queue
// module: a wake becomes a delivery to `target` (its one setting), now or at
// the instant, as a queue service delivers a task to whatever starts a
// worker. The harness serves `target` and counts each delivery as a worker
// started.

import { WAKE_METHODS, WakeAtRequest, WakeNowRequest } from 'engine-contracts/slots';
import { SlotRefusal, serveSlot } from 'movement-engine/public/module-wire';

function deliver(target: string, kind: string): Promise<void> {
  return fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) }).then(
    () => undefined,
    (error: unknown) => {
      process.stderr.write(`wake delivery to ${target} failed: ${String(error)}\n`);
    },
  );
}

// A wake due now is delivered before the module answers, as a queue service
// accepts a task before it acknowledges it: listen-fire may stop the module the moment
// it has its answer.
async function deliverAfter(target: string, kind: string, delayMs: number): Promise<void> {
  if (delayMs <= 0) return deliver(target, kind);
  setTimeout(() => void deliver(target, kind), delayMs);
}

void serveSlot({
  manifest: { protocolVersion: 2, name: 'acme_wake', kind: 'core', slot: 'wake', methods: [...WAKE_METHODS] },
  print: true,
  answer: async (method, params, settings) => {
    const target = settings.target;
    if (typeof target !== 'string' || target === '') throw new Error('the `target` setting is missing');
    switch (method) {
      case 'wake.now': {
        const wake = WakeNowRequest.safeParse(params);
        if (!wake.success) throw new SlotRefusal('bad_request', `wake.now: ${wake.error.issues[0]?.message}`);
        await deliverAfter(target, wake.data.kind, 0);
        return null;
      }
      case 'wake.at': {
        const wake = WakeAtRequest.safeParse(params);
        if (!wake.success) throw new SlotRefusal('bad_request', `wake.at: ${wake.error.issues[0]?.message}`);
        await deliverAfter(target, wake.data.kind, Date.parse(wake.data.at) - Date.now());
        return null;
      }
      default:
        throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    }
  },
});
