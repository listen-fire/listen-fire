// The composition root's asks wiring: the composed deployment's answer to "an
// ask settled, now what".
//
// Asks publishes a notifier interface and nothing more — it does not know the
// movement engine, parked runs, or `adapter_await` exist. Automations knows all
// three and nothing about how an answer got written. This module is the only
// place that knows both, which is the same shape as the knowledge mutation
// subscriber and the knowledge usage sink: the two products meet here and
// nowhere else.
//
// The behaviour is exactly what the door did inline before the seam existed —
// a fire-and-forget kick at the await-resume worker so a parked run wakes on
// the answer rather than on the next poll tick (A-5: wrapped, not replaced).

import { registerAskSettledNotifier } from '../translation_graph/adapters/ask/notifier';
import { nudgeAwaitResume } from '../movement_engine/await_resume';

export function notifyEngineOfSettledAsks(): void {
  registerAskSettledNotifier({
    async notify() {
      nudgeAwaitResume();
    },
  });
}
