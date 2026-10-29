# @listen-fire/whatsapp

## 0.12.8

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.7

### Patch Changes

- 81e20ed: The manifest's description and trigger expectation say who reaches a listen on either host: where the number is the project's own (`lf`), every message sent to it; on the shared Listen-Fire number, only messages from a phone linked to the user's account. Before, both stated the shared-number rule alone, which is wrong under `lf`.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
