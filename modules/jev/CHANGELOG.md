# @listen-fire/jev

## 0.12.11

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.12.10

### Patch Changes

- 1e85960: The handbook section's inbox listen is written on the email connection's `Emails` edge (`inbox-[e:Emails WHERE e.Key == "sort-inbound"]->`).
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

## 0.12.9

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.8

### Patch Changes

- 6d7a585: A new module, `@lf/jev`: Jev, Typesafe AI's non-generative judge, as two cheap classifier plugins. `jev.score(subject, question)` answers a number from 0 to 1, how likely a statement is true (`if (jev.score(m.Body, "…") >= 0.7)`); `jev.classify(subject, labels, question)` answers `{ label, confidence }`, which of the labels fits. The subject is a text or a record of the fields that matter. Each call answers what it cost (Jev's input tokens at $0.042 a million), counted against the run's cost cap; a request over about 30,000 tokens fails before it is sent; a refused key fails the run naming the credential, and a rate limit or overload is retried three times. The credential is an API key and, optionally, another Jev's address. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
