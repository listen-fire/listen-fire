import { firedActor, firedRecordFields } from '../fired';

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

describe('firedActor', () => {
  it('reads who acted on the arrival that fired the run, as its module said at the door', () => {
    const actor = { identifier: 'U1', scheme: 'opaque' as const, label: 'U1' };
    const event = {
      pipelineInputId: 'chat:answer',
      adapterType: 'slack',
      triggerType: 'arrival' as const,
      arrival: { adapterType: 'slack', edge: 'Messages', landing: { recordId: 'C1:1.0', fields: { user: 'U1' } }, actor },
    };
    expect(firedActor(event)).toEqual(actor);
  });

  it('reads no one off an arrival that named no actor, or a run no arrival fired', () => {
    expect(firedActor({ pipelineInputId: 'p', adapterType: 'slack', triggerType: 'arrival', arrival: { adapterType: 'slack', edge: 'Messages', landing: { fields: { user: 'U1' } } } })).toBeNull();
    expect(firedActor({ pipelineInputId: 'p', adapterType: 'slack', triggerType: 'poll', payload: { user: 'U1' } })).toBeNull();
  });
});
