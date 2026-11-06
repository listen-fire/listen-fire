// The module over a host context: which number a credential sends from and
// where it reaches Meta, which media handles are the install's, and how a
// file a write hands it is read. The whole surface's answers are held to the
// legacy adapter by lf-platform's apps/api recorded parity (whatsapp_parity.unit.test.ts).

import { LANGUAGE_VERSION, checkSourceInRust, type CatalogSnapshot } from 'movement-lang';
import type { Arrival } from 'engine-contracts';
import type { CredentialFields, ModuleCredential, ModuleFiles } from 'module-kit';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { fileValue, ownedFileSource } from 'movement-engine/public/adapter';
import { instanceSchemaFromDescriptors, makeMetaPosition, makeStablePosition } from 'movement-engine/public/catalog';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

import { whatsappModule, whatsappModuleWith, type WhatsappHost } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'whatsapp', fields: async () => fields, update: async () => {} };
}

const OWN = { accessToken: 'TOKEN', phoneNumberId: 'PN-1', movementsPhoneNumberId: 'PN-2', twilioAccountSid: 'AC1' };

function load(input: { credential: ModuleCredential; host?: WhatsappHost; baseUrlOverride?: string; files?: ModuleFiles }) {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null });
    if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: 'MEDIA-UP' }), { status: 200 });
    if (String(url).startsWith('https://files.example/')) return new Response('bytes', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 });
  };
  const definition = input.host === undefined ? whatsappModule : whatsappModuleWith(input.host);
  const loaded = adapterInProcess(definition, {
    tenant: 'team-1',
    credential: input.credential,
    fetch,
    log: silent,
    files: input.files ?? refusingFiles('no files'),
    kv: refusingKv('no kv'),
    ...(input.baseUrlOverride !== undefined ? { baseUrlOverride: input.baseUrlOverride } : {}),
    validateResults: true,
  });
  return { adapter: loaded.adapter, manifest: loaded.manifest, calls };
}

const mutationContext = { source: {}, occurredAt: '2026-10-19T00:00:00.000Z' };
const reply = (data: Record<string, unknown>, fields: Record<string, unknown> = { Body: 'hi' }) =>
  ({ mutationContext, recordType: 'Message', fields, parentLinks: [{ recordType: 'Message', externalId: 'wamid.IN', edgeName: 'Replies', data }] }) as never;

describe('@lf/whatsapp', () => {
  it('declares its credential and that it checks its own inbound; the manifest quotes the number its host names', () => {
    const own = load({ credential: credential(OWN) });
    expect(own.manifest.credentials?.[0]?.name).toBe('whatsapp');
    expect(own.manifest.inbound).toEqual({ providerKey: 'whatsapp', scheme: 'module' });
    expect(own.manifest.methods).toContain('checkInbound');
    expect(whatsappModuleWith({ movementsNumber: '+44 7700 900000' }).manifest.description).toContain('(+44 7700 900000)');
  });

  it('says who reaches a listen on either host: anyone messaging a number of the project\'s own, only linked phones on a shared one', () => {
    for (const manifest of [whatsappModule.manifest, whatsappModuleWith({ movementsNumber: '+44 7700 900000' }).manifest]) {
      for (const text of [manifest.description, manifest.triggerExpectation ?? '']) {
        expect(text).not.toMatch(/^WhatsApp on the shared/);
        expect(text).toMatch(/number is the project's own.*every message (sent )?to it/);
        expect(text).toMatch(/shared Listen-Fire number.*linked/);
      }
    }
  });

  it('replies from the number its message arrived on, at Meta, with the credential’s token', async () => {
    const { adapter, calls } = load({ credential: credential(OWN) });
    await adapter.createRecord(reply({ from: '447700900001', businessPhoneNumberId: 'PN-2' }));
    await adapter.createRecord(reply({ from: '447700900001', businessPhoneNumberId: 'PN-9' }));
    await adapter.createRecord(reply({ from: '447700900001' }));
    expect(calls.map((call) => call.url)).toEqual([
      'https://graph.facebook.com/v19.0/PN-2/messages',
      'https://graph.facebook.com/v19.0/PN-1/messages',
      'https://graph.facebook.com/v19.0/PN-1/messages',
    ]);
    expect(calls.every((call) => call.authorization === 'Bearer TOKEN')).toBe(true);
    expect(calls[0]?.body).toMatchObject({ to: '+447700900001', text: { body: 'hi' }, context: { message_id: 'wamid.IN' } });
  });

  it('reaches the dev loop’s fake over the credential’s base URL, and the base URL over the credential’s', async () => {
    const own = load({ credential: credential({ ...OWN, baseUrl: 'http://own.example/graph' }) });
    await own.adapter.createRecord(reply({ from: '1' }));
    const faked = load({ credential: credential({ ...OWN, baseUrl: 'http://own.example/graph' }), baseUrlOverride: 'http://fake.example/graph' });
    await faked.adapter.createRecord(reply({ from: '1' }));
    expect([own.calls[0]?.url, faked.calls[0]?.url]).toEqual(['http://own.example/graph/PN-1/messages', 'http://fake.example/graph/PN-1/messages']);
  });

  it('refuses a send by name when the install has no credential', async () => {
    const { adapter } = load({ credential: noCredential('WhatsApp: no credential is connected') });
    await expect(adapter.createRecord(reply({ from: '1' }))).rejects.toThrow('no credential is connected');
  });

  it('owns the media its host exposed and its Twilio account’s, and fetches only those', async () => {
    const host: WhatsappHost = { exposedFileUrl: (url) => url.startsWith('https://files.example/') };
    const { adapter, calls } = load({ credential: credential(OWN), host });
    const ref = (handle: string) => ({ ref: { __brand: 'FileRef' as const, name: 'x', source: ownedFileSource({ adapterType: 'whatsapp', handle }) } });
    const exposed = await adapter.resolveFileRef!(ref('https://files.example/blob/1'));
    expect('stream' in exposed && exposed.contentType).toBe('text/plain');
    await expect(adapter.resolveFileRef!(ref('https://api.twilio.com/2010-04-01/Accounts/AC2/Media/M'))).rejects.toThrow('not one its owner whatsapp issued');
    const lf = load({ credential: credential({ accessToken: 'T', phoneNumberId: 'P' }) });
    await expect(lf.adapter.resolveFileRef!(ref('https://files.example/blob/1'))).rejects.toThrow('TWILIO_ACCOUNT_SID is not configured');
    expect(calls.map((call) => call.url)).toEqual(['https://files.example/blob/1']);
  });

  it('sends a file a write hands it, read through the host’s files, uploaded then sent by id', async () => {
    const read: unknown[] = [];
    const files: ModuleFiles = {
      ...refusingFiles('no put'),
      read: async (file) => {
        read.push(file.name);
        return new TextEncoder().encode('%PDF');
      },
    };
    const { adapter, calls } = load({ credential: credential(OWN), files });
    const file = fileValue({ __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', source: ownedFileSource({ adapterType: 'gmail', handle: 'h' }) });
    const result = await adapter.createRecord(reply({ from: '447700900001' }, { Body: 'the deck', File: file }));
    expect(read).toEqual(['deck.pdf']);
    expect(calls.map((call) => call.url)).toEqual(['https://graph.facebook.com/v19.0/PN-1/media', 'https://graph.facebook.com/v19.0/PN-1/messages']);
    expect(calls[1]?.body).toMatchObject({ type: 'document', document: { id: 'MEDIA-UP', caption: 'the deck', filename: 'deck.pdf' } });
    expect(result.externalId).toBe('wamid.OUT');
  });

  describe('listens', () => {
    const envelope = (messages: unknown[]) => ({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { display_phone_number: '+447700900000' }, contacts: [{ profile: { name: 'Ada' } }], messages } }] }],
    });
    const TEXT = { from: '447700900001', id: 'wamid.T', timestamp: '1760000000', type: 'text', text: { body: 'hello' } };
    const REACTION = { from: '447700900001', id: 'wamid.R', timestamp: '1760000050', type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '👍' } };
    const LOCATION = { from: '447700900002', id: 'wamid.L', timestamp: '1760000100', type: 'location', location: { latitude: 51.5, longitude: -0.12, name: 'Home' } };

    async function arrived(messages: unknown[]): Promise<Arrival[]> {
      const { adapter } = load({ credential: credential(OWN) });
      const inbound = await adapter.preprocessInbound?.({ raw: envelope(messages) });
      expect(inbound?.events).toEqual([]);
      return inbound?.arrivals ?? [];
    }

    it('lists Messages, Reactions and Locations as listenable root edges, each landing on its own record type, pushed to the connection', async () => {
      const { adapter } = load({ credential: credential(OWN) });
      const entries = await adapter.listEntryPoints();
      const listenable = entries.filter((e) => e.listenable === true);
      expect(listenable).toEqual([
        { typeId: 'whatsapp:message', displayName: 'Message', collectionName: 'Messages', writable: false, readable: false, listenable: true, delivery: 'connection', identity: 'Message Id' },
        { typeId: 'whatsapp:reaction', displayName: 'Reaction', collectionName: 'Reactions', writable: false, readable: false, listenable: true, delivery: 'connection', identity: 'Message Id', attributes: true },
        { typeId: 'whatsapp:location', displayName: 'Location', collectionName: 'Locations', writable: false, readable: false, listenable: true, delivery: 'connection', identity: 'Message Id' },
      ]);
      const root = await adapter.edgesFrom?.(makeMetaPosition('whatsapp'));
      expect(root?.descriptor.references.map((r) => [r.name, r.targetTypeId, r.listenable, r.readable])).toEqual([
        ['Messages', 'whatsapp:message', true, false],
        ['Reactions', 'whatsapp:reaction', true, false],
        ['Locations', 'whatsapp:location', true, false],
      ]);
    });

    it('keeps no 0.12 event vocabulary, and states protocol 2.6', () => {
      expect(whatsappModule.manifest).not.toHaveProperty('subscribableEvents');
      expect(whatsappModule.manifest).not.toHaveProperty('defaultSubscribedEvents');
      expect(whatsappModule.manifest.methods).not.toContain('listEventTypes');
      expect(whatsappModule.protocolMinor).toBe(6);
    });

    it('reports a message on Messages, a reaction on Reactions and a location on Locations, each its own record type', async () => {
      const arrivals = await arrived([TEXT, REACTION, LOCATION]);
      expect(arrivals).toEqual([
        {
          edge: 'Messages',
          identity: 'wamid.T',
          actor: { identifier: '447700900001', scheme: 'phone', adapterType: 'whatsapp', name: 'Ada', label: 'Ada', proven: true },
          landing: { recordId: 'wamid.T', recordType: 'Message', fields: expect.objectContaining({ 'Message Id': 'wamid.T', From: '447700900001', Body: 'hello', 'Profile Name': 'Ada', body: 'hello', from: '447700900001' }) },
          occurredAt: '2025-10-09T08:53:20.000Z',
        },
        {
          edge: 'Reactions',
          identity: 'wamid.R',
          actor: { identifier: '447700900001', scheme: 'phone', adapterType: 'whatsapp', name: 'Ada', label: 'Ada', proven: true },
          landing: { recordId: 'wamid.R', recordType: 'Reaction', fields: expect.objectContaining({ Emoji: '👍', 'Reacted Message Id': 'wamid.T', From: '447700900001' }) },
          about: { recordType: 'Message', externalId: 'wamid.T' },
          occurredAt: '2025-10-09T08:54:10.000Z',
        },
        {
          edge: 'Locations',
          identity: 'wamid.L',
          actor: { identifier: '447700900002', scheme: 'phone', adapterType: 'whatsapp', name: 'Ada', label: 'Ada', proven: true },
          landing: { recordId: 'wamid.L', recordType: 'Location', fields: expect.objectContaining({ Latitude: 51.5, Longitude: -0.12, Name: 'Home', From: '447700900002' }) },
          occurredAt: '2025-10-09T08:55:00.000Z',
        },
      ]);
      // A root edge names no record it hangs off.
      for (const arrival of arrivals) expect(arrival).not.toHaveProperty('key');
    });

    it('a reaction is not a message: it lands on Reactions and carries no Body', async () => {
      const [reaction] = await arrived([REACTION]);
      expect(reaction?.edge).toBe('Reactions');
      expect(reaction && 'landing' in reaction ? reaction.landing.recordType : null).toBe('Reaction');
      expect(reaction && 'landing' in reaction ? reaction.landing.fields : null).not.toHaveProperty('Body');
    });

    it('a kind no edge takes is no arrival, and a time Meta did not state is left out', async () => {
      expect(await arrived([{ from: '1', id: 'wamid.C', type: 'contacts' }])).toEqual([]);
      const [message] = await arrived([{ from: '1', id: 'wamid.N', type: 'text', text: { body: 'x' } }]);
      expect(message).not.toHaveProperty('occurredAt');
    });

    it('the run each arrival fires reads its sender as the actor, by phone, with the profile name', async () => {
      const { adapter } = load({ credential: credential(OWN) });
      const arrivals = await arrived([TEXT, REACTION, LOCATION]);
      const actors = await Promise.all(
        arrivals.map(async (arrival) => {
          if ('gone' in arrival) throw new Error('no arrival');
          // The run's trigger, as the host hands it to a run its listen fired.
          const event = arrivalTriggerOf({ pipelineInputId: 'wa:answer', adapterType: 'whatsapp', arrival, now: new Date() });
          const candidates = await adapter.getActorCandidates?.({ event });
          return { actor: await adapter.extractActor?.({ event }), candidates: candidates?.map((c) => [c.identity.identifier, c.source]) };
        }),
      );
      const from = (phone: string) => ({ actor: { identifier: phone, scheme: 'phone', adapterType: 'whatsapp', name: 'Ada', label: 'Ada', proven: true }, candidates: [[phone, 'originator']] });
      expect(actors).toEqual([from('447700900001'), from('447700900001'), from('447700900002')]);
      // The door names the sender on each arrival itself.
      expect(arrivals.map((arrival) => ('gone' in arrival ? undefined : arrival.actor))).toEqual(actors.map((a) => a.actor));
    });

    it('a message that arrived is read by its display names and replied under', async () => {
      const { adapter, calls } = load({ credential: credential(OWN) });
      const [arrival] = await arrived([TEXT]);
      if (arrival === undefined || 'gone' in arrival) throw new Error('no arrival');
      const message = makeStablePosition({ adapterType: 'whatsapp', recordType: 'Message', recordId: arrival.landing.recordId ?? '', data: arrival.landing.fields });
      await expect(adapter.getFieldValue?.({ position: message, fieldId: 'Body' })).resolves.toBe('hello');
      await expect(adapter.getFieldValue?.({ position: message, fieldId: 'From' })).resolves.toBe('447700900001');
      await adapter.createRecord(reply(arrival.landing.fields));
      expect(calls[0]?.body).toMatchObject({ to: '+447700900001', context: { message_id: 'wamid.IN' } });
    });

    async function snapshot(): Promise<CatalogSnapshot> {
      const { adapter } = load({ credential: credential(OWN) });
      const entries = await adapter.listEntryPoints();
      const descriptors = new Map(
        (await Promise.all(entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const))).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
      );
      const { schema } = instanceSchemaFromDescriptors({ adapterType: 'whatsapp', entries, descriptors, supportsInPlaceUpdate: true });
      return {
        adapters: { whatsapp: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], canFire: true, schemas: { wa_cred: schema } } },
        credentials: { wa_cred: { adapters: ['whatsapp'] } },
        plugins: {},
      };
    }

    const program = (hop: string, landing: string) => `import { whatsapp } from adapters
import { wa_cred } from credentials

wa = connect whatsapp using wa_cred

function got(x: <wa-[:${landing}]->>) {
  return "got it"
}

listen to wa-${hop}-> fire got
`;

    it('the checker takes a listen on each edge narrowed by a field of its record, and refuses a field the record lacks', async () => {
      const catalog = await snapshot();
      const errors = (source: string) =>
        checkSourceInRust(source, catalog, { languageVersion: LANGUAGE_VERSION })
          .filter((d) => (d.severity ?? 'error') === 'error')
          .map((d) => `${d.code} ${d.message}`);
      expect(errors(program('[m:Messages WHERE m.From == "447700900001"]', 'Messages'))).toEqual([]);
      expect(errors(program('[r:Reactions WHERE r.Emoji == "👍"]', 'Reactions'))).toEqual([]);
      expect(errors(program('[l:Locations WHERE l.Name == "Home"]', 'Locations'))).toEqual([]);
      // A reaction has no Body: it is not the message it is on.
      expect(errors(program('[r:Reactions WHERE r.Body == "hello"]', 'Reactions')).join('\n')).toMatch(/Body/);
    });

    it('declares how a 0.12 events listen becomes a listen on the edge its events arrive on', () => {
      const become = whatsappModule.manifest.listenSettingsBecome;
      expect(become).toMatchObject({ path: ['Messages'], aliases: ['m'], paramFrom: 'Message', keys: {} });
      expect(become?.byEvent).toEqual({
        message: { path: ['Messages'], aliases: ['m'], paramFrom: 'Message', keys: {} },
        reaction: { path: ['Reactions'], aliases: ['r'], paramFrom: 'Reaction', keys: {} },
        location: { path: ['Locations'], aliases: ['l'], paramFrom: 'Location', keys: {} },
      });
    });
  });
});
