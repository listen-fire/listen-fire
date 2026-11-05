---
'@listen-fire/web': patch
---

`linkedin-research` finds a core of text about a person more cheaply. It asks `site:linkedin.com/in/<slug>` before the bare address, keeps the snippet of the profile's own index entry, and counts the person's own profile and post results from those searches as evidence. The planner sees that snippet and the new optional `context` input. It writes up to two queries, and a location alone is never what a query searches on. It also says whether anything ties the person down, and the paid profile read now runs only when nothing does. If no result names the person with a consistency term, it retries once. The ceiling is four searches including the identity ones, two fetches, three planner calls, one writing call and three minutes, and the profile wait is shortened to what the three minutes have left.

A location ties nobody down, so it is never a consistency term: the planner is told not to write one, and the writing model gets the location on its own line as support for a result that matches a term, never as a reason to accept one. The caller's `context` may still suggest terms and may settle that the person is tied down, but the organisation reported is read from the headline, the index or the profile and never from the context alone.

The new optional output `activity_text` holds the passages that name the person and a consistency term, each under its source address. When the writing model finds nothing but such passages exist, only `activity_text` comes back: no `activity_summary` and no `activity_confidence`. Text with no summary means the research could not confirm anything beyond it, and a program that does not read `activity_text` sees what it saw before.

Confidence is `low` when the accepted sources are only the person's own LinkedIn addresses, or when nothing tied the person down and no profile text was read. Otherwise the writing model's confidence stands.

The shared profile reader behind `research` and `linkedin-research` now also reads the hosted reader's labelled form, taking the name from `Name:` and the headline from `Position:` and leaving them absent when those lines are missing; it took the first line literally before. Standalone search carries each result's plain text `extensions` into its snippet, ahead of the description, skipping sitelinks and anything the description already says.
