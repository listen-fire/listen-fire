<!-- hero:start -->
# Listen-Fire

**Automations your agent can write and you can read.**

Today your automations live in a workflow tool as a diagram of nodes. Nobody can read one back a year later, your agent cannot write one at all, and every change is a click nobody recorded.

With Listen-Fire an automation is a short text file. Tell your agent "when a deal is marked won in the CRM, add a row to the onboarding sheet and tell #customers"; it writes the file, checked against the real fields of your tools, and from then on every won deal is handled the same way. You can read the file back, see what changed and when, and have the agent change it for you. On the hosted platform no terminal is involved.

- **For:** teams who automate across their SaaS tools today with n8n, Zapier or Make.
- **Replaces:** a drag-and-drop workflow. A text file can be written by an agent, read by a person, and read again a year later.
- **Proves it:** the won-deal automation above is a dozen lines, and running it twice never adds the row twice.
<!-- hero:end -->

## Notes for the test

- Claim under test: a short text file is a better home for an automation than a diagram in a workflow tool, because an agent can write it and a person can read it.
- The reader should be able to say back: "it is my zaps as files my agent writes and I can read."
- Watch for: non-engineers hearing "text file" as "code I must write". The counter is that the agent writes it; the person reads it.
