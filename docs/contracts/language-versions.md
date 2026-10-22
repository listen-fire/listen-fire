# Language versions

Version: the release's own

The language version is the toolchain release: the one semver every crate and package of a release carries (`0.12.0-rc.6`, `0.12.0`). There is no separate integer and no name.

- **A pin is a release's version.** A saved movement is pinned to the release it was written against: `MAJOR.MINOR.PATCH`, with an optional `-pre-release` (`0.12.0`, `0.12.0-rc.6`). A text of any other form is not a version.
- **The compatibility key.** A version's key is its minor under 0.x (`0.12.3` → `0.12`) and its major from 1.0 (`1.4.0` → `1`). A pre-release has its release's key (`0.12.0-rc.6` → `0.12`).
- **The rule.** A release reads a pin whose key is its own, and refuses any other by name, with the remedy. One rule, implemented twice: `compatible` and `standing` in `crates/movement-parser/src/version.rs`, `compatible` and `languageVersionStanding` in `packages/movement-lang/language_version.ts`. A test holds both to the table below.
- **This release's version** is read from one place on each side: the parser crate's `CARGO_PKG_VERSION` (`LANGUAGE_VERSION`), and `packages/movement-lang/package.json`'s `version` (`LANGUAGE_VERSION`).
- **On the wire:** the pin travels as `languageVersion` with a run's input, on `segment.open` (so an in-process adapter reads it from its segment), and on the checker's `check.program`. A remote adapter does not receive it: the adapter protocol carries no `languageVersion` today.

## The standings

| pin | release | standing |
|---|---|---|
| 0.12.3 | 0.12.0 | compatible |
| 0.12.0-rc.6 | 0.12.0 | compatible |
| 1.4.0 | 1.0.0 | compatible |
| 0.13.0 | 0.12.0 | newer |
| 2.0.0 | 1.9.0 | newer |
| 0.11.0 | 0.12.0 | older key |
| banana | 0.12.0 | malformed |

## The refusals

A pin this release does not read is refused with `MOV_LANGUAGE_VERSION_UNSUPPORTED` (the checker) or `MOVENG_LANGUAGE_VERSION` (the engine), whose message is one of three, `{pin}` the pin and `{own}` this release:

- **newer:** "this automation pins language {pin}, newer than this release ({own}); upgrade the engine"
- **older key:** "this automation pins language {pin}, which this release ({own}) does not read; validate it under {own} and upgrade it"
- **malformed:** "this automation pins language {pin}, which is not a version; a pin is a release's version, such as {own}"

A compatible pin is read with nothing said: a deprecation is the CHANGELOG's to announce.

## Breaking changes

Breaking changes never break a saved movement.

- **A break lands in a new key.** A spelling retired, a construct's meaning changed, a plugin's output reshaped, an engine rule tightened: each ships in a release of a new compatibility key, never within one.
- **A changed meaning is diagnosed.** Any construct whose meaning changed gets a checker diagnostic under the new key, so "validates clean under the new release" can never hide a silent behaviour change.
- **The pin moves only by an explicit upgrade.** A person asks for it (`lf upgrade`, the API's or an agent's upgrade). Never automatically, and never by an ordinary edit.
- **The CHANGELOG says why.** The entry for a break names the release that introduces it and why.

Movements pinned to the integer versions of earlier releases (1 to 4) are the platform's: it keeps their parser, checker and engine until they are upgraded. The integer 5 is the 0.12 line.

## Changes

- **0.12** (this rewrite): the language version is the toolchain release; a pin is a semver, read by its compatibility key. The integer versions and their names (version 5, "Dancing Wren", is the 0.12 line) retire, and so does `MOV_LANGUAGE_VERSION_DEPRECATED`.
