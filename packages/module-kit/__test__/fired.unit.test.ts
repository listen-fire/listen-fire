import { firedRecordFields } from '../fired';

describe('firedRecordFields', () => {
  it('reads the fields of the record that landed on the arrival that fired the run', () => {
    const event = {
      pipelineInputId: 'notes:summarise',
      adapterType: 'granola',
      triggerType: 'arrival' as const,
      arrival: { adapterType: 'granola', edge: 'Meetings', landing: { recordId: 'n1', recordType: 'Meeting Note', fields: { note_owner_email: 'priya@fund.example' } } },
    };
    expect(firedRecordFields(event)).toEqual({ note_owner_email: 'priya@fund.example' });
  });

  it('reads none off a run no arrival fired', () => {
    expect(firedRecordFields({ pipelineInputId: 'p', adapterType: 'granola', triggerType: 'poll', payload: { note_owner_email: 'priya@fund.example' } })).toEqual({});
  });
});
