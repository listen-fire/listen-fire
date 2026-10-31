// The forms adapter. A write makes a form: an unguessable id, kept with its
// title and the fields the node the write named asks for, at a link under
// the module's door (`ctx.config.inboundUrl`). The link answers a GET with
// the form (a page, or its fields as JSON) and takes one answer by POST,
// checked against the fields. A recorded answer is reported as an arrival on
// the form's `Submissions`, keyed by the form's id; the host keeps the wait.

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';
import type { Arrival, ArrivalsCapability, AwaitHead, AwaitKey, GetFieldValueInput, WriteInput, WriteResult } from 'engine-contracts';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'engine-contracts';
import type { InboundRequest, ModuleKv } from 'module-kit';
import { BaseAdapter } from 'module-kit/adapter/base';
import { accepted, inboundRequest, reply } from 'module-kit';
import { positionData } from 'movement-engine/public/catalog';

import { answerOf, formFieldsOf, type FormFields } from './fields';
import { FIELDS_FIELD, FORM_TYPE, FORMS_ADAPTER_TYPE, FORMS_COLLECTION, SUBMISSION_TYPE, SUBMISSIONS_EDGE } from './manifest';
import { formPage, messagePage } from './page';

export interface FormsSources {
  /** Where the forms are kept: the install's own state. */
  kv: ModuleKv;
  /** The module's door at the host, when it serves one. */
  inboundUrl: string | undefined;
  /** A new form's id: unguessable, as the link is all that guards it. */
  newId(): string;
}

/** A form's one answer, as the first post that recorded it sent it. */
interface Submission {
  identity: string;
  values: Record<string, unknown>;
}

/** A form as it is kept. Its answer is kept whole, not only marked: the host
 *  may refuse to keep the arrival the first post reports (its store cannot
 *  keep waits), and the sender's retry of that post must report it again. */
interface StoredForm {
  title: string;
  fields: FormFields;
  answer: Submission | null;
}

const formKey = (id: string) => `form:${id}`;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

function isSubmission(value: unknown): value is Submission {
  return isObject(value) && typeof Reflect.get(value, 'identity') === 'string' && isObject(Reflect.get(value, 'values'));
}

function isStoredForm(value: unknown): value is StoredForm {
  if (!isObject(value)) return false;
  const answer = Reflect.get(value, 'answer');
  return typeof Reflect.get(value, 'title') === 'string' && isObject(Reflect.get(value, 'fields')) && (answer === null || isSubmission(answer));
}

/** A link to a form: the door, and the form's id in its query. */
function linkTo(door: string, id: string): string {
  const url = new URL(door);
  url.searchParams.set('form', id);
  return url.toString();
}

/** A browser wants the page; anything that asks for JSON gets JSON. */
function wantsPage(request: InboundRequest): boolean {
  const accept = request.header('accept') ?? '';
  if (request.method === 'GET') return !accept.includes('application/json');
  return accept.includes('text/html');
}

/** The answer as data or as a page, with the same status. */
function answer(request: InboundRequest, status: number, json: Record<string, unknown>, said: { title: string; message: string }): InboundCheck {
  return wantsPage(request) ? reply(status, { html: messagePage(said.title, said.message) }) : reply(status, { json });
}

export function newFormId(): string {
  return randomBytes(18).toString('base64url');
}

export class FormsAdapter extends BaseAdapter {
  readonly adapterType = FORMS_ADAPTER_TYPE;
  readonly supportedTriggers = [] as const;

  constructor(private readonly sources: FormsSources) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // Written, never listed: a form's link is all that guards it, so only
      // the program that wrote a form holds it.
      { typeId: FORM_TYPE, displayName: FORM_TYPE, writable: true, readable: false, collectionName: FORMS_COLLECTION },
      // An answer is reached only by arriving on a form's `Submissions`.
      { typeId: SUBMISSION_TYPE, displayName: SUBMISSION_TYPE, writable: false, readable: false },
    ];
  }

  async describe(typeId: string): Promise<SchemaTypeDescriptor | null> {
    switch (typeId) {
      case FORM_TYPE:
        return {
          typeId: FORM_TYPE,
          displayName: FORM_TYPE,
          description: 'A form at a link, answered once.',
          fields: [
            { fieldId: 'Url', displayName: 'Url', kind: 'string', writable: false, required: false, description: 'The link that answers the form.' },
            { fieldId: 'Title', displayName: 'Title', kind: 'string', writable: true, required: true, description: 'What the form asks, shown above its fields.' },
            {
              fieldId: FIELDS_FIELD,
              displayName: FIELDS_FIELD,
              kind: 'json',
              writable: true,
              required: true,
              readable: false,
              description: 'The node the form asks for (`Fields: Refund`): its fields are the form’s, and its submissions have them.',
            },
          ],
          references: [
            {
              fieldId: SUBMISSIONS_EDGE,
              name: SUBMISSIONS_EDGE,
              targetTypeId: SUBMISSION_TYPE,
              cardinality: 'many',
              direction: 'outgoing',
              readable: false,
              listenable: true,
              identity: 'Id',
              answerShapeFrom: FIELDS_FIELD,
              description: 'The form’s one answer, with the fields of the node the write named.',
            },
          ],
        };
      case SUBMISSION_TYPE:
        return {
          typeId: SUBMISSION_TYPE,
          displayName: SUBMISSION_TYPE,
          description: 'An answer to a form: the fields of the node the form asked for, and its Id.',
          fields: [{ fieldId: 'Id', displayName: 'Id', kind: 'string', writable: false, required: false, description: 'The answer’s id: a form takes one, so its form’s.' }],
          references: [],
        };
      default:
        return null;
    }
  }

  /** A form's and an answer's fields are their names: an answer's are the
   *  node's the form asked for, which no describe names. */
  override async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const data = positionData(input.position) as Record<string, unknown> | null | undefined;
    return data?.[input.fieldId] ?? null;
  }

  override async createRecord(input: WriteInput): Promise<WriteResult> {
    if (input.recordType !== FORM_TYPE) throw new Error(`forms writes a ${FORM_TYPE}, not a ${input.recordType}`);
    const title = input.fields['Title'];
    if (typeof title !== 'string' || title.trim() === '') throw new Error('a form needs a Title: what it asks, shown above its fields');
    const asked = formFieldsOf(input.fields[FIELDS_FIELD]);
    if ('refused' in asked) throw new Error(asked.refused);
    const door = this.sources.inboundUrl;
    if (door === undefined) {
      throw new Error("a form's link points at listen-fire serve, and none is known here: set publicUrl in lf.yaml to where listen-fire serve is reached");
    }
    const id = this.sources.newId();
    const stored: StoredForm = { title, fields: asked.fields, answer: null };
    await this.sources.kv.set(formKey(id), stored);
    const url = linkTo(door, id);
    return { adapterType: FORMS_ADAPTER_TYPE, externalId: id, recordType: FORM_TYPE, url, data: { Url: url, Title: title } };
  }

  /** A form's `Submissions` are waited on under its id. */
  readonly arrivals: ArrivalsCapability = {
    awaitKeys: async ({ edge, heads }: { edge: string; heads: AwaitHead[] }): Promise<AwaitKey[]> => {
      if (edge !== SUBMISSIONS_EDGE) throw new Error(`forms: '${edge}' is not a listenable edge (only '${SUBMISSIONS_EDGE}')`);
      return heads.map((head) => ({ key: head.recordId }));
    },
  };

  async checkInbound(input: InboundCheckInput): Promise<InboundCheck> {
    const request = inboundRequest(input);
    const id = request.query['form'] ?? '';
    const key = formKey(id);
    const form = id === '' ? undefined : await this.sources.kv.get(key);
    if (!isStoredForm(form)) {
      return answer(request, 404, { outcome: 'not_found', message: 'there is no form at this link' }, { title: 'No form here', message: 'There is no form at this link.' });
    }
    if (request.method !== 'GET' && request.method !== 'POST') return reply(405, { json: { outcome: 'method_not_allowed', message: 'a form is read with GET and answered with POST' } });
    const answered = () => answer(request, 410, { outcome: 'answered' }, { title: form.title, message: 'This form has been answered.' });
    if (request.method === 'GET') {
      if (form.answer !== null) return answered();
      // The page posts back to the link it was opened at.
      return wantsPage(request) ? reply(200, { html: formPage(form.title, form.fields, '') }) : reply(200, { json: { title: form.title, fields: form.fields } });
    }
    const fromForm = (request.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
    const read = answerOf(form.fields, fromForm ? request.form() : request.json(), fromForm);
    if ('refused' in read) {
      if (form.answer !== null) return answered();
      return answer(request, 400, { outcome: 'mismatch', message: read.refused }, { title: form.title, message: `Not recorded: ${read.refused}.` });
    }
    const submission = await this.record(key, form, { identity: id, values: read.values });
    if (submission === undefined) return answered();
    const landing = { Id: submission.identity, ...submission.values };
    const arrival: Arrival = {
      edge: SUBMISSIONS_EDGE,
      key: id,
      identity: submission.identity,
      landing: { recordId: submission.identity, recordType: SUBMISSION_TYPE, fields: landing },
    };
    const recorded = wantsPage(request)
      ? { status: 200, html: messagePage(form.title, 'Thank you: your answer is recorded.') }
      : { status: 200, json: { outcome: 'recorded' } };
    return accepted([], { arrivals: [arrival], deliveryId: submission.identity, reply: recorded });
  }

  /** The form's one answer, if `posted` is it: the first post to come keeps
   *  its submission, and a post of the same values is that submission again
   *  (a retry, reported again; the host's log drops it if it is kept). Any
   *  other is not the answer. */
  private async record(key: string, form: StoredForm, posted: Submission): Promise<Submission | undefined> {
    if (form.answer === null && (await this.sources.kv.compareAndSet(key, form, { ...form, answer: posted }))) return posted;
    // Answered before, or by a post that came at the same time as this one.
    const first = form.answer ?? (await this.answerOf(key));
    return first !== null && isDeepStrictEqual(first.values, posted.values) ? first : undefined;
  }

  private async answerOf(key: string): Promise<Submission | null> {
    const form = await this.sources.kv.get(key);
    return isStoredForm(form) ? form.answer : null;
  }
}
