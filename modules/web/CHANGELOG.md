# @listen-fire/web

## 0.12.11

### Patch Changes

- 00fd77c: An index title that gives only a location, such as `Jane Doe - Sverige | Yrkesprofil`, no longer counts as the person's role. `linkedin-research` now reads the profile for such a person, and a location is told to the planner and the synthesiser as a location. A result that rests on the index alone reports low confidence, and `current_role` no longer falls back to the title's text. The `Nothing consistent with the headline` log line now lists the title and address of each search result it was given.
- 1fa4e60: `linkedin-research` finds a core of text about a person more cheaply. It asks `site:linkedin.com/in/<slug>` before the bare address, keeps the snippet of the profile's own index entry, and counts the person's own profile and post results from those searches as evidence. The planner sees that snippet and the new optional `context` input. It writes up to two queries, and a location alone is never what a query searches on. It also says whether anything ties the person down, and the paid profile read now runs only when nothing does. If no result names the person with a consistency term, it retries once. The ceiling is four searches including the identity ones, two fetches, three planner calls, one writing call and three minutes, and the profile wait is shortened to what the three minutes have left.
  
  A location ties nobody down, so it is never a consistency term: the planner is told not to write one, and the writing model gets the location on its own line as support for a result that matches a term, never as a reason to accept one. The caller's `context` may still suggest terms and may settle that the person is tied down, but the organisation reported is read from the headline, the index or the profile and never from the context alone.
  
  The new optional output `activity_text` holds the passages that name the person and a consistency term, each under its source address. When the writing model finds nothing but such passages exist, only `activity_text` comes back: no `activity_summary` and no `activity_confidence`. Text with no summary means the research could not confirm anything beyond it, and a program that does not read `activity_text` sees what it saw before.
  
  Confidence is `low` when the accepted sources are only the person's own LinkedIn addresses, or when nothing tied the person down and no profile text was read. Otherwise the writing model's confidence stands.
  
  The shared profile reader behind `research` and `linkedin-research` now also reads the hosted reader's labelled form, taking the name from `Name:` and the headline from `Position:` and leaving them absent when those lines are missing; it took the first line literally before. Standalone search carries each result's plain text `extensions` into its snippet, ahead of the description, skipping sitelinks and anything the description already says.

## 0.12.10

### Patch Changes

- 384e46d: `linkedin-research` reads the profile when its headline is a placeholder ("Stealth", "Stealth Startup", "Self-employed", "Independent", "Freelance"), the same as when there is no headline. Before, a placeholder counted as a role, so the profile was never read and the search ran on the bare name, which finds namesakes. The query planner now sees the profile text and searches on the person's founder history. A run that read the profile is no longer capped at low confidence. For a stealth founder, the summary leads with their previous venture, and `current_organisation` names it as a likely guess. The general `research` plugin reads profiles through the same rule, so it reads stealth profiles too.

## 0.12.9

### Patch Changes

- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.12.8

### Patch Changes

- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.7

### Patch Changes

- c49a3ee: A gated document source whose crawl fails now raises its alert even when the host cannot keep the screenshot of the failed page. The screenshot step alone is guarded: a screenshot that cannot be taken or kept is logged and the alert names none, where before the storage failure swallowed the alert.
- 50a00c7: DocSend's consent banner and drawer tab no longer cover the email gate or reach the slide captures. A stylesheet rule hides them on the page's document before the gate is filled and again before the slides are captured, where a one-off check hid them only if already visible and lost the race to a banner that grows in a moment later.
- ca7379e: A gated document source no longer waits for the share page's `load` event, which a viewer's trackers can hold open past the navigation timeout and so lose a deck already on screen. Navigation waits for the DOM, then for the source's own sign that it has rendered: DocSend waits for its email gate, its Spaces gate or listing, its viewer, or a hand-off to another site, and fails naming that when none appears in 30 s; a source without its own signal gives `load` 30 s and carries on without it.
- d60df8b: A Papermark link is read as a PDF of its pages, one screenshot each, as a DocSend deck is. The crawler waits for the gate or the viewer instead of a fixed six seconds, fills an email or password gate and submits once Continue enables, then turns through the horizontal viewer or scrolls the vertical one, waiting for each page's image to load. A page it does not recognise goes to the AI fallback instead of failing with "Failed to authenticate". It refuses, saying which, the gates a crawler must not push through: an NDA, a one-time code sent to an inbox, and an email gate with no email given.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
