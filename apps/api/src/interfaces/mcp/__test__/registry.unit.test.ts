import { z } from 'zod';

import { registerCrudRoutes, validateCallApiBody } from '../registry';

// Isolated synthetic domain — not the real 'valuations' routes — so this
// stays a pure unit test of validateCallApiBody's matching + strict-parse
// logic, independent of whatever register_routes.ts currently declares.
const domain = `test-registry-${Math.random().toString(36).slice(2)}`;

beforeAll(() => {
  registerCrudRoutes({
    basePath: '/v1/test/events',
    description:
      "test events. To record an acquisition, use the addAcquisition tool instead — it stamps the acquired company's legal entity",
    domain,
    listSchema: z.object({ legal_entity_id: z.string().uuid().optional() }),
    createSchema: z.object({
      date: z.string(),
      legal_entity_id: z.string(),
    }),
    updateSchema: z.object({
      date: z.string().optional(),
    }),
  });
});

describe('validateCallApiBody', () => {
  it('passes through a route with no registered schema (GET)', () => {
    expect(validateCallApiBody(domain, 'GET', '/v1/test/events/some-id', undefined)).toEqual({ ok: true });
  });

  it('accepts a body matching the schema exactly', () => {
    expect(
      validateCallApiBody(domain, 'POST', '/v1/test/events', { date: '2026-01-01', legal_entity_id: 'x' }),
    ).toEqual({ ok: true });
  });

  it('rejects an unrecognized field, naming it and surfacing the resource description', () => {
    const result = validateCallApiBody(domain, 'POST', '/v1/test/events', {
      date: '2026-01-01',
      legal_entity_id: 'x',
      acquirer_id: 'y',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Unrecognized field(s): acquirer_id');
    expect(result.error).toContain('addAcquisition');
  });

  it('does not silently strip an unrecognized field — same body succeeds once the field is removed', () => {
    const withExtra = validateCallApiBody(domain, 'POST', '/v1/test/events', {
      date: '2026-01-01',
      legal_entity_id: 'x',
      acquirer_id: 'y',
    });
    const withoutExtra = validateCallApiBody(domain, 'POST', '/v1/test/events', {
      date: '2026-01-01',
      legal_entity_id: 'x',
    });
    expect(withExtra.ok).toBe(false);
    expect(withoutExtra.ok).toBe(true);
  });

  it('matches :id path templates for update routes', () => {
    const result = validateCallApiBody(domain, 'PATCH', '/v1/test/events/abc-123', { bogus: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('bogus');
  });

  it('reports required-field errors alongside unrecognized-field errors', () => {
    const result = validateCallApiBody(domain, 'POST', '/v1/test/events', { acquirer_id: 'y' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Unrecognized field(s): acquirer_id');
    expect(result.error).toContain('legal_entity_id');
  });

  it('does not validate against a different domain\'s routes', () => {
    expect(
      validateCallApiBody('some-other-domain', 'POST', '/v1/test/events', { acquirer_id: 'y' }),
    ).toEqual({ ok: true });
  });
});
