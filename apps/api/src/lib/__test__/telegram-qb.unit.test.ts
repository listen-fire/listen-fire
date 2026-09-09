/**
 * Smoke coverage for the Telegram identity tables' schema wall. They used to
 * live in a dedicated `adapters` schema; the carve folded them into
 * `automations` (M-26), and this proves the queries still name a schema
 * explicitly rather than falling back to `public`.
 *
 */

import { getAutomationsQb } from '../kysely';

describe('getAutomationsQb — telegram identity tables', () => {
  it('compiles a query against the automations schema for telegram_identity', () => {
    const compiled = getAutomationsQb(['telegram_identity'])
      .selectFrom('telegram_identity')
      .select(['id', 'team_id', 'telegram_user_id', 'email', 'linked_at'])
      .where('telegram_user_id', '=', '12345')
      .compile();

    expect(compiled.sql).toContain('"automations"."telegram_identity"');
  });

  it('compiles a query against the automations schema for telegram_token', () => {
    const compiled = getAutomationsQb(['telegram_token'])
      .selectFrom('telegram_token')
      .select(['id', 'token', 'native_user_id', 'team_id', 'expires_at', 'used_at', 'created_at'])
      .where('token', '=', 'abc')
      .compile();

    expect(compiled.sql).toContain('"automations"."telegram_token"');
  });
});
