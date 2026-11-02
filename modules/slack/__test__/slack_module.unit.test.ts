// The module over a host context: where a credential reaches Slack, what a
// host without a model or without a credential gets, how a file value's
// bytes are found and uploaded, and what the module declares about its
// inbound. The whole surface's answers are held to the legacy adapter by
// lf-platform's apps/api recorded parity (slack_parity.unit.test.ts).

import type { AddressInfo } from 'node:net';
import type { CredentialFields, ModuleCredential, ModuleFiles } from 'module-kit';

import { createServer, type Server } from 'node:http';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

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

/** A Slack Web API over HTTP, as the module's client reaches it: the
 *  channels it names (`conversations.info`), the app's bot user
 *  (`auth.test`), and every method called, in order. */
async function slackApi(
  channels: Record<string, string>,
  faults: Map<string, 'down' | 'limited' | 'hangs'> = new Map(),
): Promise<{ baseUrl: string; methods: string[]; close(): Promise<void> }> {
  const methods: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\//, '');
      methods.push(method);
      const fault = faults.get(method);
      if (fault === 'hangs') return;
      if (fault === 'down') return void res.writeHead(500).end('outage');
      if (fault === 'limited') return void res.writeHead(429, { 'retry-after': '30' }).end();
      const form = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json');
      const id = form.get('channel') ?? '';
      const name = channels[id];
      const answer =
        method === 'auth.test' ? { ok: true, user_id: 'UBOT', bot_id: 'B1' }
        : method !== 'conversations.info' ? { ok: true }
        : name === undefined ? { ok: false, error: 'channel_not_found' }
        : { ok: true, channel: { id, name } };
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    methods,
    close: () => new Promise<void>((closed) => (server.closeAllConnections(), server.close(() => closed()))),
  };
}

/** A channel carried with the name Slack could not give: its `Name` unknown, never guessed. */
function unnamedChannel(id: string) {
  return { recordId: id, recordType: 'Channel', fields: { id, name: null, Id: id, Name: null }, unknown: ['Name'] };
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
  it('declares the signed inbound the platform door has always verified, the legacy token it never keeps, and its credential', () => {
    const { manifest } = load({ credential: credential({ accessToken: 'xoxb-1' }) });
    expect(manifest.inbound).toEqual({
      providerKey: 'slack',
      scheme: 'slack_v0',
      signatureHeaders: ['x-slack-signature'],
      intercepts: ['slack_url_verification'],
      redactFields: ['token'],
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

  it('a top-level message is one Messages arrival keyed by its channel, carrying the channel by name', async () => {
    const api = await slackApi({ C1: 'deals' });
    try {
      const { adapter } = load({ credential: credential({ accessToken: 'xoxb-messages', baseUrl: api.baseUrl }) });
      const event = { type: 'message', channel: 'C1', user: 'U1', text: 'hi <@UBOT>', ts: '1700000000.000100' };
      await expect(adapter.preprocessInbound?.({ raw: { type: 'event_callback', event_id: 'Ev9', event } })).resolves.toEqual({
        events: [],
        arrivals: [
          {
            edge: 'Messages',
            key: 'C1',
            identity: 'C1:1700000000.000100',
            landing: {
              recordId: 'C1:1700000000.000100',
              recordType: 'Message',
              fields: {
                ...event,
                Id: 'C1:1700000000.000100',
                Message: 'hi <@UBOT>',
                User: 'U1',
                Channel: 'C1',
                Timestamp: '2023-11-14T22:13:20.000Z',
                timestamp: '2023-11-14T22:13:20.000Z',
                Topic: null,
                'Mentions App': true,
              },
            },
            parents: [{ recordId: 'C1', recordType: 'Channel', fields: { id: 'C1', name: 'deals', Id: 'C1', Name: 'deals' } }],
            occurredAt: '2023-11-14T22:13:20.000Z',
          },
        ],
      });
      // A message that does not name the bot user does not mention the app;
      // Slack's own `app_mention` always does.
      const plain = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: { ...event, text: 'hi' } } });
      expect(plain?.arrivals?.map((a) => ('landing' in a ? a.landing.fields['Mentions App'] : undefined))).toEqual([false]);
      const mention = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: { ...event, type: 'app_mention', text: 'hi' } } });
      expect(mention?.arrivals?.map((a) => ('landing' in a ? a.landing.fields['Mentions App'] : undefined))).toEqual([true]);
      // A channel whose name cannot be read is carried with its Name unknown, never guessed.
      const elsewhere = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: { ...event, channel: 'C9' } } });
      expect(elsewhere?.arrivals?.map((a) => ('parents' in a ? a.parents : undefined))).toEqual([[unnamedChannel('C9')]]);
      // No event, no arrival.
      await expect(adapter.preprocessInbound?.({ raw: { type: 'url_verification', challenge: 'c' } })).resolves.toEqual({ events: [] });
      // The channel and the bot user were read once each, from the client's cache after.
      expect(api.methods.filter((m) => m === 'auth.test')).toHaveLength(1);
      expect(api.methods.every((m) => m !== 'conversations.history')).toBe(true);
    } finally {
      await api.close();
    }
  });

  it('a lookup Slack cannot answer is bounded: the delivery goes on with what is known, its failure kept briefly, misses asked once', async () => {
    const faults = new Map<string, 'down' | 'limited' | 'hangs'>([['conversations.info', 'down']]);
    const api = await slackApi({ C1: 'deals' }, faults);
    const before = { ...process.env };
    // Read when the token's client is made.
    process.env.SLACK_LOOKUP_FAILURE_CACHE_MS = '300';
    process.env.SLACK_LOOKUP_TIMEOUT_MS = '300';
    try {
      const { adapter } = load({ credential: credential({ accessToken: 'xoxb-outage', baseUrl: api.baseUrl }) });
      const event = { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1700000000.000100' };
      const deliver = (message: typeof event = event) => adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: message } });
      const parents = (read: Awaited<ReturnType<typeof deliver>>) => read?.arrivals?.map((a) => ('parents' in a ? a.parents : undefined));

      // Slack's 500 is not retried; two deliveries at once ask once.
      const started = Date.now();
      const [first, second] = await Promise.all([deliver(), deliver()]);
      expect(Date.now() - started).toBeLessThan(1000);
      expect([parents(first), parents(second)]).toEqual([[[unnamedChannel('C1')]], [[unnamedChannel('C1')]]]);
      expect(api.methods.filter((m) => m === 'conversations.info')).toHaveLength(1);
      // Within the failure's short keep, Slack is not asked again.
      expect(parents(await deliver())).toEqual([[unnamedChannel('C1')]]);
      expect(api.methods.filter((m) => m === 'conversations.info')).toHaveLength(1);

      // Recovered, and past the keep: the channel is named.
      faults.clear();
      await new Promise((settle) => setTimeout(settle, 400));
      expect(parents(await deliver())).toEqual([[{ recordId: 'C1', recordType: 'Channel', fields: { id: 'C1', name: 'deals', Id: 'C1', Name: 'deals' } }]]);

      // A rate-limited call fails at once, never waiting out Slack's retry-after.
      faults.set('conversations.info', 'limited');
      const limited = Date.now();
      expect(parents(await deliver({ ...event, channel: 'C2' }))).toEqual([[unnamedChannel('C2')]]);
      expect(Date.now() - limited).toBeLessThan(1000);
      // A call Slack never answers times out.
      faults.set('conversations.info', 'hangs');
      const hung = Date.now();
      expect(parents(await deliver({ ...event, channel: 'C3' }))).toEqual([[unnamedChannel('C3')]]);
      expect(Date.now() - hung).toBeLessThan(1500);
    } finally {
      process.env = before;
      await api.close();
    }

  });

  it('when Slack cannot say who the app\'s bot user is, a message\'s Mentions App is unknown, never false', async () => {
    const api = await slackApi({ C1: 'deals' }, new Map([['auth.test', 'down']]));
    try {
      const { adapter } = load({ credential: credential({ accessToken: 'xoxb-no-bot', baseUrl: api.baseUrl }) });
      const event = { type: 'message', channel: 'C1', user: 'U1', text: 'hi <@UBOT>', ts: '1700000000.000100' };
      const read = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event } });
      const landing = read?.arrivals?.map((a) => ('landing' in a ? a.landing : undefined))[0];
      expect(landing?.fields['Mentions App']).toBeNull();
      expect(landing?.unknown).toEqual(['Mentions App']);
      // Slack's own `app_mention` says so whoever the bot user is.
      const mention = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: { ...event, type: 'app_mention' } } });
      expect(mention?.arrivals?.map((a) => ('landing' in a ? [a.landing.fields['Mentions App'], a.landing.unknown] : undefined))).toEqual([[true, undefined]]);
    } finally {
      await api.close();
    }
  });

  it('a delivery\'s lookups are bounded by the operator\'s settings, each a default where unset or out of range', async () => {
    const { slackLookupSettings } = await import('../api_client');
    expect(slackLookupSettings({})).toEqual({ timeoutMs: 2000, retries: 0, failureCacheMs: 5000 });
    expect(slackLookupSettings({ SLACK_LOOKUP_TIMEOUT_MS: '750', SLACK_LOOKUP_RETRIES: '1', SLACK_LOOKUP_FAILURE_CACHE_MS: '0' })).toEqual({ timeoutMs: 750, retries: 1, failureCacheMs: 0 });
    expect(slackLookupSettings({ SLACK_LOOKUP_TIMEOUT_MS: '0', SLACK_LOOKUP_RETRIES: '-1', SLACK_LOOKUP_FAILURE_CACHE_MS: 'soon' })).toEqual({ timeoutMs: 2000, retries: 0, failureCacheMs: 5000 });
  });

  it('a reaction is one Reactions arrival keyed by its message, about it, carrying only its channel', async () => {
    const api = await slackApi({ C1: 'deals' });
    try {
      const { adapter } = load({ credential: credential({ accessToken: 'xoxb-reactions', baseUrl: api.baseUrl }) });
      const event = { type: 'reaction_added', user: 'U2', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '1700.1' }, item_user: 'U1', event_ts: '1700000000.000200' };
      await expect(adapter.preprocessInbound?.({ raw: { type: 'event_callback', event_id: 'Ev8', event } })).resolves.toEqual({
        events: [],
        arrivals: [
          {
            edge: 'Reactions',
            key: 'C1:1700.1',
            identity: 'C1:1700.1:U2:eyes:1700000000.000200',
            landing: { recordId: 'reaction:C1:1700.1:eyes', recordType: 'Reaction', fields: { ...event, Emoji: 'eyes', Channel: 'C1', Reactor: 'U2' } },
            parents: [{ recordId: 'C1', recordType: 'Channel', fields: { id: 'C1', name: 'deals', Id: 'C1', Name: 'deals' } }],
            about: { recordType: 'Message', externalId: 'C1:1700.1' },
            occurredAt: '2023-11-14T22:13:20.000Z',
          },
        ],
      });
      // A reaction on a file is no message's.
      const onFile = { ...event, item: { type: 'file', file: 'F1' } };
      await expect(adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: onFile } })).resolves.toEqual({ events: [] });
    } finally {
      await api.close();
    }
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
    // Named as the message is when its channel is listed and when it arrives.
    expect(result).toMatchObject({ externalId: 'C1:1700.1', data: { channelId: 'C1', ts: '1700.1' } });
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
    expect(posted).toHaveLength(1);
  });

  it('a Topic is the id of the block the buttons sit in, read back from there; one without Buttons is refused by name', async () => {
    const { slackSourcesFrom } = await import('../index');
    const { moduleContext } = await import('module-kit');
    const { createUnifiedMessage, TOPIC_WITHOUT_BUTTONS, reservedBlockId } = await import('../write');
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

    const buttons = [{ Text: 'In', Value: 'in' }];
    const result = await write({ text: 'Lunch?', topic: 'lunch-poll', buttons });
    expect(posted[0]?.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Lunch?' } },
      { type: 'actions', block_id: 'lf:lunch-poll', elements: [{ type: 'button', text: { type: 'plain_text', text: 'In' }, value: 'in', action_id: 'lf_button_0' }] },
    ]);
    // The message a run wrote reads its Topic as a listed one does, off its blocks.
    const { adapter } = load({ credential: credential({}) });
    const { makeStablePosition } = await import('movement-engine/public/catalog');
    const written = makeStablePosition({ adapterType: 'slack', recordType: 'Message', recordId: result.externalId, data: result.data });
    await expect(adapter.getFieldValue({ position: written, fieldId: 'Topic' })).resolves.toBe('lunch-poll');
    await expect(adapter.getFieldValue({ position: written, fieldId: 'Id' })).resolves.toBe('C1:1700.1');
    const listed = makeStablePosition({ adapterType: 'slack', recordType: 'Message', recordId: 'C1:1700.2', data: { channel: 'C1', ts: '1700.2', text: 'hi' } });
    await expect(adapter.getFieldValue({ position: listed, fieldId: 'Topic' })).resolves.toBeNull();

    await expect(write({ text: 'Lunch?', topic: 'lunch-poll' })).rejects.toThrow(TOPIC_WITHOUT_BUTTONS);
    await expect(write({ text: 'Lunch?', topic: 'x'.repeat(253), buttons })).rejects.toThrow('Topic is 253 characters; Slack holds at most 252');
    // A Topic's block ids are the module's: a message's own Blocks may not use one.
    const own = [{ type: 'actions', block_id: 'lf:mine', elements: [] }];
    await expect(write({ text: 'Lunch?', blocks: own })).rejects.toThrow(reservedBlockId('lf:mine'));
    expect(reservedBlockId('lf:mine')).toContain("block ids starting 'lf:' are reserved for a Topic");
    expect(posted).toHaveLength(1);
  });

  it('the Topic is documented where an author reads it: the handbook section and the field, both naming the block id it is kept on', async () => {
    const { SLACK_HANDBOOK_SECTION } = await import('../handbook_section');
    expect(SLACK_HANDBOOK_SECTION.content).toContain('A \`Topic\` goes only on a message with \`Buttons\`; one without is refused.');
    expect(SLACK_HANDBOOK_SECTION.content).toContain('the \`Topic\` is stored as the id of the block its buttons sit in (\`lf:<topic>\`)');
    expect(SLACK_HANDBOOK_SECTION.content).toContain('A block id starting \`lf:\` is reserved for the \`Topic\`');
    const { adapter } = load({ credential: credential({}) });
    const topic = (await adapter.describe('Message'))?.fields.find((f) => f.displayName === 'Topic');
    expect(topic?.description).toContain('Only a message with Buttons takes one');
    expect(topic?.description).toContain('stored as the id of the block its buttons sit in (`lf:<topic>`)');
    expect(topic?.description).toContain('block ids starting `lf:` are reserved for it');
    // The checker keeps a Topic to the post with buttons.
    const union = (await adapter.describe('Message'))?.writeUnion?.variants.map((v) => [v.name, v.fields.includes('topic')]);
    expect(union).toEqual([['a file post', false], ['an interactive post', false], ['a post with buttons', true]]);
  });

  it('a Buttons entry missing its Text or Value, or past Slack\'s limits, is refused naming it before anything posts', async () => {
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

    await expect(write({ text: 'x', buttons: [{ Text: 'Pursue' }] })).rejects.toThrow('Buttons[0] has no Value: each button needs the value a press answers with.');
    await expect(write({ text: 'x', buttons: [{ Text: 'Pursue', Value: 'pursue' }, { Value: 'pass' }] })).rejects.toThrow('Buttons[1] has no Text: each button needs the label it shows.');
    await expect(write({ text: 'x', buttons: [{ Text: '', Value: 'pass' }] })).rejects.toThrow('Buttons[0] has no Text');
    await expect(write({ text: 'x', buttons: [{ Text: 'Pass', Value: 3 }] })).rejects.toThrow('Buttons[0].Value must be text, got a number.');
    await expect(write({ text: 'x', buttons: ['Pass'] })).rejects.toThrow('Buttons[0] must be { Text, Value }, got the string "Pass".');
    await expect(write({ text: 'x', buttons: [{ Text: 'a'.repeat(76), Value: 'v' }] })).rejects.toThrow('Buttons[0].Text is 76 characters; Slack shows at most 75 on a button.');
    await expect(write({ text: 'x', buttons: [{ Text: 't', Value: 'v'.repeat(2001) }] })).rejects.toThrow('Buttons[0].Value is 2001 characters');
    const many = Array.from({ length: 26 }, (_, i) => ({ Text: `b${i}`, Value: `v${i}` }));
    await expect(write({ text: 'x', buttons: many })).rejects.toThrow('a Slack Message holds at most 25 Buttons; this write has 26.');
    await expect(write({ text: 'x'.repeat(3001), buttons: [{ Text: 't', Value: 'v' }] })).rejects.toThrow(
      "a Slack Message with Buttons has at most 3000 characters of Message text (Slack's limit for the text above the buttons); this one has 3001.",
    );
    expect(posted).toHaveLength(0);
    // At the limits, it posts.
    await write({ text: 'x'.repeat(3000), buttons: Array.from({ length: 25 }, (_, i) => ({ Text: 'a'.repeat(75), Value: `v${i}` })) });
    expect(posted).toHaveLength(1);
  });

  it('a block_actions payload is one Interactions arrival keyed by its message, carrying its channel and the message pressed', async () => {
    const api = await slackApi({ C1: 'office' });
    try {
      const { adapter } = load({ credential: credential({ accessToken: 'xoxb-presses', baseUrl: api.baseUrl }) });
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Lunch?' } }, { type: 'actions', block_id: 'lf:lunch-poll', elements: [] }];
      const message = { type: 'message', ts: '1700000000.000100', text: 'Lunch?', user: 'UBOT', blocks };
      const payload = {
        type: 'block_actions',
        trigger_id: '13345224609.738474920.8088930838d88f008e0',
        user: { id: 'U1', username: 'ada', name: 'ada', team_id: 'T1' },
        api_app_id: 'A1',
        container: { type: 'message', message_ts: '1700000000.000100', channel_id: 'C1', is_ephemeral: false },
        channel: { id: 'C1', name: 'office' },
        message,
        actions: [
          { type: 'button', action_id: 'lf_button_0', block_id: 'lf:lunch-poll', value: 'in', text: { type: 'plain_text', text: 'In' }, action_ts: '1700000060.000900' },
        ],
      };
      const press = {
        id: '13345224609.738474920.8088930838d88f008e0',
        at: '1700000060.000900',
        actions: [{ value: 'in', text: 'In', action_id: 'lf_button_0', block_id: 'lf:lunch-poll', type: 'button' }],
        user: { id: 'U1', username: 'ada', name: 'ada', team_id: 'T1' },
        channel: 'C1',
        message,
      };
      // As the host hands a form-encoded delivery over: its fields.
      await expect(adapter.preprocessInbound?.({ raw: { payload: JSON.stringify(payload) } })).resolves.toEqual({
        events: [],
        arrivals: [
          {
            edge: 'Interactions',
            key: 'C1:1700000000.000100',
            identity: '13345224609.738474920.8088930838d88f008e0',
            landing: { recordType: 'Interaction', fields: { ...press, Id: press.id, At: '2023-11-14T22:14:20.000Z', pressed_at: '2023-11-14T22:14:20.000Z' } },
            parents: [
              { recordId: 'C1', recordType: 'Channel', fields: { id: 'C1', name: 'office', Id: 'C1', Name: 'office' } },
              {
                recordId: 'C1:1700000000.000100',
                recordType: 'Message',
                fields: {
                  ...message,
                  channel: 'C1',
                  Id: 'C1:1700000000.000100',
                  Message: 'Lunch?',
                  User: 'UBOT',
                  Channel: 'C1',
                  Timestamp: '2023-11-14T22:13:20.000Z',
                  timestamp: '2023-11-14T22:13:20.000Z',
                  Topic: 'lunch-poll',
                  'Mentions App': false,
                },
              },
            ],
            about: { recordType: 'Message', externalId: 'C1:1700000000.000100' },
            occurredAt: '2023-11-14T22:14:20.000Z',
          },
        ],
      });
      // An optional member field Slack sends as null is left out, not a reason
      // to drop the press.
      const nulled = { ...payload, user: { id: 'U1', username: null, name: null, team_id: null } };
      const landed = await adapter.preprocessInbound?.({ raw: { payload: JSON.stringify(nulled) } });
      expect(landed?.arrivals?.map((arrival) => ('landing' in arrival ? arrival.landing?.fields.user : undefined))).toEqual([{ id: 'U1' }]);
      // A press Slack sends without its message carries no message, so a
      // filter on it cannot be judged rather than passing.
      const { message: _pressed, ...bare } = payload;
      const unmessaged = await adapter.preprocessInbound?.({ raw: { payload: JSON.stringify(bare) } });
      expect(unmessaged?.arrivals?.map((arrival) => ('parents' in arrival ? arrival.parents?.[1] : undefined))).toEqual([null]);
      // A press outside a message (a modal) names none, and arrives on nothing.
      const { container: _container, channel: _channel, message: _message, ...modal } = payload;
      await expect(adapter.preprocessInbound?.({ raw: { payload: JSON.stringify(modal) } })).resolves.toEqual({ events: [] });
      // Nothing listed the channel's history to find the message.
      expect(api.methods.filter((m) => m !== 'auth.test' && m !== 'conversations.info')).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it('a press walks to the message pressed, as it came with the press, with nothing fetched', async () => {
    const { adapter } = load({ credential: credential({}) });
    const { makeUnstablePosition } = await import('movement-engine/public/catalog');
    const pressed = { ts: '1700000000.000100', text: 'Lunch?', blocks: [{ type: 'actions', block_id: 'lf:lunch-poll' }] };
    const press = makeUnstablePosition({ adapterType: 'slack', recordType: 'Interaction', data: { id: 'trig-1', at: null, actions: [], user: { id: 'U1' }, channel: 'C1', message: pressed } });
    const [message] = await adapter.getRelated({ position: press, fieldId: 'Message', direction: 'outgoing' });
    await expect(adapter.getFieldValue({ position: message!.position, fieldId: 'Topic' })).resolves.toBe('lunch-poll');
    await expect(adapter.getFieldValue({ position: message!.position, fieldId: 'Id' })).resolves.toBe('C1:1700000000.000100');
    await expect(adapter.getFieldValue({ position: message!.position, fieldId: 'Timestamp' })).resolves.toBe('2023-11-14T22:13:20.000Z');
    // A press Slack sent without its message walks to none.
    const bare = makeUnstablePosition({ adapterType: 'slack', recordType: 'Interaction', data: { id: 'trig-2', at: null, actions: [], user: { id: 'U1' }, channel: 'C1' } });
    await expect(adapter.getRelated({ position: bare, fieldId: 'Message', direction: 'outgoing' })).resolves.toEqual([]);
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

  it('a thread reply is a Replies arrival on its root, not one of its channel\'s Messages', async () => {
    const { adapter } = load({ credential: credential({}) });
    const reply = { type: 'message', channel: 'C1', user: 'U2', text: 'yes', ts: '1700.5', thread_ts: '1700.1' };
    const answer = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event_id: 'Ev2', event: reply } });
    expect(answer?.arrivals).toMatchObject([
      { edge: 'Replies', key: 'C1:1700.1', identity: 'C1:1700.5', landing: { recordId: 'C1:1700.5', recordType: 'Message', fields: { ...reply, Message: 'yes' } } },
    ]);
    expect(answer?.events).toEqual([]);
    const root = { type: 'message', channel: 'C1', user: 'U2', text: 'hi', ts: '1700.1' };
    expect((await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: root } }))?.arrivals?.map((a) => a.edge)).toEqual(['Messages']);
  });

  it('the run each arrival fires reads who sent, reacted or pressed as its actor', async () => {
    const { adapter } = load({ credential: credential({}) });
    const message = { type: 'message', channel: 'C1', user: 'U2', text: 'hi', ts: '1700.1' };
    const reaction = { type: 'reaction_added', user: 'U3', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '1700.1' }, item_user: 'U2', event_ts: '1700.2' };
    const press = {
      type: 'block_actions',
      trigger_id: 'trig-1',
      user: { id: 'U4', username: 'ada' },
      container: { type: 'message', message_ts: '1700.1', channel_id: 'C1' },
      actions: [{ type: 'button', action_id: 'lf_button_0', value: 'in', action_ts: '1700.3' }],
    };
    const deliveries = [{ type: 'event_callback', event: message }, { type: 'event_callback', event: reaction }, { payload: JSON.stringify(press) }];
    const actors: unknown[] = [];
    for (const raw of deliveries) {
      const [arrival] = (await adapter.preprocessInbound?.({ raw }))?.arrivals ?? [];
      if (arrival === undefined || 'gone' in arrival) throw new Error('nothing arrived');
      // The run's trigger, as the host hands it to a run its listen fired.
      const event = arrivalTriggerOf({ pipelineInputId: 'chat:answer', adapterType: 'slack', arrival, now: new Date() });
      actors.push([arrival.edge, await adapter.extractActor?.({ event })]);
    }
    const actor = (id: string) => ({ identifier: id, scheme: 'opaque', adapterType: 'slack', label: id });
    expect(actors).toEqual([
      ['Messages', actor('U2')],
      ['Reactions', actor('U3')],
      ['Interactions', actor('U4')],
    ]);
  });

  it('a message that mentions the app arrives as its message would, under the same identity', async () => {
    const { adapter } = load({ credential: credential({}) });
    const reply = { type: 'app_mention', channel: 'C1', user: 'U2', text: '<@UBOT> yes', ts: '1700.5', thread_ts: '1700.1' };
    const answer = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event_id: 'Ev3', event: reply } });
    expect(answer?.arrivals).toMatchObject([
      { edge: 'Replies', key: 'C1:1700.1', identity: 'C1:1700.5', landing: { recordId: 'C1:1700.5', recordType: 'Message', fields: { ...reply, 'Mentions App': true } } },
    ]);
    // Slack sends the same reply again as a `message`: the one identity, so a repeat.
    const asMessage = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event_id: 'Ev4', event: { ...reply, type: 'message' } } });
    expect(asMessage?.arrivals?.map((a) => ('identity' in a ? a.identity : undefined))).toEqual(['C1:1700.5']);
    // A mention outside a thread is one of its channel's Messages, under the same identity either way.
    const { thread_ts: _thread, ...mention } = reply;
    const top = await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: mention } });
    expect(top?.arrivals?.map((a) => [a.edge, 'identity' in a ? a.identity : undefined])).toEqual([['Messages', 'C1:1700.5']]);
  });

  it('a message_deleted event is a gone arrival on Interactions, Replies and Reactions', async () => {
    const { adapter } = load({ credential: credential({}) });
    const deleted = { type: 'message', subtype: 'message_deleted', hidden: true, channel: 'C1', ts: '1700.8', deleted_ts: '1700.1' };
    expect((await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: deleted } }))?.arrivals).toEqual([
      { edge: 'Interactions', key: 'C1:1700.1', gone: true },
      { edge: 'Replies', key: 'C1:1700.1', gone: true },
      { edge: 'Reactions', key: 'C1:1700.1', gone: true },
    ]);
    // An edit is hidden, and arrives on nothing.
    const edited = { type: 'message', subtype: 'message_changed', hidden: true, channel: 'C1', ts: '1700.9' };
    expect((await adapter.preprocessInbound?.({ raw: { type: 'event_callback', event: edited } }))?.arrivals).toBeUndefined();
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
    await expect(adapter.arrivals?.awaitKeys({ edge: 'Reactions', heads })).resolves.toEqual([{ key: 'C1:1700.1' }, { key: 'C2:1700.7' }]);
    // A channel's Messages are keyed by the channel, never by a message's `channel:ts`.
    await expect(adapter.arrivals?.awaitKeys({ edge: 'Messages', heads: [{ recordId: 'C1', headData: { id: 'C1', name: 'deals' } }] })).resolves.toEqual([{ key: 'C1' }]);
    await expect(adapter.arrivals?.awaitKeys({ edge: 'Author', heads })).rejects.toThrow(/'Author' is not a listenable edge/);
  });

  it('declares a channel\'s Messages and a message\'s Reactions and Interactions listenable, each carrying what is above it, and nothing of 0.12\'s settings', async () => {
    const loaded = load({ credential: credential({}) });
    const { adapter, manifest } = loaded;
    const channel = await adapter.describe('Channel');
    expect(channel?.references.find((r) => r.name === 'Messages')).toMatchObject({ listenable: true, delivery: 'connection', carries: ['Channels'], cursor: false });
    // Listed as well as announced: a listen passes through it to a message's edges.
    expect(channel?.references.find((r) => r.name === 'Messages')?.readable).not.toBe(false);
    const message = await adapter.describe('Message');
    expect(message?.references.find((r) => r.name === 'Reactions')).toMatchObject({ readable: false, writable: true, listenable: true, delivery: 'connection', carries: ['Channels'], attributes: true });
    expect(message?.references.find((r) => r.name === 'Interactions')).toMatchObject({ delivery: 'connection', carries: ['Channels', 'Messages'] });
    expect(message?.fields.map((f) => f.displayName)).toEqual(expect.arrayContaining(['Id', 'Timestamp', 'Topic', 'Mentions App']));
    expect(message?.fields.map((f) => f.displayName)).not.toContain('Posted At');
    // Each listenable edge lands on its own record type.
    expect([channel?.references.find((r) => r.name === 'Messages')?.targetTypeId, message?.references.find((r) => r.name === 'Reactions')?.targetTypeId, message?.references.find((r) => r.name === 'Interactions')?.targetTypeId]).toEqual([
      'slack:message',
      'slack:reaction',
      'slack:interaction',
    ]);
    const entries = await adapter.listEntryPoints();
    expect(entries.some((e) => 'fires' in e)).toBe(false);
    expect(manifest).not.toHaveProperty('subscribableEvents');
    expect(manifest).not.toHaveProperty('listenConfig');
    expect(manifest.methods).not.toContain('listEventTypes');
    expect('listEventTypes' in adapter).toBe(false);
    expect(slackModule.protocolMinor).toBe(6);
    expect(manifest.listenSettingsBecome?.byEvent?.app_mention?.keys.events).toEqual({ hop: 1, field: 'Mentions App', op: 'eq', values: { app_mention: true } });
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
      literalsFrom: [{ at: ['Actions', 'Value'], from: 'Buttons[].Value' }],
    });
    const replies = message?.references.find((r) => r.name === 'Replies');
    expect(replies).toMatchObject({ listenable: true, cursor: false, sequenced: 'chronological' });
    // A reply is named by its record id, `channel:ts`, listed or announced.
    expect(replies?.identity).toBeUndefined();
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
