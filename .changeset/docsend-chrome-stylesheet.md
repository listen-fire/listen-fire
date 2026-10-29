---
"@listen-fire/web": patch
---

DocSend's consent banner and drawer tab no longer cover the email gate or reach the slide captures. A stylesheet rule hides them on the page's document before the gate is filled and again before the slides are captured, where a one-off check hid them only if already visible and lost the race to a banner that grows in a moment later.
