// A delivery's body as the door hands it to its module: JSON, or the fields
// of a form-encoded one (Slack posts a press as `payload=<json>`). The Rust
// door reads it the same way (crates/lf inbound.rs `delivery_body`).

import { deliveryBody } from '../deliver';

describe('a delivery body', () => {
  it('is JSON unless it says it is a form', () => {
    expect(deliveryBody(Buffer.from('{"type":"event_callback"}'), { 'content-type': 'application/json' })).toEqual({ type: 'event_callback' });
    expect(deliveryBody(Buffer.from('{"a":1}'), {})).toEqual({ a: 1 });
    expect(() => deliveryBody(Buffer.from('payload=x'), {})).toThrow();
  });

  it('is a form’s fields when form-encoded, a repeated field the list of its values', () => {
    const body = Buffer.from('payload=%7B%22type%22%3A%22block_actions%22%7D&tag=a&tag=b+c');
    expect(deliveryBody(body, { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' })).toEqual({
      payload: '{"type":"block_actions"}',
      tag: ['a', 'b c'],
    });
  });
});
