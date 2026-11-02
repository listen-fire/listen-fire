---
"@listen-fire/slack": patch
---

A thread reply arrives with its channel, as a message does, and `Replies` declares that it carries `Channels`. So a listen on a thread's replies narrows by the channel's name, `listen to chat-[ch:Channels WHERE ch.Name == "deals"]->-[:Messages]->-[:Replies]-> fire f`, where before it was refused at check (`MOV_LISTEN_UNWATCHABLE`). A reply does not carry its root message: a filter on that message stays refused.
