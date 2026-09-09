import { z } from 'zod';

import { anthropicChatStructured } from '../../../lib/anthropic';
import { currentContext } from '../../../services/context';
import { getAdapterManifest } from '../../../services/translation_graph/adapters/registry';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';

/**
 * Suggests concrete automation ideas for the lobby's Step 3, tailored to the
 * tools the user ticked. One forced-tool Sonnet call: the schema IS the tool
 * input, so the reply is validated JSON by construction — no prose parsing, no
 * thinking budget to blow through, and latency low enough (~6s) to re-draft on
 * every picker change (the card generates from two picks and redrafts per
 * selection). Haiku was tried and is ~2x faster, but reliably violates the
 * negative capability rules (kept proposing CRM-triggered WhatsApp
 * "notifications" dressed up as replies); Sonnet holds them.
 *
 * The ideas are grounded in each adapter's real capabilities — its manifest
 * `description` and, crucially, `triggerExpectation` (the honest account of what
 * a listener actually fires on). Without this the model invents capabilities
 * that don't exist — e.g. implying Listen-Fire can read arbitrary WhatsApp messages
 * rather than only ones the user forwards to the Listen-Fire number.
 *
 */

const IDEA_COUNT = 4;

const IdeasSchema = z.object({
  // Sonnet 5 mangles nested-array tool arguments in observed ways: the array
  // arrives as a JSON *string*, as a keyed *object* ({"0": …}), or wrapped in
  // an extra object ({"ideas": […]}). Recover all three at the boundary;
  // genuinely wrong items still fail item-level validation below.
  ideas: z.preprocess(
    (v) => {
      let value = v;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          return v;
        }
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const vals = Object.values(value);
        value = vals.length === 1 && Array.isArray(vals[0]) ? vals[0] : vals;
      }
      return value;
    },
    z
      .array(
        z.object({
          tag: z.string().min(1).max(24).describe('One-word category, e.g. Dealflow, Portfolio, LPs, Ops'),
          text: z.string().min(1).max(400).describe('The automation ask, first-person, under 30 words'),
        }),
      )
      .min(1)
      .max(IDEA_COUNT),
  ),
});

const SYSTEM = `You help a venture investor set up automations across the tools they use. You are given the user's tools AND the honest facts about what each tool can actually do in Listen-Fire. Propose ${IDEA_COUNT} concrete, useful automations — the routine work an investor at a small VC firm wants off their plate (dealflow, portfolio tracking, LP updates, back-office). If the tool mix genuinely can't support ${IDEA_COUNT} grounded ideas, give fewer rather than invent capabilities.

Rules:
- Ground every idea strictly in the capability facts provided. Never imply a tool can do something the facts don't support.
- Respect how each trigger actually fires. Several channels (e.g. WhatsApp, Telegram, Email) are shared Listen-Fire addresses/numbers that only carry messages the USER THEMSELVES sends, identified from their own linked account — so always phrase them first-person ("When I forward…", "When I send a note to…"). Never write these as a third party (a founder, an LP) messaging the number/address — their messages are not recognised. Never imply Listen-Fire watches someone's inbox, chats, or channels it doesn't.
- A write-only destination can only be a place data goes, not a trigger.
- Listen-Fire can only send a WhatsApp message as a reply within a run that a WhatsApp message from the user started. A run triggered by anything else (a CRM change, new data, a schedule) can never message the user on WhatsApp — never propose it as a notification channel, and calling the notification a "reply" (or deferring it to "the next message") doesn't make it one. If the mix leaves WhatsApp nothing honest to do in an idea, use it in fewer ideas.
- Listen-Fire cannot send emails. Email is only ever a source of content the user forwards in, never a destination or notification channel.
- Listen-Fire cannot browse or search Google Drive — only the folders/files the user explicitly granted, though it can read and write within those.
- Each idea is ONE first-person, effect-level ask, e.g. "When I forward a pitch email, get the company, founder and key deck details into Attio as a new deal."
- One or two sentences, under 30 words. Say the outcome, not the configuration — no field names, no step-by-step, and never Listen-Fire-internal words like "movement" or "automation run"; describe what happens in the user's own tools.
- Only use the tools you are given. Prefer ideas that combine two of them.
- Before finalising, re-check each idea's trigger AND each message it sends against the capability facts. Two honest ideas beat four where one breaks a fact — drop the violator, don't rephrase it.`;

/** Capability limits the manifests don't carry, stated per tool alongside its
 *  trigger facts — the model grounds ideas in this block far more reliably
 *  than in a generic rule list (a system-prompt-only WhatsApp rule still
 *  produced "send me a WhatsApp when the CRM changes" ideas). */
const CAPABILITY_CAVEATS: Record<string, string> = {
  whatsapp:
    'Sending: can ONLY reply within a run that a WhatsApp message from the user started. A run triggered by anything else (a CRM change, new data, a schedule) can never send the user a WhatsApp message — not even by replying to a later or "next" message. It is not a notification channel.',
  email:
    'Sending: none. Listen-Fire cannot send email — email is purely a source of content the user forwards in.',
  google_drive:
    'Access: only the folders and files the user has explicitly granted in the picker — no browsing or searching the rest of the Drive. Within granted folders it can read, and write new files and folders.',
};

/** Turn the selected adapter slugs into grounding facts from their manifests:
 *  what each tool is, and the honest truth about how it triggers. */
function groundingFacts(slugs: string[]): { names: string[]; facts: string } {
  const manifests = slugs
    .map((slug) => (getAdapterManifest(slug) ? { slug, manifest: getAdapterManifest(slug)! } : null))
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const facts = manifests
    .map(({ slug, manifest: m }) => {
      const trigger = m.triggerExpectation
        ? m.triggerExpectation
        : m.supportedTriggers.length === 0
          ? 'Write-only destination — automations can send data to it but cannot be triggered by it.'
          : 'Fires on changes in the connected account.';
      const caveat = CAPABILITY_CAVEATS[slug];
      return `### ${m.displayName}\n${m.description ?? ''}\nTrigger surface: ${trigger}${
        caveat ? `\n${caveat}` : ''
      }`;
    })
    .join('\n\n');

  return { names: manifests.map(({ manifest }) => manifest.displayName), facts };
}

const workflowIdeasRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    generate: userProcedure
      .input(
        z.object({
          // adapter slugs, e.g. 'attio', 'whatsapp', 'google_sheets'
          services: z.array(z.string().min(1).max(40)).min(1).max(12),
        }),
      )
      .mutation(async ({ input }) => {
        const { names, facts } = groundingFacts(input.services);
        if (names.length === 0) throw new Error('No known tools selected');

        const generate = () =>
          anthropicChatStructured({
            system: SYSTEM,
            userMessage: `Tools the user uses: ${names.join(', ')}.

Exactly what each can do — ground every idea in these facts:

${facts}`,
            schema: IdeasSchema,
            toolName: 'propose_ideas',
            toolDescription: 'Propose the automation ideas for this tool mix.',
            model: 'claude-sonnet-5',
            maxTokens: 1200,
            label: 'workflow-ideas',
          });

        // One bounded retry: structured failures (truncation, missing/invalid
        // tool call) are rare and transient once the tool is forced.
        try {
          return await generate();
        } catch {
          return await generate();
        }
      }),
  });
};

export { workflowIdeasRouter };
