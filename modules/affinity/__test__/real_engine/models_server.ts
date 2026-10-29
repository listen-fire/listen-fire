// A models module for measuring a deal sync through `listen-fire`: the Affinity
// matcher's model calls answered the way the unit fixture's `plainModels`
// answers them — affixes come off nothing, a split is the last token, and
// every judge declines — so a match is always a rule's.

import { serveSlot } from 'movement-engine/public/module-wire';

void serveSlot({
  manifest: { protocolVersion: 2, name: 'plain_models', kind: 'core', slot: 'models', methods: ['models.call'] },
  print: true,
  answer: async (method, params) => {
    if (method !== 'models.call') throw new Error(`no method "${method}"`);
    const call = params as { label: string; userMessage: string; schema?: unknown };
    const usage = { usage: { inputTokens: 1, outputTokens: 1 }, cost: [{ label: 'plain_models', microdollars: 1 }] };
    // listen-fire asks for structured data in words and reads the reply's text as JSON.
    if (call.schema !== undefined || call.label === 'affinity.findMatchingPerson') {
      return { text: '{"id":null}', data: { id: null }, ...usage };
    }
    if (call.label === 'affinity.stripNameAffixes') return { text: JSON.stringify({ name: call.userMessage }), ...usage };
    if (call.label === 'affinity.splitName') {
      const tokens = call.userMessage.trim().split(/\s+/);
      return { text: JSON.stringify({ first_name: tokens.slice(0, -1).join(' '), last_name: tokens[tokens.length - 1] }), ...usage };
    }
    return { text: 'null', ...usage };
  },
});
