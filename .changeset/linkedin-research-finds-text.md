---
'@listen-fire/web': patch
---

`linkedin-research` finds a core of text about a person more cheaply. It asks `site:linkedin.com/in/<slug>` before the bare address, keeps the snippet of the profile's own index entry, and counts the person's own profile and post results from those searches as evidence. The planner sees that snippet and the new optional `context` input. It writes up to two queries, and a location alone is never what a query searches on. It also says whether anything ties the person down, and the paid profile read now runs only when nothing does. If no result names the person with a consistency term, it retries once. The ceiling is four searches including the identity ones, two fetches, three planner calls, one writing call and three minutes.

The new optional output `activity_text` holds the passages that name the person and a consistency term, each under its source address. When the writing model finds nothing but such passages exist, it comes back with `activity_confidence: 'low'` and no `activity_summary`.

The shared profile reader behind `research` and `linkedin-research` now also reads the hosted reader's `Name:` and `Position:` lines, which it took literally before. Standalone search carries each result's `extensions` text into its snippet, ahead of the description.
