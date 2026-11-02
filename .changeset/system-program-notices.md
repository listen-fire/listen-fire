---
'@listen-fire/system': minor
---

`Validation Issue` and `Deprecated Version` have a reader. `SystemRecords` gains the optional `validationIssues` and `deprecatedVersions` (each `({ after: { at, automationId }, limit }) => ProgramNotice[]`, oldest first: the program, the version involved, the reason, when it was found, an optional URL), and the poll keeps a mark per kind in its cursor. A host without them reports neither kind, as before; listen-fire supplies none, so its own records are unchanged. lf-platform's deploy check supplies both (docs/contracts/system-events.md).
