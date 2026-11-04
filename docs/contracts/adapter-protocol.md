# The adapter protocol

Version: 2
Minor: 8

A remote adapter connects a system you run to Listen-Fire. It is an HTTP
server you host, in any language. Listen-Fire calls it to learn your data
model, to read and write your records, and to wait on things that happen in
your system. Your server calls Listen-Fire back when something happens.

This document is the contract. The source of truth is the zod schema in
`packages/engine-contracts/protocol.ts`; where this page
and the schema disagree, the schema wins. The reference adapter is the fake
CRM, a single file in this repository, `examples/lf-acme/externals/acme_crm/server.mjs` (see
[Build your first adapter](#build-your-first-adapter)).

Contents:

- [The envelope](#the-envelope)
- [Transport](#transport)
- [Versioning](#versioning)
- [Authentication](#authentication)
- [The manifest and installing](#the-manifest-and-installing)
- [Methods](#methods)
- [Waiting on your system (awaits)](#waiting-on-your-system-awaits)
- [Telling Listen-Fire something happened](#telling-listen-fire-something-happened)
- [Modules: credentials, signatures and schedules](#modules-credentials-signatures-and-schedules)
- [Paging](#paging)
- [Files](#files)
- [Limits and timeouts](#limits-and-timeouts)
- [Errors](#errors)
- [Build your first adapter](#build-your-first-adapter)
- [Changes](#changes)

## The envelope

Every call is a `POST` of JSON to one URL, your `baseUrl`. The method name is
in the body, not the path.

```json
{
  "protocolVersion": "2",
  "method": "describe",
  "cacheScopeId": "c0ffee",
  "params": { "typeId": "Company" }
}
```

- `protocolVersion` is the string `"2"`.
- `cacheScopeId` is opaque. You may scope a per-call cache by it, or ignore it.
  - A host sends one id per adapter instance per run segment, so the calls of
    one run share it and two runs never do. `<none>` and `<slot>` name no run:
    a host's own reads (a manifest, an inbound check) and a slot's calls.
  - A module served by module-kit is answered inside the run scope this id
    names (its read memo and call ceiling), as it is in process.
- `params` is the method's input (see [Methods](#methods)).
- `inbound` (optional) is `{ "url": … }`: where the install's inbound
  requests reach a module that takes any, its door at the host (under
  `listen-fire`'s `publicUrl`, else the listener serving the call). A module
  that hands out links to itself (a form's page) builds them from it. It is
  absent when the module takes no inbound requests or nothing serves its
  door. module-kit gives it as `ctx.config.inboundUrl`.
- `hostRelease` (on a slot request only, from 2.8) is the release of the
  `listen-fire` that sent it, its core version (`"0.15.2"`). A module serving
  runners of several releases (a platform's store, movements and secrets
  modules) tells their lines apart by it, and answers each by its own. A
  slot request without it comes from a runner before 0.15.2. A module that
  serves one runner may ignore it.

You answer with HTTP 200 and one of two bodies:

```json
{ "ok": true, "result": { "typeId": "Company", "displayName": "Company", "fields": [], "references": [] } }
```

```json
{ "ok": false, "error": { "code": "adapter_error", "message": "CRM timed out", "retryable": true } }
```

- An application failure is still HTTP 200, with `ok: false`.
- Non-200 is for transport faults only: 401 when authentication fails, 400 when
  the body is not a request envelope. Listen-Fire treats any non-2xx as a
  transport error, marked retryable (see [Limits](#limits-and-timeouts) for
  what that does today).
- Listen-Fire validates every `result` against the method's schema. A wrong
  shape fails the call and names the method and the offending path.

Types, fields and edges each have two names, and the two may differ:

- `typeId` (and a field's `fieldId`) is your own id. Listen-Fire hands a
  `typeId` back to `describe` and reads it in a reference's `targetTypeId`.
  Keep it stable.
- `displayName` (a reference's `name`, for an edge) is the natural name.
  Automations write it (`crm-[:Company]->`), and every other call names the
  type, field or edge by it: `recordType: "Company"`, the keys of `fields`,
  `edge: "Comments"`. It is not just presentation: renaming it breaks the
  saved automations that use it.
- `describe` may be asked by either name, so accept both. Simplest: give each
  type one name and use it for both.

Record ids are identity, and cross the wire unchanged.

## Transport

Every module kind — adapter, plugin, and every core slot (store, models, judge, files, limiter, browser, wake, ocr, secrets, movements) — is reached this one way: this envelope over HTTP. Where it listens decides how:

| where the module runs | its address | how |
|---|---|---|
| on the host's box, started by the host | `unix:<socket path>` | HTTP/1.1 on a Unix socket |
| on the host's box, where there are no sockets | `http://127.0.0.1:<port>/` | loopback TCP |
| elsewhere (a remote module: only a manifest on the host) | `https://…` | HTTPS |

- **A module the host starts** is told where to listen: `MODULE_SOCKET` (a socket path) when set, else `PORT` (`0` picks one). It requires `Authorization: Bearer <MODULE_TOKEN>` when that is set, and prints one line on its stdout once it answers: `listening unix:<socket path>`, or `listening <port>`.
- **A URL below a socket** (a file a module serves) is `http+unix://<socket path, percent-encoded>/<path>`.
- **A remote module** is an `lf-external.yaml` with `url:` (and `auth:` naming the install field holding its secret). A credential goes only over HTTPS, a socket or loopback.
- **Outgoing auth.** A remote module behind a platform's own sign-in (Cloud Run with IAM, a proxy) is reached with a second credential, set per install: `outgoing_auth: google-identity` sends a Google identity token for `outgoing_audience` (default: the URL's origin), minted by the metadata server; `outgoing_auth: bearer` sends `outgoing_token`. It goes in `outgoing_header`, by default `authorization`, or `x-serverless-authorization` when the module's own secret holds `authorization`. The module never sees these fields as settings.

## Versioning

The protocol's version is 2.N: a major, 2, and a minor, N, counted within it.

- **The major is a change in meaning.** A request carries `"protocolVersion": "2"` (the major alone). A server built on the reference kit answers any other with the error code `protocol_version`.
- **A minor is what hosts speak.** Each addition within version 2 that hosts speak (a method a host may call, a host behaviour) raises the minor hosts speak by one. An older server never lists the method, and an older host never calls it.
- **Your `manifest` answer carries both, as numbers:** `"protocolVersion": 2` and `"protocolMinor": N`.
  - The minor you state is what you need your host to speak: 0 unless your module relies on a host behaviour of a later minor, which its author declares (`protocolMinor` on the module's definition). The reference kits stamp it.
  - A method you offer never raises it, whatever minor introduced the method: a host calls only the methods it speaks, so an older host leaves a newer one alone and your module works there as before.
  - So rebuilding a module with a newer kit, or offering a newer method, never makes an older host refuse it.
  - An absent `protocolMinor` is unstated, read as 2.0. Every module published up to 0.12.5 states none.
- **What a host refuses, by name.** `listen-fire` and the engine speak 2.0 to 2.8. They refuse a manifest that states another major (newer or older), or a minor above 8. `listen-fire` reads a core module's manifest before any other method it asks of it: as `listen-fire drain` opens, for the modules it starts then, and at the first call otherwise. The text names the module, its package and version when the host finds them, what it speaks and what the host speaks, and what to upgrade. Installing probes your server the same way: Listen-Fire calls `manifest` with the secret and refuses it outside that range.
- **The floor stays 2.0 within the major.** A host reads every minor from 2.0 up, so a module that predates a feature still loads. A method a host needs a module to have is checked by name where it is needed, never by the stated minor, and the refusal names the minor that introduced it: `listen-fire serve` refuses a movements module that does not answer `movements.watch` (adapter protocol 2.1), and arming a polled listen fails on a store module that does not answer `work.enqueueIfAbsent` (adapter protocol 2.2).
- **An addition that names nothing in the manifest keeps the minor.** A new optional field or declaration is learned from the manifest, never from the version: a method is called only when it is listed in `methods`, and a declaration (`credentials`, `inbound`, `poll`, `periodic`) is acted on only when it is present. An older server sends neither and is unchanged; an older host ignores both.
- An install made before its secret is supplied stores the version the manifest file claims. The probe runs when the secret is linked.
- **Where it is held.** `MANIFEST_PROTOCOL_VERSION`, `PROTOCOL_VERSION` and `PROTOCOL_MINOR` (`packages/engine-contracts/protocol.ts`) hold the major and the minor, and a test holds them equal to the lines at the top of this page. The table of minors is `PROTOCOL_MINORS` there, and its Rust twin (`crates/module-wire`) is test-held equal to it. [The contracts index](README.md) lists what each release supports.

### Minors of version 2

| minor | what hosts speaking it add | since |
|---|---|---|
| 2.0 | everything before minors were counted | 0.12.0 |
| 2.1 | a `<slot>.watch` method ([Watching for changes](#watching-for-changes-slotwatch)) | listen-fire 0.12.2 |
| 2.2 | `work.enqueueIfAbsent` ([the store slot](store-slot.md)) | listen-fire 0.12.5 |
| 2.3 | a host behaviour: a polled source labels each poll event with its kind, `eventType`, and a host delivers an unlabelled one to the listen that polled it, with a notice ([Polled sources](#polled-sources-and-periodic-tasks)). An older host routes a labelled event correctly, so no module needs to state 2.3 | listen-fire 0.12.8 |
| 2.4 | `refreshEventSubscription` ([Event subscriptions that expire](#event-subscriptions-that-expire)) | listen-fire 0.12.10 |
| 2.5 | `awaitKeys`, arrivals on a delivery's reading, the `wake` door's arrivals, the store slot's `waits.*` (`waits.log` names it) ([Waiting on your system](#waiting-on-your-system-awaits)) | listen-fire 0.13.0 |
| 2.6 | arrivals for listens ([Reporting arrivals](#reporting-arrivals)): one on a root edge names no `key`; one may carry `parents`, `about`, `notFor`, `takenApplied`, `occurredAt` and, on its landing and each parent, `unknown`; the landing and each parent state their `recordType`, and an arrival that states none runs no listen. A host fires the listens on the edge it landed on. A polled listenable edge is polled as `poll({ edge, filter?, scope?, cursor? })`, once per connection, edge, taken filter and scope ([Polled sources](#polled-sources-and-periodic-tasks)); a pushed one is subscribed for as `ensureEventSubscription({ edge, filter?, scope?, callbackUrl, current? })`, once per the same ([Subscribing for an edge's arrivals](#subscribing-for-an-edges-arrivals)). Each head `awaitKeys` is asked about names its `recordType` where the host knows it. `checkInbound` may be handed `replayed: true`, when the host runs a request it kept itself again ([A module that checks its own inbound](#a-module-that-checks-its-own-inbound)); `inbound.captureHeaders` names the headers a kept request holds and `inbound.redactFields` the body and query fields it drops ([Declared inbound signatures](#declared-inbound-signatures)). **A module that uses any of these states `protocolMinor: 6`**: an older host would refuse a root arrival, judge without `unknown` or `recordType`, or keep a request whole | listen-fire 0.13.0 |
| 2.7 | host behaviours, additive: a poll's answer may say when the edge is next worth polling (`pollAgainAt`), and a host polls it then when that is sooner than its interval ([Polled sources](#polled-sources-and-periodic-tasks)); an arrival may say who acted (`actor`, as `extractActor` answers), and a run an arrival fires is handed its `about` and `actor` and stamped with its `occurredAt` ([Reporting arrivals](#reporting-arrivals)). An older host ignores both members (it polls on its interval and asks `extractActor`), so no module needs to state 2.7 | listen-fire 0.13.1 |
| 2.8 | a host behaviour, additive: every slot request carries `hostRelease`, the release of the runner that sent it ([The envelope](#the-envelope)). A module serving runners of several releases answers each by its line, and reads a request without it as from a runner before 0.15.2. An older module ignores the member, so no module needs to state 2.8 | listen-fire 0.15.2 |

A module offering one of these methods states no minor for it. Until 0.12.9 the kits stamped a module with the minor of the methods it offered; from 0.12.10 they stamp only what its author declares.

The first `listen-fire` that reads `protocolMinor` is 0.12.6. A `listen-fire` up to 0.12.5 ignores the field and loads the module as before.

## Authentication

Listen-Fire sends your secret on every call. Your manifest picks how:

| `authStrategy` | Header Listen-Fire sends |
|---|---|
| `{ "kind": "bearer" }` | `Authorization: Bearer <secret>` |
| `{ "kind": "shared_secret" }` | `x-listen-fire-adapter-secret: <secret>` |
| `{ "kind": "shared_secret", "header": "x-acme-key" }` | `x-acme-key: <secret>` |

- Check the header on every request; answer HTTP 401 when it is missing or wrong.
- The secret is entered at install time and stored encrypted. It never goes in
  the manifest.
- The secret belongs to the INSTALL: every call to your server carries it,
  whichever user the call acts as. Who the call acts as at your provider
  rides separately, as the request's `credential`
  ([Credentials](#credentials)).
- Every call to your server carries `x-listen-fire-team: <team id>`, the UUID of
  the team whose install is calling. A server that serves several teams learns
  from it which one. It is not a credential: authenticate by the secret.
- When your server calls Listen-Fire (the push doors), it sends the same secret.
  The team header is optional there; send it only to disambiguate a secret
  shared across teams. See [the door](#the-door-you-call).

## The manifest and installing

The manifest file registers your server with a team:

```json
{
  "protocolVersion": 2,
  "protocolMinor": 0,
  "adapterType": "acme_crm",
  "displayName": "Acme CRM",
  "description": "Our internal CRM.",
  "baseUrl": "https://crm.acme.example/listen-fire",
  "authStrategy": { "kind": "bearer" },
  "supportedTriggers": ["webhook"],
  "runtimeCapabilities": {
    "traversal": { "incoming": false, "edgeProperties": false },
    "resources": false
  },
  "methods": [
    "listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated",
    "iterateRelatedPage", "createRecord", "updateRecord", "deleteRecord",
    "preprocessInbound", "listEventTypes", "awaitKeys",
    "ensureEventSubscription", "removeEventSubscription"
  ]
}
```

- `adapterType` is the slug an automation connects (`crm = connect #acme_crm using acme`). One install per slug per team. Charset: `^[a-z][a-z0-9_]*$` (ASCII lower case).
  It may not be a name a built-in adapter answers to (`slack`, `gmail`,
  `inbound_email`, `kg_mutation`, …, in any casing), nor `callback` or `ask`:
  the install is refused.
- `methods` lists exactly what you implement. Listen-Fire never calls an
  optional method you did not list.
- The file is what Listen-Fire uses. Installing calls your `manifest` method
  only to check its `protocolVersion` and its shape; `methods`,
  `supportedTriggers` and `runtimeCapabilities` come from the file. Keep the
  two answers the same.
- `supportedTriggers` is `["webhook"]` if your system announces events, else `[]`.
- `description` (optional): one or two sentences about your system. An
  author's editor shows it when they hover your adapter or a connection to it.
- `positionArgs` (optional): `[{ name, optionsFrom, label? }]`, the construction
  args that pin an entry position (an Airtable `base`). A program writes one on
  the connection (``connect `@lf/airtable` using acme { base: "CRM" }``); the host
  describes the module once per value a program constructs it with, and sends
  that value on every call of the connection as `"settings": { "base": "CRM" }`.
- `introspectedSchema` (optional): `true` when your schema comes from the
  connected account (Airtable's tables and fields, a spreadsheet's tabs), so
  describing it needs a credential and costs calls to your system. Leave it out
  when the schema is yours alone. `listen-fire modules show` tells an author
  which, and a module with a live schema is summarised without describing it.
- `resendWindowSeconds` (optional): how long, in seconds, your system may
  re-send an arrival it already sent (Stripe retries an event for three days).
  An hour when you declare none. The host keeps each arrival's identity that
  long, apart from the arrival itself, and drops a repeat inside it, even one
  that comes after the arrival was swept from the log. It is a default: the
  operator's `lf.yaml` overrides it per module (`resendWindow: { stripe: 7d }`).
  A value that is not a positive whole number is refused.
- `listenSettingsBecome` (optional): how a 0.12 settings listen on your module
  (`listen to gh { events: ["mention"] }`) becomes a 0.13 traversal, so
  `listen-fire upgrade` can rewrite one: `{ path, aliases, paramFrom?, keys }`.
  `path` is the edges from the connection to the edge its events arrive on
  (`["Notifications"]`), `aliases` one per edge, `paramFrom` the record type a
  fired function's parameter was typed as (retyped by the landing), and `keys`
  each settings key's hop, field and comparison
  (`{ "events": { "hop": 0, "field": "Reason", "op": "in" } }`, with `values`
  where a settings value is spelled otherwise on the field). The comparison is
  `eq`, `neq`, `in`, `contains` (a member of a list field; several values are an OR
  of them, `labels: ["INBOX", "SPAM"]` becoming
  `m.Labels CONTAINS "INBOX" OR m.Labels CONTAINS "SPAM"`) or `type`. The upgrade turns
  that listen into `listen to gh-[n:Notifications WHERE n.Reason IN ["mention"]]->`.
  A module whose records hold their row before and after a change says
  `fieldChange`: the hop, the two settings keys that name a field and the value
  it came to hold, and the record's fields holding the row as the change left
  it and as it was (Airtable's
  `"fieldChange": { "hop": 2, "field": "field", "becomes": "becomes", "current": "Current", "previous": "Previous" }`).
  Each row is tested present before a field is read through it (a created row
  has no previous). With a value, the rewrite is
  `exists(c.Current) AND c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR c.Previous.Stage != "Interview")`.
  A field alone is the field changed, an absent row's field counting as absent:
  `(exists(c.Current) AND exists(c.Previous) AND c.Current.Stage != c.Previous.Stage) OR (exists(c.Current) AND NOT exists(c.Previous) AND exists(c.Current.Stage)) OR (NOT exists(c.Current) AND exists(c.Previous) AND exists(c.Previous.Stage))`.
  A value with no field narrows nothing. Where the host narrowed the path's hops by
  their WHEREs, the field is checked against the narrowed row and the fired
  parameter is retyped to the narrowed landing.
  A key may also say `absent`, what a listen that left it out meant, as a
  settings value (`"absent": ""` for an inbox's own mail, a list for the
  events a listen with none heard): the rewrite of such a listen compares it,
  so the traversal hears what the listen heard. `"lowercase": true` says your
  module compared the key's values lowercased, so the rewrite writes them so.
  `"absentField"` names the field `absent` is compared on when leaving the key
  out meant something about another field (gmail's `labels` left out of a
  `label_added` listen meant the mailbox's own labels: `Label Type == "user"`).
  When your events arrive on more than one edge, `byEvent` maps an event to the
  mapping a listen naming it becomes instead (`{ "label_added": { "path":
  ["Labelings"], … } }`), with `events` spent choosing it; a listen that leaves
  `events` out chooses by the `absent` of the top mapping's `events` key, and
  takes the top mapping when that names none (or none of them is mapped). One naming
  events of two mappings has no rewrite (its author writes one listen per
  edge), and nor has one naming an event `byEvent` does not beside one it
  does. Events of one edge whose mappings differ only by keys one compares
  besides take the mapping that compares least (Slack's `message` with
  `app_mention`: a mention is a message). Several values of a `contains` key become an OR of `CONTAINS`: the
  rewrite is safe only when the field declares `containsAny`. A rewrite is offered only when every literal it writes is one the field's
  owned scalar takes. A `values` entry of `null` says that value narrowed
  nothing, so the key compares nothing (GitHub's
  `"participating": { …, "values": { "true": true, "false": null } }`: `false`
  heard every thread); `true` and `false` are looked up by their text. Where a
  mapping hears otherwise than the settings listen did, say so in `changed`
  (gmail's `label_added`: a label removed and added again now runs the listen
  again): a listen taking it is told the note and rewritten only under
  `listen-fire upgrade --all`. Where its events also arrive on other edges,
  name each path in `alsoArrivesOn` (Slack's `message`: a thread reply arrives
  on `["Channels", "Messages", "Replies"]`): a listen taking it has no
  rewrite and is told to write one listen for each edge. A connection positioned at a member (an Airtable `base`)
  stands on the hops its position keys map to. A path naming an edge you do
  not describe, a key mapped past the path, an `eq`/`in` key with no `field`,
  `lowercase: true` on a `type` key, an `absent` the key cannot compare (on a
  `type` key, several values on an `eq` or `neq` key unless each is a `byEvent`
  event, which it then only chooses by, a value its `values` do not spell,
  an `absentField` with no `absent`), or a `fieldChange` past the path or on a
  key the mapping also maps, in the mapping or any `byEvent` one, is refused when the module is described. A listen with a key you do not map is left for its author.
- Optional fields: `handbookSection` (`{ title, content }`, prose the authoring
  handbook shows about your system), `vocabulary` (an icon and event phrasing),
  `webhookEventTypeId`.
- Optional module declarations: `credentials`, `inbound`, `poll` and
  `periodic` ([Modules](#modules-credentials-signatures-and-schedules)).
- What a listen on your adapter may say is the edges you declare listenable
  ([Declaring a listenable edge](#declaring-a-listenable-edge)). The 0.12
  declarations `subscribableEvents`, `defaultSubscribedEvents`,
  `listenConfig` and `subscriptionScopeKeys` are retired in 0.13: a host
  refuses a manifest that still declares one, naming it.

Install it on the **Adapters** page, pasting the manifest and the secret
together. An agent can instead give the user a link to enter the secret
out of band.

## Methods

Required: `manifest`, `listEntryPoints`, `describe`, `resolveEntity`,
`getFieldValue`, `getRelated`, `createRecord`, `updateRecord`, `deleteRecord`.
A pure sink returns `null` and `[]` from the reads; a read-only source can
throw from the writes. Everything else is optional and declared in `methods`.

Each example shows `params` → `result` (the `result` inside `ok: true`).

### manifest

`{}` → the same declarations as the manifest file:

```json
{
  "protocolVersion": 2,
  "adapterType": "acme_crm",
  "supportedTriggers": ["webhook"],
  "runtimeCapabilities": { "traversal": { "incoming": false, "edgeProperties": false }, "resources": false },
  "methods": [
    "listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated",
    "iterateRelatedPage", "createRecord", "updateRecord", "deleteRecord",
    "preprocessInbound", "listEventTypes", "awaitKeys",
    "ensureEventSubscription", "removeEventSubscription"
  ]
}
```

The hosted product reads only `protocolVersion` from it (see
[installing](#the-manifest-and-installing)). `listen-fire`, which has no manifest file,
reads every declaration from it, the listen declarations included.

`webhookEventTypeId` (a string) is optional.

### listEntryPoints

`{}` → the types an automation can start from:

```json
[
  { "typeId": "Company", "displayName": "Company", "writable": true, "readable": false, "listenable": true, "collectionName": "Companies",
    "description": "A company. A listen on `Companies` is delivered each one somebody creates in the CRM." },
  { "typeId": "Comment", "displayName": "Comment", "writable": false, "readable": false }
]
```

- `writable`: automations may create this type.
- `readable`: automations may enumerate it from the root.
- `listenable` (optional): you announce arrivals on the instance's own edge to
  this type, named by `collectionName` (else `displayName`): a listen can start
  there (`cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]->`). The edge exists
  whether or not the type is `readable`. It takes every key
  [a listenable reference](#declaring-a-listenable-edge) takes.
- Publish every type your edges reach, even one only reached along an edge
  (`Comment` above), so it is named.
- `description` (optional): what a record of this type is. An author's
  editor leads with it when they hover the type, a walk to it or a
  parameter holding one. A `description` on the type's `describe` answer
  wins over this one.

### describe

`{ "typeId": "Company" }` → one type, or `null` if unknown:

```json
{
  "typeId": "Company",
  "displayName": "Company",
  "fields": [
    { "fieldId": "Name", "displayName": "Name", "kind": "string", "writable": true, "required": true,
      "description": "The company's legal name." },
    { "fieldId": "Description", "displayName": "Description", "kind": "string", "writable": true, "required": false }
  ],
  "references": [
    { "fieldId": "Comments", "name": "Comments", "targetTypeId": "Comment", "cardinality": "many",
      "direction": "outgoing", "writable": false, "listenable": true, "identity": "Id",
      "sequenced": "chronological",
      "description": "What people said about the company, oldest first." }
  ]
}
```

- A field's `kind` is one of `string`, `number`, `boolean`, `date`,
  `file`, `json`, `enum` (with `enumValues`), `owned` (with `owned`),
  `record` (with `record`), or `reference` (an edge, not a value). `record`
  holds a record as its value, read on with `.` and never fetched (a
  change's row before and after): `"record": { "typeId": "Candidates" }`
  names its type, and it reaches the catalog as
  `{ "kind": "record", "position": { "kind": "position", "position": "<that type's displayName>" } }`.
  A field of kind `record` that names no type is refused, naming the field.
  `"mayBeAbsent": true` says a record may lack the field (a change's row
  before, on a created row): it reaches the catalog as
  `{ "kind": "maybeAbsent", "of": … }`, and a read of it may be absent. `owned` is a named scalar your module
  owns and parses, a cron schedule or a mailbox key:
  `"owned": { "name": "Cron", "allowPattern": "^…$", "format": "cron" }`,
  `allowPattern` being optional, the least you say of its values. `format`,
  also optional, says your values are written in a format the checker knows,
  so it refuses a literal as you would: `"cron"` (a five-field schedule) or
  `"timeZone"` (an IANA zone). The checker chooses that check by `format`
  alone, never by the scalar's name. It reaches the catalog as
  `{ "kind": "owned", "name": "Cron", "owner": "<your adapterType>", "format": "cron" }`. A
  field of kind `owned` that names no scalar is refused, naming the field.
  Any field may declare `changedIn` (`{ "release": "0.13.0", "note": "…" }`):
  a release of yours changed what the field holds (gmail's `Labels`: label
  names where they were ids), so a check for an upgrade from before that
  release warns (`MOV_FIELD_MEANING_CHANGED`) wherever a program reads it.
  `changedIn.unchangedValues` (optional, a list of strings) names the values
  that mean what they always did (gmail's own labels, `INBOX`, `UNREAD`, …):
  a comparison of the field with literals that are all among them
  (`==`, `!=`, `CONTAINS`, `IN`) is not warned, and the checker only compares
  the literal with the list. The pin stays until the author has checked each read and confirmed the
  upgrade (`--all`). A field with any other `kind` is silently dropped, and the
  type's position is then left open: automations may read any field name
  off it unchecked. Add `"cardinality": "many"` for a list.
- Fields and references pass through with whatever extra keys you declare.
  On a reference Listen-Fire reads:
  - `readable` — defaults to true; `false` marks a write-only edge;
  - `writable` — only an explicit `true` allows creating along the edge;
    absent means read-only;
  - `listenable`, `cursor`, `identity`, `version` (see
    [awaits](#waiting-on-your-system-awaits));
  - `literalsFrom` (optional) — fields of what lands on the edge that take
    the text literals the write it hangs off wrote at a path. For example,
    `[{ "at": ["Actions", "Value"], "from": "Buttons[].Value" }]` makes each
    action's `Value` one of the `Value`s of the buttons that message was
    written with. `at` walks from the landing by reference names and ends at
    the field; `from` names the write's field by `displayName`, `[]` going
    into each entry of a list and `.` into a field of an entry. The field
    must be a single text field, and every reference on the way must land on
    one type. A `literalsFrom` that breaks either rule, or whose `from` does
    not parse, is refused when `listen-fire` describes your adapter.
  - `answerShapeFrom` (optional) — the field of the write the edge hangs off
    that names a node the program declares. For example, a form's
    `Submissions` with `"answerShapeFrom": "Fields"` lets a program write
    `Fields: Refund` (after `node Refund { Approve: <boolean> }`), and each
    submission then has `Approve`, typed boolean, beside the landing's own
    fields. The field must be a single writable `json` field of the type the
    reference is on: your `createRecord` receives the node's fields there,
    `{ "fields": { "Approve": "boolean" } }`, each a field type as this page
    spells them. The reference must land on one type. One that breaks either
    rule is refused when `listen-fire` describes your adapter. The records
    you report landing on the edge carry those fields.
- `description` (optional) on the type, a field or a reference: what it is,
  in a sentence. An author's editor shows it when they hover the record, the
  field or the walk along the reference. A write-only field's description is
  also quoted when an automation tries to read it, so say there where the
  value can be read instead.
- `deletable` (optional, on the type): `true` says your `deleteRecord`
  removes a record of this type. Absent means no. A `delete` of a type that does not say `"deletable": true`
  is refused before the automation is saved (`MOV_DELETE_NOT_DECLARED`);
  automations pinned to an earlier version are unaffected.
- `pinned` (optional, on a field): `true` says a read of this type must pin
  the field in its `WHERE` with `==`, because your `getRelated` takes it as
  an argument of the read rather than filtering records it could list (an
  MCP tool's required input). Each pinned field must be stated as
  `r.<field> == <value>` among the `WHERE`'s `AND`-joined conditions, where
  the value is a literal or a name in scope, and the `WHERE` must be one
  Listen-Fire sends you: one that calls no function and tests no `EXISTS`.
  A read that does not do this is refused before the automation is saved
  (`MOV_HOP_PIN_REQUIRED`), naming the fields and the form to write. Writes
  of the type are unaffected. Read the values out of the `where` you are
  sent, and return them on each record: Listen-Fire applies the `WHERE`
  again to what comes back.
- `listEntryPoints` and `describe` are asked once per connection the
  automations make, carrying that connection's credential: two connections
  of your module (two workspaces, two servers) may answer different types,
  and each is checked against its own. A check costs one round of them per
  connection.
- `edgesFrom` (optional) replaces `describe` for nested systems: `{ position, cursor? }`
  → `{ descriptor, targetPositions?, nextCursor? }` or `null`. The adapter
  handbook's schema chapter covers it.

### resolveEntity

Decides whether a record Listen-Fire is about to write already exists.

```json
{
  "record": { "Name": "Vireo Robotics" },
  "recordType": "Company",
  "candidates": [],
  "constraints": { "any": [ { "all": [ { "field": "Name" } ] } ] }
}
```
→
```json
{ "candidates": [ { "adapterType": "acme_crm", "externalId": "company-7", "recordType": "Company", "data": { "Name": "Vireo Robotics" } } ] }
```

Return `{ "candidates": [] }` when nothing matches; Listen-Fire then creates.

### getFieldValue

```json
{
  "position": { "adapterType": "acme_crm", "recordType": "Company",
                "identity": { "kind": "stable", "recordId": "company-7", "data": { "Name": "Vireo Robotics" } } },
  "fieldId": "Name"
}
```
→ `"Vireo Robotics"` (any JSON value, or `null`).

A position is how Listen-Fire hands a record back to you: the `recordType`,
your `recordId`, and the `data` you attached when you returned it. Read from
`data` when you can; it saves a call to your system.

A position an automation produced, rather than read from you, also carries
`originRef` (its `kind` is `extract`, `transform` or `resource`) and may carry
`evidence` and `resources`. You may ignore all three. A file ref inside them
is in the wire's spelling ([Files](#files)): its owner type and handle, never
Listen-Fire's credential or construction args.

### getRelated

```json
{
  "position": { "adapterType": "acme_crm", "recordType": "Company", "identity": { "kind": "stable", "recordId": "company-7" } },
  "fieldId": "Comments",
  "direction": "outgoing"
}
```
→
```json
[ { "position": { "adapterType": "acme_crm", "recordType": "Comment",
                  "identity": { "kind": "stable", "recordId": "comment-1", "data": { "Text": "approved" } } } } ]
```

- Every position you return must name its `recordType`; a typeless one is rejected.
- `where`, `orderBy` and `limit` may arrive as hints. You may ignore them;
  Listen-Fire applies them again.
- For a large collection, implement [`iterateRelatedPage`](#paging) too.

### createRecord

```json
{
  "recordType": "Company",
  "fields": { "Name": "Vireo Robotics" },
  "mutationContext": { "source": { "type": "structured_input" }, "occurredAt": "2026-10-07T09:54:31Z" },
  "parentLinks": [ { "recordType": "Deal", "externalId": "d_1", "edgeName": "Company" } ]
}
```
→
```json
{ "adapterType": "acme_crm", "externalId": "company-1", "recordType": "Company", "data": { "Name": "Vireo Robotics" } }
```

- `fields` is keyed by your field display names.
- `parentLinks` (optional) are parents to attach the new record to, along the named edge.
  A link may carry `data`: the parent's own payload, in its adapter's shape.
- Optional inputs: `evidence` (per field), `resources`, `bridgeToExternal`.
- The `data` you return is what an automation reads off the written record,
  and what [`awaitKeys`](#awaitkeys) later receives as `headData`.
- Optional outputs: `url`, `events`.

### updateRecord

The `createRecord` input plus `externalId` →

```json
{ "adapterType": "acme_crm", "externalId": "company-1", "recordType": "Company", "data": { "Name": "Vireo" }, "association": "none" }
```

- If the record is gone, return `{ "notFound": true }`; do not throw.
- `association` says what became of the `parentLinks`: `made`, `already`,
  `unsupported` (you cannot attach an existing record along that edge) or
  `none` (no parent was named). Omitted, it reads as `unsupported`.

### deleteRecord

`{ "recordType": "Company", "externalId": "company-1", "mutationContext": { … } }` → `{}` (optionally `{ "events": [] }`).

Asked only for a type whose descriptor says `"deletable": true`: under
an automation cannot delete any other.

### Optional methods

| Method | params | result |
|---|---|---|
| `iterateRelatedPage` | `getRelated` params + `cursor?` | `{ items, nextCursor? }` ([Paging](#paging)) |
| `awaitKeys` | `{ edge, heads: [{ recordId, headData?, recordType? }] }` | `[{ key }` or `{ gone: true }]`, one per head ([awaits](#awaitkeys)); adapter protocol 2.5 |
| `resolveAwait` | `{ recordId, edge, headData? }` | `pending` / `landed` / `empty` ([the key form](#the-key-form-before-25)) |
| `wakeKeys` | `{ raw }` | `string[]` ([the key form](#the-key-form-before-25)) |
| `preprocessInbound` | `{ raw, checkpoint? }` | `{ arrivals, checkpoint? }` — **required** to receive webhooks through the [host door](#inbound-through-the-host-door) ([Reporting arrivals](#reporting-arrivals)) |
| `listEventTypes` | `{}` | `[{ tag, positionType, match? }]` |
| `ensureEventSubscription` | `{ edge, filter?, scope?, callbackUrl, current? }` ([Subscribing for an edge's arrivals](#subscribing-for-an-edges-arrivals)); adapter protocol 2.6 | `{ externalId?, secret, expiresAt? }` |
| `removeEventSubscription` | `{ edge, filter?, scope?, callbackUrl, externalId? }`; a webhook a 0.12 listen registered is removed as `{ callbackUrl, externalId?, scope? }` | `null` |
| `refreshEventSubscription` | `{ edge, filter?, scope?, externalId }` | `{ expiresAt? }` or `null` ([Event subscriptions that expire](#event-subscriptions-that-expire)); adapter protocol 2.4 |
| `readRecord` | `{ recordType, externalId, fieldIds? }` | the record's fields, or `null` (lets an update with no changes be skipped) |
| `linkRecords` / `unlinkRecords` | `{ from: { recordType, externalId }, edgeName, to: { … }, mutationContext }` | `{ created }` / `{ removed }` |
| `resolveFileRef` | `{ ref }` | `{ url, contentType? }` ([Files](#files)) |
| `translateFilter` | `{ expression, entityType }` | `{ native, residual }` |
| `getDedupRules` | `{ typeRef }` | `{ constraints }` or `null` |
| `getActorCandidates` | `{ event }`: the run's trigger, whose `arrival` holds the landing, its `parents`, `about` and `actor` ([Who acted](#who-acted)) | `[{ identity, source }]` |
| `extractActor` | `{ event }`, as above; asked only when the arrival names no `actor` | an actor identity, or `null` |
| `describeOpaqueId` | `{ fieldPath, value }` | a label, or `null` |
| `invokeFieldFunction` | `{ recordType, fieldId, functionName, args: { instructions, data } }` | the composed value |
| `edgesFrom` | `{ position, cursor? }` | see [describe](#describe) |
| `poll` | `{ edge, filter?, scope?, cursor? }` | `{ arrivals, cursor?, pollAgainAt? }` ([Modules](#polled-sources-and-periodic-tasks)); needs `poll` declared; adapter protocol 2.6 (`pollAgainAt` 2.7) |
| `refreshCredential` | `{}` | `{ fields }` ([Modules](#credentials)); needs `credentials` declared |
| `runPeriodic` | `{ name }` | `null` ([Modules](#polled-sources-and-periodic-tasks)); needs `periodic` declared |
| `checkInbound` | `{ request, secret?, checkpoint?, replayed? }` | `accepted` / `refused` / `reply` ([Modules](#a-module-that-checks-its-own-inbound)); needs `inbound.scheme: module` |

### Event subscriptions that expire

Some sources let a subscription lapse unless it is renewed (Airtable's
webhooks expire 7 days after their last refresh). Such a module says when:

- `ensureEventSubscription` answers `expiresAt` (an ISO time) beside
  `externalId` and `secret`.
- It lists `refreshEventSubscription`, which extends the subscription named by
  `externalId` (and `scope`) and answers its new `expiresAt`.

`listen-fire` keeps each subscription's `expiresAt` and refreshes it a day before then,
or halfway there when less than two days remain. The refresh is a work row
(`refresh_subscription`), so `listen-fire serve` runs it on its tick, and `listen-fire drain`
takes it in a scale-from-zero deployment, whose wake slot is told when it is
due. A refresh that fails is said once and tried again 15 minutes on. A
subscription whose `expiresAt` has passed has lapsed: `listen-fire` registers it anew
(`ensureEventSubscription` with no `current`) and keeps the new id and secret.
A module that answers no `expiresAt` is never refreshed.

`listEventTypes` example — the CRM's one event, delivered as a `Company`:

```json
[ { "tag": "company.created", "positionType": "Company" } ]
```

## Waiting on your system (awaits)

An automation can wait for something to happen in your system:

```
c = write crm-[:Company]-> { Name: "Vireo Robotics" }
r = await c-[:Comments]->
```

The run stops at the `await` and resumes when a comment arrives. Listen-Fire
owns all the waiting state: a log of what arrived on each record's edge, and
each run's wait on it. Your server does two things (adapter protocol 2.5):

- It names the key each record's edge is waited on under (`awaitKeys`).
- It reports what arrives, as arrivals: with the events of a delivery it
  reads, or pushed to the `wake` door ([Reporting arrivals](#reporting-arrivals)).

An arrival reported before anybody waits is kept for a while, so a run that
starts waiting just after the write that caused it still takes it.

### Declaring a listenable edge

On the reference in `describe`:

- `listenable: true` — you announce arrivals on the edge: automations may
  `await` it, and you will wake waiting runs (through `wake` or a delivery to
  the host door). Without it, `await` on the edge is refused when the
  automation is saved.
- `readable` says separately whether the edge can be listed. An edge can be
  listenable, listable, or both.
- `identity` (optional) — the field of what lands that names an arrival, so a
  repeat is dropped.
- `version` (optional) — the field that changes when an arrival changes.
  Without it, only a new record counts as an arrival.
- `identity` and `version` name a field by the `displayName` the landing's
  type declares. A name the landing does not declare is refused when
  `listen-fire` describes your adapter.
- `cursor` (optional) — `true` if you can list the arrivals since a mark you
  hand out. Without it, an arrival announced while nobody listened is lost.
- `sequenced` — the order you list the edge in (`chronological`, `document`
  or `arrival`).

What a listen needs to know (an entry point that is `listenable` takes the
same keys). Every number you declare is a default the operator's `lf.yaml`
overrides; you state it because Listen-Fire has none of its own.

- `delivery` — how arrivals reach Listen-Fire: `connection` (pushed for the
  whole connection: one subscription serves every listen on it), `scope`
  (pushed per parent you can subscribe to, a table), or `polled`.
- `pollEverySeconds` — with `delivery: polled`, and only then: how often you
  are polled, a positive whole number. `lf.yaml`'s
  `pollEvery: { <credential>: <duration> }` overrides it.
- `bounded` — absent means bounded: the edge holds what one record has.
  `false` says it spans more than a listen should range over (every schedule,
  every team's mail). Such an edge names, in `boundedBy`, the landing's fields
  whose `==` or `IN [ … ]` with literals narrow it to a finite set; a listen
  that narrows it no other way is refused when the automation is saved.
- `carries` — the earlier hops whose records an arrival carries, by edge
  name, outermost first (`["Bases", "Tables"]` on a table's `Changes`): a
  filter on one of them is judged against the record the arrival carries.
  A hop it does not carry may come between: Slack's reaction carries its
  channel (`["Channels"]` on a message's `Reactions`), not the message it
  is on, so a listen filtering that message is refused.
- `scopedBy` — with `delivery: scope`, and only then: the earlier hop, by
  edge name, whose records your subscriptions are made per, instead of the
  record the edge hangs off. listen-fire then subscribes once per record that
  hop landed on for a listen, whatever number of records hang off it. Each
  arrival still names, as its `key`, the record it is under, and a listen
  keeps only arrivals under the records it watches. Airtable's `Changes`
  declares `scopedBy: "Bases"`: one data webhook per base
  (`ensureEventSubscription({ edge: "Changes", scope: <base id> })`), each
  change keyed by its table, so a listen over three tables of one base makes
  one webhook, not three. The hop must come before the edge on every path to
  it from the instance.
- `attributes` — `true` if an arrival names the record it is about.
- `addressed` — `true` if each arrival is sent to an address its sender chose
  (an inbox's plus-suffix). An arrival that no listen's `WHERE` takes is then
  a misdirected message, and the host says so at its default log level; on an
  edge that does not declare it, that line is said only under `LF_LOG=debug`.
- `membersChange` — how a listen learns the edge's members changed, so a
  filter on it as an earlier hop can be re-resolved. Declare it only where
  listing the members is cheap (a base's tables; never every message in a
  workspace). One of:
  - `"pushed"` — you report when a member is created, renamed
    or removed, as an arrival on this edge itself (so it must be
    `listenable`), and a listen re-resolves on each such arrival listen-fire
    receives, never on a clock. listen-fire subscribes to (or polls) the edge
    for the listen itself; one with `delivery: "scope"` that hangs off a
    record is subscribed to once per record it hangs off (Airtable's
    `Tables`: `ensureEventSubscription({ edge: "Tables", scope: <base id> })`,
    one schema webhook per base);
  - `{ "relistEverySeconds": n }` — how often, in seconds, its members should
    be re-listed. `lf.yaml`'s `resolveEvery` overrides it.

Each is refused, by name, when `listen-fire` describes your adapter if it
cannot mean what it says: a `delivery` that is none of the three, a polled
edge without `pollEverySeconds` (or `pollEverySeconds` on one that is not
polled), `bounded: false` without `boundedBy` (or `boundedBy` on a bounded
edge), a `boundedBy` field the landing does not declare, a `carries` hop that
is no edge into the type the next one hangs off or a type before it, a `scopedBy` on an edge not
delivered per scope or on a root collection, or naming a hop some path to the
edge does not come through, a `membersChange` that is neither `"pushed"` nor
`{ relistEverySeconds }`, `membersChange: "pushed"` on an edge that is not `listenable`, a number that is not a positive whole number of seconds, a
field of kind `owned` that names no scalar, `delivery: scope` on a root
collection (nothing comes before it to scope by), an `identity` or `version`
naming a field the landing does not declare, or one listenable edge name that
lands on the same record type from two record types: an arrival says only
its edge and the record type it landed on, so give each its own record type
to land on.

A reference that still declares `awaitable` or `watchable` (retired in 0.13)
is refused when `listen-fire` describes your adapter, naming `listenable`.
One that declares `resolvesEmpty` (retired in 0.13) is refused too: a record
that goes (a [gone arrival](#reporting-arrivals)) leaves the wait waiting on
every edge, so there is nothing to declare. The host marks such a wait
stranded and shows it ([stranded waits](stranded-waits.md)).

### awaitKeys

```json
{ "edge": "Comments", "heads": [ { "recordId": "company-1", "headData": { "Name": "Vireo Robotics" } } ] }
```
→
```json
[ { "key": "thread:company-1" } ]
```

- One answer per head, in the order of `heads`.
- `recordId` is the `externalId` you returned when the record was written;
  `headData` the `data` you returned with it, when there was any.
- `recordType` is the record's type, as your catalog names it, wherever the
  host knows it (adapter protocol 2.6).
- `key` is what your arrivals on that record's edge will name. Compute it
  from the heads alone: no call to your system.
- A host matches an arrival to a wait by module, edge and key alone. If your
  record types number their ids apart (an organization 13 and a person 13),
  qualify the key by the kind of record, here and in each arrival's `key`
  alike (`organization:13`). The key is only ever compared, never parsed.
- `{ "gone": true }` says the record is gone and nothing more arrives on it.
  The run's wait on it opens without a key, and an `await` on it parks
  stranded ([stranded waits](stranded-waits.md)).

### Reporting arrivals

One arrival names the edge, the key of the record it landed on, its identity
(the landing's value of the field the edge declares as `identity`), its
`version` when the edge declares one, and the landing:

```json
{ "edge": "Comments", "key": "thread:company-1", "identity": "comment-7",
  "landing": { "recordId": "comment-7", "recordType": "Comment", "fields": { "Id": "comment-7", "Text": "approved" } } }
```

A record that went is a gone arrival: `{ "edge": "Comments", "key": "thread:company-1", "gone": true }`.

From adapter protocol 2.6 an arrival may say more, for the listens on its edge
(`listen to crm-[c:Company WHERE c.Name != "Ignored"]-> fire welcome`):

- **No `key` on a root edge.** An arrival on one of the connection's root
  edges (an entry point declaring `listenable`) lands on no record's edge, so
  it names no key. No wait reads it; the listens on that edge do. A gone
  arrival always names its key.
- **`recordType` on the landing and on each parent**: the record type it is,
  as you describe it (its `displayName`). One edge name may hang off several
  of your record types (every object's `Changes`), and the host tells their
  arrivals apart by the record type alone: a listen on
  `pay-[:Customers]->-[c:Changes]->` fires only on a landing that says it is
  the record type a customer's `Changes` lands on, carried with a parent
  that says it is a `Customer`. An arrival whose landing or parent states
  another record type is not that listen's; one that states none runs no
  listen, and the host says why.
- **`parents`**: the records of the earlier hops the edge declares it
  `carries`, outermost first, each a landing or `null` for one it cannot
  carry. A listen's filter on an earlier hop is judged against them.
- **`unknown` on the landing and on each parent**: the fields you could not
  read for it, by name (`"unknown": ["Mentions App"]`), when a lookup your
  provider did not answer stands between the delivery and a field's value.
  Report the arrival anyway, and acknowledge the delivery: never rely on the
  provider sending it again. A listen whose filter reads one of those fields
  is not judged on a guess (unless another side of an `OR` holds, or of an
  `AND` fails, which decides it whatever the field): it runs nothing for this arrival, and the host
  reports it (on listen-fire an `Arrival Not Judged` system event,
  [system-events.md](system-events.md)). Every other listen on the edge is
  judged as usual. What `fields` holds for an unknown field (null, or
  nothing) is never read by the judge.
- **`about`**: `{ "recordType", "externalId" }`, the record the arrival is
  about when that is not its landing (a change to a row names the row).
- **`notFor`**: the listen it must not run, by its pipeline: a listen's own
  failure, reported to the listens on the edge it failed on, never reaches
  it. On `listen-fire` a listen on a traversal is
  `listen:<file>:<movement>:<digest>`, the digest being the first 8 hex
  digits of the sha256 of the listen's identity (what makes two listens one
  to the checker) and its connection's construction, so two listens in one file that fire one function are
  told apart. Nothing is said of the listen an arrival is not for.
- **`takenApplied`**: `true` when your module applied the listen's filter
  before reporting it (a filtered poll or subscription). Absent, the host
  judges the whole filter itself. A field of kind `owned` is one only you can
  evaluate, so the host judges a comparison on it only when the arrival
  carries the field: it then compares the text the arrival carries with the
  listen's literal, exactly. Carry the canonical spelling, the one a listen's
  literal is checked against (your `allowPattern`): an inbox carries its key
  lowercased, as its pattern admits only lowercase, and a cron tick carries
  the schedule and zone it was polled for. Leave the field out, or set
  `takenApplied`, when text equality would not mean what your scalar means.
- **`occurredAt`**: when the change happened in your system, as your system
  stamped it (an ISO 8601 instant). Listen-Fire measures from it whether a
  run's write caused the arrival (the loop breaker, below), however late a
  poll finds it. Send it wherever your system gives a time; an arrival
  without it is measured to when Listen-Fire takes it. One that is not an
  instant is refused, naming its place and edge. From 2.7 the run the
  arrival fires is stamped with it, so its writes say when the change they
  follow happened, not when the host took it.
- **`actor`** (adapter protocol 2.7): who acted, where your provider says,
  as `extractActor` answers: `{ "identifier", "scheme", "email"?, "name"?,
  "label"? }` ([Who acted](#who-acted)).

A run an arrival fires is handed the arrival's landing, its `parents`, its
`about` and its `actor` (2.7), and nothing else: there is no raw event
after the door. Put on the landing every field its record type's edges
read (the record as your provider sent it, with your named fields over it),
so an edge walked from the fired record reads what it would read from a
listed one.

#### Who acted

Set `actor` where you build the arrival: the member who posted, the sender
of a mail, the owner of a meeting.

```json
{ "edge": "Messages", "key": "C0DEALS", "identity": "C0DEALS:1730541600.000100",
  "landing": { "recordId": "C0DEALS:1730541600.000100", "recordType": "Message", "fields": { "user": "U001", "text": "Acme wants a term sheet" } },
  "actor": { "identifier": "U001", "scheme": "opaque", "label": "U001" } }
```

- `identifier` is your system's id for them; `scheme` says how a host
  resolves them to one of its users: `email` (the address is `email`, or
  the identifier), `phone`, or `opaque` (a provider id that resolves to no
  user). `name`, else `label`, is what `@actor_name` reads.
- The run's `@actor_*` read it; your `extractActor` is asked only for an
  arrival that names none.
- A host resolves `@user_*` from it: it asks your `getActorCandidates`
  when you offer it (a lookup by API, a mail's forwarding relays), else
  takes the actor as the one originator candidate.
- Both methods are handed the run's trigger as `event`. Its `arrival` holds
  what you put on the arrival: read who acted from `event.arrival.actor` and
  the record's fields from `event.arrival.landing.fields`. A run fired by an
  arrival has no `payload`.

```json
{ "edge": "Company", "identity": "company-1",
  "landing": { "recordId": "company-1", "recordType": "Company", "fields": { "id": "company-1", "Name": "Osprey" } } }
```

A module that reports a root arrival states `protocolMinor: 6`: a host
speaking 2.5 refuses an arrival with no key.

Report them in one of three places:

- `arrivals` beside the events `preprocessInbound` answers for a delivery to
  the [host door](#inbound-through-the-host-door);
- `arrivals` on an `accepted` answer of [`checkInbound`](#a-module-that-checks-its-own-inbound)
  (`accepted(events, { arrivals })` in the module kit);
- pushed to the `wake` door: `{ "arrivals": [ … ] }` ([the door](#the-door-you-call)).

What Listen-Fire does with them:

- Every arrival is logged, waited on or not, and kept while a wait, or a
  step about to open one, may read it. A delivery's arrivals are logged with
  its receipt, so a redelivery under the same delivery id logs nothing
  again, and an arrival reported again with the same identity and version
  within your `resendWindowSeconds` (an hour unless you declare one) is
  logged once, wherever it comes from.
- A run a delivery or a poll starts waits from just before that delivery's
  or page's arrivals on the records it is handed: its trigger's edges, and
  the edges off each record its trigger's arrival carries (`parents`) that
  the automation awaits. Any other arrival of the same delivery or page may
  answer its `await new` on them, and only the arrival that is its trigger,
  matched by identity, never does. A record the run reaches some other way
  is waited on from when the run reaches it.
- Each run waiting on the record's edge is woken. It reads the arrivals
  logged since it began waiting, judges each once by identity and version,
  and resumes with the first that passes the automation's `WHERE`.
- Each arrival that landed is judged against every listen on its edge that
  hears the connection it came for. A listen its filter takes runs, its
  parameter bound to the landing; the same arrival (edge, key, identity and
  version) delivered again runs it once. One its filter refuses runs nothing;
  `listen-fire` says so only under `LF_LOG=debug`, as one line per arrival
  and listen would flood a busy edge. One it cannot judge runs nothing
  either, and its reason is said once per delivery.
- An arrival without an identity is refused, naming its place and edge
  (`arrival 0 on 'Comments' has no identity`): at the `wake` door with 400,
  on a delivery as your adapter's failure (500).
- **The loop breaker.** A run's writes can cause arrivals that fire more
  runs (a two-way sync, or two automations feeding each other).
  Listen-Fire keeps each record write a run sends, the moment you answer it.
  An arrival on a record a run wrote is caused by that write when it
  happened at most `lf.yaml`'s `loopWindow` (default 20 seconds) after it:
  measured to its `occurredAt`, or, without one, to when Listen-Fire takes
  it. The arrival is matched by the record it is `about` (where the edge
  declares `attributes`) and by its landing's `recordId`; the deepest write
  of either is its cause. The run it fires is the next in that write's
  chain, and the listen whose arrival would make a chain longer than
  `loopDepth` (default 10) runs is paused, `LISTEN_LOOP`, naming the chain,
  until `listen-fire listens resume`. While it is paused, its arrivals are
  counted and run nothing; they are not run when it resumes. An edge whose arrivals name no record they are
  about, landing on records no write to your module makes, cannot be
  protected: `listen-fire listens` says so.
- **Writes that change nothing are not sent** where you list `readRecord`:
  the engine reads the record first, and settles a write whose fields all
  match `noop`. A two-way sync's echo then writes nothing, and its chain
  ends. Without `readRecord` every write is sent, and its echo runs again
  until the loop breaker stops it; `listen-fire listens` says that too.
- **Commit before you report.** A woken run reads the landing you reported,
  not your system, so report what you committed.

### The key form (before 2.5)

The key form is retired in 0.13.0: no host calls `resolveAwait` or `wakeKeys`, a `checkInbound` acceptance's `wakeKeys` is ignored, and the `wake` door refuses `{ keys }` by name (400, saying to send `arrivals`).

## Telling Listen-Fire something happened

There are two ways in. Use whichever fits your system:

- **You push** arrivals to the `wake` door. Simplest: no subscription, no
  signatures.
- **Listen-Fire subscribes** to you and you deliver webhooks to the URL it
  gives you (the host door). Use this when your system already sends webhooks.

Either way what you report is arrivals ([Reporting arrivals](#reporting-arrivals)).

### The door you call

```
POST {listen-fire}/api/public/adapter/{adapterType}/wake   { "arrivals": [ … ] }
```

The `emit` door of earlier releases is retired ([below](#emit-retired-in-013)).

Authentication:

- Send the same header, with the same secret, that Listen-Fire sends you (your
  `authStrategy`). The install whose secret matches is the team.
- You never name the team, except with the optional `x-listen-fire-team`
  header (the same header, and the same team id, Listen-Fire sends on every
  call to you). Use it when one secret serves several teams' installs of your
  adapter: it narrows the lookup to that team. Its value must be the team's
  id, a UUID; anything else is answered 401 with no further detail.

Answers:

| Status | Body | When |
|---|---|---|
| 202 | `{ "accepted": n }` | queued |
| 400 | `{ "error": "bad_request", "issues": [{ "path", "message" }] }` | malformed body |
| 410 | `{ "error": "emit_retired", "message" }` | any body sent to `emit`, once authenticated |
| 401 | `{ "error": "unauthorized" }` | the secret matches no install of this type, the type is not installed, the named team has no matching install, or the type is a name a built-in adapter answers to |
| 409 | `{ "error": "ambiguous_credential", "message" }` | the secret matches installs on several teams and no `x-listen-fire-team` was sent |
| 413 | | the body is over 1 MB |
| 500 | `{ "error": "internal" }` | retry later |

- Authentication is checked before the body, so an unauthenticated caller
  learns nothing about the body's shape.
- 401 is the only refusal for anything unauthenticated: never 404.
- A body carries 1 to 1,000 arrivals, in at most 1 MB of JSON
  (`content-type: application/json`).
- Delivery is at least once. Retry on 5xx or a network failure.
#### emit: retired in 0.13

From 0.13.0 an event fires no listen: a listen is a traversal, fired by the
arrivals on its edge. So `emit` refuses by name rather than accept what could
run nothing: once the caller is authenticated (401 and 409 are as for `wake`),
whatever the body, it answers 410 `{ "error": "emit_retired", "message" }` and
keeps nothing. Report what happened on `wake`.

#### wake: what arrived

```json
{ "arrivals": [ { "edge": "Comments", "key": "thread:company-1", "identity": "comment-7",
                  "landing": { "recordType": "Comment", "fields": { "Id": "comment-7", "Text": "approved" } } } ] }
```

- Each arrival is logged, and each run waiting on its record's edge is woken
  ([Reporting arrivals](#reporting-arrivals)). An arrival nobody waits on is
  accepted and kept for a run that starts waiting soon after.
- An arrival without an identity is answered 400 at path `arrivals`, naming
  it (`arrival 0 on 'Comments' has no identity`); nothing is logged.
- A body naming keys (`{ "keys": ["thread:company-1"] }`, [the key form](#the-key-form-before-25))
  is answered 400 at path `keys`, naming adapter protocol 2.5 and `arrivals`;
  nothing in it is logged.
- `accepted` counts the arrivals taken.

### Inbound through the host door

If your system sends webhooks, let Listen-Fire subscribe:

1. While any listen ends on a listenable edge of yours that declares
   `delivery: connection` or `scope`, Listen-Fire calls
   `ensureEventSubscription` for it ([Subscribing for an edge's arrivals](#subscribing-for-an-edges-arrivals)):

   ```json
   { "edge": "Companies", "callbackUrl": "https://listen-fire.example/api/public/webhook-sync/acme_crm/5f0c…" }
   ```
   →
   ```json
   { "externalId": "crm-sub-1", "secret": "8c1d…" }
   ```

   - Make it an idempotent upsert. `current` (`{ externalId }`) arrives when
     the subscription is already held; keep it rather than adding another.
   - Return the same secret to keep it. A different secret rotates it:
     Listen-Fire stores it and verifies the next delivery with it.
   - Being asked again is how a subscription you lost (a restart, a wiped
     store) comes back.
   - Treat `callbackUrl` as opaque. It is stable for the install.
   - `secret` is required. Without one the subscription is refused, withdrawn
     (`removeEventSubscription`), and reported as a problem when the automation
     is saved.

2. Deliver each webhook as a `POST` to `callbackUrl`, signed:

   ```
   x-listen-fire-signature: <lowercase hex HMAC-SHA256 of the exact raw body, keyed by the secret>
   ```

   The body is your own format, sent as `content-type: application/json`, at
   most 100 KB. Listen-Fire answers:

   | Status | When |
   |---|---|
   | 200 `{ "ok": true, "eventsProcessed": n }` | accepted; `n` counts the arrivals (and any events) the delivery brought |
   | 400 `{ "error": "provider_mismatch" }` | the URL's adapter segment does not match the subscription |
   | 401 `{ "error": "signature_invalid" }` | bad or missing signature |
   | 404 `{ "error": "subscription_not_found" }` | unknown or deleted subscription |
   | 503 `{ "error": "arrivals_not_kept", "message" }` | the delivery reports arrivals and Listen-Fire's store cannot keep them yet; nothing was kept: send it again |
   | 500 | your adapter does not implement `preprocessInbound`; an arrival it reports names no identity; or an internal failure |

3. While your delivery is open, Listen-Fire calls you back:
   `preprocessInbound({ raw })` turns your body into the arrivals it reports
   ([Reporting arrivals](#reporting-arrivals)). A single-threaded server must
   not block on its own delivery.

   ```json
   { "raw": { "companies": [ { "id": "company-3", "Name": "Larch Bio" } ] } }
   ```
   →
   ```json
   { "arrivals": [ { "edge": "Companies", "identity": "company-3", "landing": { "recordId": "company-3", "recordType": "Company", "fields": { "Name": "Larch Bio" } } } ] }
   ```

   `checkpoint` is optional: whatever you return is handed back on the next delivery.

4. When no listen needs the subscription any more, Listen-Fire calls
   `removeEventSubscription`.

Protocol 2 has no replay protection: a captured signed delivery verifies
again. Keep the callback on HTTPS.

### Subscribing for an edge's arrivals

From adapter protocol 2.6 a listenable edge declaring `delivery: connection`
or `scope` is subscribed for with its own shape, once for every listen on it
([Declaring a listenable edge](#declaring-a-listenable-edge)):

- `ensureEventSubscription`: `{ edge, filter?, scope?, callbackUrl, current? }`
  → `{ externalId?, secret, expiresAt? }`. `edge`, `filter` and `scope` mean
  what they mean on an [edge's poll](#polled-sources-and-periodic-tasks):
  the edge's name, the part of the listens' `WHERE` on it that you take, and
  the record it hangs off when the listens watch it under one. `current`
  (`{ externalId }`) arrives when the subscription is already held: keep it,
  and answer `null` to leave it as it is. There are no `events`.
- **One subscription per connection, edge, filter and scope.** Every listen
  whose traversal ends on the same edge of the same connection (credential
  and position), with the same filter you take and the same scope, shares
  one subscription, with its own `callbackUrl` and secret. Two listens with
  different taken filters are two subscriptions.
- Deliver to its `callbackUrl` as for any subscription, reporting what
  landed as `arrivals` from `preprocessInbound`
  ([Reporting arrivals](#reporting-arrivals)). The host judges an arrival
  delivered there only against the listens sharing that subscription.
- **`takenApplied`.** Set it on an arrival only when you applied `filter`.
  Without it, the host checks the whole filter itself.
- `removeEventSubscription` (`{ edge, filter?, scope?, callbackUrl,
  externalId? }`) comes once no listen shares it, and
  `refreshEventSubscription` (`{ edge, filter?, scope?, externalId }`) as for
  any [subscription that expires](#event-subscriptions-that-expire). One that
  lapsed is asked for anew with `edge`, `filter` and `scope` too.

## Modules: credentials, signatures and schedules

An installable module (a built-in integration such as `@lf/attio`, or your
own server) can hand its housekeeping to the host by declaring it in the
manifest. Every declaration is optional and is an addition within version 2:
a server that declares nothing is unchanged.

A declaration and its method go together. The manifest is refused when one
is present without the other (`poll` with the `poll` method, `periodic` with
`runPeriodic`, `plugins` with `invokePlugin`), or when a name is declared
twice. `refreshCredential` needs
`credentials`, but `credentials` does not need `refreshCredential`.

### Credentials

Declare the credential your module needs to reach its provider. Several
declarations are ALTERNATIVES (Gmail sign-in or a service account): a
connection uses exactly one (``connect `@lf/gmail` using alice_gmail``), and the host
sends only that one. A module that needs two secrets at once declares them as
two fields of one credential:

```json
"credentials": [
  {
    "name": "attio",
    "kind": "oauth2",
    "fields": [{ "name": "workspace_id", "label": "Workspace", "secret": false }],
    "oauth2": {
      "authorizeUrl": "https://app.attio.com/authorize",
      "tokenUrl": "https://app.attio.com/oauth/token",
      "scopes": ["record_permission:read-write"],
      "clientAuth": "body",
      "pkce": true
    }
  }
]
```

- `name` is ASCII lower case. It names the credential in `lf.yaml`, a connect
  link and the request.
- `kind` is `static` or `oauth2`:
  - `static` is entered once and never refreshed by the host (an API key, a
    bot token). It holds exactly its `fields`.
  - `oauth2` is connected through the provider's authorize page. It holds
    `access_token`, `refresh_token` and `expires_at` (an ISO time) besides its
    `fields`, and needs the `oauth2` block.
- Each field is `{ name, label?, secret?, optional? }`. A field is secret
  unless it says `"secret": false`: the host keeps secret fields out of logs,
  traces and error text.
- `oauth2`: `authorizeUrl` and `tokenUrl` (required), `scopes`, `clientAuth`
  (`basic`, the default, sends the client id and secret as an HTTP Basic
  header on the token call; `body` sends them in the form), `pkce`, and
  `authorizeParams` (extra query parameters for the authorize page).

Your server's secret belongs to the install; a declared credential belongs to
the CONNECTION. One install serves many users: a movement connects once per
account, naming the credential each connection acts as,

```
hs_alice = connect #hubspot using alice_hubspot
hs_bob = connect #hubspot using bob_hubspot
```

and every call made through `hs_alice` is signed with the install's secret
and carries Alice's credential, every call through `hs_bob` Bob's. The host
binds each stored credential to one module and one of its declared
credentials (the platform's credential row; listen-fire's `module:` + `credential:`
secrets entry), and refuses at check a connection naming a credential bound
to another module, or to a credential the module does not declare. The OAuth
app you register at your provider (its client id and secret) belongs to the
install too, and stays with the host, which refreshes with it.

The host sends the connection's credential on every request, beside
`params`:

```json
{
  "protocolVersion": "2",
  "method": "poll",
  "cacheScopeId": "c0ffee",
  "params": { "config": {} },
  "credential": { "name": "attio", "fields": { "access_token": "…", "refresh_token": "…", "expires_at": "2026-10-17T12:00:00.000Z" } }
}
```

- Every field value is a string.
- The fields sent are the ones the declaration names, plus `access_token`,
  `refresh_token` and `expires_at` for an `oauth2` one. Anything else the host
  keeps beside them (its client secret, say) is never sent.
- `credential` is the one the connection names, under the declared
  credential it fills. Never more than one: the request has no `credentials`
  list (an older host that sends one is ignored). A module that declares none
  is sent none.
- The host sends a credential only to an installed module that declares it,
  and only over loopback or HTTPS.
- Never log it, echo it in an error, or store it beyond the call.

If your call changed the credential (you refreshed the token, or the provider
rotated the refresh token), say so beside the result:

```json
{ "ok": true, "result": { "events": [] }, "credentialUpdate": { "name": "attio", "fields": { "access_token": "…", "refresh_token": "…" } } }
```

- Only the fields you name change; the host merges them over the stored ones
  and writes them back to the credential the call carried (Alice's update
  lands on Alice's credential, never Bob's).
- Name only fields your declaration names (and the three token fields of an
  `oauth2` credential). An update naming any other field is refused, and the
  call fails.
- `credentialUpdate` may ride a failure (`ok: false`) too. Send it whenever a
  token changed, or a rotated refresh token is lost.

Refreshing:

- The host refreshes an `oauth2` credential itself, with the standard
  refresh-token grant at `tokenUrl` and the install's OAuth app, before a call
  when `expires_at` is near and once more when a call fails as unauthorized.
- A provider whose refresh is not the standard grant implements
  `refreshCredential`: `{}` → `{ fields }`, the changed fields. The credential
  to refresh is the request's `credential`.
- The host runs at most one refresh of a credential at a time, so two calls
  never spend the same refresh token.

### Declared inbound signatures

A module whose provider sends webhooks names how they are signed, and the
host verifies each delivery before `preprocessInbound` sees it:

```json
"inbound": {
  "providerKey": "attio",
  "scheme": "attio",
  "signatureHeaders": ["attio-signature", "x-attio-signature"]
}
```

- `providerKey` is the door's provider segment:
  `/api/public/webhook-sync/<providerKey>/<subscription>`. A built-in keeps
  today's key, so no subscription's URL changes.
- `scheme` is one of:

  | `scheme` | Provider |
  |---|---|
  | `hmac_sha256_hex` | lower-case hex HMAC-SHA256 of the raw body |
  | `airtable_mac` | Airtable's `x-airtable-content-mac` |
  | `attio` | Attio's signature |
  | `affinity_hex_or_b64` | Affinity's signature, hex or base64 |
  | `slack_v0` | Slack's `v0` signature over the timestamp and body |
  | `telegram_secret_token` | Telegram's secret token, compared whole |
  | `remote` | this protocol's own `x-listen-fire-signature` ([host door](#inbound-through-the-host-door)) |

- `signatureHeaders` lists the headers that may carry the signature, in lower
  case; the first one present is read. `slack_v0` also reads
  `x-slack-request-timestamp`, which the scheme fixes, and refuses a request
  whose timestamp is more than five minutes from now (a replay).
- `deliveryId` (optional) names the header that carries the provider's id for
  a delivery, `{ "header": "x-github-delivery" }` (lower case, as
  `signatureHeaders`). The host reads it before `preprocessInbound` and keeps
  a second delivery under the same id at the same subscription out: it answers
  200 `{ ok: true, duplicate: true, eventsProcessed: 0 }` and queues nothing.
  Without it every delivery is kept under an id the host mints, and none is a
  duplicate. Ignored for `scheme: module`, whose check names the id itself.
- `intercepts` (optional) names requests the host answers itself, unsigned,
  before verifying: `slack_url_verification` echoes Slack's `challenge`.
- `secretIssuedBy` (optional) says who sets the key deliveries are signed
  with. `installer`, the default: whoever installs the module sets it (`listen-fire
  connect` generates one or takes the one typed). `provider`: the provider
  issues it when the webhook is registered, as `ensureEventSubscription`'s
  `secret`; nobody is asked for it, and a registration that returns none is
  refused (and withdrawn). Attio and Airtable issue theirs.
- `captureHeaders` (optional, lower case; adapter protocol 2.6) names the
  headers your inbound handling reads besides the body. A kept delivery holds
  its request for a replay (`listen-fire listens replay`), and of its headers
  only these, beside the two the host reads itself under a declared scheme:
  `content-type`, which it decodes the body by, and the `deliveryId` header.
  None by default. A header that may carry a credential is refused when the
  module is described: `cookie`, any scheme's signature header, any of the
  declaration's `signatureHeaders`, and any name holding `signature`,
  `secret`, `token`, `key`, `auth`, `hmac` or `password`. A replay is not
  verified again.
- `redactFields` (optional; adapter protocol 2.6) names the fields of the
  body and the query string that may carry a credential, dropped before a
  request is kept: a JSON body's own members, a form's fields and the
  members of a JSON object a form field holds (Slack's `payload`), and the
  query's parameters. `@lf/slack` names `token`, its legacy verification
  token; `@lf/webhook` names the fields a sender that cannot sign puts a
  credential in (`token`, `access_token`, `api_key`, `apikey`, `api_token`,
  `secret`, `client_secret`, `password`, `signature`). Anything else in the body is kept as the provider sent it, so a
  kept request may hold what the provider puts there.
- One host rule for every scheme: a delivery is refused when the key it
  should be signed with is missing, blank or still the placeholder a
  subscription holds before its registration returns a secret, and when its
  signature is wrong. No scheme is lenient for a module (a built-in keeps its
  door's behaviour only until it moves onto a module manifest).
- A scheme or intercept the host does not know refuses the manifest; it is
  never silently left unverified. A provider no scheme fits checks its own
  requests ([below](#a-module-that-checks-its-own-inbound)).

### A module that checks its own inbound

A provider no scheme fits (Mailgun's form signature, Resend's Svix), or one
that needs a handshake answered (Meta's verification `GET`), is checked by the
module itself. The manifest says so, and lists `checkInbound`:

```json
"inbound": { "providerKey": "email", "scheme": "module" }
```

- No `signatureHeaders` and no `intercepts`. `secretIssuedBy` and
  `captureHeaders` are as above: a replayed request carries only the headers
  `captureHeaders` names (`@lf/email` names `svix-id`, which tells Resend from
  Mailgun; `@lf/forms` names `content-type`), never its signature.
- The door takes `POST` and `GET` for it (only `POST` for a declared scheme).
- The host hands each request to `checkInbound`, as it arrived, and sends what
  the module answers. It verifies nothing itself, and does not call
  `preprocessInbound` for it.

```json
{
  "request": {
    "method": "POST",
    "path": "/api/public/webhook-sync/email/mail",
    "query": "",
    "headers": { "content-type": "application/x-www-form-urlencoded" },
    "body": "c2VuZGVyPWFkYSU0MGV4YW1wbGUuY29tJi4uLg=="
  },
  "secret": "key-3b2f…"
}
```

- `body` is the exact bytes, base64. Header names are lower case, each with
  its first value.
- `secret` is the subscription's key, present only when it is usable (not
  missing, blank or the placeholder before registration). Refuse when you
  need it and it is absent.
- `checkpoint` is what your last `accepted` answer returned.
- `replayed` (adapter protocol 2.6) is `true` when the host is running a
  request it kept itself again (`listen-fire listens replay`), not one that
  arrived. The host vouches for the request: skip your signature check and
  your timestamp window, which would refuse a request signed days ago, and
  answer as for any request, your lookups made afresh. The host sets it only
  for a replay, from nothing a sender controls, and never for a live request;
  read it from this field alone, never from a header, the query or the body.
  The replayed request holds only the headers your `captureHeaders` names, so
  its signature is not there to check. A module older than 2.6 ignores
  `replayed` and checks as before, and refuses the replay.
- The request carries the install's credential, as any call does: the keys a
  check reads (a verify token, the API key a thin notification is fetched
  with).

The answer is one of three:

| `outcome` | Fields | The door answers |
|---|---|---|
| `accepted` | `events`, `arrivals?`, `checkpoint?`, `deliveryId?`, `reply?` | 200 `{ ok, eventsProcessed }` once the arrivals are logged and the events are queued, as for any delivery, or `reply` (a 2xx `status` with `text`, `html` or `json`) in its place; a non-empty `deliveryId` already kept at this subscription answers 200 `{ ok, duplicate: true, eventsProcessed: 0 }` and queues nothing |
| `refused` | `status?` (a 4xx) | `status`, default 401, `{ "error": "signature_invalid" }` |
| `reply` | `status`, `text?`, `html?` or `json?` | exactly that: `text` as `text/plain`, `html` as `text/html` (a page your module serves at its door), `json` as JSON, none as an empty body; nothing runs |

```json
{ "outcome": "reply", "status": 200, "text": "1158201444" }
```

A throw is an internal failure: the door answers 500 and the provider
retries. The module kit reads the request for you (`inboundRequest(input)`:
its bytes, text, JSON, form, query and headers) and builds the answers
(`accepted`, `refused`, `reply`).

### Polled sources and periodic tasks

A source with no webhooks is polled:

```json
"poll": { "intervalSeconds": 300 }
```

A listenable edge declaring `delivery: polled` is polled once for every
listen on it ([Declaring a listenable edge](#declaring-a-listenable-edge);
adapter protocol 2.6). The declaration says the module answers `poll`; the
interval is the edge's own (below).

- `poll`: `{ edge, filter?, scope?, cursor? }` → `{ arrivals, cursor?, pollAgainAt? }`.
  `edge` is the edge's name. `filter` is the part of the listens' `WHERE` on
  the edge that you take (an expression, as a hop's `where` hint is: a field
  your declaration gives `filterOperators`, on an edge whose `capability` says
  `filter: "native"`); absent when you take none of it. An OR of `==` on one
  field reaches you when the field declares `in`, and an OR of `CONTAINS` on
  one field (a record containing any of the values) when it declares
  `containsAny`; module-kit's `takenComparisons` reads them as `in` and
  `containsAny`. `scope` is the id of
  the record the edge hangs off, when the listens watch it under one. `cursor`
  is what your previous poll answered, absent the first time. Each arrival has
  the shape of [Reporting arrivals](#reporting-arrivals).
- **One poll per connection, edge, filter and scope.** Every listen whose
  traversal ends on the same edge of the same connection, with the same
  filter you take and the same scope, shares one poll and one cursor. Two
  listens with different taken filters are two polls.
- **`takenApplied`.** Set `takenApplied: true` on an arrival only when you
  applied `filter` to it. Without it, the host checks the whole filter
  itself, so a filter you ignored is still honoured.
- **A first poll only arms.** The host keeps its `cursor` and fires nothing:
  what was there before the listen is not news.
- **The interval** is lf.yaml's `pollEvery` for the connection
  (`pollEvery: { <credential>: <duration> }`, the connection named by the
  credential it polls as, or by your module for one that uses none), else
  the edge's `pollEverySeconds`.
- **`pollAgainAt`** (adapter protocol 2.7) is when the edge is next worth
  polling, as an ISO instant: the time of the next thing you know is due. The
  host polls that edge next at the earlier of it and one interval on, and
  never sooner than a second after the poll, so a time already past is soon,
  not at once. Answer it with every poll it applies to, the first included:
  the host keeps no earlier answer. The cron unit answers its next tick, so a
  schedule fires on time rather than up to an interval late. Leave it out to
  be polled on the interval alone.
- What a poll returns is handled as a pushed arrival is: logged for the
  waits, then judged against each listen sharing the poll, each running once
  per identity and version. A poll that fires a listen is kept as a delivery
  of its own, so an arrival on another edge in the same page (a comment on
  the note that started a run) answers that run. A record edited so that it newly matches a
  listen's filter is a new version, so it fires.
- An entry point's root collection says what it takes with `capability` on
  the entry (`{ "filter": "native", "supportsLimit": false }`), as a
  reference does on its edge.

Housekeeping on a schedule, per install (renewing a webhook the provider
expires, say):

```json
"periodic": [{ "name": "renew_webhook", "intervalSeconds": 86400 }]
```

- The host calls `runPeriodic({ name })` every `intervalSeconds` for each
  install, with that install's credential. It answers `null`.

### Plugins

A module may serve plugins instead of (or as well as) an adapter: functions a
movement calls. It declares them as one package, which a program imports by
its tag:

```json
"plugins": {
  "package": "@lf/web",
  "plugins": [
    {
      "name": "fetch-url",
      "spec": {
        "args": ["url", "email"],
        "priced": false,
        "argTypes": { "url": "text", "email": "text" },
        "requiredArgs": ["url"],
        "effects": { "reads": ["the web"] },
        "output": { "kind": "value", "type": "text" },
        "description": "The page at a URL, as text."
      }
    }
  ]
}
```

```
import { `@lf/web` as web } from plugins
page = web.fetchUrl(u)
```

- `package` is the tag, matched exactly and never parsed.
- Each plugin's `name` is its registered name; a program calls it by the
  camel case of it (`fetch-url` → `fetchUrl`). Two names that spell the same
  (`fetch-url`, `fetch_url`) are one plugin declared twice, and refused.
- `spec` is what the checker reads: the arguments a call may write, their
  types, the required ones, its effects, whether it may cost money
  (`priced`), what it hands back (`output`), the arguments a
  `through [ … ]` stage feeds it (`fedArgs`), and `fedByExtraction` for a
  plugin that only reads what the stage extracted. Its optional
  `description` says what the plugin does; an author's editor shows it when
  they hover a call.
- `plugins` pairs with the method `invokePlugin`:
  `{ name, config, extractedContext }` → `{ text?, data?, records?, outcome?, costMicrodollars?, files?, warnings? }`.
  `config` is the author's arguments by name; `extractedContext` the fields
  extracted so far inside a stage (empty otherwise). The answer is what the
  plugin added: fetched `text` to extract from, `data` fields, `records` (one
  per thing it fetched, for a records output), an `outcome` for the trace,
  and what its own work cost that nothing else priced.
- **`files`** (a plugin that makes a file): `{ "<field>": { name?, contentType?, base64 } }`.
  Bytes do not ride the envelope as a URL a plugin could serve, so the plugin
  hands them over inline and the host stores each file (the platform under the
  team's key prefix, listen-fire as one of the run's documents) and puts the file it
  made at `data.<field>`. A plugin declaring a `value` output of type `file`
  answers it as `files.value`: the call's value is that file.
- **`warnings`**: text the run's author should know; each is a warning on the
  run (`MOVENG_PLUGIN_WARNING`) naming nothing but what the plugin said. A
  plugin that did what it could, and tells you what it could not
  (`@lf/pdf`: characters its default font cannot draw).
- A plugin module answers `manifest` with `supportedTriggers: []` and lists
  only `manifest` and `invokePlugin` (and `refreshCredential` if it needs
  one) in `methods`.

### Kinds, settings, spend and the host's models

- **Kind.** The manifest may say what the module is: `"kind": "adapter"`,
  `"plugin"` or `"core"`. A `core` module fills one of the host's core
  services and names it in `"slot"`: `models`, `judge`, `store`, `files`,
  `limiter`, `browser`, `wake`, `ocr`, `secrets` or `movements`.
  The host names one module per slot (lf.yaml's `core:`); a slot's contract
  is its methods and its conformance suite: [store](store-slot.md),
  [limiter](limiter-slot.md), [models](models-slot.md),
  [judge](judge-slot.md), [files](files-slot.md), [browser](browser-slot.md),
  [wake](wake-slot.md), [ocr](ocr-slot.md), [secrets](secrets-slot.md),
  [movements](movements-slot.md), each over [the transport](#transport). A core
  module answers `manifest` with `{ protocolVersion: 2, protocolMinor, name,
  kind: "core", slot, methods }` (`protocolMinor` as [Versioning](#versioning)
  says: optional, what the module needs its host to speak, never raised by its `methods`).
  Without `kind`, a module is an adapter, or a plugin package when it
  declares `plugins`.
- **Settings.** Construction arguments the install supplies (an Airtable
  `base`, a Sheets `spreadsheet`) are declared, each
  `{ name, label?, secret?, optional? }`:

  ```json
  "settings": [{ "name": "base", "label": "The Airtable base id" }]
  ```

  The host asks for them when the module is set up (`listen-fire connect`, the
  platform's install screen) and sends them on every request as
  `"settings": { "base": "app123" }`.
- **One credential.** A request carries `credential`, the one the connection
  names, under the declared alternative it fills. Read it from
  `ctx.credential`; `ctx.credential.name` says which alternative it is. One
  `credentialUpdate` rides an answer: that credential's.
- **A refused token.** Answer `ok: false` with the code `credential_refused`
  when the provider refused the request's credential. The host refreshes it
  (its OAuth 2 grant, or your `refreshCredential`) and retries the call once.
- **Spend.** An answer (on success or failure) may carry what the call spent
  on a paid service:

  ```json
  { "ok": true, "result": { … }, "cost": [{ "microdollars": 1500, "label": "enrichment-api" }] }
  ```

  The host adds each line to the spend of the run that made the call, so the
  run's cost cap (`maxRunCostUsd`) counts it.
- **The host's models.** A module that declares `"hostModels": true` may ask
  the host's models slot for a model call:

  ```
  POST {listen-fire}/api/public/adapter/{adapterType}/models
  { "label": "affinity.formatLocation", "system": "…", "userMessage": "…", "model": "claude-sonnet-5" }
  → { "text": "…", "cost": [{ "microdollars": 812, "label": "anthropic/claude-sonnet-5" }] }
  ```

  Authentication is the push doors'. A `schema` (a JSON schema, with
  `toolName` and `toolDescription`) asks for the reply as `data`. The door
  bills no run itself: add its `cost` to the `cost` of the answer whose work
  asked it. The module kit does both for you.
- **The host's OCR.** Any module the host started may ask its ocr slot for
  the text of a scanned PDF or an image ([ocr-slot.md](ocr-slot.md)):

  ```
  POST {listen-fire}/api/public/adapter/{adapterType}/ocr
  { "bytes": "<base64>", "contentType": "application/pdf", "label": "web.vc-url-retrieval" }
  → { "text": "…", "pages": 12, "cost": [{ "microdollars": 18000, "label": "document-ai/ocr" }] }
  ```

  Authentication is the models door's. An empty slot answers 503
  `ocr_slot_empty`, saying so. Like the models door it bills no run itself;
  the module kit's `ctx.ocr` charges the read to the answer that asked.
- **Limits.** The manifest may declare the provider's limits on calls, so the
  host never sends more than it allows:

  ```json
  "limits": [{ "scope": "credential", "calls": 100, "per": "10s" }, { "scope": "module", "concurrent": 4 }]
  ```

  Each limit counts per `scope`: `credential` (one user's grant), `module`
  (every install on the host), `install` or `team`. `calls` and `per` (a
  duration: `500ms`, `10s`, `1m`, `1h`, `1d`) go together; `concurrent` caps
  calls at once. The host holds a call until it is within all of them (its
  [limiter slot](limiter-slot.md)).
- **The limits door.** One call to a module can become several requests to
  its provider, plus retries. A module that declares `"hostLimits": true`
  (its author's choice, never implied by `limits`; see the last bullet)
  asks the host before each of those requests, so its `limits` count them
  rather than the host's calls. On each call the host hands it the door:

  ```json
  { "method": "listEntryPoints", …, "hostLimits": { "url": "http://127.0.0.1:4100/api/public/adapter/%40acme%2Fcrm/limits", "ticket": "…" } }
  ```

  Before each provider request, and after it:

  ```
  POST {hostLimits.url}            Authorization: Bearer {hostLimits.ticket}
  { "op": "acquire" }                          → { "outcome": "granted", "permit": "p7" }
                                               or { "outcome": "wait", "retryAfterMs": 400 }
  { "op": "release", "permit": "p7" }          → {}
  { "op": "throttle", "retryAfterMs": 30000 }  → {}
  ```

  - The door never waits. On `wait`, wait that long and ask again.
  - `throttle` reports a provider's "too many requests" (HTTP 429) and its
    `Retry-After`. Every request counted as the same credential (or install)
    is held until then, the host's own calls included.
  - The ticket names the call to the host. The host counts under the
    module, install, credential and team it resolved for that call; the
    module sees no counter and no scope's value.
  - The ticket is good until the call answers. A permit not yet released
    then is released by the host.
  - A call that carries `hostLimits` is not counted by the host itself, so
    no request counts twice. A call without it was counted by the host as a
    whole (listen-fire offers the door only to a module on its own box, from a
    process that listens). The module then asks nobody.
  - The module kit does all of this inside `ctx.fetch`. A module declares
    `hostLimits` (TypeScript: `hostLimits: true` in `defineModule`; Rust:
    `.declare("hostLimits", Js::Bool(true))`) only if every provider
    request goes through `ctx.fetch` (TypeScript) or `ctx.permit()` (Rust).
    A request made any other way (the global `fetch`, another client) is
    counted by nobody, since the host stops counting that module's calls.
    The kit never declares it for you: `limits` alone leaves the host
    counting each call once. Requests to the host's own address (its files,
    its doors) are not counted. The Rust kit has no HTTP client of its own:
    take `ctx.permit()` before each request, and hand it back with
    `release()` or `throttled(retry_after)`.
  - A host that loads modules in process (the platform) or an embedder that
    hands no door is unchanged: `ctx.fetch` is then the plain fetch, and the
    host counts calls as before.
- **The records door.** A module listen-fire started may read the host's facts
  about its own runs, waits and releases at
  `POST {host}/api/public/adapter/{module}/records`, under the host token, as
  `ctx.records.read(method, params)` (module-kit). It names no event kind;
  `@lf/system` turns its facts into events. Its methods and rows are
  [system-events.md](system-events.md)'s. A host that serves none refuses a
  read by name.
- **Throttle.** An answer (on success or failure) may carry `retryAfter`, in
  seconds: the provider asked for quiet. The host sends no further call as
  that credential (or install, without one) until then.

  ```json
  { "ok": false, "error": { "code": "rate_limited", "message": "429", "retryable": true }, "retryAfter": 30 }
  ```
- **Event idempotency.** An event (`preprocessInbound`) may
  carry `idempotencyKey`, the provider's own id for the occurrence; a host
  that sees one key twice runs it once. A file ref's `size` (bytes) is kept
  wherever the ref travels.

### Serving a module

A module written with the module kit (`packages/module-kit`,
`defineModule`) is served as a process by `serve-module <module>`: it binds
the socket `MODULE_SOCKET` names (else loopback on `PORT`, 0 picks one),
prints `listening unix:<path>` (or `listening <port>`), and requires
`Authorization: Bearer <MODULE_TOKEN>` when that is set. The platform loads
the same module in process; both declare the same manifest.

A module's own state (`ctx.kv`) is small JSON per install: `get`, `set`,
`delete`, `list(prefix)`, and `compareAndSet(key, expected, value)`, which
writes only when the key still holds `expected` (undefined: unset), compared
as JSON values, and answers whether it wrote — of two writers that read the
same value, one wins.

## Paging

`getRelated` returns everything at once. For a large collection implement
`iterateRelatedPage` and list it in `methods`:

```json
{ "position": { … }, "fieldId": "Company", "direction": "outgoing", "cursor": 2 }
```
→
```json
{ "items": [ { "position": { … } }, { "position": { … } } ], "nextCursor": 4 }
```

- The first call has no `cursor`. Return `nextCursor` while more remain and
  omit it on the last page.
- The cursor is any JSON value you like. Listen-Fire echoes it back unchanged.
- Returning the same cursor you were given fails the walk (it would never
  end), and so does a walk past 10,000 pages.
- Refuse a cursor you did not mint with `bad_request` (not retryable). On
  the TypeScript reference kit, throw `AdapterBadRequestError`; any other
  throw becomes `adapter_error`, which is marked retryable: a caller that
  honours the flag would ask again with the same cursor.

The TypeScript reference kit (`createAdapterProtocolHandler`) serves
`iterateRelatedPage` for you. If your in-process adapter only offers a stream
(`iterateRelated`), the kit drains it into one page capped at 1,000 items,
with no `nextCursor`, and logs a warning naming the adapter. If it offers
neither, the method answers `method_not_implemented`.

## Files

File bytes never ride the JSON envelope; they move by URL. A file is what
the envelope declares one, never a shape the data carries: a field your
catalog declares `"kind": "file"` (in `describe`), or a resource's `fileRef`.
A file ref anywhere else is data to Listen-Fire, whatever keys it carries.

- **Into your system.** A write may carry a file (in a field you declare a
  file, or a resource's `fileRef`) with a `url`:

  ```json
  { "__brand": "FileRef", "name": "deck.pdf", "contentType": "application/pdf",
    "source": { "ownerAdapterType": "email", "handle": "…" },
    "url": "https://listen-fire.example/api/files/blob/abc123" }
  ```

  `GET` the `url` at write time; it is short-lived. `__brand` is the ref's
  spelling; the field it sits in is what makes it a file. The `source` names
  the owner type and its handle only: no ref Listen-Fire sends names its
  credential or construction args. The reference kit makes the value at each
  field you declare a file a file before your code sees it.

- **Out of your system.** Return a file ref only at a field your catalog
  declares a file. Its `source` is
  `{ "ownerAdapterType": "<your adapterType>", "handle": "<your id>" }` (or a
  `url` alone), and you implement `resolveFileRef`:

  ```json
  { "ref": { "__brand": "FileRef", "name": "deck.pdf", "source": { "ownerAdapterType": "acme_crm", "handle": "f_42" } } }
  ```
  →
  ```json
  { "url": "https://crm.acme.example/files/f_42?sig=…", "contentType": "application/pdf" }
  ```

  Listen-Fire fetches the URL server-side, so it can be signed and
  short-lived. The reference kit answers `resolveFileRef` only for a ref that
  already carries a `url`; any other ref answers `method_not_implemented`.
  A ref returned at a field you do not declare a file reaches Listen-Fire as
  data: it is never read as a file (lf-platform's conformance CLI's `files-declared`
  check names such a field).

## Watching for changes (`<slot>.watch`)

A core slot may let listen-fire hear of a change instead of asking on a timer. The movements slot is the first to ask for it ([movements.watch](movements-slot.md#methods)). The shape is the same for any slot that adopts it.

`<slot>.watch` takes `{ cursor?: string, waitMs: number }` and answers `{ cursor: string, events: [...] }` or `{ resync: true }`.

- `waitMs` is a non-negative integer. A module honours at most 30,000 ms (30 s) and may answer sooner, including at once with `events: []`. A missing or negative `waitMs`, or a cursor that is not a string, is `bad_request`.
- A request with no `cursor` answers the module's current cursor and no events.
- A `cursor` is a position in the module's own log of events, and only the module reads it. It is not one caller's: every caller that holds a cursor sees every event after it, so two listen-fire processes watching one module each get each event.
- The events after a cursor come in order. A cursor the module has answered is never answered again with fewer events.
- A cursor the module never gave, or can no longer serve (it restarted, or its log moved on), is answered `{ resync: true }`. The caller then lists what it needs once and asks for a fresh cursor.
- A module answers before the request timeout of the platform it runs behind. A platform that cuts a request off sooner than 30 s must have its module answer earlier with `events: []`; listen-fire then asks again at once, since that answer was not immediate.
- listen-fire asks for 30 s and gives up on the request after 40 s. While a watch is held, a module that listen-fire started is not stopped as idle, and the module's other methods are answered as usual.

## Limits and timeouts

- **The `wake` door**: a JSON body of at most 1 MB, carrying 1 to
  1,000 arrivals. A larger body is answered 413 before anything is
  read.
- **Host webhook door**: the raw body is read for
  `content-type: application/json` and
  `application/x-www-form-urlencoded`, up to 100 KB. A larger body is
  answered 413. A body of any other content type is not read, so its
  signature cannot verify (401). The signature is checked over the raw bytes
  either way; `preprocessInbound`'s `raw` is the parsed JSON, or for a form
  its fields as an object of text (a field sent more than once is the list
  of its values, in order). Slack posts a press on a message's control that
  way, as `payload=<json>`; the module parses the field.
- **Watch**: a `<slot>.watch` request is held up to 30 s ([Watching for changes](#watching-for-changes-slotwatch)); listen-fire gives up on it after 40 s.
- **Calls to your server**: Listen-Fire sets no timeout of its own; Node's
  `fetch` defaults apply (about 5 minutes for the response headers, and 5
  minutes between body chunks). A call is never retried in place, and the
  `retryable` flag is not yet acted on: a failed call fails the automation
  run that made it (an install's `manifest` call fails the install).

## Errors

Inside the envelope (HTTP 200, `ok: false`):

| `code` | `retryable` | Meaning |
|---|---|---|
| `method_not_implemented` | false | Unknown method, or one you do not implement |
| `adapter_error` | true | Your code failed (the flag is not yet acted on: [Limits](#limits-and-timeouts)) |
| `bad_request` | false | `params` did not match the method's schema (the message is `<method>: <path>: <problem>`), or you refused the request (a cursor you never minted) |
| `protocol_version` | false | The request's `protocolVersion` is not `"2"` |

Outside it:

- HTTP 401 `unauthorized`: authentication failed.
- HTTP 400 `bad_request`: the body is not JSON, or not a request envelope.

Use your own `code` for anything else; set `retryable` honestly.

## Build your first adapter

The Acme CRM is a complete protocol-2 adapter in one dependency-free file:
[`examples/lf-acme/externals/acme_crm/server.mjs`](../../examples/lf-acme/externals/acme_crm/server.mjs).
It has one type, `Company`, with a comment thread. It uses both push doors
and the host door's methods, and it pages. Read it next to this walkthrough,
and drive it with `listen-fire`, the same binary a user runs your adapter under.

`listen-fire` has no adapter conformance command. These three commands make up the
check, and each runs against the example project:

- `listen-fire check` and `listen-fire catalog` start your server and read its `describe`: a
  catalog `listen-fire` cannot read fails here, and a movement written against a type
  or field you did not publish is a diagnostic.
- `listen-fire run --webhook` hands a delivery to the doors as a provider would,
  signature and all, and shows the event it became.
- `listen-fire serve` is the real host: your server pushes to its doors, and a
  parked run resumes.

The doors themselves are held to the cases every host's doors pass by
`listen-fire --contract-doors`, which is not a command to type: it serves the doors
for the contract suite over a JSON-RPC bridge on stdin and stdout. Run it as
`node --conditions=movement-engine-internals --test --require tsx/cjs src/__test__/inbound_contract.test.ts`
from `apps/cli`.

1. **Install the example and keep `listen-fire check` green as you build.** Copy
   `examples/lf-acme` to a folder of your own, give it its secrets, and check:

   ```bash
   cp -R examples/lf-acme my-adapter && cd my-adapter
   mkdir .lf && cp secrets.example.yaml .lf/secrets.yaml && chmod 600 .lf/secrets.yaml
   listen-fire check                 # 1 file(s), 0 error(s)
   listen-fire catalog               # the catalog, with acme_crm's types, fields and the listenable Comments edge
   ```

   To build your own, replace `externals/acme_crm/` with a folder of the same
   shape (`lf-external.yaml` names the command that serves it, or a `url:` already
   serving) and put your credential in `.lf/secrets.yaml`. `listen-fire` refuses a
   secrets file other users can read. `listen-fire catalog` shows what `describe`
   published: a field you meant to be writable, a file field, a missing
   `listenable` edge, are all visible there before any movement uses them.

   Then deliver a webhook. The example verifies HMAC-SHA256 of the raw body in
   `x-listen-fire-signature`, keyed by the credential's `webhook_secret`:

   ```bash
   SIG=$(openssl dgst -sha256 -hmac dev-acme-webhook-secret -hex < events/webhook_body.json | awk '{print $NF}')
   listen-fire run --webhook acme_crm --body events/webhook_body.json --install acme \
     --header "x-listen-fire-signature:$SIG"
   ```

   Without the header, or with a wrong one, it refuses
   (`signature did not verify for external "acme_crm"`) and runs nothing.
   `listen-fire run --event events/company_created.json` routes one event, as your
   server's `preprocessInbound` would have shaped it, to the listens it
   matches. `listen-fire runs` and `listen-fire runs show <run-id>` show what each run saw.
   The fake CRM passes all of this. What a real host does with a push is
   step 7.

2. **Describe your data.** `listEntryPoints` publishes `Company` (writable,
   fires) and `Comment`. `describe` gives `Company` its fields and its
   `Comments` edge, declared `listenable` (with `identity: "Id"`, a field
   `Comment` declares, and `sequenced`).

3. **Implement the required methods.** `resolveEntity` always answers no
   match, so every write creates. `createRecord` stores the company and
   returns its id and fields. `getFieldValue` reads the position's `data`.

4. **Serve it.** In TypeScript, wrap your adapter with the reference kit:

   ```ts
   const handler = createAdapterProtocolHandler({
     adapter,
     authenticate: (headers) => headers['authorization'] === `Bearer ${secret}`,
   });
   http.createServer((req, res) => void handler(req, res)).listen(port);
   ```

   The kit answers `manifest`, checks the version, validates `params`, maps
   throws to `adapter_error`, and serves paging. In another language, follow
   [the envelope](#the-envelope).

5. **Make the thread awaitable.** `awaitKeys` answers `thread:<company id>`
   for each company, and `{ "gone": true }` for one the CRM deleted. Its
   `getRelated` lists a company's comments oldest first, so a plain `await`
   takes one already there.

6. **Push.** When somebody comments, the CRM `POST`s the comment as an arrival,
   `{ "arrivals": [{ "edge": "Comments", "key": "thread:<company id>", "identity": "<comment id>", "landing": … }] }`,
   to `/wake`.
   When somebody creates a company, it `POST`s the company as an arrival on
   `Company` to `/wake` too. Both send `Authorization: Bearer <secret>`.

7. **Try it under `listen-fire serve`.** Start clean (`rm -rf .lf/state.db .lf/externals`,
   so the ids below are the CRM's first) and replace the example's
   `movements/companies.mvt` with `movements/discuss.mvt`:

   ```
   crm = connect #acme_crm using acme

   function discuss(company: <crm-[:Company]->>) {
     thread = write crm-[:Company]-> { Name: "Discuss ${company.Name}" }
     c = await thread-[:Comments]->
     write crm-[:Company]-> { Name: "Answered ${c.Text}" }
   }

   listen to crm-[:Company]-> fire discuss
   ```

   Serve the project and read the port `listen-fire` started the CRM on; the example
   keeps its companies in `.lf/externals/acme_crm/state.json`, and the CRM
   pushes to the host's doors with the credential `listen-fire` hands it:

   ```bash
   listen-fire serve --port 5871 &      # wait for its address line, and for .lf/externals/acme_crm/port to appear
   CRM=http://127.0.0.1:$(cat .lf/externals/acme_crm/port)
   curl -s -XPOST $CRM/dev/companies -d '{"Name":"Larch Bio"}'
   # the CRM pushes the company's arrival to wake: {"id":"company-1","arrived":{…}}
   # listen-fire serve prints: run … discuss:discuss parked   (it wrote "Discuss Larch Bio", then awaits its first comment)
   curl -s -XPOST $CRM/dev/comments -d '{"company":"company-2","text":"approved"}'
   # the CRM pushes the comment's arrival to wake; listen-fire serve prints: resumed … discuss:discuss completed
   curl -s $CRM/dev/state      # every company the CRM holds, ending in "Answered approved"
   ```

   The doors refuse what they should. A wake presenting a credential no install
   holds answers `401`, and one naming keys rather than arrivals answers `400`:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -XPOST -H 'authorization: Bearer nope' \
     -H 'content-type: application/json' -d '{"keys":["thread:company-1"]}' \
     http://127.0.0.1:5871/api/public/adapter/acme_crm/wake       # 401
   ```

   Stop `listen-fire serve` when done. `listen-fire runs show <run-id>` shows the park and the
   wake that ended it.

## Changes

- **Adapter protocol 2.8: a slot request says which release sent it** (within version 2; listen-fire 0.15.2; additive). Every request `listen-fire` sends a slot module carries `hostRelease`, its core version ([The envelope](#the-envelope)). A request without it comes from a runner before 0.15.2. Why: a hosted product serves a team's own runners on two releases at once (0.12 and 0.15 during a move between them), whose store methods differ, and some kept their names while their meaning changed (`waits.sweep`, `inbound.keepDelivery`'s mark, [store-slot.md](store-slot.md#changes)); with only the protocol's major on a request, it could not tell the two apart. A host behaviour, as 2.7 was: an older module ignores the member, so a module states no minor for it.
- **The loop guard slot is removed** (within version 2; listen-fire 0.14.0; breaking for a module that fills it). A core module whose manifest or `lf-external.yaml` names `slot: loopGuard` is refused by name, as is an `lf.yaml` that names `core.loopGuard`: the host's loop breaker replaces it. listen-fire stopped calling the slot's methods before 0.14.0.
- **Adapter protocol 2.7: a poll may say when to poll again, and who acted rides on the arrival** (within version 2; 2026-11-02; listen-fire 0.13.1; additive). `poll` may answer `pollAgainAt`, an ISO instant: the host polls that edge next at the earlier of it and its interval, never sooner than a second on ([Polled sources](#polled-sources-and-periodic-tasks)). The cron unit answers its next tick. An arrival may carry `actor`, as `extractActor` answers; the run it fires reads `@actor_*` from it and a host resolves `@user_*` from it ([Who acted](#who-acted)). The run's trigger keeps the arrival's `about` and `actor`, and is stamped with its `occurredAt` (when the host took it, for one that names none), so a run's writes say when the change they follow happened. Why: a schedule is cron's polled `Ticks` edge, and a tick seen only on the next poll fired up to an interval (60 seconds) late; and a run is handed the arrival and never the raw event, so whatever a run or a host feature needs travels on the arrival, set at the door. Both are host behaviours, as 2.3 was: an older host ignores `pollAgainAt` and polls on its interval, and drops `actor` and asks `extractActor`, so a module that answers either states no minor for it.
- **The settings poll and the events subscription leave the protocol** (adapter protocol 2.6, within version 2; 2026-11-01; listen-fire 0.13.0; breaking for a module that still answers them). `poll` is asked only as `{ edge, filter?, scope?, cursor? }` and answers `{ arrivals, cursor? }`; a 0.12 `{ events, checkpoint }` answer is refused, naming `arrivals`. `ensureEventSubscription` is asked only for an edge; `removeEventSubscription` keeps the 0.12 form only to remove a webhook a 0.12 listen registered, and a host removes such a webhook rather than refreshing it. `emit` is refused 410 (`emit_retired`), naming `wake`; it kept events that fired no listen. Why: a 0.13 listen is a traversal, and nothing a settings poll or an events webhook brings can fire one.
- **`inbound.redactFields`** (adapter protocol 2.6, within version 2; 2026-11-01; listen-fire 0.13.0; additive). A module names the body and query fields that may carry a credential, and a kept request drops them ([Declared inbound signatures](#declared-inbound-signatures)); a header whose name holds `token`, `key`, `auth`, `hmac` or `password`, or `set-cookie`, is never kept either. A module that names one states `protocolMinor: 6`. Why: Slack sends its legacy verification `token` in the body, and a kept request is stored for days. `@lf/slack` names `token`.
- **`membersChange`** (within version 2, no bump; 2026-11-01; listen-fire 0.13.0). One member, `"pushed"` or `{ relistEverySeconds }`, says how a listen learns a hop's members changed, where this release's earlier builds read three (`cheapToList`, `parentChanges`, `relistEverySeconds`) ([Declaring a listenable edge](#declaring-a-listenable-edge)). Why: the three described one choice, and two of them together meant nothing.
- **`owned.format`** (within version 2, no bump; 2026-11-01; listen-fire 0.13.0; additive). An owned scalar may say its values are a `cron` schedule or a `timeZone`, and the checker validates a literal by that format alone, never by the scalar's name ([describe](#describe)). Why: a scalar named `Zone` by another module was checked as a time zone by accident of its name.
- **`changedIn` on a field** (within version 2, no bump; 2026-11-01; listen-fire 0.13.0; additive). A field may say a release of the module changed what it holds; a check for an upgrade from before that release warns where a program reads it (`MOV_FIELD_MEANING_CHANGED`) ([describe](#describe)). Why: gmail's `Labels` holds label names from 0.13, where it held ids, and a 0.12 program comparing ids would check clean and never match.
- **`changed`, `alsoArrivesOn` and `null` values in `listenSettingsBecome`** (within version 2, no bump; 2026-11-01; listen-fire 0.13.0; additive). A mapping says where its rewrite hears otherwise than the settings listen did (`changed`: a note, and the rewrite is applied only under `--all`), where its events also arrive on other edges (`alsoArrivesOn`: no rewrite, one listen per edge), and a value that narrowed nothing (`null`) ([The manifest and installing](#the-manifest-and-installing)). Why: `listen-fire upgrade` applied rewrites that heard more or less than 0.12 did (Affinity's `organization.updated`, Slack's thread replies, GitHub's `participating: false`, gmail's `label_added`) and called them safe.
- **`unknown` fields on an arrival** (adapter protocol 2.6, within version 2; 2026-11-01; listen-fire 0.13.0; additive). An arrival's landing and each parent may name the fields the module could not read (`unknown`); a listen whose filter reads one is undecided, runs nothing, and the host reports it; every other listen is judged as usual ([Reporting arrivals](#reporting-arrivals)). Why: a field read as absent compared false and skipped the arrival silently, and a provider's retry cannot be relied on to bring it again. A module that names one states `protocolMinor: 6`: a host before it would ignore the member and judge the field as absent.
- **What a module declares about listening** (within version 2, no bump; 2026-10-31; listen-fire 0.13.0; additive). A listenable reference or entry point may declare `delivery`, `pollEverySeconds`, `bounded`, `boundedBy`, `carries`, `scopedBy` (a reference delivered per scope, subscribed per record an earlier hop landed on), `attributes` and `membersChange` ([Declaring a listenable edge](#declaring-a-listenable-edge)); an entry point may declare `listenable`, `cursor`, `identity` and `version`, and is then an edge a listen starts at; a field may be of kind `owned`; the manifest may declare `resendWindowSeconds`, and `listenSettingsBecome`, how its 0.12 settings listens become traversals for `listen-fire upgrade`. Each is refused by name when it cannot mean what it says, a field of kind `owned` that names no scalar included. Why: a standing listen becomes a traversal over the edges a module declares listenable, and the host needs to know how each one's arrivals reach it, what bounds it, and how often to poll or re-list, from the module, since it has no numbers of its own. listen-fire reads them into the catalog; the checker and the hosts act on them in later 0.13 work. An older host ignores them.
- **`resolvesEmpty` retired** (within version 2, no bump; 2026-10-31; listen-fire 0.13.0). A reference that declares it is refused when listen-fire describes the module, naming it: a record that goes leaves the wait waiting on every edge, so there is nothing to declare.
- **The key form retired** (within version 2, no bump; 2026-10-31; listen-fire 0.13.0). listen-fire no longer calls `resolveAwait` or `wakeKeys`, and ignores a `checkInbound` acceptance's `wakeKeys`: a run waits on the arrivals a module reports (2.5). A module may still implement them; nothing calls them.
- **Pages, replies on acceptance, the inbound URL and `answerShapeFrom`** (within version 2, no bump; 2026-10-31; listen-fire 0.13.0; additive). A module that checks its own inbound may `reply` with `html` (sent as `text/html`), and its `accepted` answer may carry `reply`, what the door answers once it has kept the request in place of its own acknowledgement ([A module that checks its own inbound](#a-module-that-checks-its-own-inbound)). A request may carry `inbound: { url }`, where the install's inbound requests reach the module ([The envelope](#the-envelope)). A reference may declare `answerShapeFrom`, the write field naming the node that types its landing. Why: `@lf/forms` serves a form at its own door, hands out its link, thanks the person who answered, and types the answer by the node the program wrote. An older host sends no `inbound`, refuses an answer carrying `html` or an acceptance's `reply` as outside `checkInbound`'s shape, and reads no `answerShapeFrom`.
- **`slack_v0` refuses a replay** (within version 2, no bump; 2026-10-30; listen-fire 0.13.0). A request whose `x-slack-request-timestamp` is more than five minutes from now is refused 401 though its signature is right, as Slack advises ([Declared inbound signatures](#declared-inbound-signatures)). Nothing changes for a module: Slack signs every request with the time it sends it.
- **Form-encoded deliveries** (within version 2, no bump; 2026-10-30; listen-fire 0.13.0). The host webhook door reads a delivery sent as `application/x-www-form-urlencoded` as well as JSON: its signature is checked over the raw bytes, and `preprocessInbound`'s `raw` is the form's fields ([Limits and timeouts](#limits-and-timeouts)). Why: Slack posts a press on a message's control that way (`payload=<json>`), so `@lf/slack` reports presses as arrivals on the host's own door, verified with Slack's own signature. An older host refuses such a delivery as not JSON.
- **Replayed requests** (adapter protocol 2.6, within version 2, no bump; 2026-11-01; listen-fire 0.13.0; additive). `checkInbound` may be handed `replayed: true`, when the host runs a request it kept itself again (`listen-fire listens replay`). A module that verifies its own requests skips its signature and its timestamp window for it; the host vouches, and never sets it for a request that arrived. Why: a replay days after a delivery would otherwise be refused by Stripe's five minute window. `@lf/stripe`, `@lf/webhook`, `@lf/whatsapp` and `@lf/email` read it; `@lf/forms` checks no signature. An older module ignores it and checks as before.
- **Kept request headers** (adapter protocol 2.6, within version 2; 2026-11-01; listen-fire 0.13.0; additive). `inbound.captureHeaders` names the headers a module's inbound handling reads besides the body; a kept delivery's request holds only those (and, under a declared scheme, `content-type` and the `deliveryId` header). A header that may carry a credential is refused when the module is described. Why: a kept request is stored for days, and a signature, a token or a secret stored with its body could be sent again at the live door. `@lf/email` names `svix-id`, `@lf/forms` `content-type`; a module that names one states `protocolMinor: 6`, and an older module names none, so its requests are kept without headers.
- **Adapter protocol 2.6: arrivals for listens** (within version 2; listen-fire 0.13.0). An arrival on a root edge names no `key`, and an arrival may carry `parents` (the records of the earlier hops its edge `carries`), `about`, `notFor` and `takenApplied` ([Reporting arrivals](#reporting-arrivals)). Each head `awaitKeys` is asked about names its `recordType` wherever the host knows it, so a module whose record types number their ids apart can key a wait by the kind of record as well as its id. Listen-Fire judges each arrival that landed against the listens on its edge (`listen to <traversal> fire f`) and runs each one it fires, its parameter bound to the landing, once per arrival. Why: a listen is a traversal, fired by what lands on its last edge, not by a module's settings. A module that uses any 2.6 member (a root arrival, `unknown`, `recordType`, `captureHeaders`, `redactFields`) states `protocolMinor: 6`, so an older host refuses it rather than misjudging its arrivals or keeping a request whole. A listenable edge declaring `delivery: polled` is polled as `poll({ edge, filter?, scope?, cursor? }) → { arrivals, cursor? }`, once per connection, edge, filter the module takes and scope, shared by every listen on it; an arrival says `takenApplied` only when the module applied the filter. The interval is lf.yaml's `pollEvery` for the connection, else the edge's `pollEverySeconds`. An entry point may declare its root collection's `capability`. A listenable edge declaring `delivery: connection` or `scope` is subscribed for as `ensureEventSubscription({ edge, filter?, scope?, callbackUrl, current? })`, once per connection, edge, filter the module takes and scope; `removeEventSubscription` and `refreshEventSubscription` name the same `edge`, `filter` and `scope`. An arrival delivered through it is judged only against the listens sharing it. An arrival may carry `occurredAt`, when the change happened at its provider: Listen-Fire's loop breaker measures from it whether a run's write caused the arrival (`lf.yaml`'s `loopWindow`, default 20 seconds), so an echo a poll finds late is still the write's; one without it is measured to when Listen-Fire takes it.
- **Adapter protocol 2.5: arrivals** (within version 2; listen-fire 0.13.0). A module with listenable edges names the key each record's edge is waited on under (`awaitKeys`, a new optional method), and reports what lands there as arrivals: `arrivals` beside the events `preprocessInbound` answers, on `checkInbound`'s `accepted`, or pushed to the `wake` door as `{ arrivals }` ([Waiting on your system](#waiting-on-your-system-awaits)). Listen-Fire logs every arrival and keeps each run's wait itself (the store slot's `waits.*`, [store-slot.md](store-slot.md)). An arrival names its identity; one without is refused by name. Why: a run waiting on an edge reads what arrived since it began waiting, so an arrival during the write that caused it is never lost, and Listen-Fire, not the module, decides whether an arrival matches. Offering `awaitKeys` states no minor. From listen-fire 0.13.0 a wait reads arrivals only: `resolveAwait` is not called for it, `wakeKeys` wakes nothing, and the `wake` door refuses `{ keys }` (400, naming adapter protocol 2.5 and `arrivals`).
- **Adapter protocol 2.4: subscriptions that expire** (within version 2; 2026-10-27; listen-fire 0.12.10). `ensureEventSubscription` may answer `expiresAt`, and a new optional method, `refreshEventSubscription`, extends a subscription before it lapses ([Event subscriptions that expire](#event-subscriptions-that-expire)). Offering the method states no minor: a `listen-fire` up to 0.12.9 reads a module that lists it and never calls it, so its webhooks lapse there as before. `@lf/airtable` lists it. With this change the kits stop raising a module's stated minor for the methods it offers (`.watch`, `work.enqueueIfAbsent`, `refreshEventSubscription`): it is what the author declares, else 0.
- **`narrows` on a listen config key** (within version 2, no bump; 2026-10-27; additive). A `listenConfig` entry may say which hop of an event's address it is ([The manifest and installing](#the-manifest-and-installing)). `listen-fire` narrows a signature's event to the node the address walks to, as the hosted product does. An older host ignores the field; a module that declares none is unchanged.
- **Adapter protocol 2.3: labelled poll events** (within version 2; 2026-10-26; listen-fire 0.12.8). A polled source labels each event it returns with its kind (`eventType`), as a pushed event is labelled, and the host narrows a listen's `events` by it either way ([Polled sources](#polled-sources-and-periodic-tasks)). It is a rule for sources and a host behaviour, not a feature a module states: an older host routes a labelled event correctly, so a module labelling its events states no higher minor for it. An unlabelled poll event still reaches the listen that polled it, with a notice. The bundled polled modules (Gmail, Evertrace, Dealroom, Granola) label theirs.
- **`poll`'s `movementId`** (within version 2, no bump; 2026-10-26). `listen-fire` sends the listen's pipeline, `listen:<file>:<movement>`, rather than the movement's bare name, so a source can tell two same-named movements in different files apart.
- **Adapter protocol 2.N** (within version 2, no bump; 2026-10-25; listen-fire 0.12.6). The manifest may state `protocolMinor`, the minor of version 2 it uses, computed by the kits from the features it lists ([Versioning](#versioning)). `listen-fire` and the engine speak 2.0 to 2.2 and refuse a module outside that range by name, a core module included. The rule from here on: an addition a manifest can show bumps the minor. An unstated minor is 2.0, so every module published before is unchanged; an older host ignores the field.
- **`<slot>.watch`** (within version 2, no bump; 2026-10-23; additive for adapters). A held, bounded request that answers a cursor and the events after it ([Watching for changes](#watching-for-changes-slotwatch)). Adapters and other slots are unchanged. A movements module must answer `movements.watch`: `listen-fire serve` and `listen-fire drain` (without `--until-idle`) refuse a module that does not.
- **Delivery ids** (within version 2, no bump; 2026-10-22; additive). `inbound.deliveryId: { header }` in a declared scheme, `deliveryId` in `checkInbound`'s `accepted` answer and in `emit`'s body name the provider's id for a delivery, and the host keeps a repeat of it out. An older server declares and sends none and is unchanged; an older host ignores the field. See [Declared inbound signatures](#declared-inbound-signatures) and [emit](#emit-retired-in-013).
- **The ocr slot and the host's OCR door** (within version 2, no bump; 2026-10-20; additive). A ninth core slot, `ocr` ([ocr-slot.md](ocr-slot.md)), and `POST …/{adapterType}/ocr` for a module's `ctx.ocr`.
- **One transport for every module kind** (within version 2, no bump; 2026-10-19). Every core slot's methods ride this envelope ([Transport](#transport)): a Unix socket on the host's box, loopback TCP without one, HTTPS for a remote module; the store, limiter and loop guard slots' stdin/stdout JSON-RPC wire is retired. New slot methods for models, judge, files and browser; a core module's manifest; per-install outgoing auth; `ctx.kv.compareAndSet`. Additive for adapters and plugins: an older server is unchanged.
- **Checking an adapter.** `listen-fire check` and `listen-fire catalog` read a server's `describe`, and `listen-fire run --webhook` and `listen-fire serve` drive its push doors ([Build your first adapter](#build-your-first-adapter)). lf-platform keeps its own conformance CLI for the hosted platform.
- **Version 2** (current; the only version this release speaks). Breaking for a server built against version 1:
  - Requests carry `protocolVersion: "2"`, and the `manifest` answers `protocolVersion: 2`. Installing probes the server and refuses anything older.
  - Names on the wire are the natural display names; `typeId` and `fieldId` are the server's own ids.
  - Params are validated, and a mismatch answers `bad_request` naming the path.
  - New: awaits (`resolveAwait`, `wakeKeys`), the two push doors (`emit`, `wake`), paging (`iterateRelatedPage`), and files by URL.
  - A webhook subscription must return a secret, and deliveries are signed.
  - Clarified within version 2 (no bump; the reference adapter declares no file field, and conformance is unchanged for it): a file is read only at a field the catalog declares `kind: "file"` or in a resource's `fileRef`; a file ref anywhere else is data. File refs Listen-Fire sends (in a write, a position's resources, evidence) name no credential. The CLI gains `files-declared`.
- **`inbound.secretIssuedBy`** (within version 2, no bump; additive, absent means `installer`). A module says whether the installer sets its webhook signing secret or the provider issues it at registration; for `provider`, `listen-fire connect` asks for none ([Declared inbound signatures](#declared-inbound-signatures)).
- **`deletable` on a type** (within version 2, no bump; since 0.12). A type's `describe` may say `"deletable": true` when `deleteRecord` removes one. The field is additive: an older server that never sends it still installs, speaks version 2 and passes conformance, and an automation pinned to an earlier language deletes as before. The ruling: no protocol version bump. An adapter that omits it has every `delete` of its types refused when the automation is checked (`MOV_DELETE_NOT_DECLARED`); declare it to allow them.
- **Modules** (within version 2, no bump). The manifest may declare
  `credentials`, `inbound`, `poll` and `periodic`; a request may carry
  `credential`, and a response `credentialUpdate`; three optional methods,
  `poll`, `refreshCredential` and `runPeriodic`. All additive: an older server
  declares none of them and is unchanged, and an older host ignores them. The
  ruling: no protocol version bump. See
  [Modules](#modules-credentials-signatures-and-schedules).
- **Descriptions an editor shows** (within version 2, no bump; 2026-10-20).
  A manifest's `description`, a type's, a field's and a reference's, and a
  plugin spec's, all optional. Additive: an older server sends none and is
  unchanged, and nothing is checked against them. See
  [describe](#describe) and [Plugins](#plugins).
- **Plugin modules** (within version 2, no bump). The manifest may declare
  `plugins` (a package of them), paired with the optional method
  `invokePlugin`. Additive: a server that declares none is unchanged, and an
  older host ignores the declaration. See [Plugins](#plugins).
- **The limits door** (within version 2, no bump; 2026-10-20). The
  manifest may declare `hostLimits`; a request may carry `hostLimits` (the
  door's `url` and the call's `ticket`). Additive: a module that declares
  none is counted per call as before, a host that hands no door counts the
  call itself, and an older module ignores the field. See
  [the limits door](#kinds-settings-spend-and-the-hosts-models).
- **One credential per request** (within version 2, no bump; 2026-10-17). The request's `credentials` list is removed; `credential` is the one the connection names. A module declaring several credentials declares alternatives.
- **Core modules, settings, spend** (within version 2, no bump; 2026-10-17).
  The manifest may declare `kind`, `slot`, `settings` and `hostModels`; a
  request may carry `settings`; an answer may carry `cost`;
  the error code `credential_refused`; the host's models door; an event's
  `idempotencyKey`. All additive: an older server sends and declares none of
  them and is unchanged, and an older host ignores them. See
  [Kinds, settings, spend and the host's models](#kinds-settings-spend-and-the-hosts-models).
  A store module may be a process speaking [the store slot's wire](store-slot.md).
- **Limits and throttles** (within version 2, no bump; 2026-10-18). The
  manifest may declare `limits`; an answer may carry `retryAfter`; the
  `limiter` core slot and [its wire](limiter-slot.md); the store wire's
  `work.claimDue` takes `kinds`. All additive: an older server declares and
  sends none of them and is unchanged, and an older host ignores them.
- **A module checks its own inbound** (within version 2, no bump; 2026-10-19).
  `inbound.scheme` may be `module`, paired with the optional method
  `checkInbound`: the host hands the raw request and sends the module's
  answer (events, a refusal, or a reply such as a handshake); the door also
  takes `GET` for such a module. Additive: an older server declares no such
  scheme and is unchanged, and an older host refuses the unknown scheme
  rather than leave it unverified. See [A module that checks its own
  inbound](#a-module-that-checks-its-own-inbound).
- **Version 1**: the first protocol. Not supported: an install that answers it is refused, naming the version.
