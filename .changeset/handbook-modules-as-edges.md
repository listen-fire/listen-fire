---
"@listen-fire/handbook": patch
---

The handbook's inbox, schedule and manual listens are written on their edges: `inbox-[e:Emails WHERE e.Key == "intake"]->`, `timer-[k:Ticks WHERE k.Schedule == "0 9 * * 1"]->`, `manual-[:Invocations]->`, each function typed by the edge it fires on (`<inbox-[:Emails]->>`). The listeners chapter says a listen is a traversal ending on the edge its events arrive on. Its captured catalog carries the 0.13 shapes of email, cron and manual.
