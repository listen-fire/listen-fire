# @listen-fire/movement-lang

## 0.12.13

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.12

No changes in this release.

## 0.12.11

No changes in this release.

## 0.12.10

No changes in this release.

## 0.12.9

No changes in this release.

## 0.12.8

No changes in this release.

## 0.12.7

No changes in this release.

## 0.12.6

### Patch Changes

- Adapter protocol 2.N: a module states the protocol minor it uses (`protocolMinor` on its manifest), and lf and the engine speak 2.0–2.2 and refuse a module outside that range by name. lf checks a slot module's protocol at start, so a slot module must answer `manifest` before anything else.
