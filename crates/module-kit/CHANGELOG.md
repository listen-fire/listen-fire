# Changelog

## 0.12.8 - 2026-10-27

- The store slot's method table serves `runs.rerun { runId, input, at, fence }`, which starts a failed run's next attempt as one fenced write (`null` when the run's status is not `failed`). A run row may answer `attempt` and `attempts` (the earlier attempts, oldest first). A store module built on the kit can now serve `lf runs rerun`.

## 0.12.6 - 2026-10-25

- A module's manifest states the adapter protocol minor it uses (`protocolMinor`), computed from its features; a declared `protocolMinor` can raise it, never lower it.
- Its own version from here on.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
