<!-- hero:start -->
# Listen-Fire

**The automation language for agents.**

When an agent looks after a stream of events, it is called on every one: each webhook, cron tick and inbound email is another model call, and no two calls do quite the same thing.

With Listen-Fire the agent is asked once. Tell it "when I label an email Dealflow, add the company to Attio and tell #dealflow"; it writes a short program, checked against the real fields of your tools, and from then on every matching email is handled the same way, with no agent in the loop and no tokens spent unless the program asks for AI. When the program needs a person, it waits for one.

- **For:** teams building agents that have to react to a stream of events, not answer one prompt.
- **Replaces:** an LLM call on every webhook or cron run. A compiled program is cheaper, deterministic, and the same on the thousandth event as on the first.
- **Proves it:** an agent is told "when a company lands in the inbox, add it to the CRM unless it is already there". It writes a nine-line program; the engine then handles every email without the agent, and posts a button in Slack and waits for the tap before adding a company it is not sure about.
<!-- hero:end -->

## Notes for the test

- Claim under test: an agent writes the automation once and it runs on every event after that, without the agent.
- The reader should be able to say back: "my agent writes the automation, then the automation runs by itself, and it can pause to ask me."
- Watch for: readers who hear "no model in the loop" as "no AI at all". The program can still call a model when it chooses to (`ai(…)`, `extract(…)`); the point is that the engine does not need one to run.
