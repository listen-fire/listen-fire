# Listen-Fire plugins for Claude

Plugins that connect Claude to Listen-Fire, the automation platform: tell
Claude what should happen and Listen-Fire runs it on your real tools, the same
way every time.

## Plugins

- **[listen-fire-builder](./listen-fire-builder/)**: teaches Claude to build
  automations on your real tools with Listen-Fire. Pair it with your
  deployment's Automation MCP connector, which gives Claude the tools this
  skill teaches it to use.

## Install

Add this directory as a marketplace, then install the plugin from it:

```bash
claude plugin marketplace add ./plugins
claude plugin install listen-fire-builder@listen-fire-plugins
```

## License

[MIT](./LICENSE).
