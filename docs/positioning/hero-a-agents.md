<!-- hero:start -->
# Listen-Fire

**Agents write it. Listen-Fire runs it.**

Every webhook, cron tick and inbound email that an agent handles today costs a model call, and no two calls do quite the same thing. Listen-Fire is the layer that takes that work off the model: an agent reads the language handbook once and writes a small program, and the engine then runs that program on every event with no model in the loop. A run is fast, costs nothing per event, leaves an audit trail, and can still stop and wait for a person when the program says so.

- **For:** teams building agents that have to react to a stream of events, not answer one prompt.
- **Replaces:** an LLM call on every webhook or cron run. A compiled program is cheaper, deterministic, and the same on the thousandth event as on the first.
- **Proves it:** an agent is told "when a company lands in the inbox, add it to the CRM unless it is already there". It writes a nine-line program; the engine then handles every email without the agent, and posts a button in Slack and waits for the tap before adding a company it is not sure about.
<!-- hero:end -->

## Notes for the test

- Claim under test: a program an agent writes once beats a model call per event.
- The reader should be able to say back: "my agent writes the automation, then the automation runs by itself, and it can pause to ask me."
- Watch for: readers who hear "no model in the loop" as "no AI at all". The program can still call a model when it chooses to (`ai(…)`, `extract(…)`); the point is that the engine does not need one to run.
