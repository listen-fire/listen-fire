import type { SeedRows, Task } from '../task';

function attioDeal(id: string, name: string, stage: string): SeedRows['entities'][number] {
  return {
    entity_type: 'record:deals',
    id,
    data: {
      id: { workspace_id: 'test', object_id: 'deals', record_id: id },
      values: { name: [{ value: name }], stage: [{ option: { title: stage } }] },
    },
  };
}

/**
 * handbook patterns#scheduled-digest: a tick fires, a query gathers, one message
 * goes out. Asks about open deals rather than "added this week" because the fake
 * CRM carries no creation timestamp to filter on.
 */
export const scheduledDigest: Task = {
  id: 'scheduled-digest',
  title: 'Monday roundup of open deals → #dealflow',
  source: 'patterns#scheduled-digest',
  request: 'Every Monday morning, post a roundup of our open deals from Attio in #dealflow.',
  hiddenSpec:
    "9am every Monday. One message in #dealflow listing every deal in Attio that isn't marked Passed, each with its name and stage. Passed deals are closed; leave them out.",
  connections: ['attio', 'slack'],
  seed: [
    {
      service: 'attio',
      entities: [
        attioDeal('deal-zephyr', 'Zephyr Robotics seed', 'Sourced'),
        attioDeal('deal-quill', 'Quill Labs Series A', 'Diligence'),
        attioDeal('deal-oldco', 'Oldco bridge', 'Passed'),
      ],
    },
  ],
  fixtures: [
    {
      id: 'monday-tick',
      description: 'the two open deals listed, the passed one left out',
      event: { kind: 'schedule' },
      assertions: [
        {
          kind: 'created',
          collection: 'slack/messages',
          where: { channel: 'dealflow', text: /^(?=[\s\S]*zephyr)(?=[\s\S]*quill)(?![\s\S]*oldco)/i },
          count: 1,
          label: 'one #dealflow roundup with the open deals only',
        },
        { kind: 'created', collection: 'slack/messages', count: 1, label: 'nothing posted elsewhere' },
      ],
    },
  ],
};
