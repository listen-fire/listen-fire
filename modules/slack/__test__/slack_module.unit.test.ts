// The module over a host context: where a credential reaches Slack, what a
// host without a model or without a credential gets, how a file value's
// bytes are found and uploaded, and what the module declares about its
// inbound. The whole surface's answers are held to the legacy adapter by
// lf-platform's apps/api recorded parity (slack_parity.unit.test.ts).

import type { CredentialFields, ModuleCredential, ModuleFiles } from 'module-kit';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { makeMetaPosition } from 'movement-engine/public/catalog';

import { slackModule, slackModuleWith, type SlackHosted } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'slack', fields: async () => fields, update: async () => {} };
}

interface Call {
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

/** A Slack Web API that answers every method well, and the upload URL and a
 *  file URL; every request kept. */
function fakeSlack(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined || init.body === null ? '' : Buffer.from(init.body as Uint8Array).toString('utf8');
    calls.push({ url, authorization: headers.get('authorization'), contentType: headers.get('content-type'), body });
    if (url.startsWith('https://files.example/')) return new Response('remote bytes', { status: 200, headers: { 'content-type': 'text/csv' } });
    if (url.endsWith('/files.getUploadURLExternal')) {
      return Response.json({ ok: true, upload_url: 'https://upload.example/F9', file_id: 'F9' });
    }
    if (url.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: 'C1', is_member: true } });
    return Response.json({ ok: true, ts: '1.2', channels: [], members: [] });
  };
  return { fetch, calls };
}

function load(input: { credential: ModuleCredential; hosted?: SlackHosted; files?: ModuleFiles; fetch?: typeof fetch }) {
  const definition = input.hosted === undefined ? slackModule : slackModuleWith(input.hosted);
  return adapterInProcess(definition, {
    tenant: 'team-1',
    credential: input.credential,
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    log: silent,
    files: input.files ?? refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  });
}

describe('@lf/slack', () => {
  it('declares the signed inbound the platform door has always verified, and its credential', () => {
    const { manifest } = load({ credential: credential({ accessToken: 'xoxb-1' }) });
    expect(manifest.inbound).toEqual({
      providerKey: 'slack',
      scheme: 'slack_v0',
      signatureHeaders: ['x-slack-signature'],
      intercepts: ['slack_url_verification'],
    });
    expect(manifest.credentials?.[0]).toMatchObject({ name: 'slack', kind: 'static' });
  });

  it('with no credential, a root read refuses by name and makes no request', async () => {
    const { adapter } = load({ credential: noCredential('nothing connected') });
    await expect(adapter.getRelated({ position: makeMetaPosition('slack'), fieldId: 'Channels', direction: 'outgoing' })).rejects.toThrow(
      /no usable Slack credential for team team-1 \(credentialsId=unset\)\. Connect Slack\./,
    );
  });

  it('the composition function refuses without a host model, and writes with one', async () => {
    const invoke = (adapter: ReturnType<typeof load>['adapter']) =>
      adapter.invokeFieldFunction?.({ recordType: 'Message', fieldId: 'Message', functionName: 'SLACK_MESSAGE', args: { instructions: 'say hi', data: ['x'] } } as never);
    await expect(invoke(load({ credential: credential({ accessToken: 'xoxb-1' }) }).adapter)).rejects.toThrow(/needs a model/);
    const asked: string[] = [];
    const hosted = load({
      credential: credential({ accessToken: 'xoxb-1' }),
      hosted: { chat: async (input) => (asked.push(input.userMessage), '  *hi*  ') },
    });
    await expect(invoke(hosted.adapter)).resolves.toBe('*hi*');
    expect(asked).toEqual(['say hi\n\nData you can use:\n- x']);
  });

  it('a file value with a URL is fetched with the host’s fetch and uploaded with the bot token', async () => {
    const slack = fakeSlack();
    const { slackSourcesFrom } = await import('../index');
    const { moduleContext } = await import('module-kit');
    const { createUnifiedMessage } = await import('../write');
    const ctx = moduleContext({ tenant: 't', credential: credential({}), fetch: slack.fetch, log: silent, files: refusingFiles('x'), kv: refusingKv('x'), validateResults: false });
    // A stub Web API client: the module's own client posts through
    // @slack/web-api's HTTP stack; only file bytes go through the host's fetch.
    const client = {
      api: {
        token: 'xoxb-1',
        conversations: { info: async () => ({ ok: true, channel: { is_member: true } }) },
        files: {
          getUploadURLExternal: async () => ({ ok: true, upload_url: 'https://upload.example/F9', file_id: 'F9' }),
          completeUploadExternal: async () => ({ ok: true }),
        },
      },
    } as never;
    const result = await createUnifiedMessage({
      client,
      host: slackSourcesFrom(ctx),
      anchor: { kind: 'post', channelId: 'C1' },
      fields: { file: { __brand: 'FileRef', name: 'a.csv', url: 'https://files.example/a.csv' } },
    });
    expect(result.externalId).toBe('F9');
    expect(slack.calls.map((c) => [c.url, c.authorization, c.contentType, c.body])).toEqual([
      ['https://files.example/a.csv', null, null, ''],
      ['https://upload.example/F9', 'Bearer xoxb-1', 'text/csv', 'remote bytes'],
    ]);
  });

  it('without a URL, a file value’s bytes come from the host’s files', async () => {
    const read = jest.fn(async () => new TextEncoder().encode('stored bytes'));
    const files: ModuleFiles = { put: async () => ({ __brand: 'FileRef' }), expose: async () => Promise.reject(new Error('no')), read };
    const { slackSourcesFrom } = await import('../index');
    const { moduleContext } = await import('module-kit');
    const ctx = moduleContext({ tenant: 't', credential: credential({}), log: silent, files, kv: refusingKv('x'), validateResults: false });
    const sources = slackSourcesFrom(ctx);
    const ref = { __brand: 'FileRef' as const, name: 'n', source: { adapterType: 'gmail', handle: 'h' } };
    await expect(sources.readFile(ref)).resolves.toEqual({ body: Buffer.from('stored bytes') });
    expect(read).toHaveBeenCalledWith(ref);
  });

  it('a delivery fires its event with Slack’s idempotency key; a message is a create', async () => {
    const { adapter } = load({ credential: credential({}) });
    const raw = { type: 'event_callback', event_id: 'Ev9', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '9.1' } };
    await expect(adapter.preprocessInbound?.({ raw })).resolves.toEqual({
      events: [
        {
          payload: raw.event,
          externalId: '9.1',
          recordType: 'slack:message',
          eventType: 'message',
          idempotencyKey: 'Ev9',
          changeType: 'create',
        },
      ],
    });
    await expect(adapter.preprocessInbound?.({ raw: { type: 'url_verification', challenge: 'c' } })).resolves.toEqual({ events: [] });
  });

  it('Buttons post as an actions block whose values are the written Values', async () => {
    const { slackSourcesFrom } = await import('../index');
    const { moduleContext } = await import('module-kit');
    const { createUnifiedMessage } = await import('../write');
    const ctx = moduleContext({ tenant: 't', credential: credential({}), log: silent, files: refusingFiles('x'), kv: refusingKv('x'), validateResults: false });
    const posted: Array<Record<string, unknown>> = [];
    const client = {
      api: {
        conversations: { info: async () => ({ ok: true, channel: { is_member: true } }), members: async () => ({ ok: true, members: [] }) },
        users: { list: async () => ({ ok: true, members: [] }) },
        chat: { postMessage: async (args: Record<string, unknown>) => (posted.push(args), { ok: true, ts: '1700.1' }) },
      },
    } as never;
    const write = (fields: Record<string, unknown>) =>
      createUnifiedMessage({ client, host: slackSourcesFrom(ctx), anchor: { kind: 'post', channelId: 'C1' }, fields });

    const result = await write({ text: 'Pursue?', buttons: [{ Text: 'Pursue', Value: 'pursue' }, { Text: 'Pass', Value: 'pass' }] });
    expect(result).toMatchObject({ externalId: '1700.1', data: { channelId: 'C1', ts: '1700.1' } });
    expect(posted[0]).toMatchObject({ channel: 'C1', text: 'Pursue?' });
    expect(posted[0]?.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Pursue?' } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Pursue' }, value: 'pursue', action_id: 'lf_button_0' },
          { type: 'button', text: { type: 'plain_text', text: 'Pass' }, value: 'pass', action_id: 'lf_button_1' },
        ],
      },
    ]);

    const buttons = [{ Text: 'Pursue', Value: 'pursue' }];
    await expect(write({ text: 'x', buttons, blocks: [{ type: 'divider' }] })).rejects.toThrow("a Slack Message's Buttons can't be combined with Blocks or File");
    await expect(write({ text: 'x', buttons, file: { __brand: 'FileRef', name: 'a', content: 'b' } })).rejects.toThrow("a Slack Message's Buttons can't be combined with Blocks or File");
    await expect(write({ buttons })).rejects.toThrow(/Buttons needs its Message text/);
    await expect(write({ text: 'x', buttons: [{ Text: 'Pursue' }] })).rejects.toThrow(/Buttons\[0\] must be \{ Text, Value \}/);
    expect(posted).toHaveLength(1);
  });

  it('a block_actions payload is one Interactions arrival keyed by its message', async () => {
    const { adapter } = load({ credential: credential({}) });
    const payload = {
      type: 'block_actions',
      trigger_id: '13345224609.738474920.8088930838d88f008e0',
      user: { id: 'U1', username: 'ada', name: 'ada', team_id: 'T1' },
      api_app_id: 'A1',
      container: { type: 'message', message_ts: '1700.1', channel_id: 'C1', is_ephemeral: false },
      channel: { id: 'C1', name: 'general' },
      message: { type: 'message', ts: '1700.1', text: 'Pursue?' },
      actions: [
        { type: 'button', action_id: 'lf_button_0', block_id: 'b1', value: 'pursue', text: { type: 'plain_text', text: 'Pursue' }, action_ts: '1700.9' },
      ],
    };
    // As the host hands a form-encoded delivery over: its fields.
    await expect(adapter.preprocessInbound?.({ raw: { payload: JSON.stringify(payload) } })).resolves.toEqual({
      events: [],
      arrivals: [
        {
          edge: 'Interactions',
          key: 'C1:1700.1',
          identity: '13345224609.738474920.8088930838d88f008e0',
          landing: {
            recordType: 'Interaction',
            fields: {
              id: '13345224609.738474920.8088930838d88f008e0',
              at: '1700.9',
              actions: [{ value: 'pursue', text: 'Pursue', action_id: 'lf_button_0', block_id: 'b1', type: 'button' }],
              user: { id: 'U1', username: 'ada', name: 'ada', team_id: 'T1' },
            },
          },
        },
      ],
    });
    // A press outside a message (a modal) names none, and arrives on nothing.
    const { container: _container, channel: _channel, message: _message, ...modal } = payload;
    await expect(adapter.preprocessInbound?.({ raw: { payload: JSON.stringify(modal) } })).resolves.toEqual({ events: [] });
  });

  it('an Interaction reads its Id and At, and walks to its Actions and the member who pressed', async () => {
    const { adapter } = load({ credential: credential({}) });
    const { makeUnstablePosition } = await import('movement-engine/public/catalog');
    const press = makeUnstablePosition({
      adapterType: 'slack',
      recordType: 'Interaction',
      data: { id: 'trig-1', at: '1700000000.000100', actions: [{ value: 'pursue', text: 'Pursue' }], user: { id: 'U1' } },
    });
    await expect(adapter.getFieldValue({ position: press, fieldId: 'Id' })).resolves.toBe('trig-1');
    await expect(adapter.getFieldValue({ position: press, fieldId: 'At' })).resolves.toBe('2023-11-14T22:13:20.000Z');
    const actions = await adapter.getRelated({ position: press, fieldId: 'Actions', direction: 'outgoing' });
    expect(actions).toHaveLength(1);
    await expect(adapter.getFieldValue({ position: actions[0]!.position, fieldId: 'Value' })).resolves.toBe('pursue');
    await expect(adapter.getFieldValue({ position: actions[0]!.position, fieldId: 'Text' })).resolves.toBe('Pursue');
  });

  it('a thread reply is a Replies arrival on its root; a root message is none', async () => {
    const { adapter } = load({ credential: credential({}) });
    const reply = { type: 'message', channel: 'C1', user: 'U2', text: 'yes', ts: '1700.5', thread_ts: '1700.1' };
    const answer = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event_id: 'Ev2', event: reply } });
    expect(answer?.arrivals).toEqual([
      { edge: 'Replies', key: 'C1:1700.1', identity: 'C1:1700.5', landing: { recordId: 'C1:1700.5', recordType: 'Message', fields: reply } },
    ]);
    expect(answer?.events).toHaveLength(1);
    const root = { type: 'message', channel: 'C1', user: 'U2', text: 'hi', ts: '1700.1' };
    expect((await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: root } }))?.arrivals).toBeUndefined();
  });

  it('a message_deleted event is a gone arrival on Interactions and Replies', async () => {
    const { adapter } = load({ credential: credential({}) });
    const deleted = { type: 'message', subtype: 'message_deleted', hidden: true, channel: 'C1', ts: '1700.8', deleted_ts: '1700.1' };
    expect((await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: deleted } }))?.arrivals).toEqual([
      { edge: 'Interactions', key: 'C1:1700.1', gone: true },
      { edge: 'Replies', key: 'C1:1700.1', gone: true },
    ]);
  });

  it('awaitKeys names a message by its own ts for Interactions and by its thread root for Replies', async () => {
    const { adapter } = load({ credential: credential({}) });
    const heads = [
      // A message this run wrote: its bare ts, its channel in the write's data.
      { recordId: '1700.1', headData: { channelId: 'C1', ts: '1700.1' } },
      // A reply read off a thread: `channel:ts`, its root in `thread_ts`.
      { recordId: 'C2:1700.7', headData: { channel: 'C2', ts: '1700.7', thread_ts: '1700.2' } },
    ];
    await expect(adapter.arrivals?.awaitKeys({ edge: 'Interactions', heads })).resolves.toEqual([{ key: 'C1:1700.1' }, { key: 'C2:1700.7' }]);
    await expect(adapter.arrivals?.awaitKeys({ edge: 'Replies', heads })).resolves.toEqual([{ key: 'C1:1700.1' }, { key: 'C2:1700.2' }]);
    await expect(adapter.arrivals?.awaitKeys({ edge: 'Author', heads })).rejects.toThrow(/'Author' is not a listenable edge/);
  });

  it('declares Interactions listenable and typed by the Buttons written, which its describe holds', async () => {
    const { adapter } = load({ credential: credential({}) });
    const { unreadableLiteralsFrom } = await import('movement-engine/public/catalog');
    const message = await adapter.describe('Message');
    const interactions = message?.references.find((r) => r.name === 'Interactions');
    expect(interactions).toMatchObject({
      readable: false,
      listenable: true,
      cursor: false,
      identity: 'Id',
      resolvesEmpty: true,
      literalsFrom: [{ at: ['Actions', 'Value'], from: 'Buttons[].Value' }],
    });
    expect(message?.references.find((r) => r.name === 'Replies')).toMatchObject({ listenable: true, cursor: false, identity: 'Timestamp', resolvesEmpty: true, sequenced: 'chronological' });
    const descriptors = new Map();
    for (const name of ['Interaction', 'Action']) {
      const described = await adapter.describe(name);
      descriptors.set(described!.typeId, described);
    }
    expect(unreadableLiteralsFrom(interactions!, descriptors)).toBeUndefined();
    expect(adapter.arrivals).toBeDefined();
    expect('awaitable' in adapter && adapter.awaitable !== undefined).toBe(false);
  });
});
