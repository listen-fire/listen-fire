// Slack's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Slack without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { SLACK_HANDBOOK_SECTION } from './handbook_section';
import { SLACK_MESSAGES_EDGE_NAME, SLACK_MESSAGE_TYPE_NAME, SLACK_REACTIONS_EDGE_NAME, SLACK_REACTION_TYPE_NAME, SLACK_REPLIES_EDGE_NAME } from './inbound';
import { SLACK_CHANNELS_COLLECTION } from './read_graph';
import { SLACK_ADAPTER_TYPE } from './types';

/** 0.12's `channels: [...]`: the channels a listen heard, by name. */
const CHANNEL_NAMES = { hop: 0, field: 'Name', op: 'in' } as const;

/** 0.12's `events: ["app_mention"]`: a message that names the app. */
const MENTIONS = { hop: 1, field: 'Mentions App', op: 'eq', values: { app_mention: true } } as const;

/** 0.12's `events` at the top level: a mention, as above; left out, the
 *  listen heard every message and every reaction, two edges. */
const EVENTS = { ...MENTIONS, absent: ['message', 'reaction_added'] };

/** What a 0.12 listen hearing messages becomes: a listen on a channel's
 *  `Messages`, its channels compared by name. */
const MESSAGES_BECOME = {
  path: [SLACK_CHANNELS_COLLECTION, SLACK_MESSAGES_EDGE_NAME],
  aliases: ['ch', 'm'],
  paramFrom: SLACK_MESSAGE_TYPE_NAME,
  keys: { channels: CHANNEL_NAMES },
};

/** A 0.12 `message` or `app_mention` listen heard thread replies too, which
 *  arrive on their root message's `Replies`: two edges, so no one rewrite. */
const REPLIES_TOO = { alsoArrivesOn: [[SLACK_CHANNELS_COLLECTION, SLACK_MESSAGES_EDGE_NAME, SLACK_REPLIES_EDGE_NAME]] };

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. Slack is BOTH source (inbound text + attachments) and
 * target (its `createRecord` posts a message / thread reply — a real write, so
 * Slack is a usable destination).
 *
 */
export const SLACK_MANIFEST: AdapterManifest = {
  adapterType: SLACK_ADAPTER_TYPE,
  displayName: 'Slack',
  website: 'https://slack.com',
  category: 'Messaging',
  description:
    'Slack. Post messages into channels from your movements, run movements ' +
    'on inbound Slack activity, and read the workspace graph — channels, ' +
    'members, message history and threads.',
  triggerExpectation:
    'Slack only delivers the events its app is subscribed to in the Slack ' +
    'admin — it does NOT see every message by default. A listen on a channel\'s ' +
    'Messages runs on each top-level message in the channels it names that Slack ' +
    'sends (message.channels for public channels, which many teams do not enable); ' +
    'the common setup is @-mentions of the bot, narrowed with ' +
    'm.`Mentions App` == true. So do not promise "every message in a channel" — if ' +
    'the user wants all-message capture, tell them it depends on their Slack app\'s ' +
    'subscriptions and ask. A listen on a message\'s Reactions runs on each emoji ' +
    'added, and on its Interactions on each button press (one run per press). ' +
    'Also: a listener only fires when the message\'s SENDER (or the person who ' +
    'reacted) resolves to a registered member of this team (matched by Slack ' +
    'profile email). Activity from unregistered people — guests, external ' +
    'members of shared channels, other bots, and Listen-Fire\'s own posts — is dropped ' +
    'before any automation runs, so do not promise runs on activity from people ' +
    'outside the team.',
  authoringHints:
    'Listen on the edge the record arrives on, each its own record type: a channel\'s ' +
    'Messages (a Message), a message\'s Replies (a Message in its thread), Reactions (a ' +
    'Reaction) or Interactions (an Interaction, a button press). Each arrives with its ' +
    'channel, and a press with its message too, so narrow on them in the traversal: ' +
    'chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[m:Messages WHERE m.`Mentions App` == true]->. ' +
    'A reply or a reaction does not carry the message it is under: filter a Replies or ' +
    'Reactions listen by channel only (chat-[ch:Channels WHERE ch.Name == "deals"]->-[:Messages]->-[:Replies]->). ' +
    'Write a Topic with a message\'s Buttons to listen to its presses alone: ' +
    'chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll" AND m.Timestamp WITHIN 3d]->-[:Interactions]->.',
  inboundRequiresRegisteredActor: true,
  handbookSection: SLACK_HANDBOOK_SECTION,
  supportedTriggers: ['webhook'],
  // A 0.12 `listen to chat { channels, events }` heard messages and mentions,
  // thread replies among them, and reactions. A message now arrives on its
  // channel's `Messages`, a reply on its root's `Replies` and a reaction on
  // its message's `Reactions`, so only a `reaction_added` listen has one
  // rewrite: any other is told to write one listen for each edge.
  listenSettingsBecome: {
    ...MESSAGES_BECOME,
    keys: { ...MESSAGES_BECOME.keys, events: EVENTS },
    byEvent: {
      message: { ...MESSAGES_BECOME, ...REPLIES_TOO },
      app_mention: { ...MESSAGES_BECOME, ...REPLIES_TOO, keys: { ...MESSAGES_BECOME.keys, events: MENTIONS } },
      reaction_added: {
        path: [SLACK_CHANNELS_COLLECTION, SLACK_MESSAGES_EDGE_NAME, SLACK_REACTIONS_EDGE_NAME],
        aliases: ['ch', 'm', 'r'],
        paramFrom: SLACK_REACTION_TYPE_NAME,
        keys: { channels: CHANNEL_NAMES },
      },
    },
  },
  // `createRecord` posts a message — a real write (so Slack is writable).
  // `updateRecord` / `deleteRecord` are deliberately NOT listed: Slack's
  // overrides throw (the v3 output only ever posts), so they aren't genuine
  // implementations.
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'preprocessInbound',
    'getActorCandidates', 'extractActor', 'resolveFileRef',
    'createRecord', 'invokeFieldFunction', 'awaitKeys',
  ],
  requiredCredentialType: 'SLACK',
  triggerKinds: ['SLACK'],
  vocabulary: {
    icon: {
      d: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
      fill: true,
    },
    eventPhrase: {
      // One sentence for every Slack arrival, channel→routing-key→bare.
      default: [
        { template: 'When a Slack message arrives in {channel}' },
        { template: 'When a Slack message arrives in `{key}`' },
        { template: 'When a Slack message arrives' },
      ],
    },
  },
};
