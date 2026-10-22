# Positioning tests

The README's hero block sits between `<!-- hero:start -->` and `<!-- hero:end -->`. Each file here is a drop-in replacement for it: copy the block between the same markers over the README's, leave the rest of the README alone.

| file | hypothesis | the competitor it names |
|---|---|---|
| [`hero-a-agents.md`](hero-a-agents.md) | agent builders: *agents write it, Listen-Fire runs it* | a model call on every webhook or cron run |
| [`hero-b-workflows.md`](hero-b-workflows.md) | workflow automation: automations as plain text | n8n, Zapier, Make |
| [`hero-c-embedded.md`](hero-c-embedded.md) | embedded automation for SaaS products | a home-grown rules engine |

Hero A is the lead hypothesis and is the one in the README. The VC CRM automation that Listen-Fire grew out of is the worked example in every variant, not the identity.

## Persona rehearsal, 2026-10-22

A cheap proxy for a test with people: four model-played personas were each shown all three hero blocks, with no access to the repository, and asked to explain hero A back, say what they would use it for, name what they misread, pick the hero that landed, and ask one question. The prompts and answers are summarised here; the exercise is worth repeating whenever a hero changes.

Personas: an engineer at a startup building a support agent (A's target); a revenue operations lead who owns sixty zaps (B's target); a staff engineer at a B2B SaaS with "customer automations" on the roadmap (C's target); a VC associate who does two hours of CRM entry a day (the original use case).

**Explain-back.** All four restated hero A correctly: an agent writes a small program once, the engine runs it on every event without a model call, and it can pause for a person.

**Which hero landed.** Each persona picked the hero aimed at them. The VC associate picked A, because its example is their job, while saying A's framing ("teams building agents") is not them.

**Shared gaps in hero A**, each now answered in the README's "How it works" section:

- "No model in the loop" read as "no AI at all" to two of four. Both asked whether a program can call a model for one fuzzy step and stay deterministic around it. (It can: `ai(…)` and `extract(…)`.)
- Three of four could not tell which systems it connects. Hero A names none.
- Two of four could not tell whether they install it or someone hosts it.
- "Compiled", "engine", "layer", "handbook" and "deterministic" were called developer words by the two non-engineers.

**The one question each would ask before trying it:**

- Agent builder: can a program call a model for one step and keep everything else deterministic?
- Ops lead: can my AI assistant rebuild one of my zaps against my connected HubSpot and Slack, with no code or repo?
- SaaS engineer: where does a paused run's state live, and can I keep it in my own Postgres per tenant?
- VC associate: can I get this working with Affinity and Gmail without a terminal, and what does it cost a month?

**What to change if hero B or C becomes the lead.** B's non-engineer reader was lost by "diff", "pull request" and "version control"; say "reviewed like a document" before "reviewed like code". C's reader wanted proof of the tenant boundary and the run store, not a phrase; lead with the embed example's test.

## Second rehearsal, 2026-10-22, heroes B and C in the contrast register

After the README hero was rewritten to open on the default and what is wrong with it, B and C were rewritten the same way and each shown to its own target persona.

**B (the ops lead).** Explained it back correctly and named the exact zap they are afraid to touch. Lost by "tested against fake systems" and by `unique by`; both are now out of the hero. Would close the tab on finding a terminal or GitHub is needed, and asked whether their assistant could rewrite an existing zap with no engineer. So hypothesis B only lands with the hosted platform in the pitch; the hero now says so in one sentence.

**C (the SaaS engineer).** Explained it back correctly and mapped it onto the roadmap item. Wanted concreteness, not reassurance: what exactly they implement (now: describe your product once as a module, answer requests for data, AI, the clock and storage), what a paused run is in practice (now: wait three days, then act), and tenant isolation and limits (now: every run sees one tenant only and stops at the limits you set). Would close the tab on no answer about sandboxing customer-written programs: CPU, memory, loops, cross-tenant leakage. The hero answers tenant and spend limits; CPU and memory limits are not claimed because the engine does not enforce them.
