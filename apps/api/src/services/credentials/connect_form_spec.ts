// Author-time connect-LINK key-entry form spec.
//
// The connect link works for OAuth adapters (browser sign-in) AND API-key
// adapters (a browser form where the user pastes — or replaces — the key). For
// the key-entry kind, the landing route renders a form whose FIELDS come from
// here, and the submit route validates the posted values with the SAME zod
// parser the in-app `addCredential` mutation uses (views/credentials.ts).
// One field spec per credential type, paired with its real parser, so the form
// is never hardcoded per adapter and can never drift from what the adapter
// actually accepts.
//
// Only adapters whose credential is a user-supplied key/secret belong here.
// Intrinsic credentials (NATIVE_VALUATIONS — server auto-mints; connected via
// intrinsic_provision.ts) and handshake credentials (TELEGRAM — deep-link /
// shared-bot) are deliberately absent: they have no "paste a key" browser form.

import { z } from 'zod';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { affinityCredsParser } from '../../adapters/affinity/apiClient';
import { attioCredsParser } from '../../adapters/attio/apiClient';
import { evertraceCredsParser } from '../../adapters/evertrace/apiClient';
import { RemoteAdapterCredentialPayload } from '../translation_graph/adapters/remote/manifest';

/** Stored Granola credential — the API key the user pastes. */
export const granolaCredsParser = z.object({
  apiKey: z.string(),
});

/** One field rendered on the key-entry form. */
export interface ConnectFormField {
  /** The posted form field name — also the key in the credentials envelope. */
  name: string;
  /** Human label shown above the input. */
  label: string;
  /** A secret → rendered as a password input (no echo), never pre-filled. */
  secret: boolean;
  /** Optional fields don't block submission when left blank. */
  optional: boolean;
  /** Input type hint: a plain string vs a URL. */
  kind: 'text' | 'url';
  /** Optional placeholder / hint. */
  placeholder?: string;
  /** Short hint rendered under the input — what the field means / when to
   *  leave it blank. Plain text (the page escapes it). */
  help?: string;
}

/**
 * A key-entry connectable adapter's form: the fields to render + the parser to
 * validate the submitted envelope against (the EXACT parser `addCredential`
 * uses). `parse` returns the validated credentials object or throws.
 */
export interface ConnectFormSpec {
  fields: ConnectFormField[];
  /** Step-by-step "where to find this" instructions rendered above the form —
   *  the walk from the provider's UI to the value(s) below. Plain text. */
  guide?: string[];
  /** A caveat worth surfacing alongside the guide (plan requirements etc.). */
  note?: string;
  parse(values: Record<string, string>): unknown;
}

function specFor(
  parser: z.ZodType,
  fields: ConnectFormField[],
  extras: { guide?: string[]; note?: string } = {},
): ConnectFormSpec {
  return {
    fields,
    ...extras,
    parse(values) {
      // Trim, then OMIT blanks entirely so the parser's own required/optional
      // rules decide: a blank required field is dropped → the parser rejects the
      // missing key (we never persist an empty secret); a blank optional field
      // is dropped → `.optional()` is satisfied.
      const cleaned: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.name];
        if (v === undefined) continue;
        const trimmed = v.trim();
        if (trimmed === '') continue;
        cleaned[f.name] = trimmed;
      }
      return parser.parse(cleaned);
    },
  };
}

const CONNECT_FORM_SPECS: Partial<Record<ExternalServiceType, ConnectFormSpec>> = {
  [ExternalServiceType.AFFINITY]: specFor(
    affinityCredsParser,
    [
      { name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' },
      {
        name: 'webhookSignatureKey',
        label: 'Webhook signature key (optional)',
        secret: true,
        optional: true,
        kind: 'text',
        help:
          'Optional extra security: with this set, events Affinity sends us are ' +
          'checked against your account\u2019s signature key so forged deliveries are ' +
          'rejected. Found next to your API key in the API section.',
      },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank — it's only needed if Affinity has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Affinity in your browser.',
        'Open Settings, then the API section.',
        "Copy your API key (generate one there if you don't have one yet) and paste it below.",
        'Optionally also copy the Webhook Signature Key from the same page for verified event deliveries.',
      ],
    },
  ),
  // Attio issues workspace access tokens that authenticate exactly like the
  // OAuth ones (`Authorization: Bearer …`), so the pasted token lands in the
  // same `accessToken` envelope the OAuth callback stores and every outbound
  // call is unchanged. `connectKindForType` still prefers OAuth wherever the
  // connector is wired; this form is what a deployment WITHOUT its own Attio
  // OAuth app connects through.
  [ExternalServiceType.ATTIO]: specFor(
    attioCredsParser,
    [
      { name: 'accessToken', label: 'Access token', secret: true, optional: false, kind: 'text' },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank — it's only needed if Attio has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Attio, open the dropdown beside your workspace name and choose Workspace settings.',
        'Open the Developers tab and click "+ New access token".',
        'Name the token and give it these scopes: record_permission:read-write, object_configuration:read, ' +
          'list_entry:read-write, list_configuration:read, note:read-write, task:read-write, ' +
          'comment:read-write, file:read-write, webhook:read-write, user_management:read.',
        'Copy the token and paste it below.',
      ],
      note: 'Only an Attio workspace admin can create an access token.',
    },
  ),
  [ExternalServiceType.GRANOLA]: specFor(
    granolaCredsParser,
    [{ name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' }],
    {
      guide: [
        'Open the Granola desktop app.',
        'Go to Settings, then API keys, and click "Create new key".',
        'Copy the key (it starts with "grn_") and paste it below.',
      ],
      note: 'Creating Granola API keys requires a Business or Enterprise workspace.',
    },
  ),
  [ExternalServiceType.EVERTRACE]: specFor(
    evertraceCredsParser,
    [
      { name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank \u2014 it's only needed if Evertrace has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Evertrace in your browser.',
        'Open Settings, then API access, and create a key.',
        'Copy the key (it starts with "sk_live_") and paste it below.',
      ],
    },
  ),
  // A user-installed remote adapter authenticates with a single secret (the
  // token its server checks on every request). The parser is the same
  // { secret } payload resolveAdapter decrypts, so the form can never drift
  // from what the adapter accepts. The submit binds it to the adapter (app_id)
  // and links it onto the install — see interfaces/rest/connect.ts.
  [ExternalServiceType.REMOTE]: specFor(
    RemoteAdapterCredentialPayload,
    [
      {
        name: 'secret',
        label: 'Adapter secret',
        secret: true,
        optional: false,
        kind: 'text',
        help:
          'The auth token your adapter server checks on each request (sent as a ' +
          'Bearer token or your configured header). Paste it here.',
      },
    ],
    {
      guide: [
        'Open the adapter server you built for your CRM.',
        'Copy the secret it expects for authentication.',
        'Paste it below — it is stored encrypted and never leaves Listen-Fire.',
      ],
    },
  ),
};

/** The key-entry form spec for a credential type, or undefined if it isn't a
 *  key-entry connectable adapter (OAuth / intrinsic / handshake). */
export function connectFormSpecForType(
  type: ExternalServiceType,
): ConnectFormSpec | undefined {
  return CONNECT_FORM_SPECS[type];
}

/** Whether a credential type can be connected via the browser key-entry form. */
export function isKeyEntryConnectable(type: ExternalServiceType): boolean {
  return connectFormSpecForType(type) !== undefined;
}
