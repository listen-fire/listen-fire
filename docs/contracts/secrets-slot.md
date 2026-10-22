# The secrets slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A secrets module is where lf's credentials are kept. lf asks it for what it holds, and:

- reads a credential and writes a refreshed one back, by version
- holds a credential under a lease while a refresh spends its token
- changes whole entries for `lf connect`, `lf credential add|update|delete` and a webhook's registration

The default, `@lf/file-secrets`, is the secrets file (plain or SOPS) and its lock file, in process. A module of your own fills the slot when many workers share one vault: a token one worker refreshes is kept for all, and two workers refresh it once.

**A module only stores.** Refreshing a token, signing in against a provider and every other decision stay in lf.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_vault
kind: core
slot: secrets
url: https://vault.example.com   # a remote module; or command: [node, vault.mjs], started in this folder
settings:                        # what lf asks it with on every request
  - { name: vault, label: the vault credentials are kept in }
```

`lf.yaml` names it for the slot: `core: { secrets: acme_vault }`.

## Its own settings come from outside it

A module cannot be asked for the settings it is asked with. They come from the environment (`LF_SECRET__ACME_VAULT__EXTERNAL=acme_vault` with `LF_SECRET__ACME_VAULT__VAULT=…`) or the project's secrets file, never from the module. `lf connect acme_vault` writes them to the secrets file.

- A project naming a secrets module with settings neither source holds is refused as it loads: "the secrets module's own settings come from LF_SECRET__… or the secrets file, not from the module".
- A module that declares no required setting has nothing to bootstrap, and is not refused.
- `LF_SECRET__<CREDENTIAL>__<FIELD>` lies over what the module holds, field by field, whichever module it is. That overlay is lf's, not the module's.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time, the install's settings on every request.

## Methods

`ref` is the module's own name for a credential: a name in a secrets file, a row id in a table. `fields` is an object of strings (`expires_at` an ISO time).

| method | params | result |
|---|---|---|
| `secrets.resolve` | `{ ref }` | `{ fields, version }`, or `null` when nothing is stored under `ref` |
| `secrets.writeBack` | `{ ref, fields, expectedVersion }` | `{ kind: "written", record }`, `{ kind: "not_persisted", record, why }`, `{ kind: "conflict", current }` or `{ kind: "missing" }` |
| `secrets.list` | `{}` | `[{ ref, external, binding, version }]` |
| `secrets.lock` | `{ ref, ttlMs }` | `{ token }`, or `null` when another holds the lease |
| `secrets.unlock` | `{ ref, token }` | `null` |
| `secrets.assertWritable` | `{ ref }` | `null`, or `{ kind: "read_only", reason }` |
| `secrets.create` | `{ ref, external, binding, fields }` | `null`, or `{ kind: "read_only", reason }` |
| `secrets.replace` | `{ ref, external, binding, fields }` | `null`, or `{ kind: "read_only", reason }` |
| `secrets.delete` | `{ ref }` | `null`, or `{ kind: "read_only", reason }` |

`record` is `{ fields, version }`. `binding` is how an entry is bound:

- `"install"`: the install of the module `external` (its server secret and settings)
- `"legacy"`: a hand-written entry for `external`, from before bindings
- `{ credential }`: a credential `external` declares, by that name

### Reading and writing back

- **`version`** is opaque and changes whenever the stored fields change. `secrets.list` answers the same version `secrets.resolve` does for an entry.
- **A write-back merges `fields` over the stored ones** and keeps the ones it does not name. It is compare-and-swap: if the stored version is not `expectedVersion` it changes nothing and answers `conflict` with the current record. A `ref` the module does not hold is `missing`.
- **`not_persisted`** says the module took the write for this process only (an environment store); `why` names no value. lf warns once per credential and carries on.
- **No secret value in an error.** A refusal's message, a log line and anything else the module prints must not carry a field value.

### The lease

A refresh spends a refresh token that rotates: two lf processes must not both do it. lf takes the credential's lease around a refresh, and around a whole-entry change.

- **`secrets.lock`** answers `{ token }` when `ref` is free, and `null` when a lease on it is held. lf asks again every 20 ms for up to 10 s, then fails the command, naming the credential.
- **A lease lapses on its own** `ttlMs` after it was granted, so a holder that died frees it. lf asks for 30 s.
- **`secrets.unlock`** with the lease's token frees it. A token that is not the lease's frees nothing, and answers `null`.
- **A token is new each time.** A lease granted after an unlock or a lapse has a token of its own.
- **A module that cannot hold a lease** (a store with a compare-and-swap of its own, that makes a concurrent refresh a conflict anyway) may grant every lock. The cost is a refresh token spent twice, and the second refresh is refused by the provider, so grant honestly where you can.

### Whole entries

`secrets.create`, `secrets.replace` and `secrets.delete` change one entry, answering `null` when done.

- **`create`** refuses (a refusal, any code) when `ref` exists.
- **`replace`** is the whole entry, not a merge: what `fields` does not name is gone. It writes the entry whether or not one existed.
- **`delete`** refuses (a refusal, any code) when `ref` does not exist.
- **`binding` and `external` are required.** A request without them is `bad_request`. So is a request without its `ref`, or a lock without its `ttlMs`.

### Read-only

A module whose credentials come from somewhere lf cannot write (a platform's credential store, a secret manager the deployment fills) answers the three entry methods and `secrets.assertWritable` with `{ kind: "read_only", reason }`, and keeps nothing.

- lf then refuses by name, exit 2, writing nothing: `<module> holds its credentials read-only: <reason>. Add it where it lives.` A webhook's registration adds `Register the webhook where the credentials live.`
- **`assertWritable` is lf's probe before a sign-in.** `lf credential add` and `update` ask it before sending a person through the provider, so a read-only module refuses before anything leaves the machine. It answers `null` when entries can be changed. The file module's answer is its permission check (SOPS runs).
- **Read-only is for whole entries.** A read-only module still lists, resolves, leases and takes a write-back: a refreshed token is kept.
- A refusal that is not `read_only` (the module is down, the vault said no) fails the command with the message, exit 1.

## The redirect relay

The provider's redirect URI is lf's, not the module's: signing in runs in lf whichever module stores the grant. Where the provider's registered callback is held by something in front of the fleet, `lf.yaml`'s `oauth: { redirectUri: https://… }` is what lf sends at authorize and at the token exchange, and the relay forwards the `code` and `state` query to `lf serve`'s `GET /oauth/callback`. A module sees only the entry written once the sign-in finishes.

## What a module must pass

Every secrets module answers the same cases:

- **`commonSlotCases('secrets', SECRETS_METHODS)`**: its manifest names the slot and lists the nine methods; an unknown method, another protocol version and a request without the module's token are refused as the protocol says.
- **`secretsSlotCases`** (`packages/module-runtime/module_wire/conformance.ts`, re-exported as movement-engine `public/module-wire`), against a module that can change its entries:
  - `list` names each credential with its external, binding and the version `resolve` answers
  - `create`, `replace` and `delete` change whole entries, each answered `null`; `replace` is the whole entry
  - `create` of an entry that exists and `delete` of one that does not are refused
  - a second `lock` while one is held answers `null`, a wrong token unlocks nothing, `unlock` frees it under a new token
  - a lease whose ttl lapsed is free
  - `assertWritable` answers `null`
  - a request without its `ref`, a lock without its ttl, an entry without its binding: `bad_request`
- **`secretsReadOnlySlotCases`**, against a module that keeps its entries read-only: `create`, `replace`, `delete` and `assertWritable` each answer `read_only` with a reason and keep nothing; `list`, `resolve` and the lease still work. A module that always changes its entries skips these.
- **`secretsContractCases`** (movement-engine `public/secrets-testing`), the eleven cases every secrets store passes (resolve, the write-back's merge and version, the conflict, a refresh and a rotated token, one token call for two concurrent refreshes in a process and from two handles, a retry after unauthorized, the warning for a store that cannot keep a write-back, no secret in an error). `SecretsSlotBackend` (module-wire) is the module's wire as a `SecretsBackend`, so the cases run against any module at its address:

```ts
const handle = () => new SecretsSlotBackend(address, settings);
await contractCase.run({
  backend: handle(),
  sibling: handle,           // a second handle, as another process holds it
  seed: async (fields) => { /* handle().seed(ref, 'acme_crm', fields); return ref */ },
  missingRef: () => 'a-ref-it-does-not-hold',
});
```

## Running the cases

- **Against a module of your own**, with the three kits above, as `apps/cli/src/__test__/secrets_slot_contract.test.ts` does for the test vault (`secrets_module/serve.ts`): serve the module, make a `SlotClient` at its address with its settings, and run each case.
- **Through lf's own client of it**: `lf --contract-secrets-slot --dir <project>` serves the project's secrets slot as a secrets module, every method passed on through lf's client of the module `core: { secrets: … }` names (or the file module, by default). The same cases then hold lf's side of the wire to the meaning they hold the module to. The module's settings come from the environment, as for any command; the runner answers a `secrets.lock` another holds with `null` after a short wait, as the wire says.
- **`lf --contract-secrets <secrets file | env>`** is the family's bridge over stdio, for lf's own stores.

## Changes

- **2026-10-22** (within adapter protocol 2): the secrets slot, its methods, and its conformance cases.
