// A form as a browser sees it: one page that posts back to its own link, and
// the page an answer, a refusal or a missing form is told with.

import type { FormField, FormFields } from './fields';

function escaped(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input[type=text], input[type=number], input[type=date], input[type=datetime-local], select, textarea { width: 100%; padding: 0.4rem; box-sizing: border-box; }
  .choice { font-weight: normal; display: inline; margin-right: 1rem; }
  button { margin-top: 1.5rem; padding: 0.5rem 1.2rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function input(name: string, field: FormField): string {
  const id = `f-${escaped(name)}`;
  const named = `name="${escaped(name)}"`;
  const required = field.required ? ' required' : '';
  switch (field.type) {
    case 'text':
      return `<textarea id="${id}" ${named} rows="3"${required}></textarea>`;
    case 'number':
      return `<input type="number" step="any" id="${id}" ${named}${required}>`;
    case 'boolean':
      return ['true', 'false']
        .map((value) => `<label class="choice"><input type="radio" ${named} value="${value}"${required}> ${value === 'true' ? 'Yes' : 'No'}</label>`)
        .join('\n');
    case 'date':
      return `<input type="date" id="${id}" ${named}${required}>`;
    case 'datetime':
      return `<input type="datetime-local" id="${id}" ${named}${required}>`;
    case 'choice': {
      const blank = field.required ? '' : '<option value=""></option>';
      const options = (field.options ?? []).map((o) => `<option value="${escaped(o)}">${escaped(o)}</option>`).join('');
      return `<select id="${id}" ${named}${required}>${blank}${options}</select>`;
    }
    default: {
      const unknown: never = field.type;
      throw new Error(`unknown form field type ${String(unknown)}`);
    }
  }
}

/** The form: each field, and a button that posts the answer to `action`
 *  (empty: the link the page was opened at). */
export function formPage(title: string, fields: FormFields, action: string): string {
  const rows = Object.entries(fields)
    .map(([name, field]) => `<label for="f-${escaped(name)}">${escaped(name)}${field.required ? '' : ' (optional)'}</label>\n${input(name, field)}`)
    .join('\n');
  return page(title, `<h1>${escaped(title)}</h1>\n<form method="post" action="${escaped(action)}">\n${rows}\n<button type="submit">Send</button>\n</form>`);
}

/** A page that says one thing: the answer recorded, or why it was not. */
export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escaped(title)}</h1>\n<p>${escaped(message)}</p>`);
}
