// Version 1's corpus tests ruled out: each asserted an internal shape that has
// since been refactored, a reworded message, or a refusal that version 2
// turned into acceptance — none a difference in what a valid version-1
// movement does. Anything that changes what a movement does is a version
// conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const PARSE = 'parser/__test__/parse.unit.test.ts';
const LINK_AST =
  "AST shape only: a link's target moved from `link.target` ({handle} | {criteria}) to `link.to` ({handle} | {match}); the same source parses, and the program means the same";

const ACCEPTED =
  'refusal became acceptance; no valid v1 program observes it';

exports.triage = [
  { file: PARSE, test: "rejects 'unique by' inside a link body (criteria ARE the identity)", reason: ACCEPTED },
  { file: 'checker/__test__/value_collections.unit.test.ts', test: 'a function that hands nothing back is refused', reason: ACCEPTED },
  { file: PARSE, test: 'parses the bare-handle link statement', reason: LINK_AST },
  { file: PARSE, test: 'parses the criteria-form link statement (identity-criteria body)', reason: LINK_AST },
  { file: PARSE, test: 'parses a bound criteria link with an explicit type for a polymorphic edge', reason: LINK_AST },
  { file: PARSE, test: 'criteria-link explicit types: bare types get the fix-it (handle form untouched)', reason: `${LINK_AST} (the fix-it assertion before it still passes)` },
  { file: PARSE, test: 'criteria-link explicit types: the bracketed form parses', reason: LINK_AST },
  { file: PARSE, test: 'parses backtick-quoted link/unlink source and target handles, and a listen instance name', reason: LINK_AST },
  {
    file: PARSE,
    test: 'rejects binding the bare-handle link form (it binds nothing)',
    reason: 'still refused at the same place; only the parse error wording changed (it names `match` instead of "the criteria form")',
  },
  {
    file: 'checker/__test__/check_typed.unit.test.ts',
    test: 'MOV_WRITE_UNKNOWN_FIELD for a criteria field the found type lacks',
    reason: 'same diagnostic code at the same span; only the message wording changed',
  },
  {
    file: 'checker/__test__/check_typed.unit.test.ts',
    test: "MOV_LINKED_UNKNOWN_EDGE with link phrasing when the source's type lacks the edge",
    reason: 'same diagnostic code at the same span; only the message wording changed',
  },
  {
    file: 'checker/__test__/appendable_local_node.unit.test.ts',
    test: 'a criteria body is refused — a node this run built has no system to search',
    reason: 'still refused; the diagnostic was renamed MOV_NODE_LINK_CRITERIA → MOV_NODE_LINK_BODY, and the test reads the retired constant (undefined)',
  },
  {
    file: 'service/__test__/service.unit.test.ts',
    test: 'offers DATETIME as both, NUMBER as a function only, CURRENCY/TEXT as namespaces only',
    reason: ACCEPTED,
  },
  {
    file: 'service/__test__/service.unit.test.ts',
    test: 'hover on NUMBER before `(` mentions the coercer (no namespace duality)',
    reason: ACCEPTED,
  },
  {
    file: 'checker/__test__/block_returns.unit.test.ts',
    test: "the same over a local node's entries",
    reason:
      "the test uses COALESCE as its stand-in for a call the checker cannot type; COALESCE now types as the kind its arguments share (a bug fix under every version, so a yes/no reaching a declared text field is refused), and a typed return over a lazy entry meets the order rule exactly as `return f.`Name`` already did under v1",
  },
];
