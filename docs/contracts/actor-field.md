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

An identity with no identifier yields no `Actor` at all.

## Why `Domain` is the last `@`

A filter compares `Domain == "x.com"`. Taking the part after the last `@` means `a@x.com.evil.com` has the domain `x.com.evil.com`, which does not match.
