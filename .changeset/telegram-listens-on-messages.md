---
"@listen-fire/telegram": minor
---

Telegram is listened to on `Messages`, a root edge (``listen to tg-[m:Messages WHERE m.`Chat Id` == "42"]-> fire f``, ``function f(m: <tg-[:Messages]->>)``): each message the bot receives is an arrival landing on the `Message`, named by `Id` (the chat and the message id, since Telegram numbers a message within its chat) and at the time of its `date`. Telegram cannot list chats, so a listen narrows to one by the message's `Chat Id`. Adapter protocol 2.6. It declares how a 0.12 `listen to tg {} fire f` becomes a listen on `Messages` (`listenSettingsBecome`). `listEventTypes`, the `fires` edge `Message` and `telegramInboundEvents` are gone: `preprocessInbound` answers `arrivals`, no events (`telegramInboundArrivals` is the parse).
