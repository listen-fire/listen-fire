# Triage GitHub into Slack every morning

You ask your agent:

> Every weekday at 8:30, post the GitHub notifications that need me (review requests and mentions) to Slack as one message.

It writes a program. The checker catches its mistake before anything runs. Then the program runs every morning with no model, at no cost.

All the output below is real. You can reproduce it from a clone with no accounts: a fake GitHub and a fake Slack stand in for the real ones.

## The program

`movements/triage.mvt`:

```
gh   = connect `@lf/github` using my_github
chat = connect `@lf/slack` using my_slack

function triage(t: <cron-[:Ticks]->>) {
  lines = gh-[n:Notifications WHERE n.Reason IN ["review_requested", "mention"] ORDER BY n.`Updated At` DESC]-> {
    url = coalesce(n-[:`Pull Request`]->.`HTML URL`, n-[:Issue]->.`HTML URL`, "")
    return "• ${n-[:Repository]->.`Full Name`}: ${n.Title} (${n.Reason}) ${url}"
  }
  if (count(lines) == 0) { return "nothing needs you" }
  channel = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (channel == null) { fail("no #general channel") }
  write channel-[:Messages]-> { Message: "GitHub needs you:\n${Text.join(lines, "\n")}" }
}

listen to cron-[t:Ticks WHERE t.Schedule == "30 8 * * 1-5"]-> fire triage   # weekdays, 08:30 UTC
```

- `Notifications` is your unread inbox on GitHub.
- A notification has no link of its own. The link is on the pull request or issue it is about, so the program walks there.
- When nothing needs you, it posts nothing.

## The checker catches a wrong field

The agent's first draft used GitHub's JSON name for the link, `html_url` (`mistakes/triage_wrong_field.mvt`):

```
    url = coalesce(n-[:`Pull Request`]->.html_url, n-[:Issue]->.html_url, "")
```

`listen-fire check` refuses it, and lists the fields a pull request and an issue really have:

```
$ listen-fire check
…/github-triage/movements/triage.mvt:6:11 error MOV_UNKNOWN_PROPERTY gh.Pull Request has no field 'html_url' — it has: Number, Title, Body, State, Author, HTML URL, Created At, Updated At, Closed At, Assignees, Label Names, Id, Draft, Merged, Merged At, Requested Reviewers, Head Ref, Base Ref
…/github-triage/movements/triage.mvt:6:11 error MOV_UNKNOWN_PROPERTY gh.Issue has no field 'html_url' — it has: Number, Title, Body, State, Author, HTML URL, Created At, Updated At, Closed At, Assignees, Label Names, Id, State Reason, Comment Count
1 file(s), 2 error(s)
```

Nothing ran and nothing called GitHub. The agent reads the list and writes `` `HTML URL` ``:

```
$ listen-fire check
1 file(s), 0 error(s)
```

## Run it, offline

From a clone of this repository, after `pnpm install` and with `listen-fire` on your PATH (or `LF_BIN` naming it):

```
$ cd examples/github-triage
$ node demo/serve-fakes.cjs          # its own terminal; Ctrl-C stops it
ran: listen-fire connect @lf/github --yes
ran: listen-fire credential add --module @lf/github my_github
ran: listen-fire connect @lf/slack --yes
ran: listen-fire credential add --module @lf/slack my_slack
fake GitHub: http://127.0.0.1:54003 (5 unread: 2 review requests, 1 mention, 1 release, 1 CI run)
fake Slack:  http://127.0.0.1:5556/slack/ (what the bot posted: node demo/posted.cjs)
ready; Ctrl-C stops both
```

The script starts both fakes. Then it points this project's credentials at them, with the commands it prints.

The schedule fires the program at 08:30. To fire it now, hand it one tick (`events/tick.json`):

```
$ listen-fire check
1 file(s), 0 error(s)
$ listen-fire run --event events/tick.json
run 9381b04e-42db-4ab8-893d-83c11cfe3e81 triage:triage completed — 1 write(s), 3 trace entries
```

What it posted to Slack:

```
$ node demo/posted.cjs
#general GitHub needs you:
• acme/api: Retry webhook deliveries with backoff (review_requested) https://github.com/acme/api/pull/42
• acme/api: Webhook retries double-charge on timeout (mention) https://github.com/acme/api/issues/57
• acme/web: Move settings to the new layout (review_requested) https://github.com/acme/web/pull/318
```

- The release and the CI run are left out: they do not need you.
- `listen-fire runs show 9381b04e-…` shows the run, its one Slack write, and `"costMicrodollars": 0.0`. No model was called.

## Every morning

```
listen-fire serve
```

- `listen-fire serve` fires the program each weekday at 08:30 UTC.
- Or run `listen-fire drain --until-idle` from your own scheduler. A morning missed while nothing ran fires once on the next drain.
- For 08:30 where you are, add a zone beside the schedule: `{ schedule: "30 8 * * 1-5", timezone: "Europe/London" }`.

## Against real GitHub and Slack

You need:

- a GitHub classic personal access token with the `notifications` and `repo` scopes. GitHub does not offer the notifications feed to fine-grained tokens.
- a Slack app's bot token (`xoxb-…`) that can list channels and post (`channels:read`, `chat:write`), invited to the channel. Change `"general"` in the program to your channel.

```
listen-fire init triage && cd triage
cp <this folder>/movements/triage.mvt movements/
listen-fire connect @lf/github
listen-fire credential add --module @lf/github my_github   # the token; enter for api.github.com
listen-fire connect @lf/slack                             # enter generates its webhook secret
listen-fire credential add --module @lf/slack my_slack     # the bot token; enter for the rest
listen-fire check
listen-fire run --event <this folder>/events/tick.json     # once, now
listen-fire serve                                         # then every weekday morning
```

## What is here

- `movements/triage.mvt`: the program.
- `mistakes/triage_wrong_field.mvt`: the first draft the checker refuses. It sits outside `movements/`, so the project checks clean. To see the refusal, copy it over `movements/triage.mvt`, run `listen-fire check`, then copy the program back.
- `events/tick.json`: one 08:30 tick, for `listen-fire run --event`.
- `demo/`: the fakes, seeded with a morning's inbox. `apps/cli/src/__test__/github_triage_example.test.ts` drives this folder end to end against the same fakes, so this page cannot drift from what `listen-fire` does.
