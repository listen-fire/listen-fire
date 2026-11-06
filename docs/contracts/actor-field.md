# The `Actor` field

Version: none. This is a convention `listen-fire` and the platform share, not a contract a host must keep: a host may offer nothing, or something else.

A host that wants a run or a listen's filter to read who acted wraps what lands and adds `Actor`, a record on the landing, from the module's `ActorIdentity` (`extractActor`, or the `actor` an arrival carries; [Who acted](adapter-protocol.md#who-acted)). The language names nothing of it: to a run and to a filter it is an ordinary field that may be absent.

| Field | Meaning |
|---|---|
| `Id` | The module's own id for them (the identity's `identifier`) |
| `Email` | Their address, lower case. Present when the identity carries `email`, or has the `email` scheme |
| `Domain` | The part of `Email` after its last `@`, lower case. Absent when `Email` has no `@` |
| `Phone` | Digits only, country code first, no plus. Present for the `phone` scheme |
| `Name` | The identity's `name`, else its `label`, as the source system reports it |
| `Proven` | True when the module checked that the source system vouches for the identity (`proven: true` on it). Absent in the identity reads as false |

## The rule

Identity in, fields out. Each implementation (`normalisedActor` in `packages/engine-contracts/actor.ts`, and `lf`'s twin) is held to these rows by a test that reads this table. A member the row does not show is absent from the fields.

| Identity | Fields |
|---|---|
| `{"identifier":"U1","scheme":"opaque","label":"Ann"}` | `{"Id":"U1","Name":"Ann","Proven":false}` |
| `{"identifier":"U1","scheme":"opaque","name":"Ann Lee","label":"Ann"}` | `{"Id":"U1","Name":"Ann Lee","Proven":false}` |
| `{"identifier":"U1","scheme":"email","email":"A@X.com","proven":true}` | `{"Id":"U1","Email":"a@x.com","Domain":"x.com","Proven":true}` |
| `{"identifier":"A@X.com","scheme":"email"}` | `{"Id":"A@X.com","Email":"a@x.com","Domain":"x.com","Proven":false}` |
| `{"identifier":"a@x.com.evil.com","scheme":"email","email":"a@x.com.evil.com"}` | `{"Id":"a@x.com.evil.com","Email":"a@x.com.evil.com","Domain":"x.com.evil.com","Proven":false}` |
| `{"identifier":"nobody","scheme":"email","email":"nobody"}` | `{"Id":"nobody","Email":"nobody","Proven":false}` |
| `{"identifier":"+44 7700 900001","scheme":"phone"}` | `{"Id":"+44 7700 900001","Phone":"447700900001","Proven":false}` |
| `{"identifier":"U1","scheme":"opaque","proven":false}` | `{"Id":"U1","Proven":false}` |
| `{"identifier":"U1","scheme":"email","email":"\ufeffA@X.com\ufeff"}` | `{"Id":"U1","Email":"a@x.com","Domain":"x.com","Proven":false}` |
| `{"identifier":"U1","scheme":"email","email":"\u0085A@X.com\u0085"}` | `{"Id":"U1","Email":"a@x.com","Domain":"x.com","Proven":false}` |

An identity with no identifier yields no `Actor` at all. An identifier of nothing but trimmed characters is none.

Trimming, wherever these rules trim (an address, and whether an identifier is empty), strips exactly: U+0009 to U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. That is the union of what JavaScript's `trim` and Rust's `trim` each strip, named here so the two cannot differ: JavaScript alone strips U+FEFF, and Rust alone strips U+0085.

## Where `lf` writes it

`lf` writes `Actor` into each arrival's landing fields before the arrival is judged or logged, on every path an arrival comes in by: a delivery, a push to the `wake` door, a poll, a replay, an event file given to `run --event`. A filter, a run and a wait read it as they read any field, and `lf` answers the read itself, since the module never described it.

- An identity with an address or a phone costs no call.
- An opaque identity asks the module's `getActorCandidates` when any movement text in the project says `Actor`, and takes the address of its first `originator` candidate. `Id` and `Proven` stay as the arrival named them.
- If that call fails, `lf` writes what it has and lists `Actor` in the landing's `unknown`. A filter reading it lands as `Arrival Not Judged`, and a listen with no such filter still fires.
- An arrival naming no actor has no `Actor`, and a record reached by reading has none. An `Actor` the body carried through is removed, unless the module declared that field itself: only what `lf` wrote can be read as who acted.
- A landing type whose module declares a field named `Actor` keeps it: `lf` adds and writes nothing there, and says so when it describes the module, naming the module and the type. `lf` reads that from the schema it described for the connection the delivery came through. The names in a source system are its customer's, so `lf` never refuses one. A module's own type named `Actor` is likewise untouched: the record `lf` offers is a type of another name.

A replay of a delivery re-reads the delivery, so it asks the module again and can get a newer answer than the run it replays. A replay of a polled page reads the answer kept with the page.

## Why `Domain` is the last `@`

A filter compares `Domain == "x.com"`. Taking the part after the last `@` means `a@x.com.evil.com` has the domain `x.com.evil.com`, which does not match.
