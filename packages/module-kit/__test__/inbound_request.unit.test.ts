// What a module reads of the request its host hands `checkInbound`. Whether
// the host is replaying its own capture is the host's call alone: it is read
// from the call's `replayed`, never from the request a sender controls.

import { WireCheckInboundInput } from 'engine-contracts';

import { inboundRequest } from '../inbound';

const request = (extra: Record<string, unknown> = {}) =>
  WireCheckInboundInput.parse({
    request: {
      method: 'post',
      path: '/hooks/stripe/acme',
      query: 'replayed=true',
      headers: { replayed: 'true', 'X-Replayed': 'true' },
      body: Buffer.from('{"replayed":true}').toString('base64'),
    },
    ...extra,
  });

describe('inboundRequest', () => {
  it('is a replay only when the host says so', () => {
    expect(inboundRequest(request({ replayed: true })).replayed).toBe(true);
    expect(inboundRequest(request({ replayed: false })).replayed).toBe(false);
    expect(inboundRequest(request()).replayed).toBe(false);
  });

  it('is not a replay for anything the sender put in the request', () => {
    const read = inboundRequest(request());
    expect(read.query['replayed']).toBe('true');
    expect(read.header('replayed')).toBe('true');
    expect(read.json()).toEqual({ replayed: true });
    expect(read.replayed).toBe(false);
  });

  it('is not a replay for a field of the call that is not `replayed`', () => {
    expect(inboundRequest(request({ replay: true, request_replayed: true })).replayed).toBe(false);
    expect(WireCheckInboundInput.safeParse({ ...request(), replayed: 'yes' }).success).toBe(false);
  });
});
