# @listen-fire/web

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
