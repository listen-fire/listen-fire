// The conformance suites of the slots with no family contract of their own
// (models, judge, files, wake, ocr), the movements slot's, and the secrets slot's own cases beside
// the family's (`services/secrets/contract.ts`), and the cases every slot module answers alike (its
// manifest, the envelope's refusals). Each runs against any server over the
// wire: written once here, they hold lf's built-ins (`lf --contract-<slot>`)
// and a third-party module in any language to the same meaning. The store,
// limiter and loop guard are held to their families' contract cases
// (`services/run_host/contract.ts`, `limiter/contract.ts`,
// `loop_guard/contract.ts`) driven over this same wire; the browser to
// `services/browser/contract.ts` through its wire client.

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

import { PROTOCOL_VERSION, type WireCoreSlotShape as CoreSlot } from 'engine-contracts';
import {
  FilesOpenAnswer,
  JudgeArbitrateAnswer,
  MODELS_PRICES_METHOD,
  ModelsCallAnswer,
  ModelsPricesAnswer,
  MovementsListAnswer,
  MovementsReadAnswer,
  MovementsWriteAnswer,
  MovementsWatchAnswer,
  WATCH_WAIT_CAP_MS,
  type MovementsChangeShape,
  OCR_PRICES_METHOD,
  OCR_UNSUPPORTED_TYPE_CODE,
  OcrPricesAnswer,
  OcrReadAnswer,
  SecretsEntryAnswer,
  SecretsListed,
  SecretsLockAnswer,
  SecretsRecord,
  StoredFile,
  WireSlotManifest,
  isFreePrice,
  type ModelPriceShape,
} from 'engine-contracts/slots';

import { pngOf, scannedPdfOf, textImage } from './scanned';
import { z } from 'zod';

import { SlotClient, SlotRefused, postTo } from './wire';

export interface SlotConformanceCase {
  name: string;
  run(client: SlotClient): Promise<void>;
}

async function refusedWith(code: string, call: Promise<unknown>): Promise<SlotRefused> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SlotRefused) {
      assert.equal(error.code, code, `expected the code ${code}, got ${error.code}: ${error.message}`);
      return error;
    }
    throw error;
  }
  assert.fail(`expected a refusal with the code ${code}, got an answer`);
}

/** Every slot module: its manifest names its slot and lists its methods, and
 *  the envelope's refusals read as the protocol's. */
export function commonSlotCases(slot: CoreSlot, methods: readonly string[]): SlotConformanceCase[] {
  return [
    {
      name: `${slot}: the manifest names the slot and lists its methods`,
      async run(client) {
        const manifest = await client.read('manifest', {}, WireSlotManifest);
        assert.equal(manifest.slot, slot);
        for (const method of methods) assert.ok(manifest.methods.includes(method), `the manifest lists ${method}`);
      },
    },
    {
      name: `${slot}: an unknown method is refused as method_not_implemented`,
      async run(client) {
        await refusedWith('method_not_implemented', client.call(`${slot}.noSuchMethod`, {}));
      },
    },
    {
      name: `${slot}: another protocol version is refused as protocol_version`,
      async run(client) {
        const answer = await postTo(client.address, JSON.stringify({ protocolVersion: '1', method: 'manifest', params: {} }));
        assert.equal(answer.status, 200);
        const body: unknown = JSON.parse(answer.body);
        assert.deepEqual(Reflect.get(Object(Reflect.get(Object(body), 'error')), 'code'), 'protocol_version');
        assert.notEqual(PROTOCOL_VERSION, '1');
      },
    },
    {
      name: `${slot}: a request without the module's token is answered 401`,
      async run(client) {
        if (client.address.token === undefined) return;
        const { token: _token, ...anonymous } = client.address;
        const answer = await postTo(anonymous, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method: 'manifest', params: {} }));
        assert.equal(answer.status, 401);
      },
    },
  ];
}

/** The module's published price for `model`, when it publishes prices. */
async function publishedPrice(client: SlotClient, model: string): Promise<ModelPriceShape | undefined> {
  const manifest = await client.read('manifest', {}, WireSlotManifest);
  if (!manifest.methods.includes(MODELS_PRICES_METHOD)) return undefined;
  const { prices } = await client.read(MODELS_PRICES_METHOD, {}, ModelsPricesAnswer);
  return prices[model];
}

/** The models slot. `client` carries settings that reach a model. */
export const modelsSlotCases: SlotConformanceCase[] = [
  {
    name: 'models: a call that spent tokens reports what it cost, unless the model is published as free',
    async run(client) {
      const answer = await client.read('models.call', { label: 'conformance.priced', system: 'Answer briefly.', userMessage: 'Say hello.', model: 'sonnet' }, ModelsCallAnswer);
      const spent = answer.usage.inputTokens + answer.usage.outputTokens;
      const price = await publishedPrice(client, 'sonnet');
      if (spent === 0 || (price !== undefined && isFreePrice(price))) return;
      const total = answer.cost.reduce((sum, line) => sum + line.microdollars, 0);
      assert.ok(total > 0, `the call spent ${spent} tokens and reported a cost of ${total} microdollars`);
    },
  },
  {
    name: 'models: models.prices, when listed, prices the names a call writes in dollars per million tokens',
    async run(client) {
      const manifest = await client.read('manifest', {}, WireSlotManifest);
      if (!manifest.methods.includes(MODELS_PRICES_METHOD)) return;
      const { prices } = await client.read(MODELS_PRICES_METHOD, {}, ModelsPricesAnswer);
      assert.ok(prices.sonnet !== undefined, 'the table prices `sonnet`, a name every host writes');
    },
  },
  {
    name: 'models: one call, one answer: its text, what it cost and the tokens it spent',
    async run(client) {
      const answer = await client.read('models.call', { label: 'conformance.text', system: 'Answer briefly.', userMessage: 'Say hello.', model: 'sonnet' }, ModelsCallAnswer);
      assert.ok(answer.text.length > 0, 'the answer has text');
      for (const line of answer.cost) assert.ok(line.microdollars >= 0 && line.label.length > 0);
      assert.ok(answer.usage.inputTokens > 0 && answer.usage.outputTokens > 0, 'the answer reports the tokens it spent');
    },
  },
  {
    name: 'models: maxTokens is the answer\'s output ceiling',
    async run(client) {
      const answer = await client.read(
        'models.call',
        { label: 'conformance.ceiling', system: 'Answer at length.', userMessage: 'Tell a long story.', model: 'sonnet', maxTokens: 16 },
        ModelsCallAnswer,
      );
      assert.ok(answer.usage.outputTokens <= 16, `the answer spent ${answer.usage.outputTokens} output tokens under a ceiling of 16`);
    },
  },
  {
    name: 'models: a schema asks for the reply as data',
    async run(client) {
      const schema = { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] };
      const answer = await client.read(
        'models.call',
        { label: 'conformance.data', system: 'Answer as asked.', userMessage: 'Greet.', model: 'sonnet', schema, toolName: 'greet', toolDescription: 'a greeting' },
        ModelsCallAnswer,
      );
      assert.ok(answer.data !== undefined && answer.data !== null, 'the answer carries data');
    },
  },
  {
    name: 'models: a request missing its system prompt is refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('models.call', { label: 'conformance.bad', userMessage: 'x' }));
    },
  },
];

const QUESTION = {
  asserted: { name: 'Acme' },
  candidates: [{ recordType: 'Company', externalId: 'c1', data: { name: 'ACME Inc' } }, { recordType: 'Company', externalId: 'c2', data: { name: 'Acme Ltd' } }],
  recordType: 'Company',
  constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] },
  languageVersion: '0.12.0',
};

/** The judge slot. */
export const judgeSlotCases: SlotConformanceCase[] = [
  {
    name: 'judge: a question is answered with a candidate, or null to create',
    async run(client) {
      const answer = await client.read('judge.arbitrate', QUESTION, JudgeArbitrateAnswer);
      if (answer.index !== null) assert.ok(answer.index < QUESTION.candidates.length, 'the index names a candidate');
      if (answer.judgeUnavailable !== undefined) assert.equal(answer.index, null, 'a judge that was not asked picks none');
    },
  },
  {
    name: 'judge: candidates that are not a list are refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('judge.arbitrate', { ...QUESTION, candidates: 'c1' }));
    },
  },
];

/** The files slot. */
export const filesSlotCases: SlotConformanceCase[] = [
  {
    name: 'files: a stored document reads back its bytes, and only its tenant owns it',
    async run(client) {
      const bytes = Buffer.from('hello, files slot é', 'utf8');
      const stored = await client.read('files.put', { tenant: 'team-a', name: 'note.txt', contentType: 'text/plain', bytes: bytes.toString('base64') }, StoredFile);
      assert.equal(stored.size, bytes.length);
      assert.equal(stored.name, 'note.txt');
      const uri = stored.source.objectUri;
      assert.equal(await client.call('files.owns', { objectUri: uri, tenant: 'team-a' }), true);
      assert.equal(await client.call('files.owns', { objectUri: uri, tenant: 'team-b' }), false);
      const opened = await client.read('files.open', { objectUri: uri }, FilesOpenAnswer);
      assert.deepEqual(Buffer.from(opened.bytes, 'base64'), bytes);
    },
  },
  {
    name: 'files: a document never stored is owned by no one and does not open',
    async run(client) {
      assert.equal(await client.call('files.owns', { objectUri: 'nowhere:missing', tenant: 'team-a' }), false);
      await assert.rejects(client.call('files.open', { objectUri: 'nowhere:missing' }), SlotRefused);
    },
  },
  {
    name: 'files: two documents of one name are two documents',
    async run(client) {
      const put = (text: string) =>
        client.read('files.put', { tenant: 'team-a', name: 'same.txt', contentType: 'text/plain', bytes: Buffer.from(text).toString('base64') }, StoredFile);
      const [first, second] = [await put('one'), await put('two')];
      assert.notEqual(first.source.objectUri, second.source.objectUri);
      const opened = await client.read('files.open', { objectUri: first.source.objectUri }, FilesOpenAnswer);
      assert.equal(Buffer.from(opened.bytes, 'base64').toString(), 'one');
    },
  },
];

// ── The OCR slot ────────────────────────────────────────────────────────────

const SCANNED_LINES = ['ACME ROBOTICS', 'SERIES A: $4,000,000'];

/** The OCR slot. `client` carries settings that reach a backend. */
export const ocrSlotCases: SlotConformanceCase[] = [
  {
    name: 'ocr: a scanned PDF is read: its text, the pages read and what they cost',
    async run(client) {
      const pdf = scannedPdfOf([textImage(SCANNED_LINES), textImage(['PAGE TWO'])]);
      const answer = await client.read('ocr.read', { bytes: pdf.toString('base64'), contentType: 'application/pdf', name: 'deck.pdf', label: 'conformance.pdf' }, OcrReadAnswer);
      assert.ok(answer.text.trim().length > 0, 'the answer has text');
      assert.equal(answer.pages, 2, 'both pages were read');
      for (const line of answer.cost) assert.ok(line.microdollars >= 0 && line.label.length > 0);
    },
  },
  {
    name: 'ocr: an image is read as one page',
    async run(client) {
      const png = pngOf(textImage(SCANNED_LINES));
      const answer = await client.read('ocr.read', { bytes: png.toString('base64'), contentType: 'image/png', name: 'shot.png', label: 'conformance.image' }, OcrReadAnswer);
      assert.ok(answer.text.trim().length > 0, 'the answer has text');
      assert.equal(answer.pages, 1);
    },
  },
  {
    name: 'ocr: a read that read pages reports what it cost, unless the module publishes its price as free',
    async run(client) {
      const png = pngOf(textImage(SCANNED_LINES));
      const answer = await client.read('ocr.read', { bytes: png.toString('base64'), contentType: 'image/png', label: 'conformance.priced' }, OcrReadAnswer);
      const manifest = await client.read('manifest', {}, WireSlotManifest);
      const free = manifest.methods.includes(OCR_PRICES_METHOD) && (await client.read(OCR_PRICES_METHOD, {}, OcrPricesAnswer)).perPage === 0;
      if (answer.pages === 0 || free) return;
      const total = answer.cost.reduce((sum, line) => sum + line.microdollars, 0);
      assert.ok(total > 0, `the read read ${answer.pages} pages and reported a cost of ${total} microdollars`);
    },
  },
  {
    name: 'ocr: ocr.prices, when listed, prices a page in dollars',
    async run(client) {
      const manifest = await client.read('manifest', {}, WireSlotManifest);
      if (!manifest.methods.includes(OCR_PRICES_METHOD)) return;
      const { perPage } = await client.read(OCR_PRICES_METHOD, {}, OcrPricesAnswer);
      assert.ok(Number.isFinite(perPage) && perPage >= 0);
    },
  },
  {
    name: 'ocr: a request without bytes is refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('ocr.read', { contentType: 'application/pdf', label: 'conformance.bad' }));
    },
  },
  {
    name: 'ocr: bytes of a type the module does not read are refused as unsupported_type',
    async run(client) {
      const bytes = Buffer.from('PK\u0003\u0004 not a document').toString('base64');
      await refusedWith(OCR_UNSUPPORTED_TYPE_CODE, client.call('ocr.read', { bytes, contentType: 'application/zip', label: 'conformance.zip' }));
    },
  },
];

// ── The wake slot ───────────────────────────────────────────────────────────

/** What the wake slot's cases drive: the module, and the workers it has
 *  started. A wake module's effect is outside it (a queue service starting a
 *  worker), so the harness observes it: for a cloud queue module, the
 *  deliveries its queue makes to an endpoint the harness serves. */
export interface WakeHarness {
  client: SlotClient;
  /** When (epoch milliseconds, the harness's clock) each worker the module
   *  started began, since this harness was made. */
  started(): Promise<number[]>;
  /** How late after its due time a worker may start: the queue's delivery delay. */
  slackMs: number;
}

export interface WakeConformanceCase {
  name: string;
  run(harness: WakeHarness): Promise<void>;
}

const POLL_MS = 50;

/** The starts at or after `since`, once there is one; a failure at `by`. */
async function startsSince(harness: WakeHarness, since: number, by: number, what: string): Promise<number[]> {
  for (;;) {
    const starts = (await harness.started()).filter((at) => at >= since);
    if (starts.length > 0) return starts;
    if (Date.now() > by) assert.fail(`${what}: no worker started by ${new Date(by).toISOString()}`);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/** The wake slot (docs/contracts/wake-slot.md). */
export const wakeSlotCases: WakeConformanceCase[] = [
  {
    name: 'wake: now is answered null, and a worker starts soon after',
    async run(harness) {
      const asked = Date.now();
      assert.equal(await harness.client.call('wake.now', { kind: 'fire_event' }), null);
      await startsSince(harness, asked, Date.now() + harness.slackMs, 'wake.now');
    },
  },
  {
    name: 'wake: at an instant ahead, a worker starts then and not before',
    async run(harness) {
      const at = Date.now() + 1_500;
      assert.equal(await harness.client.call('wake.at', { kind: 'resume_timer', at: new Date(at).toISOString() }), null);
      const starts = await startsSince(harness, 0, at + harness.slackMs, 'wake.at');
      for (const start of starts) assert.ok(start >= at, `a worker started ${at - start}ms before its instant`);
    },
  },
  {
    name: 'wake: at an instant already past is now',
    async run(harness) {
      const asked = Date.now();
      assert.equal(await harness.client.call('wake.at', { kind: 'resume_timer', at: new Date(asked - 60_000).toISOString() }), null);
      await startsSince(harness, asked, Date.now() + harness.slackMs, 'wake.at in the past');
    },
  },
  {
    name: 'wake: many nows in a row are each answered, and start a worker',
    async run(harness) {
      const asked = Date.now();
      for (const kind of ['fire_event', 'wake_await', 'fire_event', 'poll_listen', 'fire_callback']) {
        assert.equal(await harness.client.call('wake.now', { kind }), null);
      }
      await startsSince(harness, asked, Date.now() + harness.slackMs, 'five wake.now');
    },
  },
  {
    name: 'wake: an at that is not an instant, or a wake without its kind, is refused as bad_request',
    async run(harness) {
      await refusedWith('bad_request', harness.client.call('wake.at', { kind: 'resume_timer', at: 'soon' }));
      await refusedWith('bad_request', harness.client.call('wake.at', { kind: 'resume_timer' }));
      await refusedWith('bad_request', harness.client.call('wake.now', {}));
    },
  },
];

// ── The secrets slot ────────────────────────────────────────────────────────

const NEW_REF = () => `conf_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const SecretsList = z.array(SecretsListed);

async function listed(client: SlotClient) {
  return client.read('secrets.list', {}, SecretsList);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The secrets slot's own cases (docs/contracts/secrets-slot.md): the list,
 *  the lease and whole entries. `client` reaches a module that can change its
 *  entries; the family's cases (`secretsContractCases`) hold its resolve and
 *  write-back to the meaning every store has. */
export const secretsSlotCases: SlotConformanceCase[] = [
  {
    name: 'secrets: list names each credential with its external, binding and the version resolve answers',
    async run(client) {
      const ref = NEW_REF();
      const binding = { credential: 'oauth' };
      await client.read('secrets.create', { ref, external: 'acme_crm', binding, fields: { access_token: 'a1', workspace: 'w1' } }, SecretsEntryAnswer);
      const one = (await listed(client)).find((entry) => entry.ref === ref);
      assert.ok(one !== undefined, 'a created entry is listed');
      assert.equal(one.external, 'acme_crm');
      assert.deepEqual(one.binding, binding);
      assert.equal(one.version, (await client.read('secrets.resolve', { ref }, SecretsRecord.nullable()))?.version);
      await client.call('secrets.delete', { ref });
    },
  },
  {
    name: 'secrets: create, replace and delete change whole entries, each answered null',
    async run(client) {
      const ref = NEW_REF();
      assert.equal(await client.call('secrets.create', { ref, external: 'acme_crm', binding: 'legacy', fields: { api_key: 'k1' } }), null);
      assert.deepEqual((await client.read('secrets.resolve', { ref }, SecretsRecord.nullable()))?.fields, { api_key: 'k1' });
      assert.equal(await client.call('secrets.replace', { ref, external: 'acme_crm', binding: 'install', fields: { api_key: 'k2', workspace: 'w2' } }), null);
      assert.deepEqual((await client.read('secrets.resolve', { ref }, SecretsRecord.nullable()))?.fields, { api_key: 'k2', workspace: 'w2' }, 'replace is the whole entry, not a merge');
      assert.equal((await listed(client)).find((entry) => entry.ref === ref)?.binding, 'install');
      assert.equal(await client.call('secrets.delete', { ref }), null);
      assert.equal(await client.call('secrets.resolve', { ref }), null);
      assert.equal((await listed(client)).find((entry) => entry.ref === ref), undefined, 'a deleted entry is not listed');
    },
  },
  {
    name: 'secrets: create of an entry that exists, and delete of one that does not, are refused',
    async run(client) {
      const ref = NEW_REF();
      const entry = { ref, external: 'acme_crm', binding: 'legacy', fields: { api_key: 'k1' } };
      await client.call('secrets.create', entry);
      await assert.rejects(client.call('secrets.create', { ...entry, fields: { api_key: 'k9' } }), SlotRefused);
      assert.equal((await client.read('secrets.resolve', { ref }, SecretsRecord.nullable()))?.fields.api_key, 'k1', 'the refused create changed nothing');
      await client.call('secrets.delete', { ref });
      await assert.rejects(client.call('secrets.delete', { ref }), SlotRefused);
    },
  },
  {
    name: 'secrets: a second lock on a credential while one is held answers null; unlock frees it',
    async run(client) {
      const ref = NEW_REF();
      const held = await client.read('secrets.lock', { ref, ttlMs: 30_000 }, SecretsLockAnswer);
      assert.ok(held !== null, 'a free credential is locked');
      assert.equal(await client.call('secrets.lock', { ref, ttlMs: 30_000 }), null);
      assert.equal(await client.call('secrets.unlock', { ref, token: `${held.token}-not` }), null, 'a token that is not the lease\'s unlocks nothing');
      assert.equal(await client.call('secrets.lock', { ref, ttlMs: 30_000 }), null);
      assert.equal(await client.call('secrets.unlock', { ref, token: held.token }), null);
      const again = await client.read('secrets.lock', { ref, ttlMs: 30_000 }, SecretsLockAnswer);
      assert.ok(again !== null && again.token !== held.token, 'an unlocked credential is locked afresh, under a new token');
      await client.call('secrets.unlock', { ref, token: again.token });
    },
  },
  {
    name: 'secrets: a lease whose ttl has lapsed is free, without an unlock',
    async run(client) {
      const ref = NEW_REF();
      assert.ok((await client.read('secrets.lock', { ref, ttlMs: 150 }, SecretsLockAnswer)) !== null);
      assert.equal(await client.call('secrets.lock', { ref, ttlMs: 150 }), null, 'held until its ttl');
      await sleep(400);
      const taken = await client.read('secrets.lock', { ref, ttlMs: 30_000 }, SecretsLockAnswer);
      assert.ok(taken !== null, 'a lapsed lease is taken over');
      await client.call('secrets.unlock', { ref, token: taken.token });
    },
  },
  {
    name: 'secrets: assertWritable of a module that changes its entries answers null',
    async run(client) {
      assert.equal(await client.call('secrets.assertWritable', { ref: NEW_REF() }), null);
    },
  },
  {
    name: 'secrets: a request without its ref, a lock without its ttl and an entry without its binding are refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('secrets.resolve', {}));
      await refusedWith('bad_request', client.call('secrets.lock', { ref: NEW_REF() }));
      await refusedWith('bad_request', client.call('secrets.create', { ref: NEW_REF(), external: 'acme_crm', fields: {} }));
    },
  },
];

/** What a module that keeps its credentials where lf cannot change them
 *  answers: `client` reaches one. Entries are refused by name with a reason;
 *  everything a refresh needs still works. */
export const secretsReadOnlySlotCases: SlotConformanceCase[] = [
  ...(['secrets.create', 'secrets.replace'] as const).map(
    (method): SlotConformanceCase => ({
      name: `secrets: a read-only module answers ${method} with read_only and its reason, and keeps nothing`,
      async run(client) {
        const ref = NEW_REF();
        const answer = await client.read(method, { ref, external: 'acme_crm', binding: 'legacy', fields: { api_key: 'k1' } }, SecretsEntryAnswer);
        assert.ok(answer !== null && answer.kind === 'read_only' && answer.reason.length > 0, `${method} answered ${JSON.stringify(answer)}`);
        assert.equal(await client.call('secrets.resolve', { ref }), null);
        assert.equal((await listed(client)).find((entry) => entry.ref === ref), undefined);
      },
    }),
  ),
  {
    name: 'secrets: a read-only module answers secrets.delete with read_only and its reason',
    async run(client) {
      const answer = await client.read('secrets.delete', { ref: NEW_REF() }, SecretsEntryAnswer);
      assert.ok(answer !== null && answer.kind === 'read_only' && answer.reason.length > 0, `secrets.delete answered ${JSON.stringify(answer)}`);
    },
  },
  {
    name: 'secrets: a read-only module answers secrets.assertWritable with read_only and its reason',
    async run(client) {
      const answer = await client.read('secrets.assertWritable', { ref: NEW_REF() }, SecretsEntryAnswer);
      assert.ok(answer !== null && answer.kind === 'read_only' && answer.reason.length > 0, `secrets.assertWritable answered ${JSON.stringify(answer)}`);
    },
  },
  {
    name: 'secrets: a read-only module still lists, resolves and leases',
    async run(client) {
      const ref = NEW_REF();
      assert.ok(Array.isArray(await client.call('secrets.list', {})));
      assert.equal(await client.call('secrets.resolve', { ref }), null);
      const held = await client.read('secrets.lock', { ref, ttlMs: 30_000 }, SecretsLockAnswer);
      assert.ok(held !== null);
      assert.equal(await client.call('secrets.unlock', { ref, token: held.token }), null);
    },
  },
];

// ── The movements slot ──────────────────────────────────────────────────────

const NEW_MOVEMENT = () => `conformance/${randomUUID()}.mvt`;

async function listedMovements(client: SlotClient) {
  return client.read('movements.list', {}, MovementsListAnswer);
}

const writeMovement = (client: SlotClient, path: string, text: string, expectedVersion: string | null) =>
  client.read('movements.write', { path, text, expectedVersion }, MovementsWriteAnswer);

/** Creates a file and returns the version it was written at. */
async function createdMovement(client: SlotClient, path: string, text: string): Promise<string> {
  const made = await writeMovement(client, path, text, null);
  assert.equal(made.kind, 'written', `creating ${path} answered ${JSON.stringify(made)}`);
  return made.kind === 'written' ? made.version : '';
}

const watchMovements = (client: SlotClient, params: object) => client.read('movements.watch', params, MovementsWatchAnswer);

/** The module's current cursor (a watch without one answers it, no events). */
async function currentCursor(client: SlotClient): Promise<string> {
  const answer = await watchMovements(client, { waitMs: 0 });
  assert.ok('cursor' in answer, `a watch without a cursor answered ${JSON.stringify(answer)}`);
  return 'cursor' in answer ? answer.cursor : '';
}

const WATCH_DEADLINE_MS = 10_000;

/** Re-asks from `cursor` until an event satisfies `wanted` or the deadline
 *  passes, so a module that answers at once (and one that holds) both pass.
 *  Returns the cursor after the answer that carried it and every event seen. */
async function watchedUntil(
  client: SlotClient,
  cursor: string,
  wanted: (event: MovementsChangeShape) => boolean,
): Promise<{ cursor: string; seen: MovementsChangeShape[] }> {
  const deadline = Date.now() + WATCH_DEADLINE_MS;
  const seen: MovementsChangeShape[] = [];
  let from = cursor;
  while (Date.now() < deadline) {
    const asked = Date.now();
    const answer = await watchMovements(client, { cursor: from, waitMs: 1_000 });
    assert.ok('cursor' in answer, `a watch from a cursor the module gave answered ${JSON.stringify(answer)}`);
    if (!('cursor' in answer)) break;
    from = answer.cursor;
    seen.push(...answer.events);
    if (answer.events.some(wanted)) return { cursor: from, seen };
    if (Date.now() - asked < 500) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no wanted event within ${WATCH_DEADLINE_MS} ms; saw ${JSON.stringify(seen)}`);
}

const eventAt = (path: string, kind: MovementsChangeShape['kind']) => (event: MovementsChangeShape) => event.path === path && event.kind === kind;

async function readVersion(client: SlotClient, path: string): Promise<string | undefined> {
  return (await client.read('movements.read', { path }, MovementsReadAnswer))?.version;
}

/** The movements slot's own cases (docs/contracts/movements-slot.md): the
 *  list, a read of nothing, writes by compare-and-swap on the version, the
 *  path rule. `client` reaches a module that can change its files. */
export const movementsSlotCases: SlotConformanceCase[] = [
  {
    name: 'movements: list names a created file, and its version is the one read answers',
    async run(client) {
      const path = NEW_MOVEMENT();
      const version = await createdMovement(client, path, 'movement hello {}\n');
      const one = (await listedMovements(client)).find((file) => file.path === path);
      assert.ok(one !== undefined, 'a created file is listed');
      assert.ok(one.version === undefined || one.version === version, 'a listed version is the one the write answered');
      assert.deepEqual(await client.read('movements.read', { path }, MovementsReadAnswer), { text: 'movement hello {}\n', version });
    },
  },
  {
    name: 'movements: read of a path with nothing at it answers null',
    async run(client) {
      assert.equal(await client.call('movements.read', { path: NEW_MOVEMENT() }), null);
    },
  },
  {
    name: 'movements: create with a null expectedVersion writes; a second create answers conflict with the current version and changes nothing',
    async run(client) {
      const path = NEW_MOVEMENT();
      const version = await createdMovement(client, path, 'one');
      assert.deepEqual(await writeMovement(client, path, 'two', null), { kind: 'conflict', current: version });
      assert.equal((await client.read('movements.read', { path }, MovementsReadAnswer))?.text, 'one', 'the refused create changed nothing');
    },
  },
  {
    name: 'movements: replace with the current version answers a new version, and the text reads back byte for byte',
    async run(client) {
      const path = NEW_MOVEMENT();
      const first = await createdMovement(client, path, 'one');
      const text = 'movement caf\u00e9 {}\n\u00fcber \u2713\n';
      const replaced = await writeMovement(client, path, text, first);
      assert.equal(replaced.kind, 'written');
      assert.ok(replaced.kind === 'written' && replaced.version !== first, 'a replace is a new version');
      const read = await client.read('movements.read', { path }, MovementsReadAnswer);
      assert.equal(read?.text, text);
      assert.equal(read?.version, replaced.kind === 'written' ? replaced.version : undefined);
    },
  },
  {
    name: 'movements: a stale version answers conflict with the current one and changes nothing; so does a version for a path with nothing at it',
    async run(client) {
      const path = NEW_MOVEMENT();
      const first = await createdMovement(client, path, 'one');
      const second = await writeMovement(client, path, 'two', first);
      assert.equal(second.kind, 'written');
      const current = second.kind === 'written' ? second.version : '';
      assert.deepEqual(await writeMovement(client, path, 'three', first), { kind: 'conflict', current });
      assert.equal((await client.read('movements.read', { path }, MovementsReadAnswer))?.text, 'two');
      assert.deepEqual(await writeMovement(client, NEW_MOVEMENT(), 'x', 'no-such-version'), { kind: 'conflict', current: null });
    },
  },
  {
    name: 'movements: the same text listed twice keeps its version; a changed text changes it',
    async run(client) {
      const path = NEW_MOVEMENT();
      await createdMovement(client, path, 'one');
      const versionOf = async () => (await client.read('movements.read', { path }, MovementsReadAnswer))?.version;
      const before = await versionOf();
      assert.equal(await versionOf(), before, 'reading twice does not change the version');
      const listedVersion = async () => (await listedMovements(client)).find((file) => file.path === path)?.version;
      assert.equal(await listedVersion(), await listedVersion(), 'listing twice does not change it');
      assert.ok(before !== undefined);
      await writeMovement(client, path, 'two', before);
      assert.notEqual(await versionOf(), before, 'a changed text is a new version');
    },
  },
  {
    name: 'movements: a path that is not relative, `/`-separated and ending .mvt is refused as bad_request on read and write',
    async run(client) {
      for (const path of ['/a.mvt', 'a/../b.mvt', './a.mvt', 'a//b.mvt', 'a\\b.mvt', 'a.txt', 'a']) {
        await refusedWith('bad_request', client.call('movements.read', { path }));
        await refusedWith('bad_request', client.call('movements.write', { path, text: 'x', expectedVersion: null }));
      }
      await refusedWith('bad_request', client.call('movements.read', {}));
    },
  },
  {
    name: 'movements: a write without its expectedVersion, or without its text, is refused as bad_request and writes nothing',
    async run(client) {
      const path = NEW_MOVEMENT();
      await refusedWith('bad_request', client.call('movements.write', { path, text: 'x' }));
      await refusedWith('bad_request', client.call('movements.write', { path, expectedVersion: null }));
      assert.equal(await client.call('movements.read', { path }), null);
    },
  },
  {
    name: 'movements: a watch without a cursor answers a cursor and no events',
    async run(client) {
      const answer = await watchMovements(client, { waitMs: 0 });
      assert.ok('cursor' in answer && answer.events.length === 0, `answered ${JSON.stringify(answer)}`);
    },
  },
  {
    name: 'movements: a file created after a watch is reported added with the version read answers; a replace is changed with the new version',
    async run(client) {
      const cursor = await currentCursor(client);
      const path = NEW_MOVEMENT();
      const first = await createdMovement(client, path, 'one');
      const added = await watchedUntil(client, cursor, eventAt(path, 'added'));
      const event = added.seen.find(eventAt(path, 'added'));
      assert.equal(event && event.kind !== 'removed' ? event.version : undefined, first, 'added carries the version read answers');
      const replaced = await writeMovement(client, path, 'two', first);
      assert.equal(replaced.kind, 'written');
      const changed = await watchedUntil(client, added.cursor, eventAt(path, 'changed'));
      const edit = changed.seen.find(eventAt(path, 'changed'));
      assert.equal(edit && edit.kind !== 'removed' ? edit.version : undefined, await readVersion(client, path), 'changed carries the new version');
    },
  },
  {
    name: 'movements: an event answered once is not answered again from the next cursor, and a write between two calls appears in the second',
    async run(client) {
      const first = NEW_MOVEMENT();
      await createdMovement(client, first, 'one');
      const cursor = await currentCursor(client);
      const second = NEW_MOVEMENT();
      await createdMovement(client, second, 'two');
      const afterSecond = await watchedUntil(client, cursor, eventAt(second, 'added'));
      assert.equal(afterSecond.seen.filter(eventAt(first, 'added')).length, 0, 'a file written before the cursor is not an event after it');
      const third = NEW_MOVEMENT();
      await createdMovement(client, third, 'three');
      const afterThird = await watchedUntil(client, afterSecond.cursor, eventAt(third, 'added'));
      assert.equal(afterThird.seen.filter(eventAt(second, 'added')).length, 0, 'an answered event is not answered again');
    },
  },
  {
    name: 'movements: two watchers from one cursor both see the change',
    async run(client) {
      const cursor = await currentCursor(client);
      const path = NEW_MOVEMENT();
      await createdMovement(client, path, 'one');
      await watchedUntil(client, cursor, eventAt(path, 'added'));
      await watchedUntil(client, cursor, eventAt(path, 'added'));
    },
  },
  {
    name: 'movements: a cursor the module never gave answers resync',
    async run(client) {
      assert.deepEqual(await watchMovements(client, { cursor: 'conformance-unknown', waitMs: 0 }), { resync: true });
    },
  },
  {
    name: 'movements: a watch without waitMs, with a negative waitMs or with a cursor that is not a string is refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('movements.watch', {}));
      await refusedWith('bad_request', client.call('movements.watch', { cursor: 'x' }));
      await refusedWith('bad_request', client.call('movements.watch', { waitMs: -1 }));
      await refusedWith('bad_request', client.call('movements.watch', { waitMs: 0, cursor: 5 }));
    },
  },
];

/** A removed file is reported `removed`. The wire has no delete, so the
 *  harness supplies the removal (the test module's `remove`, a file deleted
 *  from the folder). */
export const movementsWatchRemovalCase = (remove: (path: string) => Promise<void>): SlotConformanceCase => ({
  name: 'movements: a removed file is reported removed',
  async run(client) {
    const path = NEW_MOVEMENT();
    await createdMovement(client, path, 'one');
    const cursor = await currentCursor(client);
    await remove(path);
    await watchedUntil(client, cursor, eventAt(path, 'removed'));
  },
});

/** A module honours at most the cap: with nothing changing, a request for a
 *  minute is answered within the cap (plus slack). It takes about 30 s. */
export const movementsWatchCapCase: SlotConformanceCase = {
  name: 'movements: a watch for longer than the cap is answered within the cap',
  async run(client) {
    const cursor = await currentCursor(client);
    const asked = Date.now();
    const answer = await watchMovements(client, { cursor, waitMs: 60_000 });
    assert.ok(!('resync' in answer), 'a cursor the module gave is not resync');
    const took = Date.now() - asked;
    assert.ok(took < WATCH_WAIT_CAP_MS + 2_000, `a watch for 60000 ms took ${took} ms`);
  },
};

/** What a module that keeps the project's movements where lf cannot change
 *  them answers: `client` reaches one. A write is refused by name with a
 *  reason; listing and reading still work. */
export const movementsReadOnlySlotCases: SlotConformanceCase[] = [
  {
    name: 'movements: a read-only module answers movements.write with read_only and its reason, and keeps nothing',
    async run(client) {
      const path = NEW_MOVEMENT();
      const answer = await writeMovement(client, path, 'one', null);
      assert.ok(answer.kind === 'read_only' && answer.reason.length > 0, `movements.write answered ${JSON.stringify(answer)}`);
      assert.equal(await client.call('movements.read', { path }), null);
      assert.equal((await listedMovements(client)).find((file) => file.path === path), undefined);
    },
  },
  {
    name: 'movements: a read-only module still lists and reads',
    async run(client) {
      assert.ok(Array.isArray(await client.call('movements.list', {})));
      assert.equal(await client.call('movements.read', { path: NEW_MOVEMENT() }), null);
    },
  },
  {
    name: 'movements: a read-only module still watches: a cursor without one, resync on one it never gave',
    async run(client) {
      await currentCursor(client);
      assert.deepEqual(await watchMovements(client, { cursor: 'conformance-unknown', waitMs: 0 }), { resync: true });
    },
  },
];
