# listen-fire-language

The movement language service: what a position in a movement file answers (scope, fields, edges, built-ins, module tags, listen settings, credential names), hover, go-to-definition, diagnostics and the checker's fixes as code actions. `lf lsp` serves it over the Language Server Protocol. The design: docs/contracts/language-service.md.

## Over the wasm

`movement_language::abi` is the same service as a query over JSON: `language_query_json(src, catalog, query)` answers a completion, hover, definition or code actions question for a position, from the catalog snapshot alone (no project on disk). The engine crate links it into the movement artifact as the export `language_query`, and `@listen-fire/movement-lang` wraps that in offsets (`completionsAt`, `hoverAt`, `definitionAt`, `quickFixesIn`). The query and answer shapes: "Over the wasm" in docs/contracts/language-service.md.

The service is held to its own answers: `tests/` blesses `answers.json` over the handbook's programs, and the wasm and its TypeScript binding are tested against the same file (`packages/handbook/__test__/language_service_parity.unit.test.ts`).
