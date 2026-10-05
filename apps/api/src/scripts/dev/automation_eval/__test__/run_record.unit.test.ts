import { runRecordOf } from '../run_record';

const run = { id: 'r1', status: 'success', failureReason: null };

describe('runRecordOf', () => {
  it('summarizes writes, extractions, untaken branches and errors compactly', () => {
    const record = runRecordOf(run, {
      body: {
        writes: [
          { target: 'attio:companies', action: 'create', committed: true, values: { name: 'Acme AI', blob: 'x'.repeat(500) } },
          { target: 'slack:messages', action: 'noop', committed: false, values: {} },
          { target: 'attio:companies', action: 'attach', committed: true },
        ],
        trace: [
          { kind: 'extraction', node: 'company', entities: { company: [{ fields: { name: 'Acme AI', website: null } }] } },
          { kind: 'gate', outcome: false },
          { kind: 'gate', outcome: true },
          { kind: 'warning', code: 'W1', message: 'careful' },
        ],
        errors: [{ message: 'boom' }],
      },
    });
    expect(record).toMatchObject({
      id: 'r1',
      inspected: true,
      branchesNotTaken: 1,
      warnings: ['W1: careful'],
      errors: ['boom'],
      extractions: [{ node: 'company', entities: { company: [{ name: 'Acme AI', website: null }] } }],
    });
    if (!record.inspected) throw new Error('expected an inspected record');
    expect(record.writes.map((w) => [w.system, w.recordType, w.outcome])).toEqual([
      ['attio', 'companies', 'created'],
      ['slack', 'messages', 'skipped'],
      ['attio', 'companies', 'updated'],
    ]);
    expect(record.writes[0]?.values.blob?.length).toBeLessThan(120);
  });

  it('caps the writes list and says how many it left out', () => {
    const writes = Array.from({ length: 30 }, () => ({ target: 'a:b', action: 'create', committed: true, values: {} }));
    const record = runRecordOf(run, { body: { writes, trace: [], errors: [] } });
    if (!record.inspected) throw new Error('expected an inspected record');
    expect(record.writes).toHaveLength(20);
    expect(record.writesOmitted).toBe(10);
  });

  it('records why a run could not be inspected', () => {
    expect(runRecordOf(run, { error: 'inspect-run 404' })).toMatchObject({ inspected: false, inspectError: 'inspect-run 404' });
    expect(runRecordOf(run, { body: { error: 'run r1 not found' } })).toMatchObject({ inspected: false });
  });
});
