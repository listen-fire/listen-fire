---
"@listen-fire/module-kit": patch
---

A module that checks its own inbound requests can answer a page: `reply(status, { html })`, sent as `text/html`. `accepted(events, { arrivals, reply })` names what the door answers once it has kept the request, in place of its own acknowledgement (a page saying an answer was recorded). `ctx.config.inboundUrl` is where the install's inbound requests reach the module, when the host sends it (`inbound: { url }` on the request): a module hands out links to itself with it.
