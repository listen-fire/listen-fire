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
