// The module over a host context: which bot a credential reaches, where it
// reaches it, what the host's linked identities become, and how an owned file
// names its install. The whole surface's answers are held to the legacy
// adapter by lf-platform's apps/api recorded parity (telegram_parity.unit.test.ts).

import { LANGUAGE_VERSION, checkSourceInRust, type CatalogSnapshot } from 'movement-lang';
import type { Arrival } from 'engine-contracts';
import type { CredentialFields, LinkedIdentity, ModuleCredential } from 'module-kit';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';
import { instanceSchemaFromDescriptors, makeMetaPosition, makeStablePosition, makeUnstablePosition, positionData } from 'movement-engine/public/catalog';

import { telegramModule } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'telegram', fields: async () => fields, update: async () => {} };
}

const ADA: LinkedIdentity = { externalId: '777', email: 'Ada@Example.com ', linkedAt: '2026-06-01T12:00:00.000Z' };

function load(input: { credential: ModuleCredential; baseUrlOverride?: string; credentialRef?: string; identities?: boolean }) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: 777 } } }), { status: 200 });
  };
  const loaded = adapterInProcess(telegramModule, {
    tenant: 'team-1',
    credential: input.credential,
    fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    ...(input.identities === false
      ? {}
      : { identities: { list: async () => [ADA], find: async (id: string) => (id === ADA.externalId ? ADA : null) } }),
    ...(input.baseUrlOverride !== undefined ? { baseUrlOverride: input.baseUrlOverride } : {}),
    ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
    validateResults: true,
  });
  return { adapter: loaded.adapter, manifest: loaded.manifest, calls };
}

/** The arrivals a delivery reports, and the events it does not. */
async function delivered(adapter: ReturnType<typeof load>['adapter'], raw: unknown): Promise<{ events: unknown[]; arrivals: Arrival[] }> {
  const inbound = await adapter.preprocessInbound?.({ raw });
  return { events: inbound?.events ?? [], arrivals: inbound?.arrivals ?? [] };
}

/** The arrival's landing, for one that landed. */
function landing(arrival: Arrival | undefined) {
  if (arrival === undefined || 'gone' in arrival) throw new Error('no arrival landed');
  return arrival;
}

/** The event a run fired by the message `from` sent is handed, as the host
 *  hands it: the arrival its delivery reported. */
async function firedBy(adapter: ReturnType<typeof load>['adapter'], from: { id: number; username?: string }) {
  const raw = { update_id: 1, message: { message_id: 5, date: 1, chat: { id: from.id, type: 'private' }, from, text: 'hey' } };
  const arrival = landing((await delivered(adapter, raw)).arrivals[0]);
  return arrivalTriggerOf({ pipelineInputId: 'tg:answer', adapterType: 'telegram', arrival, now: new Date() });
}

const dm = (adapter: ReturnType<typeof load>['adapter']) =>
  adapter.createRecord({
    mutationContext: { source: {}, occurredAt: '2026-10-17T00:00:00.000Z' },
    recordType: 'Message',
    fields: { Text: 'hi' },
    parentLinks: [{ recordType: 'Linked User', externalId: '777', edgeName: 'Messages', data: {} }],
  } as never);

describe('@lf/telegram', () => {
  it('declares its credential and its inbound, verified by the secret token a team bot is registered with', () => {
    const { manifest } = load({ credential: credential({ botToken: 'T' }) });
    expect(manifest.adapterType).toBe('telegram');
    expect(manifest.credentials?.[0]?.name).toBe('telegram');
    expect(manifest.inbound).toEqual({ providerKey: 'telegram', scheme: 'telegram_secret_token', signatureHeaders: ['x-telegram-bot-api-secret-token'] });
  });

  it('sends with the credential’s bot token at its base URL', async () => {
    const { adapter, calls } = load({ credential: credential({ botToken: 'T1', baseUrl: 'http://bots.test/' }) });
    await expect(dm(adapter)).resolves.toMatchObject({ externalId: '9', data: { chat_id: '777' } });
    expect(calls).toEqual(['http://bots.test/botT1/sendMessage']);
  });

  it('the host’s base URL override wins over the credential’s', async () => {
    const { adapter, calls } = load({ credential: credential({ botToken: 'T1', baseUrl: 'http://bots.test' }), baseUrlOverride: 'http://fake.test/telegram' });
    await dm(adapter);
    expect(calls).toEqual(['http://fake.test/telegram/botT1/sendMessage']);
  });

  it.each([
    ['a blank token', credential({ botToken: '  ' })],
    ['no token', credential({})],
    ['an unreadable credential', noCredential('nothing connected')],
  ])('with %s, reads still answer and a send refuses by name', async (_name, given) => {
    const { adapter, calls } = load({ credential: given });
    await expect(adapter.listEntryPoints()).resolves.toHaveLength(3);
    await expect(dm(adapter)).rejects.toThrow(/no usable Telegram bot token for this install/);
    expect(calls).toEqual([]);
  });

  it('linked users and the actor come from the host’s identities', async () => {
    const { adapter } = load({ credential: credential({ botToken: 'T' }) });
    const users = await adapter.getRelated({ position: makeMetaPosition('telegram'), fieldId: 'Linked Users', direction: 'outgoing' });
    expect(users.map((u) => u.position.identity.data)).toEqual([{ chat_id: '777', email: 'Ada@Example.com ', linked_at: '2026-06-01T12:00:00.000Z' }]);
    const event = await firedBy(adapter, { id: 777, username: 'adas' });
    const actor = await adapter.extractActor?.({ event });
    expect(actor).toMatchObject({ identifier: '777', email: 'ada@example.com', label: '@adas' });
    // The door names the sender on the arrival itself, from the host's identities.
    expect(event.arrival?.actor).toEqual({ identifier: '777', scheme: 'email', adapterType: 'telegram', email: 'ada@example.com', label: '@adas', proven: true });
    await expect(adapter.getActorCandidates?.({ event })).resolves.toEqual([{ identity: actor, source: 'originator' }]);
    const unbound = await firedBy(adapter, { id: 888 });
    expect(unbound.arrival).not.toHaveProperty('actor');
    await expect(adapter.extractActor?.({ event: unbound })).resolves.toBeNull();
  });

  it('a host with no identities refuses the listing and resolves no actor', async () => {
    const { adapter } = load({ credential: credential({ botToken: 'T' }), identities: false });
    await expect(adapter.getRelated({ position: makeMetaPosition('telegram'), fieldId: 'Linked Users', direction: 'outgoing' })).rejects.toThrow(
      /keeps no linked identities/,
    );
    await expect(adapter.extractActor?.({ event: await firedBy(adapter, { id: 777 }) })).resolves.toBeNull();
    const message = makeStablePosition({ adapterType: 'telegram', recordType: 'Message', recordId: '1', data: { sender_id: '777' } });
    await expect(adapter.getRelated({ position: message, fieldId: 'Sender', direction: 'outgoing' })).resolves.toEqual([]);
  });

  it('an attachment’s file names the install the host gave', async () => {
    const attachment = makeUnstablePosition({ adapterType: 'telegram', recordType: 'Attachment', data: { file_id: 'F1', name: 'a.pdf' } });
    const named = load({ credential: credential({ botToken: 'T' }), credentialRef: 'cred-1' });
    await expect(named.adapter.getFieldValue({ position: attachment, fieldId: 'File' })).resolves.toMatchObject({
      source: { adapterType: 'telegram', credentialId: 'cred-1', handle: 'F1' },
    });
    const unnamed = load({ credential: credential({ botToken: 'T' }) });
    await expect(unnamed.adapter.getFieldValue({ position: attachment, fieldId: 'File' })).resolves.toEqual({
      __brand: 'FileRef',
      name: 'a.pdf',
      source: { adapterType: 'telegram', handle: 'F1' },
    });
  });

  it('lists Messages as a listenable root edge landing on the message, pushed to the connection', async () => {
    const { adapter } = load({ credential: credential({}) });
    const entries = await adapter.listEntryPoints();
    expect(entries.find((e) => e.typeId === 'telegram:message')).toEqual({
      typeId: 'telegram:message',
      displayName: 'Message',
      collectionName: 'Messages',
      writable: false,
      readable: false,
      listenable: true,
      delivery: 'connection',
      identity: 'Id',
    });
    const root = await adapter.edgesFrom?.(makeMetaPosition('telegram'));
    expect(root?.descriptor.references.find((r) => r.name === 'Messages')).toMatchObject({ listenable: true, readable: false, targetTypeId: 'telegram:message' });
    expect((await adapter.describe('Message'))?.fields.map((f) => f.displayName)).toContain('Id');
  });

  it('declares no event vocabulary of the 0.12 form, and states protocol 2.6', () => {
    const { manifest } = load({ credential: credential({}) });
    expect(manifest).not.toHaveProperty('subscribableEvents');
    expect(manifest).not.toHaveProperty('defaultSubscribedEvents');
    expect(manifest.methods).not.toContain('listEventTypes');
    expect(telegramModule.protocolMinor).toBe(6);
  });

  it('a delivery reports its message as one arrival on Messages, named by chat and message; anything else none', async () => {
    const { adapter } = load({ credential: credential({}) });
    const raw = { update_id: 1, message: { message_id: 5, date: 1_760_000_000, chat: { id: 7, type: 'private' }, from: { id: 7, username: 'ada' }, text: 'hey' } };
    const { events, arrivals } = await delivered(adapter, raw);
    expect(events).toEqual([]);
    expect(arrivals).toEqual([
      {
        edge: 'Messages',
        identity: '7:5',
        landing: {
          recordId: '5',
          recordType: 'Message',
          fields: expect.objectContaining({
            Id: '7:5',
            'Message Id': '5',
            Text: 'hey',
            'Chat Id': '7',
            'Chat Type': 'private',
            'Sender Id': '7',
            'Sender Username': 'ada',
            Date: '2025-10-09T08:53:20.000Z',
            // What a read finds it under.
            text: 'hey',
            chat_id: '7',
            message_id: '5',
          }),
        },
        occurredAt: '2025-10-09T08:53:20.000Z',
      },
    ]);
    // No key: the root edge names no record it hangs off.
    expect(arrivals[0]).not.toHaveProperty('key');
    for (const raw of [{ callback_query: { id: 'x' } }, { update_id: 2, edited_message: { message_id: 5, chat: { id: 7 } } }, 'nonsense']) {
      await expect(delivered(adapter, raw)).resolves.toEqual({ events: [], arrivals: [] });
    }
  });

  it('numbers within a chat are told apart: the same message id in another chat is another arrival', async () => {
    const { adapter } = load({ credential: credential({}) });
    const delivery = (chat: number) => ({ update_id: chat, message: { message_id: 5, date: 1, chat: { id: chat, type: 'private' }, from: { id: chat }, text: 'x' } });
    const identities = await Promise.all([7, 8, 7].map(async (chat) => landing((await delivered(adapter, delivery(chat))).arrivals[0]).identity));
    expect(identities).toEqual(['7:5', '8:5', '7:5']);
  });

  it('a message that arrived is read by its display names, replied under by its message id, and its sender resolved', async () => {
    const { adapter } = load({ credential: credential({ botToken: 'T' }) });
    const raw = { update_id: 1, message: { message_id: 5, date: 1, chat: { id: 777, type: 'private' }, from: { id: 777, username: 'adas' }, text: 'hey' } };
    const arrived = landing((await delivered(adapter, raw)).arrivals[0]).landing;
    const message = makeStablePosition({ adapterType: 'telegram', recordType: 'Message', recordId: arrived.recordId ?? '', data: arrived.fields });
    await expect(adapter.getFieldValue({ position: message, fieldId: 'Text' })).resolves.toBe('hey');
    await expect(adapter.getFieldValue({ position: message, fieldId: 'Chat Id' })).resolves.toBe('777');
    const sender = await adapter.getRelated({ position: message, fieldId: 'Sender', direction: 'outgoing' });
    expect(sender.map((s) => positionData(s.position))).toEqual([expect.objectContaining({ chat_id: '777' })]);
  });

  it('the checker takes a listen on Messages narrowed by Chat Id, and refuses a field the message lacks', async () => {
    const { adapter } = load({ credential: credential({}) });
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (await Promise.all(entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const))).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const { schema } = instanceSchemaFromDescriptors({ adapterType: 'telegram', entries, descriptors, supportsInPlaceUpdate: true });
    const snapshot: CatalogSnapshot = {
      adapters: { telegram: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], canFire: true, schemas: { team_telegram: schema } } },
      credentials: { team_telegram: { adapters: ['telegram'] } },
      plugins: {},
    };
    const program = (field: string) => `import { telegram } from adapters
import { team_telegram } from credentials

tg = connect telegram using team_telegram

function got(m: <tg-[:Messages]->>) {
  write m-[:Replies]-> { Text: "got it" }
}

listen to tg-[m:Messages WHERE m.\`${field}\` == "42"]-> fire got
`;
    const errors = (source: string) =>
      checkSourceInRust(source, snapshot, { languageVersion: LANGUAGE_VERSION })
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => `${d.code} ${d.message}`);
    expect(errors(program('Chat Id'))).toEqual([]);
    expect(errors(program('Chat')).join('\n')).toMatch(/Chat/);
  });

  it('a 0.12 listen with no settings becomes a listen on Messages, its parameter typed by the edge', () => {
    const { manifest } = load({ credential: credential({}) });
    expect(manifest.listenSettingsBecome).toEqual({ path: ['Messages'], aliases: ['m'], paramFrom: 'Message', keys: {} });
  });
});
