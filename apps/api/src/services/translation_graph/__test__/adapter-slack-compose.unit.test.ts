/**
 * Unit tests for SLACK_MESSAGE — the Slack adapter's field function (C7).
 *
 * Verifies the compose step is roster-free and channel-blind: it builds a
 * Slack-formatting system prompt (teaching the `@[Name]` mention convention)
 * plus a user message carrying the author's brief and the bare data, calls the
 * LLM, and returns the text verbatim — `@[Name]` tokens intact, to be resolved
 * at the write boundary (S4). Also checks the function is advertised on the
 * message `text` fields and that `invokeFieldFunction` routes to it.
 *
 * The LLM (`openAiChat`) is mocked — no network.
 */

const mockChatCalls: unknown[] = [];
jest.mock('../../../lib/openai', () => ({
  openAiChat: (messages: unknown) => {
    mockChatCalls.push(messages);
    return Promise.resolve('*Thanks @[Ada Okafor] for leading the Acme round!* 🎉');
  },
}));

import { SlackAdapter, SLACK_MESSAGE_TYPE_ID } from '../adapters/slack';
import { composeSlackMessage } from '../adapters/slack/compose';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = 'team-1' as TeamId;
const COMPOSED = '*Thanks @[Ada Okafor] for leading the Acme round!* 🎉';

beforeEach(() => {
  mockChatCalls.length = 0;
});

describe('SLACK_MESSAGE — advertisement', () => {
  it('is advertised on the unified message `Message` (text) field', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    const text = desc?.fields.find((f) => f.fieldId === 'text');
    expect(text?.functions?.map((fn) => fn.name)).toContain('SLACK_MESSAGE');
  });

  it('is NOT advertised on the read-only Channel field or the File field', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    expect(desc?.fields.find((f) => f.fieldId === 'channel')?.functions).toBeUndefined();
    expect(desc?.fields.find((f) => f.fieldId === 'file')?.functions).toBeUndefined();
  });
});

describe('composeSlackMessage', () => {
  it('builds a Slack system prompt + a user message carrying the brief and data', async () => {
    const out = await composeSlackMessage({
      instructions: 'thank them for leading the round',
      data: ['Ada Okafor', 'Acme Series A'],
    });
    expect(out).toBe(COMPOSED);

    const messages = mockChatCalls[0] as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/@\[Name\]/); // mention convention taught
    expect(messages[0].content).toMatch(/\*bold\*/); // mrkdwn rules present
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('thank them for leading the round');
    expect(messages[1].content).toContain('Ada Okafor');
    expect(messages[1].content).toContain('Acme Series A');
  });

  it('drops null/undefined/empty data values from the user message', async () => {
    await composeSlackMessage({ instructions: 'hi', data: [null, undefined, '', 'Keep'] });
    const messages = mockChatCalls[0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain('Keep');
    expect(messages[1].content).not.toMatch(/-\s*$/m); // no empty bullet line
  });

  it('renders array data as a joined value', async () => {
    await composeSlackMessage({ instructions: 'hi', data: [['a', 'b', 'c']] });
    const messages = mockChatCalls[0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain('a, b, c');
  });
});

describe('SlackAdapter.invokeFieldFunction', () => {
  it('routes SLACK_MESSAGE to the composer', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const composed = await adapter.invokeFieldFunction({
      recordType: SLACK_MESSAGE_TYPE_ID,
      fieldId: 'text',
      functionName: 'SLACK_MESSAGE',
      args: { instructions: 'thank them', data: [] },
    });
    expect(composed).toBe(COMPOSED);
  });

  it('rejects an unknown function name', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    await expect(
      adapter.invokeFieldFunction({
        recordType: SLACK_MESSAGE_TYPE_ID,
        fieldId: 'text',
        functionName: 'NOPE',
        args: { instructions: '', data: [] },
      }),
    ).rejects.toThrow(/unknown function "NOPE"/);
  });
});
