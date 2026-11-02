# @listen-fire/telegram

## 0.13.0

### Minor Changes

- be7cd14: Telegram is listened to on `Messages`, a root edge (``listen to tg-[m:Messages WHERE m.`Chat Id` == "42"]-> fire f``, ``function f(m: <tg-[:Messages]->>)``): each message the bot receives is an arrival landing on the `Message`, named by `Id` (the chat and the message id, since Telegram numbers a message within its chat) and at the time of its `date`. Telegram cannot list chats, so a listen narrows to one by the message's `Chat Id`. Adapter protocol 2.6. It declares how a 0.12 `listen to tg {} fire f` becomes a listen on `Messages` (`listenSettingsBecome`). `listEventTypes`, the `fires` edge `Message` and `telegramInboundEvents` are gone: `preprocessInbound` answers `arrivals`, no events (`telegramInboundArrivals` is the parse).

### Patch Changes

- cf98af4: Examples wait with `await x-[:E]->` in place of the retired `await first(x-[:E]->)`, which a 0.13 check respells. The handbook drops its common-mistakes entry against writing `await` before a bare walk, which is now the form.
- 69fbb49: The handbook sections and the `Reply Markup` (Telegram) and `Interactive` (WhatsApp) field descriptions teach a url button that opens a form from `@lf/forms` (`form = write forms-[:Forms]-> { Title: …, Fields: … }`, its `form.Url` on the button, then `await form-[:Submissions]->`), in place of a callback id on the button: `callback(…)` retired at 0.13. A `callback_data` or reply button's tap reaches no run until these modules report taps as `Interactions`, as Slack does.
- bd3b097: The handbook section's form example waits for the submission inside a `race` with a `sleep`, so a form nobody answers ends the wait after a day.
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

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
