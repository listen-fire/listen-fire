import { renderPushPayload } from '../render';
import OpsEventType from '../../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../../generated/kysely/public/OpsSeverity';

const baseEvent = {
  id: 'evt-1', type: OpsEventType.SUPPORT, severity: OpsSeverity.notable,
  title: 'New support message', team_id: null,
  detail: { text: 'Customer says the sync is broken' }, entity_refs: null,
  request_id: null, created_at: new Date('2026-06-15T00:00:00Z'),
};

describe('renderPushPayload', () => {
  it('uses the title and mirrors the slack text as the body', () => {
    const p = renderPushPayload(baseEvent as any);
    expect(p.title).toContain('New support message');
    expect(p.body).toContain('sync is broken');
  });
  it('caps the body length', () => {
    const long = { ...baseEvent, detail: { text: 'x'.repeat(5000) } };
    expect(renderPushPayload(long as any).body.length).toBeLessThanOrEqual(500);
  });
  it('survives missing detail', () => {
    const p = renderPushPayload({ ...baseEvent, detail: null } as any);
    expect(p.title).toContain('New support message');
    expect(typeof p.body).toBe('string');
  });
});
