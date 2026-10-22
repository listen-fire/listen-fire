<!-- hero:start -->
# Listen-Fire

**Automations as plain text: written by agents, reviewed by people, run by an engine.**

Workflow tools store an automation as a diagram in a database, so an agent cannot write one and a reviewer cannot diff one. Listen-Fire stores an automation as a short text file in a language made for the job: it names the systems it touches, walks their records as a graph, and moves data between them. An agent can write the file, a person can read it in a pull request, and the engine runs it on every event, pausing for a person where the program says so.

- **For:** teams who automate across their SaaS tools today with n8n, Zapier or Make, and want the automations in version control.
- **Replaces:** a drag-and-drop workflow. A text file can be authored by an agent, reviewed like code, tested against fake systems, and read again a year later.
- **Proves it:** a three-line listener that copies every new deal from a CRM into a spreadsheet, with `unique by` so a re-run never duplicates a row. The same thing in a visual tool is a diagram nobody can review.
<!-- hero:end -->

## Notes for the test

- Claim under test: plain text plus a graph model is a better home for automations than a visual workflow builder.
- The reader should be able to say back: "it is Zapier where the zap is a file my agent writes and I can review."
- Watch for: readers who expect a visual editor and hear "text" as "harder". The counter is that agents do the writing.
