// The loop guard slot's contract suite: one set of cases every guard is held
// to — the built-in in this process (FingerprintGuard), listen-fire's Rust one over
// the guard wire (`listen-fire --contract-guard`, a file and a Postgres database), and
// a guard module listen-fire drives as a process (`listen-fire --contract-guard-slot`), all in
// apps/cli's tests. A guard is only told of writes, so each case holds it to
// taking them; what it remembers, and for how long, is its own business.
//
// Runner-agnostic, as the run host's suite is: each case is a name and an
// async body that throws on failure (node:assert). Every case uses records
// of its own, so one guard can serve the whole list.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LoopGuard } from './loop_guard';

export interface LoopGuardContractCase {
  name: string;
  run(guard: LoopGuard): Promise<void>;
}

const WRITER = 'listen:sync:stamp';

function aRecord() {
  return { adapter: 'attio', recordType: 'Companies', externalId: `rec-${randomUUID()}` };
}

const seen = { name: 'Acme', description: 'Seen by lf' };
const edited = { name: 'Acme', description: 'Edited by Bob' };

export const loopGuardContractCases: LoopGuardContractCase[] = [
  {
    name: 'a write is taken, and answers nothing',
    async run(guard) {
      assert.equal(await guard.recordWrite({ ...aRecord(), writer: WRITER, record: seen }), undefined);
    },
  },
  {
    name: 'a write that left the record gone is taken',
    async run(guard) {
      await guard.recordWrite({ ...aRecord(), writer: WRITER, record: null });
    },
  },
  {
    name: 'a writer\'s later write to the same record is taken, beside another writer\'s',
    async run(guard) {
      const one = aRecord();
      await guard.recordWrite({ ...one, writer: WRITER, record: seen });
      await guard.recordWrite({ ...one, writer: 'listen:audit:log', record: edited });
      await guard.recordWrite({ ...one, writer: WRITER, record: edited });
    },
  },
];
