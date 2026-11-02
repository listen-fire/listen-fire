# @listen-fire/forms

## 0.13.3

### Patch Changes

- 134ef2f: The core peer floor is now `>=0.13.1`. The handbook section's examples connects a module with no import, which 0.13.0 does not read, so a 0.13.0 host installed it cleanly and then failed on its examples.

## 0.13.2

### Patch Changes

- 6040ec1: The handbook section keeps the handbook's prose rules: no `for each` or "ask" in prose. The WhatsApp button example connects with `using`, a credential, so it checks.

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

- 9520af9: `@lf/forms`, a new module: a form at a link, answered once. `form = write forms-[:Forms]-> { Title: "…", Fields: Refund }` makes a form whose fields are the `Refund` node's (text, a number, a boolean, a date, a date and time, or one of a set of words; optional with `| null`). `form.Url` is an unguessable link under the module's door at `listen-fire serve`: a browser gets the form, `Accept: application/json` gets `{ title, fields }`. A POST of JSON or a form records one answer (200 `recorded`); a value of the wrong kind is answered 400 `mismatch`, naming the field, and records nothing; a different second answer 410 `answered`, and the same answer sent again is reported again (so a retry after the host could not keep it is not lost); a link to no form 404. The answer arrives on the form's `Submissions` (adapter protocol 2.5), typed by the node (`answerShapeFrom`). Forms are kept in the install's `ctx.kv`, and are written, never listed: a form's link is all that guards it.
- acec0bd: A replayed request (`listen-fire listens replay`) reaches a module that checks its own requests with `replayed: true` (adapter protocol 2.6), read by module-kit's `inboundRequest` from the host's call alone, never from a header, the query or the body. `@lf/stripe`, `@lf/webhook`, `@lf/whatsapp` and `@lf/email` skip their signature and timestamp checks for it. A kept request holds only the headers a module names in `inbound.captureHeaders`, never a signature: `@lf/email` names `svix-id` (which tells a Resend notification from a Mailgun post), `@lf/forms` names `content-type`; the others need none (docs/contracts/adapter-protocol.md).

### Patch Changes

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
