# @lf/slack

Slack as a module: post messages, read the workspace (channels, members, history, threads), and listen to a channel's `Messages`, a message's `Reactions` and its `Interactions`. The handbook section (`handbook_section.ts`) is what an author reads; this file is for whoever runs the host.

## Operator settings

Each Slack delivery (a message, a reaction, a press) may need two lookups the delivery does not carry: the channel's name (`conversations.info`, kept a minute) and the app's bot user (`auth.test`, kept an hour), which `Mentions App` compares. Slack wants an answer to a delivery within three seconds, so these lookups are bounded. A lookup that fails is not retried and does not hold the delivery: the arrival goes on without what it could not read, and a listen that needed it cannot be judged.

Set in the install's environment (`env:` in the module's lf-external.yaml, as any module takes its settings). A value that is not a whole number in range is the default.

| setting | default | what it bounds |
|---|---|---|
| `SLACK_LOOKUP_TIMEOUT_MS` | 2000 | how long one lookup may take (at least 1) |
| `SLACK_LOOKUP_RETRIES` | 0 | how many times a failed lookup is asked again; a rate-limited one never is |
| `SLACK_LOOKUP_FAILURE_CACHE_MS` | 5000 | how long a failed lookup answers its failure before Slack is asked again, so an outage is not asked once per delivery (0: not kept) |

Deliveries arriving together that need the same lookup ask Slack once.
