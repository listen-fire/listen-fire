# Attio sync with `listen-fire`

One movement: when a company is created or renamed in Attio, it is found
again by its name and given a description. Its listen is on the company's
`Changes`, narrowed to those two: the movement's own write comes back from
Attio as a change to `Description`, which the listen does not take, so it
never loops. `listen-fire serve` registers Attio's webhook itself, so a
company created in Attio runs the movement.

The files here are what the walkthrough below ends with (no secrets: those are
in `.lf/secrets.yaml`, written by `listen-fire connect` and `listen-fire credential add`).

## Against real Attio

To use an access token instead of an OAuth app, add the credential with `--credential attio_token` (see `modules/attio/README.md`).

You need an OAuth app in Attio (Workspace settings, Developers): its client id
and secret, with `http://127.0.0.1:8976/callback` registered as a redirect
URI, and the scopes for records and webhooks (read-write).

```
listen-fire init attio-sync && cd attio-sync
listen-fire connect @lf/attio          # client id, client secret, 8976 (Attio issues the webhook secret itself)
listen-fire credential add --module @lf/attio henry_attio --credential attio     # enter, enter; signs you in in the browser
cp <this folder>/movements/sync.mvt movements/
listen-fire check
```

Attio must reach `listen-fire serve`: run a tunnel to its port (any will do) and put
its address in `lf.yaml`:

```
publicUrl: https://<your tunnel>
```

```
listen-fire serve --port 4400   # prints: attio (Changes, edge-…): registered webhook <id> for the arrivals on Changes at <publicUrl>/api/public/webhook-sync/attio/henry_attio/edge-…
listen-fire runs                # after you create a company in Attio
```

One webhook serves every listen on the connection's `Changes`, whichever
object it is on. Stopping and starting `listen-fire serve` again keeps it.
Remove the listen and start it again, and the webhook is removed.

## Against the fake Attio (no account, no tunnel)

The repo's fake third-party server (the package `@listen-fire/fake-channels`) has an Attio API, an
OAuth provider, and a control door that delivers Attio's signed webhooks.

```
FAKE_CHANNELS_PORT=5556 pnpm --filter @listen-fire/fake-channels start     # in its own terminal (the package's `fake-channels` bin does the same)
F=http://127.0.0.1:5556
```

```
listen-fire init attio-sync && cd attio-sync
listen-fire connect @lf/attio --base-url $F/attio --oauth-authorize-url $F/oauth/authorize --oauth-token-url $F/oauth/token
#   any client id, any client secret, 8976
listen-fire credential add --module @lf/attio henry_attio --credential attio --headless
#   enter, enter; open the printed URL (curl -si '<url>' shows the Location), paste the Location back
cp <this folder>/movements/sync.mvt movements/
listen-fire check
echo 'publicUrl: http://127.0.0.1:4400' >> lf.yaml
listen-fire serve --port 4400                                       # in its own terminal
curl -s $F/admin/attio/webhook/state                       # the webhook listen-fire serve registered
curl -s -XPOST $F/attio/v2/objects/companies/records -H 'content-type: application/json' \
  -d '{"data":{"values":{"name":"Vireo Robotics"}}}'      # note its record_id
curl -s -XPOST $F/attio/control/deliver -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"record.created","id":{"object_id":"companies","record_id":"<id>"}}]}'
curl -s $F/admin/attio/record:companies/state              # the company now has its description
listen-fire runs
```

Delivering the same event again runs nothing: it names the same change.
Deliver the movement's own write back (`record.updated` with `"attribute_id":"description"`)
and nothing runs: the listen takes only a company's creation and its `Name`.
Rename the company (`PATCH $F/attio/v2/objects/companies/records/<id>` with
`{"data":{"values":{"name":"Vireo"}}}`) and deliver `record.updated` with
`"attribute_id":"name"`: the movement runs again.
