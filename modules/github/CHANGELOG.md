# @listen-fire/github

## 0.13.2

### Patch Changes

- 134ef2f: The core peer floor is now `>=0.13.0`. The handbook section's text is written for the 0.13 catalog, which a 0.12 core cannot read, so the range admitted a core its examples cannot be checked against.

## 0.13.1

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- da1a05b: GitHub notifications arrive on the connection's `Notifications` edge, polled every minute (lf.yaml `pollEvery` overrides it for a connection): `listen to gh-[n:Notifications WHERE n.Reason IN ["mention"]]-> fire f`. Each thread new or changed since the last poll arrives once, versioned by its `Updated At`. The module takes `Reason` (`==`, `IN`) and the new `Participating` (`==`, asked of GitHub's `participating` filter) and applies them itself. Every arrival carries `Participating` (one extra call per poll that has news), so a listen may compare it in an OR or with `!=`. A walk of `Notifications` takes `Participating` either way too (`== false` is the threads GitHub's filter leaves out), and always stamps it on every thread it returns (one extra call when the walk returns threads), so the walk too may compare it in an OR or with `!=`. It declares how a 0.12 `listen to gh { events: [...], participating: true }` becomes it (`listenSettingsBecome`) and no longer declares `subscribableEvents`, `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.

### Patch Changes

- 16e3776: A module's `poll` takes an edge's input alone (`PollEdgeInput`) and answers its arrivals (`PollEdgeAnswer`); `PollInput` and `PollAnswer` are gone from the kit, and a 0.12 settings poll's input reaches no module. Dealroom, Evertrace, GitHub, Gmail, Granola and System no longer refuse that input themselves. The in-process `Adapter.ensureEventSubscription` takes an edge's subscription; removing and refreshing one still take a 0.12 settings listen's webhook, so a host can remove it.
- c4af6cc: `listen-fire upgrade` never applies a rewrite that hears otherwise than the 0.12 listen did, unasked. Affinity: a listen naming `organization.updated` (or a person's or an opportunity's) is told that `Kind == "updated"` also hears each field value set or cleared on the record, which 0.12 heard only as field_value events, with the remedy `AND c.Field == null`, and is rewritten only under `--all`. Slack: a `message` or `app_mention` listen heard thread replies too, which now arrive on their root message's `Replies`, so it has no rewrite and is told to write one listen for each edge; a `reaction_added` listen is still rewritten onto `Reactions`. GitHub: `participating: false` heard every thread in 0.12, so it now compares nothing (`participating: true` is still `n.Participating == true`). Gmail: a `label_added` listen is told that a label removed and added again now runs it again, and is rewritten only under `--all`; and a 0.12 program reading `Labels` is warned on the upgrade (`MOV_FIELD_MEANING_CHANGED`) that it holds label names where it held ids.
- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.8

### Patch Changes

- 187815e: A new module, `@lf/github`: GitHub notifications, repositories, pull requests and issues. A listen on `Notification` fires once per notification thread that is new or changed since the last poll, labelled with GitHub's reason, so `listen to gh { events: ["review_requested", "mention"] }` narrows by it and `listen-fire check` refuses a reason GitHub never sends; `participating: true` keeps threads you take part in. The first poll arms and delivers nothing. Each later poll is conditional (`If-Modified-Since`, so an unchanged feed is a 304) and never sooner than `X-Poll-Interval`. A notification walks to its `Pull Request` or `Issue`; a repository holds its `Pull Requests` and `Issues` (open and closed unless the WHERE pins `State`; state, author, labels, an assignee and an `Updated At` floor reach GitHub); each holds its `Comments` and `Labels`. Writes: a comment along `Comments`, a label along `Labels`. The credential is a personal access token (`listen-fire credential add --module github <name>`), with an optional API base URL for GitHub Enterprise Server; the notifications feed needs a classic token. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
