// The email adapter's manifest: what the catalog, editor, checker and the
// authoring agent read about email without constructing the adapter. The
// inbound address it shows is the deployment's own (`address.ts`).

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { INBOUND_EMAIL_ADDRESS_VAR, inboundRoutingAddress } from './address';
import { EMAILS_EDGE, EMAIL_ADAPTER_ALIASES, EMAIL_ADAPTER_TYPE, EMAIL_KEY_FIELD } from './types';

/** How the deployment's own address reads in prose, for the agent. */
function inboundAddressShape(): string {
  const address = inboundRoutingAddress();
  return address === null ? '<local>+<key>@<domain>' : `${address.prefix}<key>${address.suffix}`;
}

/**
 * Static manifest. Source-only — no write methods (so NOT a target) and no
 * `requiredCredentialType` (inbound creds live on the legacy `pipeline_input`,
 * not a team credential). No meta root.
 */
export const EMAIL_MANIFEST: AdapterManifest = {
  adapterType: EMAIL_ADAPTER_TYPE,
  displayName: 'Email',
  category: 'Email',
  aliases: EMAIL_ADAPTER_ALIASES,
  description:
    'Inbound email. Forward mail to a dedicated address and a movement runs ' +
    'on each message — sender, subject, body, and attachments. Built in; no ' +
    'account to connect.',
  get triggerExpectation() {
    return (
      'Fires once per email actually delivered to the movement\'s dedicated ' +
      `forwarding address (${inboundAddressShape()}) — it does NOT read an ` +
      'existing inbox or see mail sent elsewhere. The user must forward or ' +
      'send mail to that address for it to fire; the listen names the ' +
      'plus-suffix as `e.Key`, so different keys route different mail. Describe it as ' +
      '"when an email is sent to your inbound address", not "when you get an ' +
      'email".'
    );
  },
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'getActorCandidates', 'extractActor', 'resolveFileRef',
  ],
  triggerKinds: ['CUSTOM_EMAIL', 'MAILGUN', 'INBOUND_EMAIL', 'GMAIL'],
  // A 0.12 `listen to inbox { key: "deals" }` is
  // `listen to inbox-[e:Emails WHERE e.Key == "deals"]->` (`listen-fire upgrade`).
  // One with no key heard the mail sent to the box itself (the empty key);
  // 0.12 compared keys lowercased.
  listenSettingsBecome: {
    path: [EMAILS_EDGE],
    aliases: ['e'],
    paramFrom: 'Email',
    keys: { key: { hop: 0, field: EMAIL_KEY_FIELD, op: 'eq', absent: '', lowercase: true } },
  },
  // Without an address there is no door for mail to arrive at, so an author
  // who imports email on such a deployment is writing something that can
  // never fire. That is a gap they are shown, not a boot failure: a
  // deployment that uses no email at all should still start.
  get configurationGap() {
    return inboundRoutingAddress() === null
      ? `${INBOUND_EMAIL_ADDRESS_VAR} is not set, so no address routes mail into a movement`
      : undefined;
  },
  vocabulary: {
    icon: {
      d: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zm16 2l-8 5-8-5v2l8 5 8-5V6z',
      fill: true,
    },
    // Email has one implicit channel, so everything lives under `default`:
    // the same address→tag→bare preference order `describeSource` used to
    // hardcode.
    //
    // The address phrasing says what the reader has to DO, because this
    // channel only ever fires on mail they send to that address themselves
    // (see `triggerExpectation`): "arrives at" reads like a mailbox being
    // watched, which is the one thing it is not. The routing tag below is the
    // honest fallback while nothing has provisioned an address yet — a draft
    // has a tag and no address, and inventing one would name a place mail
    // cannot be sent.
    eventPhrase: {
      default: [
        { template: 'When you send an email to {address}' },
        { template: 'When an email arrives tagged `{key}`' },
        { template: 'When an email arrives' },
      ],
    },
  },
};
