// WhatsApp's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// WhatsApp without loading the adapter.
//
// The number people message belongs to the deployment, so the host names it:
// the platform quotes its shared number; a host with none (listen-fire, where the
// number is the user's own) quotes no number.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { WHATSAPP_HANDBOOK_SECTION } from './handbook_section';
import { WHATSAPP_ADAPTER_TYPE, WHATSAPP_ARRIVAL_EDGES, WHATSAPP_LOCATION_DISPLAY_NAME, WHATSAPP_MESSAGE_DISPLAY_NAME, WHATSAPP_REACTION_DISPLAY_NAME } from './types';

/** What a 0.12 listen hearing one kind of inbound record becomes: a listen on
 *  the root edge it arrives on. It had no settings besides `events`, so no
 *  key maps. */
const arrivingOn = (edge: string, alias: string, paramFrom: string) => ({ path: [edge], aliases: [alias], paramFrom, keys: {} });
const MESSAGES_BECOME = arrivingOn(WHATSAPP_ARRIVAL_EDGES.message, 'm', WHATSAPP_MESSAGE_DISPLAY_NAME);

/**
 * Source and target: a listen on `Messages`, `Reactions` or `Locations`
 * receives each message (text and media), reaction and location; a write replies, reacts or shows typing along a
 * message's edges. No `requiredCredentialType`: on the platform WhatsApp takes
 * no team credential (its one Meta app sends for every team). No meta root.
 */
export function whatsappManifest(movementsNumber: string | null): AdapterManifest {
  return {
    adapterType: WHATSAPP_ADAPTER_TYPE,
    displayName: 'WhatsApp',
    website: 'https://www.whatsapp.com',
    category: 'Messaging',
    description:
      `WhatsApp: message the number${movementsNumber ? ` (${movementsNumber})` : ''} and a movement ` +
      'runs on each message — text and media included (voice notes transcribe). ' +
      'Movements can reply (threaded), react with an emoji, and show the typing ' +
      "indicator. Where the number is the project's own (listen-fire), every message sent to it " +
      'reaches its movements; on the shared Listen-Fire number, the sender\'s phone ' +
      'must first be linked to their Listen-Fire account, or their messages are ignored.',
    authoringHints:
      'Listen on the edge the record arrives on: Messages, Reactions (somebody reacting to a ' +
      'message) or Locations, each its own record type. A conversation is the sender\'s number, ' +
      'so narrow to one by From: wa-[m:Messages WHERE m.From == "447700900001"]->. A message is ' +
      'the whole record: read m.Body, reply along m-[:Replies]->.',
    supportedTriggers: ['webhook'],
    methods: [
      'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'preprocessInbound',
      'getActorCandidates', 'extractActor', 'resolveFileRef', 'createRecord',
    ],
    // A 0.12 `listen to wa { events: [...] }` heard messages when it named no
    // events, and otherwise the kinds it named; each kind arrives on its own
    // edge, so one naming two has no rewrite (`listen-fire upgrade`).
    listenSettingsBecome: {
      ...MESSAGES_BECOME,
      byEvent: {
        message: MESSAGES_BECOME,
        reaction: arrivingOn(WHATSAPP_ARRIVAL_EDGES.reaction, 'r', WHATSAPP_REACTION_DISPLAY_NAME),
        location: arrivingOn(WHATSAPP_ARRIVAL_EDGES.location, 'l', WHATSAPP_LOCATION_DISPLAY_NAME),
      },
    },
    triggerKinds: ['INBOUND_WHATSAPP', 'TWILIO'],
    triggerExpectation:
      `A listen on Messages runs when a WhatsApp message arrives at the number` +
      `${movementsNumber ? ` (${movementsNumber})` : ''} — each message (text and media; ` +
      `voice notes transcribe) once; one on Reactions runs when somebody reacts to a message, ` +
      `and one on Locations when somebody shares a location (a reaction never runs a listen on ` +
      `Messages). Who reaches the movements depends on whose ` +
      `number it is. Where the number is the project's own (listen-fire), every message sent to it ` +
      `reaches the listen, from any sender. On the shared Listen-Fire number, common to ` +
      `every Listen-Fire user, routing identifies the sender by their linked phone, so ONLY ` +
      `messages the user sends from their own linked number reach their movements; a ` +
      `message from anyone else is unrecognized and dropped, so frame it first-person ` +
      `("when I forward or send … to the Listen-Fire number"). Either way it never reads ` +
      `anyone's WhatsApp chats or groups.`,
    handbookSection: WHATSAPP_HANDBOOK_SECTION,
    vocabulary: {
      icon: {
        d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
        fill: true,
      },
      eventPhrase: {
        // No per-event phrasing today (`message` / `reaction` / `location`
        // all shared the same generic sentence in the former switch) —
        // `default` mirrors that, channel→tag→bare.
        default: [
          { template: 'When a WhatsApp message arrives in {channel}' },
          { template: 'When a WhatsApp message arrives in `{key}`' },
          { template: 'When a WhatsApp message arrives' },
        ],
      },
    },
  };
}

/** The manifest with no number quoted. */
export const WHATSAPP_MANIFEST: AdapterManifest = whatsappManifest(null);
