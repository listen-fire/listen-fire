// What a form asks, read from the node the write named (the engine sends
// its fields as `{ fields: { <name>: <field type> } }`, each a catalog field
// type), and an answer checked against it.

export type FormFieldType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'choice';

export interface FormField {
  type: FormFieldType;
  required: boolean;
  /** A choice's words, in the node's order. */
  options?: string[];
}

export type FormFields = Record<string, FormField>;

const SCALARS: Readonly<Record<string, FormFieldType>> = { text: 'text', number: 'number', boolean: 'boolean', date: 'date', datetime: 'datetime' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One node field's type as a form field, or why a form cannot ask it. */
function formField(name: string, declared: unknown, required = true): FormField | { refused: string } {
  if (typeof declared === 'string' && SCALARS[declared] !== undefined) return { type: SCALARS[declared], required };
  if (isRecord(declared) && declared['kind'] === 'maybeAbsent' && required) return formField(name, declared['of'], false);
  if (isRecord(declared) && declared['kind'] === 'enum' && Array.isArray(declared['options'])) {
    const options = declared['options'].filter((o): o is string => typeof o === 'string');
    return { type: 'choice', required, options };
  }
  return {
    refused: `a form cannot ask for '${name}' (${JSON.stringify(declared)}): a form's field is text, a number, a boolean, a date, a date and time, or one of a set of words, optional with '| null'`,
  };
}

/** The fields a write's `Fields` value names, or why they cannot be asked. */
export function formFieldsOf(value: unknown): { fields: FormFields } | { refused: string } {
  const declared = isRecord(value) ? value['fields'] : undefined;
  if (!isRecord(declared)) {
    return { refused: "Fields is the node the form asks for (`Fields: Refund`, after `node Refund { … }`): this write sent no node's fields" };
  }
  const fields: FormFields = {};
  for (const [name, type] of Object.entries(declared)) {
    const field = formField(name, type);
    if ('refused' in field) return field;
    fields[name] = field;
  }
  if (Object.keys(fields).length === 0) return { refused: 'the node a form asks for declares no fields' };
  return { fields };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One value as the field takes it, `null` for an optional one left out. A
 *  form's values are text (`fromForm`), so a number, a boolean and a date and
 *  time are read from their text; JSON's are taken as they are. */
function valueOf(name: string, field: FormField, given: unknown, fromForm: boolean): { value: unknown } | { refused: string } {
  const blank = given === undefined || given === null || (fromForm && given === '');
  if (blank) return field.required ? { refused: `'${name}' is required` } : { value: null };
  switch (field.type) {
    case 'text':
      return typeof given === 'string' ? { value: given } : { refused: `'${name}' must be text` };
    case 'number': {
      const n = fromForm && typeof given === 'string' ? Number(given) : given;
      return typeof n === 'number' && Number.isFinite(n) ? { value: n } : { refused: `'${name}' must be a number` };
    }
    case 'boolean': {
      const b = fromForm && given === 'true' ? true : fromForm && given === 'false' ? false : given;
      return typeof b === 'boolean' ? { value: b } : { refused: `'${name}' must be true or false` };
    }
    case 'date':
      return typeof given === 'string' && DATE.test(given) && !Number.isNaN(Date.parse(given))
        ? { value: given }
        : { refused: `'${name}' must be a date, written YYYY-MM-DD` };
    case 'datetime':
      return typeof given === 'string' && !Number.isNaN(Date.parse(given))
        ? { value: new Date(given).toISOString() }
        : { refused: `'${name}' must be a date and time (ISO 8601)` };
    case 'choice':
      return typeof given === 'string' && (field.options ?? []).includes(given)
        ? { value: given }
        : { refused: `'${name}' must be one of: ${(field.options ?? []).join(', ')}` };
    default: {
      const unknown: never = field.type;
      throw new Error(`unknown form field type ${String(unknown)}`);
    }
  }
}

/** An answer's values checked against the form's fields: every field, the
 *  ones left out `null`; or the first thing wrong with it. */
export function answerOf(fields: FormFields, body: unknown, fromForm: boolean): { values: Record<string, unknown> } | { refused: string } {
  if (!isRecord(body)) return { refused: 'an answer is a JSON object or a form, one value per field' };
  const names = Object.keys(fields);
  const stray = Object.keys(body).find((key) => !names.includes(key));
  if (stray !== undefined) return { refused: `'${stray}' is not a field of this form (it has: ${names.join(', ')})` };
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const read = valueOf(name, field, body[name], fromForm);
    if ('refused' in read) return read;
    values[name] = read.value;
  }
  return { values };
}
