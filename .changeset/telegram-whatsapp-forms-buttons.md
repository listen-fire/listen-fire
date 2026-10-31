---
"@listen-fire/telegram": patch
"@listen-fire/whatsapp": patch
---

The handbook sections and the `Reply Markup` (Telegram) and `Interactive` (WhatsApp) field descriptions teach a url button that opens a form from `@lf/forms` (`form = write forms-[:Forms]-> { Title: …, Fields: … }`, its `form.Url` on the button, then `await form-[:Submissions]->`), in place of a callback id on the button: `callback(…)` retired at 0.13. A `callback_data` or reply button's tap reaches no run until these modules report taps as `Interactions`, as Slack does.
