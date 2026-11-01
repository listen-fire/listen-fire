# @lf/attio

Attio as a module: records, lists, files and webhooks. A connection uses one of
two credentials, and `listen-fire credential add` asks for the name of the one you want.

## Connect with an access token

The simplest way in, and the one for a service account. Create a token in Attio
(Workspace settings, Developers, Access tokens) with read-write access to records
and webhooks, then:

```
listen-fire connect @lf/attio                       # answers the OAuth app questions; leave them empty if you only use tokens
listen-fire credential add --module attio henry_attio --credential attio_token
#   Access token: <the token>      Base URL: <enter, unless you proxy Attio>
```

The credential `attio_token` holds `accessToken` and an optional `baseUrl`. The token
is entered once and never refreshed.

## Connect with OAuth

For a user who signs in through Attio's authorize page, with your own OAuth app
(client id and secret, the redirect URI `listen-fire connect` prints):

```
listen-fire connect @lf/attio
listen-fire credential add --module attio henry_attio --credential attio
```

Either way the movement says `connect attio using henry_attio`; Attio receives the
same bearer header from both.

## Listening

A record's changes arrive on its `Changes`, one record type per object (a deal's
are `DealChange`, a company's `CompanyChange`):

```
listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire `Stage Moved`
```

`Kind` is `created`, `updated` or `deleted`; on an update, `Field` is the title of
the attribute that changed (Attio sends one change per attribute). Each change
carries the record as it is after it, so a WHERE on the record's hop
(`crm-[d:Deals WHERE d.Stage == "Won"]->`) is judged without a read; walk the
change's `Deal` for the deal itself. `listen-fire serve` registers one webhook per
connection, for every object's record events, at the door it prints; Attio
issues its secret. A redelivery of the same change runs nothing.
