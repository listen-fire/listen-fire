// A third-party loop guard module for the tests: the loopGuard slot's
// methods (docs/contracts/loop-guard-slot.md) served as adapter protocol 2
// over HTTP, on the socket listen-fire names (`MODULE_SOCKET`), over the TypeScript
// built-in (`FingerprintGuard`). It stands for a guard whose memory is
// elsewhere — Redis, a database — which is the same wire over other state. It
// refuses to be used before `guard.open`, as a real one would.
//
// It still offers `guard.isEcho`, as a guard built for listen-fire 0.13 does:
// the slot retired the method, and a host that never calls it must load such
// a guard as before. With `GUARD_CALLS` set, it appends each call's method
// and params to that file, one JSON line each, so a test sees what the host asked.

import { appendFileSync } from 'node:fs';
import { FingerprintGuard } from 'movement-engine/services/loop_guard/loop_guard';
import { serveSlot } from 'movement-engine/public/module-wire';

const guard = new FingerprintGuard();
const calls = process.env.GUARD_CALLS;
let opened = false;

void serveSlot({
  manifest: { protocolVersion: 2, name: 'acme_guard', kind: 'core', slot: 'loopGuard', methods: ['guard.open', 'guard.recordWrite', 'guard.isEcho'] },
  print: true,
  answer: async (method, params) => {
    if (calls !== undefined) appendFileSync(calls, `${JSON.stringify({ method, params })}\n`);
    if (method === 'guard.open') {
      opened = true;
      return null;
    }
    if (!opened) throw new Error('open me with guard.open first');
    switch (method) {
      case 'guard.recordWrite':
        await guard.recordWrite(params as never);
        return null;
      case 'guard.isEcho':
        return { echo: false };
      default:
        throw new Error(`no method "${method}"`);
    }
  },
});
