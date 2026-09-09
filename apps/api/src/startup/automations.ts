// Automations' background workers: everything that makes a movement run
// without a request — the clock, the pollers, the subscription upkeep, and the
// two ways a parked run wakes up.
//
// None of these keeps a persisted pulse: each one claims its own rows and
// leaves the evidence in them, so there was never a heartbeat to read. What
// says they are alive is the in-process tick the loop primitive publishes —
// which is the whole of what the workers surface reports for them.

import { startMovementCronScheduler } from '../services/movement_scheduler/worker';
import { startExposedFilePoller } from '../services/exposed_file/worker';
import { startPollSourcePoller } from '../services/poll_source/worker';
import { startAirtableWebhookRefresh } from '../services/airtable_webhook_refresh/worker';
import { startAwaitResumeWorker } from '../services/movement_engine/await_resume';
import { startTimerResumeWorker } from '../services/movement_engine/timer_resume';
import { wireRestartOrphanSweep } from '../services/movement_engine/restart_sweep';
import type { WorkerRegistry } from './registry';

const automationsWorkers: WorkerRegistry = {
  unit: 'automations',
  workers: [
    { id: 'automations.cron_scheduler', start: startMovementCronScheduler },
    { id: 'automations.exposed_file_sweep', start: startExposedFilePoller },
    { id: 'automations.poll_source', start: startPollSourcePoller },
    { id: 'automations.airtable_webhook_refresh', start: startAirtableWebhookRefresh },
    { id: 'automations.await_resume', start: startAwaitResumeWorker },
    { id: 'automations.timer_resume', start: startTimerResumeWorker },
  ],
  // A run left `running` by a process death has nothing left to settle it —
  // the firing that owned it is gone. Taking the lock is the moment this
  // process knows the previous one has let go.
  wire: wireRestartOrphanSweep,
};

export { automationsWorkers };
