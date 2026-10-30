// Slack's `v0` signature is refused when its timestamp is more than five
// minutes from now, as Slack says to: a captured request replayed later fails
// though its signature is right. The Rust door holds the same window
// (crates/lf inbound.rs `slack_timestamp_is_fresh`).

import { createHmac } from 'node:crypto';

import { slackTimestampIsFresh, verifyWithScheme } from '../verify';

const BODY = Buffer.from('{"type":"event_callback"}');

function signedAt(timestamp: number): boolean {
  const signature = createHmac('sha256', 's3cret').update(`v0:${timestamp}:${BODY.toString('utf-8')}`).digest('hex');
  return verifyWithScheme('slack_v0', {
    rawBody: BODY,
    headers: { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': `v0=${signature}` },
    secret: 's3cret',
  });
}

describe('slack_v0', () => {
  it('accepts a fresh request and refuses one more than five minutes from now', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(signedAt(now)).toBe(true);
    expect(signedAt(now - 4 * 60)).toBe(true);
    expect(signedAt(now - 6 * 60)).toBe(false);
    expect(signedAt(now + 6 * 60)).toBe(false);
    expect(signedAt(17)).toBe(false);
  });

  it('counts the window in whole seconds, either way, and refuses a timestamp that is not one', () => {
    expect(slackTimestampIsFresh('1000', 1300)).toBe(true);
    expect(slackTimestampIsFresh('1000', 1301)).toBe(false);
    expect(slackTimestampIsFresh('1300', 1000)).toBe(true);
    expect(slackTimestampIsFresh('soon', 1000)).toBe(false);
    expect(slackTimestampIsFresh('1000.5', 1000)).toBe(false);
  });
});
