---
'@listen-fire/handbook': patch
'@listen-fire/authoring-mcp': patch
---

The micro examples: a few checked lines of listen-fire doing one thing each, found by asking in your own words. The handbook exports them (`microExamples`, `searchExamples`, `renderExampleLookup`, `renderExampleIndex`); they are read from the `listen-fire` command's own copy, `crates/lf/data/examples.md`, which a build of the package carries as `examples.md`. The authoring tools serve the lookup as `showExample`, and the front page's build loop points at it. The language search's ranking rule is now one function, `scoreFields`, which both lookups share.
