# The lowering vocabulary

What the lowering knows about built-ins: the AI tiers, the `FILE` and `READ`
contracts, each options map's keys (a key's summary, its allowed values, the
values that are not available yet and why) and the stdlib function families.

- `vocabulary.json` is the one file a human edits.
- `data.rs` is generated from it. Never edit it by hand.
- `generate.rs` is the generator; its test fails while `data.rs` differs from
  what the JSON generates.

## Editing

A family function is written as its name and its parameters, an optional one
ending in `?` (`{ "name": "REGEX_EXTRACT", "params": ["text", "pattern", "group?"] }`).
Its id (`text.regex_extract`), signature and arity are derived from those.

An options map's cross-option rule is code, not data: `agree` names a rule
`call_shape::agree` carries, and a test there fails on a name it does not know.

## Regenerating

```sh
cargo run -p listen-fire-parser --features generate --bin gen-vocabulary
```

Then rebuild the WASM (`scripts/build-movement-wasm.sh`) and commit the
artifacts with the change, since the parser is inside it.

## What else must agree

The checker's standard library (`crates/movement-checker/src/types/stdlib.rs`)
and the built-ins reference (`crates/movement-language/src/builtins.md`)
describe the same built-ins. movement-language's `vocabulary_agrees` tests fail
when a built-in named here has no library entry or reference section, when a
family function in the library or the reference is missing here, when a
family function's signature or arity differs from the library's, or when the
reference does not name an option key or an AI tier.
