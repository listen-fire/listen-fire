---
"@listen-fire/module-kit": minor
---

A poll's answer may say when the edge is next worth polling (`PollEdgeAnswer.pollAgainAt`, an ISO instant; adapter protocol 2.7): a host speaking 2.7 polls it then when that is sooner than its interval, never sooner than a second on. It is a host behaviour, so a module that answers it states no minor: an older host ignores the member and polls on its interval.
