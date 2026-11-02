---
"@listen-fire/movement-lang": patch
"@listen-fire/handbook": patch
"@listen-fire/authoring-mcp": patch
"@listen-fire/forms": patch
"@listen-fire/github": patch
"@listen-fire/jev": patch
"@listen-fire/mcp": patch
"@listen-fire/slack": patch
"@listen-fire/stripe": patch
"@listen-fire/system": patch
"@listen-fire/telegram": patch
"@listen-fire/webhook": patch
"@listen-fire/whatsapp": patch
---

`connect` names the adapter and the credential itself (`gh = connect github using my_github`), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
