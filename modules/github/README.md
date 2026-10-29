# @listen-fire/github

GitHub as a Listen-Fire module (`@lf/github`, bundled with `listen-fire`). A program listens to your notifications feed (review requests, mentions, assignments) and walks from each one to the pull request or issue it is about. It reads repositories, pull requests, issues, comments and labels as records joined by edges, and it can comment and add a label.

## Setting it up

```
listen-fire connect @lf/github
listen-fire credential add --module github henry_github
```

The credential asks for:

- `token`: a personal access token. The program never holds it.
  - Notifications need a classic token with the `notifications` scope (or `repo`); GitHub does not offer the notifications feed to fine-grained tokens.
  - Reading pull requests and issues needs read access to them; commenting and labelling needs write access to issues and pull requests.
- `baseUrl` (optional): the API base for GitHub Enterprise Server, `https://<host>/api/v3`. Empty means `https://api.github.com`.

## What a movement sees

```
import { `@lf/github` as github, `@lf/slack` as slack } from adapters
import { henry_github, team_slack } from credentials

gh   = connect github using henry_github
chat = connect slack using team_slack

function triage(n: <gh-[:Notification]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  pr = only(n-[:`Pull Request`]->)
  if (pr != null) {
    write general-[:Messages]-> { Message: "Review requested by ${pr.Author}: ${pr.Title} ${pr.`HTML URL`}" }
    write pr-[:Labels]-> { Name: "triaged" }
  } else {
    write general-[:Messages]-> { Message: "${n.Reason} in ${n-[:Repository]->.`Full Name`}: ${n.Title}" }
  }
}

listen to gh { events: ["review_requested", "mention", "assign"] } fire triage
```

- The listen fires once per notification thread that is new or has changed since the last poll. A new comment on a thread already delivered fires it again.
- `events` selects GitHub's reasons. `listen-fire check` refuses a reason GitHub does not send. Leave it out for every reason.
- `participating: true` keeps only threads you take part in or are mentioned in.
- The first poll sets the mark and delivers nothing, so going live never replays your inbox. Walk `Notifications` for what is unread now.
- Polls are conditional: an unchanged feed costs GitHub a 304 and no quota. GitHub sets how often the feed may be polled (`X-Poll-Interval`, usually a minute). A shorter `every:` polls no faster.

## The graph

| From | Edge | To | Notes |
|---|---|---|---|
| the account | `Notifications` | Notification | unread now; an `Updated At` bound reaches GitHub |
| the account | `Repositories` | Repository | yours, by full name; `Full Name == "owner/name"` fetches that one |
| Notification | `Pull Request`, `Issue` | the subject | nothing when the subject is something else |
| Notification | `Repository` | Repository | |
| Repository | `Pull Requests` | Pull Request | open and closed, newest first; `State` reaches GitHub |
| Repository | `Issues` | Issue | open and closed, newest first, never pull requests; `State`, `Author`, a label, an assignee and an `Updated At` floor reach GitHub |
| Pull Request, Issue | `Comments` | Comment | the conversation, oldest first; writable |
| Pull Request, Issue | `Labels` | Label | writable |
| Pull Request, Issue | `Repository` | Repository | |

- Field names are GitHub's: `Number`, `Title`, `Body`, `State`, `HTML URL`, `Author` (the login), `Assignees`, `Label Names`, `Created At`, `Updated At`.
- A pull request adds `Draft`, `Merged`, `Merged At`, `Requested Reviewers`, `Head Ref` and `Base Ref`.
- A notification has `Reason` (GitHub's reasons, checked as an enum), `Title`, `Subject Type`, `Unread`, `Updated At` and `Last Read At`.
- Pin `State` on a busy repository: an unpinned walk reads closed records too.

## Writes

```
write pr-[:Comments]-> { Body: "Looking at this today." }
write issue-[:Labels]-> { Name: "triaged" }
```

- A comment goes into the conversation: a pull request's issue comments, not a review.
- Adding a label the record already carries changes nothing. GitHub creates one the repository lacks.
- Nothing else is written.

## Not in v1

- Repository webhook events (a push, a pull request opened) through signed deliveries. Today only the notifications feed fires.
- Sign-in as a GitHub App or through OAuth. Today the credential is a personal access token.
- More writes: reviews, merges, closing, editing, assigning, review comments.
