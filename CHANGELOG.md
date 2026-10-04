# Changelog

Every pull request that changes what an operator sets or an author writes adds a line under Unreleased in the same pull request. Tagging a release moves the Unreleased entries under a heading for the new version, with the date.

Entries are written for two readers: an operator running a self-hosted installation (what to set, what a deploy applies, what behaves differently) and an author writing automations in the movement language (new or changed constructs, plugins, adapters, handbook idioms). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the git tags described in [`deploy/UPGRADING.md`](deploy/UPGRADING.md).

## [Unreleased]

Language version 3 arrives: **Steady Lynx**. A new automation is written in it, and the deploy check moves an automation up to it when it validates cleanly there. It reads a list literal exactly, which refuses programs Bright Otter (2) accepted, so those stay on their version until repaired and upgraded.

### Changed

- Language version 3, **Steady Lynx**, reads a list literal as the tuple it is. Why: an index read off a literal was checked against what its members share, so `AT(["a", 1], 0) * 2` multiplied text, `AT([{ a: 1 }, { b: 2 }], 0)` looked up a key the first dict was never written with, and a walk off `AT([one, two], 1)` took an edge the second record has not got, all without a word; and a literal whose members share no type was a list nothing checked, so `[o.name, o.amount]` written into a list of numbers reached the system. Under Steady Lynx each of these is refused at save (`MOV_ARITH_NON_NUMERIC`, `MOV_DICT_UNKNOWN_KEY`, `MOV_TRAVERSE_UNKNOWN_EDGE`, `MOV_WRITE_FIELD_TYPE`, and the comparison and json rules for a member that may be text, a number or json). The run is unchanged: a version-2 automation that validates under Steady Lynx does exactly what it did, so the move needs no warning beyond these refusals.
- `await parallel([...])` and `await race([...])` with arms whose results differ read as a list of their union under Steady Lynx; before, they read as a list nothing checks.
- Under Steady Lynx (3) a call is resolved the way a name is: the movement's own scopes first, then the file and its imports, then the standard library, which lists every built-in with what each argument takes, what it gives back and what it does (calls a model, reads the clock, reads a file). Why: before, a built-in's arguments were never checked and an unknown function name was a call nobody checked, so `UPPER(company)` wrote `[object Object]` and a misspelt `UPPPER(x)` failed only when the movement ran. Each of these is now refused at save:
  - An unknown function name is `MOV_FUNCTION_UNKNOWN`, with the closest function or built-in suggested. Inside a write field an unknown name is still accepted, because the target field may offer functions of its own (a Slack message's `SLACK_MESSAGE(…)`) that the save check cannot list yet.
  - Function names are case-insensitive: `upper(x)`, `UPPER(x)` and `Upper(x)` are one built-in, and `Email_To_Doc(m)` calls `email_to_doc`. Two functions (movements, plugins or imported functions) whose names differ only by letter case, or a function named like a built-in in any case (`movement sum(…)`), are `MOV_FUNCTION_NAME_COLLISION`. Variable names keep their case, and a variable holding a value shadows a built-in as TypeScript's does: `upper = 3` then `upper(x)` is `MOV_CALL_NOT_MOVEMENT`. A name bound to a closure is a function's name (see calling a closure below), so `upper = (t) => t` is `MOV_FUNCTION_NAME_COLLISION`.
  - A built-in's argument of the wrong kind is `MOV_BUILTIN_ARG_TYPE` (`ROUND(m.Subject)`); a record where a value is read is `MOV_RECORD_NOT_A_VALUE` and a json value `MOV_JSON_OPAQUE`, as everywhere else (`UPPER(company)`, `UPPER(c-[p:Members]->)`). The wrong number of arguments, or a function or type handed to a built-in that takes values, is `MOV_BUILTIN_ARGS`.
  - A built-in's call is typed by what it gives back, so `UPPER(x)` is text and writing it into a number field is `MOV_WRITE_FIELD_TYPE`. Before, such a call had no type and every rule downstream of it was silent.
  - A call written inside another expression is the value it gives back (see nested calls below). Inside a walk's `WHERE`, `ORDER BY` or settings, which are read once per landing, a movement's call, `MAP`, `FILTER`, `REDUCE`, `GROUPBY`, `KEYBY` or `MEMBERS` is refused as `MOV_CALL_NESTED`, with the binding to write. This now includes the hops heading a block (`c-[m:Members WHERE f(m)]-> { … }`), whose calls were not resolved at all before. A built-in that only computes a value, written as a statement on its own (`UPPER(x)`), is `MOV_BUILTIN_UNUSED`.
  - `listen to … fire <movement>` and `callback(<movement>(…))` name the movement in any letter case, as a call does.
  - A run does what it did: a call the save check accepts reads exactly as it did before. The collection ops and `MEMBERS` are now ordinary calls rather than forms of their own, so their errors are reported by the save check rather than as parse errors. A built-in's declared effects now count towards a movement's effect row under every version, so a `READ(file)` shows as reading files and a retired `KG_VALUE(…)` as reading the knowledge graph.
  - Under Quiet Heron (1) and Bright Otter (2) the language does not change: names keep their case, an unknown function and a built-in's arguments stay unchecked, and a built-in's call stays untyped. Only the effect row above is shared by every version.
- Under Steady Lynx (3) a call nests inside any expression, because a function's arguments are ordinary expressions and a movement is a function: `double(n) + 1`, `ONLY(extract(content, Company))`, `COUNT(MAP(xs, f))`, `MAP(MAP(xs, f), g)`, `log(MAP(xs, f))`. A nested call means exactly what binding it to a name first and reading the name means, and it is checked and typed that way: `label(x)` that returns text is refused written into a number field. Its effects count towards the movement around it. How it runs:
  - Left to right, as the text reads. Every operand before a nested call is read before the call runs, and a call's arguments are all evaluated before its body runs: `CONCAT(mark("a"), mark("b"))` writes `a` then `b`.
  - `IF`, `AND`, `OR` and `COALESCE` short-circuit, as TypeScript's `?:`, `&&`, `||` and `??` do: an operand they do not need is never evaluated, so a call in an arm that is not taken never runs and its writes never happen. There is no restriction on effects in those arms.
  - A call that may wait (a movement that `await`s) is refused inside an expression as `MOV_NESTED_CALL_SUSPENDS`: a wait parks the run where it is written, and a position inside an expression has nowhere to come back to. Call it on its own line and use the name.
  - Under Quiet Heron (1) and Bright Otter (2) nothing nests; those versions have no positional calls.
- Under Steady Lynx (3) `COALESCE(a, b, …)` stops at the first argument that has a value and never evaluates the rest. Before, every argument was evaluated first and then the first present one chosen, so a later argument could still call a model, read a file, or fail the run (`COALESCE(x, ONLY(list))` failed whenever `list` held two values, even with `x` present). A saved automation keeps the old order until it moves to version 3.
- Under Steady Lynx (3) a call to a movement that may wait is refused at save as `MOV_CALL_SUSPENDS`, on its own line or bound. Why: the run cannot yet resume inside a called movement. The callee parks at an address inside its own body, and the resume walks the dispatched movement's body from that address, so the run would come back to the wrong place. Before, such a call was accepted and broke when the wait ended. Wait in the movement itself, or run the wait as an arm of `await parallel([…])` or `await race([…])`. Under versions 1 and 2 the call is accepted as before.
- Under Steady Lynx (3) a closure bound to a name is called like any function, because movements and functions are the same thing: `inc = (v: <number>) => v + 1` then `inc(2)`, `inc(v: 2)`, `double(inc(x)) + 1`, or `note(m.Subject)` on its own line. Before, the call was refused as `MOV_CALL_NOT_MOVEMENT`. How it reads:
  - Its parameters check the arguments (`MOV_CALL_ARITY`, and the argument type rules a movement's call has), and the call is typed by what its body returns.
  - Calling it does what its body does: a model call or a write in the body counts towards the movement that calls it. Binding it does nothing.
  - Its name is a function's name: it is called in any letter case (`INC(2)`), and naming it like a built-in (`upper = (t) => t`) or like another function in another case (`Double = …` beside `movement double`) is `MOV_FUNCTION_NAME_COLLISION`. A name holding a value is still not callable.
  - A closure that may wait is refused called (`MOV_CALL_SUSPENDS`, or `MOV_NESTED_CALL_SUSPENDS` inside an expression), as a movement that may wait is; it can still be passed as an arm of `await race([…])` or `await parallel([…])`.
  - Under versions 1 and 2 a closure is passed, never called, as before.
- Under Steady Lynx (3) a movement's call, a closure's call, `MAP` and the other collection ops, or `MEMBERS` written inside `SORT`'s key is refused as `MOV_CALL_NESTED`. Why: the key is read once per member, but a call there ran once, where it was written, so every member sorted by the same answer. Work the key out per member first (`MAP`), then sort by it. A value built-in in the key (`SORT(people, LENGTH(Name))`) is read per member as before. The key is the only built-in argument read per member. Under versions 1 and 2 nothing nests, and nothing changes.
- Under Steady Lynx (3) three things the expression grammar did without a word are refused at save:
  - `JOIN`'s separator written as anything but text in place (`JOIN(xs, sep)`, `JOIN(xs, "${sep}")`) is `MOV_BUILTIN_ARGS`: it was dropped and `", "` used instead. (An aggregate's extra argument, `COUNT(xs, 3)`, which read only `xs`, is already `MOV_BUILTIN_ARGS` by the argument count rule above.)
  - `IF … THEN … END` with no `ELSE` is `MOV_IF_WITHOUT_ELSE`: where the condition failed it was `""`, whatever `THEN` held, so `IF x THEN 3 END` was a number or empty text and had no type at all. Write the `ELSE`.
  - A `KG_EXISTS` or `KG_VALUE` query written as anything but text in place (`KG_EXISTS(q)`, `KG_EXISTS("MATCH … ${x}")`) is `MOV_BUILTIN_ARGS`: it was read as an empty query. Write the query out and pass its values as parameters (`$0`, `$1`, …). Both functions remain retired in the movement engine; query the graph by walking it.
  - Under versions 1 and 2 each keeps its old behaviour exactly.
- `first(c-[m:Members]->).Name` reads the field of the landing the aggregate picks, in any letter case, as `FIRST(…).Name` always did. Before, the lowercase spelling was refused. This applies under every language version, since it accepts only what was refused before.
- Every expression is now read by one grammar that builds a structured tree, in the save check and when the movement runs. Before, a layer rewrote expression text before a second grammar parsed it. What an expression means is unchanged apart from the fixes under Fixed below and one widening: a bare walk (`c-[m:Messages]->`) is the records it lands on wherever a value goes, such as `COALESCE(c-[m:Messages]->, [])`, `[c-[m:Messages]->]` or `count(c-[m:Messages]->)`. Before, a bare walk was accepted only as a whole expression or as the first argument of an upper-case aggregate, and refused everywhere else. `EXISTS(walk)` still tests that the walk lands anywhere, and `walk.field` still reads a field. This applies under every language version, since it accepts only what was refused before.

### Fixed

- In an `if` condition, `AND` now binds tighter than `OR`, as it does everywhere else: `if a OR b AND c` means `a OR (b AND c)`. Before, an `if` condition was split on every `AND` first, so it ran as `(a OR b) AND c`, while the same text as a value or in a hop `WHERE` meant `a OR (b AND c)`. A saved `if` condition that mixes `OR` and `AND` without parentheses now runs with the precedence it was written with. This applies under every language version rather than behind a version gate, ruled as a bug fix.
- `IF a AND b THEN … END` is accepted inside an `if` condition. Before, the same split cut it in half and the condition was refused.
- Inside `EXISTS(…)`, a walk's `WHERE` can hold a `${…}` interpolation or another `EXISTS(…)`, and both are evaluated: `EXISTS(c-[p:Members WHERE EXISTS(p-[:Employer]->)]->)`. Before, both were left as a placeholder field that matched nothing. This applies under every language version.
- An empty hop `WHERE` (`crm-[c:Companies WHERE ]->`) is refused at save as `MOV_EXPR_PARSE`, saying to write a condition or drop the `WHERE`. Before, it was read as no filter, so the walk kept every record. This applies under every language version: an automation saved with one now fails at save and at run until the `WHERE` is written or removed.
- `TEXT.SERIALISE` of a value holding a `lazy` edge that has not run (`TEXT.SERIALISE(node { items: lazy a-[f:…]-> }, 'JSON')`) is now refused at save as `MOV_STDLIB_ARG_LAZY_EDGE`, saying to read the walk first. Before, it saved and failed when the movement ran. Nothing that ran changes.
- An extraction shape with a field and a child node of the same name (an `extract … from` block, a `node X: "…" { … }` declaration, or the shape of `extract(content, Shape)`) is now refused at save as `MOV_EXTRACT_FIELD_DUPLICATE`. Before, it saved and failed when a record of it was written out.
- A payout to a fund that holds a company both directly and through an SPV now reaches the cheque it was paid on: a payment is attributed to the holdings whose asset the paying entity issued, so the SPV's payout goes to the SPV cheque. Before, the SPV cheque valued on its own received nothing, and the fund's cheques valued one at a time added up to less than the fund's position valued whole. A payout on holdings that share no unit (fund-of-funds interests, capital calls) is split by the cash each cheque invested instead of being lost; one nothing held can explain is attributed the same way and logged at `warn`.
- A connector client closing its event stream no longer logs an unhandled rejection on the API; the session is released quietly.

### Added

- Under Steady Lynx (3), extraction is also a function: `companies = extract(content, Company, { tier: 'careful' })` reads a list of text and files and hands back a list of `Company` records, one per thing found. The `extract … from [ … ] { … }` keyword is unchanged: its prompts are byte for byte what they were, and it keeps its own engine path.
  - The content is a list, read in order: text, files (read as text, as the keyword reads them), and records rendered as text with `TEXT.SERIALISE(record, 'JSON')`. A record, map, json, number or date put in raw, a list inside the list (spread it with `...`), or one value where the list goes is refused at save as `MOV_EXTRACT_CONTENT`, naming the fix.
  - The shape is a node declaration: at file level, declared in the body around the call (a node declaration inside a function or lambda body now runs), or written in place with its header, `extract(content, node Person: "each person named" { name: <text> "their name" })`. Anything else is `MOV_EXTRACT_SHAPE_COMPUTED`; the anonymous `node { … }` literal is a parse error, because its strings are values, not descriptions.
  - The records read as an extracted record of the same declaration reads under the keyword (text `""` when nothing was found, a typed field `T | absent`, `<text | null>` null), walk their nested nodes with `WHERE`, take writes and links as any record the run built, and fit `MAP`, `ONLY` and `TEXT.SERIALISE`. Each field's evidence records which content item it came from, on the run's write provenance.
  - Settings are `tier`, `model` and `effort` (`'low'`, `'medium'`, `'high'`, `'xhigh'`), each written as a quoted word; a named model or effort wins over the tier's assignment on this deployment (`EXTRACTION_TIERS`). An unknown key (with a did-you-mean), a word outside its set, a computed value, or a model this deployment cannot reach is refused at save as `MOV_EXTRACT_CONFIG`.
  - It is a value like any other: bound (`found = extract(…)`), returned, or written inside another expression (`ONLY(extract(…))`, `MAP(extract(…), f)`). Inside a walk's `WHERE` it is refused as `MOV_EXTRACT_CALL_NESTED`, because the `WHERE` is read once per landing. On its own line as a statement it is a parse error.
  - A declaration's name read as a value is the declaration: `S = Company` then `extract(content, S)` fills `Company`.
  - A reply that does not fit the shape is asked once more and then fails the call; inside `MAP`, `onError` decides what that member does.
  - The prompt is laid out for the provider's prompt cache: one system prompt shared by every extraction call, each content item as its own block in the author's order, and the shape and instructions last. The engine remembers the content it has sent in a run and marks the end of the longest prefix a call shares with an earlier one, and the end of all its content, as cache breakpoints (Anthropic; other providers keep the order and drop the marks). Each call's trace entry carries the breakpoints and the provider's cache read and write tokens.
  - Under Quiet Heron (1) and Bright Otter (2), `extract(` stays the parse error it was.
- Under Steady Lynx (3) a closure can have an expression for its body, as TypeScript's can: `(v) => v * 2` is `(v) => { return v * 2 }`. So a function written in place is a value like any other, bound (`inc = (v: <number>) => v + 1`) and passed (`MAP(xs, inc)`, `MAP(xs, (t) => UPPER(t))`). Under versions 1 and 2 a closure body is still a block.
- `TEXT.SERIALISE(value, "JSON")` writes any value out as text for a prompt, byte for byte the same whenever it is the same value: two-space indented JSON with keys sorted at every level, so the order fields were written in never shows. A record is its fields plus its nested nodes under their edge names, each edge always a list; dicts and lists nest as themselves; an absent value is `null`; dates are ISO text; a file is its name, type and size, never its contents. The format is written down: an unknown or computed one is refused at save (`MOV_STDLIB_ARG_INVALID`, `MOV_STDLIB_ARG_NOT_LITERAL`), as is a record read live from a system (`MOV_STDLIB_ARG_NOT_RECORD`). Nothing existing changes meaning, so no language version moves.
- `EXTRACTION_TIERS` lets a deployment choose the model and effort behind each extraction tier (`quick`, `careful`, `thorough`), as a JSON object such as `{"careful": {"model": "claude-opus-5", "effort": "medium"}}`. Unset, nothing changes: every tier is `claude-sonnet-5` at effort `low`, `high` and `xhigh`, and an extraction with no tier keeps choosing its model by how many kinds of record it reads, at effort `low`. The model is routed by `MODEL_MAP` like any other, and boot refuses a tier, field or model it cannot serve, including a model this deployment has no credentials to call.
- `MAP` and `FILTER` take a settings record between the collection and the function: `MAP(xs, { onError: "warn", concurrency: 4, initialConcurrency: 1 }, f)`. `onError` says what a member whose function fails does: `"error"` (the default) fails the run as before, `"warn"` leaves the member out of the answer and puts a warning naming it and the failure on the run's trace, and `"ignore"` leaves it out silently. A FILTER member whose predicate fails is not kept. Only the member's own failure is forgiven: a cancelled run, the call ceiling and a `match` that ends its scope behave as they always have. `concurrency` runs that many members at once; `initialConcurrency` runs a first batch of that size to the end before the rest start, so a shared prompt is cached once before the fan-out. The answer is in member order whatever order members finish in, and so is the trace. Members' writes, matches, links and deletes still happen one at a time, so two members writing the same `unique by` record make it once. Each setting is written down, not computed; an unknown key, an `onError` outside its three values, a concurrency below 1 or not whole, and a first batch wider than the rest are refused at save as `MOV_COLLECTION_OP_CONFIG`. `REDUCE`, `GROUPBY` and `KEYBY` take no settings. Without a settings record nothing changes, so the language version does not either.
- Graph literals build a local graph as a value: `graph<Message> { text: m.Body, attachment: m-[a:Attachments]-> { name: a.Name, type: a.Type, file: a.\`File\` } }`. In the modern spelling `node` only declares a shape and `graph` only builds a value; the anonymous `node { … }` literal is unchanged.
  - With a shape the literal is checked like TypeScript's `satisfies`, and the value is then of the shape. A misspelt field is `MOV_GRAPH_FIELD_UNKNOWN` (with a did-you-mean), a mistyped one `MOV_GRAPH_FIELD_TYPE`, a field where the shape has a child node (or the reverse) `MOV_GRAPH_ENTRY_KIND`, and a required field never written `MOV_GRAPH_FIELD_MISSING`. A `<T | null>` field may be left out; it is then absent and reads as `T | absent`. A shape that is not a node declaration is `MOV_GRAPH_SHAPE`.
  - `graph { … }` with no shape takes its type from the literal.
  - `graph<Shape> {}` is the typed empty graph. It is valid when the shape requires no field. Its child nodes start empty: an edge holds zero or more records, as every other structural check already reads it.
  - The body uses a write body's field syntax. `{ … }` is a child node and `[{ … }, { … }]` several. A walk followed by a field body builds one child per record on the walk. A bare walk (`attachment: m-[:Attachments]->`) copies each record: the shape says which fields and follows the source's edge of the same name for each nested node; without a shape the records' own fields are copied. A copy whose records lack a field the shape requires is `MOV_GRAPH_COPY_SHAPE`; a copy without a shape over records nothing describes is `MOV_GRAPH_COPY_UNKNOWN`.
  - Copies are snapshots. Nothing in the graph points back into the system it was read from, so a write to the graph never reaches the source. A file is copied as the handle it is, and nothing downloads.
  - `...v` converts a computed map (plugin output, JSON, a `{ … }` dict). With a shape, the shape decides whether a nested map is a child node or a value; a map nobody can type is checked against the shape when the graph is built, and the run fails naming the first field that doesn't fit. Without a shape every nested map is a child node, and a map whose keys are unknown is `MOV_GRAPH_SPREAD_UNTYPED`. Spreading something that is not a map is `MOV_GRAPH_SPREAD_NOT_MAP`. A written entry wins over a spread's key, and a later spread over an earlier one.
  - The result reads by path, `WHERE` and dot, takes `write`, `link` and `delete` as a run-local node does, is a movement's return value, and fits a parameter of its shape.
  - `graph` is recognised only as `graph {` or `graph<Name> {`, neither of which was valid before, so an instance named `graph` (`listen to graph { … }`) keeps working and no language version changes.
- A hop `WHERE` on an edge of a node the run built now filters its landings (`msg-[a:attachment WHERE a.type = "application/pdf"]->`), in a block head and in an expression. Before, the run failed with an unsupported construct. A `WHERE` on a `lazy` entry's hop still fails the run.
- Under Steady Lynx (3) a movement is called with its arguments in order, as TypeScript calls a function: `doc = email_to_doc(msg)` and `log_doc(email_to_doc(msg))` bind each argument to the parameter declared in its place. Named calls (`email_to_doc(m: msg)`) are unchanged. One call is all positional or all named: a mix is a parse error. Too few or too many arguments is `MOV_CALL_ARITY` (with `MOV_CALL_ARG_MISSING` naming what is missing), and a type mismatch names the parameter the argument binds (`for 'count' (argument 3)`). A positional invocation is a call whatever it names; when the name is a built-in, `x = UPPER(m.Subject)` is the value it computes, exactly as before (see call resolution under Changed). A plugin's arguments stay named, because its parameters have no designed order: `fetch_url("…")` is `MOV_PLUGIN_ARGS_NAMED`. Under Quiet Heron (1) and Bright Otter (2) a positional argument is still the parse error it was.
- Under Steady Lynx (3) a movement parameter can take a value rather than a record: a scalar (`<text>`, `<number>`, `<boolean>`, `<date>`, `<datetime>`, `<file>`, `<json>`), a declared refinement (`<Tone>`), a list (`<text[]>`), or a config record spelled as a TypeScript object type (`cfg: <{ mode: text, owner?: text }>`). The argument is any expression, and it is checked as TypeScript checks one: a record literal may not carry a key the parameter does not declare (with a did-you-mean), a required key may not be missing, a string literal against a refinement must be one of its values, and a value that may be absent does not fill a parameter that requires one. Inside the movement an optional key reads as possibly absent (`AT(cfg, "owner")` needs `?:` to be written). A listener cannot fire a movement whose parameter takes a value (`MOV_LISTEN_PARAM_MISMATCH`), and a callback's fire-time parameter stays a single scalar. Under versions 1 and 2 a scalar-typed movement parameter is still refused as before.
- A value passed to a parameter that takes a record (`persist(c: msg.Subject)` where `c: <Lead>`) is refused at save as `MOV_CALL_ARG_TYPE` under Steady Lynx (3). Such a call always failed when it ran (`passing a value binding as a movement argument`); now it is said where it is written. An automation pinned to version 1 or 2 keeps the run-time refusal.
- A list literal can spread a list into itself: `[m.Subject, ...m.Files, "end"]` splices the files in place, as TypeScript's `...` does, at the start, the middle or the end. Spreading something that is not a list (a text, a number, a record, a dict) is refused at save as `MOV_LIST_SPREAD_NOT_A_LIST`, and spreading a list that may be absent is `MOV_ABSENT_REQUIRED`; a value the checker cannot type that turns out not to be a list fails the run instead of splicing nothing.
- A walk read for a field can be spread into a list: `pdfs = m-[a:Attachments WHERE a.Type = "application/pdf"]->.\`File\`` then `[m.Body, ...pdfs]`, or inline `[m.Body, ...m-[a:Attachments WHERE …]->.\`File\`]`, splices one file per attachment the `WHERE` kept, and nothing when none did. Before, both were refused as `MOV_LIST_SPREAD_NOT_A_LIST`, because such a read is typed as one value of the field's type. It still is everywhere else, so a write field reading it behaves as before; only a spread now reads it as the values, as `COUNT` and `JOIN` already did. A field that itself holds a list spreads its members as before, and a `json` field is still refused, since one landing's list cannot be told apart from several landings. Nothing that validated changes, so no language version moves.
- A list literal is typed as a tuple, one slot per member, under language version 3 (**Steady Lynx**): `[m.Subject, file]` is `[text, file]`, and `AT(t, 0)` reads the first slot exactly, always present. With a spread it is a variadic tuple, `[text, ...list of file]`. Anywhere a list is expected (`MAP`, `FILTER`, `JOIN`, a list-typed field or parameter) a tuple reads as a list of its members' union, as TypeScript reads `[string, number]` as `(string | number)[]`: `[o.name, o.amount]` is a `list of (number | text)`, so `JOIN([o.name, o.amount], " ")` validates and writing it into a list of numbers is refused. A literal holding both records and values (`[company, "label"]`) is accepted as a tuple; `MOV_LIST_MIXED` fires where it is read as a list, such as `MAP(both, …)` or a write into a list field. An automation pinned to Quiet Heron (1) or Bright Otter (2) keeps the list typing it had: a literal is the list its members share, an index read off one is that type or absent, and members that share nothing read as a list nothing checks.
- A version-2 conformance corpus: the test suites as they stood before Steady Lynx run against the current code under Bright Otter (`pnpm --filter movement-lang test:conformance:v2`, `pnpm test:conformance:v2` in apps/api).
- The automations handbook documents two `unique by` forms that already worked: a component pinned to a value (`` unique by (parent, `Stage` == "Seed") ``), and a non-equality component that narrows the candidates after the lookup (`` unique by (`Name`, `Updated` WITHIN 30d) ``, with a single `unique by` clause).
- `WHATSAPP_LINK_VERIFICATION=trust` links a signed-in user's WhatsApp number as soon as they enter it, with no code sent and no authentication template needed; anyone with an account can then claim any number, so it suits a self-host serving one organisation. The default, `otp`, is unchanged, and any other value fails boot naming the variable.

### Fixed

- A `WHERE` on the final hop of a `match` or `write` target now narrows which existing records may be matched: `` match crm-[c:Companies WHERE EXISTS(c-[:Team]->)]-> { unique by (FUZZY `Name`), … } `` considers only companies with someone on their team. It used to be accepted at save and ignored at run. Each candidate the target's lookup returns is read as the record it is, the way a traversal's `WHERE` reads one (field reads, and hops such as `EXISTS(…)` or `COUNT(…)` from the candidate), and a candidate that fails is dropped before the identity is settled. A `write` whose candidates are all ruled out creates: the `WHERE` limits what may be updated, never whether to write. The save check now types the `WHERE` against the type the target lands on, and refuses it on a hop before the last (`MOV_TARGET_WHERE_NOT_FINAL`), on a `bind` write (`MOV_TARGET_WHERE_BIND`), and on an edge of a node the run built (`MOV_TARGET_WHERE_LOCAL`). This applies under every language version rather than behind a version gate: a saved `WHERE` said which records to match and was being ignored.
- A hop's `WHERE` reads the landed record through the hop's own alias as well as through a bare field: `` crm-[c:Companies WHERE c.`Categories` == "Customer"]-> `` now keeps exactly the companies that pass. The save check used to type the `WHERE` before the alias existed, so an unknown field read through it (`c.NoSuchField`) was not refused; it is now `MOV_UNKNOWN_PROPERTY`. At run time the alias was not bound while the `WHERE` was evaluated, so the hop failed with ``'c' is not in scope``. This applies to a hop heading a block, a hop inside an expression, and a hop inside `EXISTS(…)`. This applies under every language version rather than behind a version gate, like the target `WHERE` above: a saved `WHERE` that used the alias could not have run.
- A `unique by` test that is not part of the key (`WITHIN`, `!=`, a range) is honoured with several `unique by` lines: each line's test narrows the records its own key found. `` unique by (`Name`) `` plus `` unique by (`Domain`, `Updated` WITHIN 30d) `` no longer matches a stale record found by its domain. With two or more lines the test used to be dropped silently. A candidate missing a field the test reads is read in full first; a field the record still lacks fails the test, except `!=`, which it satisfies (before, such a candidate was kept whatever the test said). The save check refuses, as `MOV_UNIQUE_CONJUNCT_NEEDS_WHERE`, a test that reads anything but the candidate's own fields (a hop such as `EXISTS(…)`, a value from earlier in the run) and a `unique by` line with no key at all; the message points to a `WHERE` on the target. This applies under every language version rather than behind a version gate: each of these tests was written and then ignored.
- The WhatsApp webhook now logs a `warn` naming the cause when an inbound delivery's signature is missing or does not verify against `WHATSAPP_WEBHOOK_SECRET` (a second Meta app subscribed to the same WhatsApp Business Account, or a rotated secret), instead of a bare 401 with no explanation.
- WhatsApp deliveries whose payload contains a slash are verified over the bytes Meta signed; they were refused with a 401.
- The Save button on a portfolio company's Edit company dialog saves again. Before, clicking it did nothing: the dialog stayed open and no change reached the company.

## [v0.9.1] - 2026-09-29

### Fixed

- A path inside `EXISTS(…)` now narrows like the same path heading a block. `` EXISTS(crm-[o:Organization WHERE …]->-[le:`List Entries` WHERE `listName` == "Master Deals List" AND `Deal Created` >= cutoff]->) `` validates, and at run time it considers only that list's entries. Before, the checker refused `Deal Created` (`… has no field 'Deal Created' — it has: listName`), or said nothing described the landing, because the path inside `EXISTS` was never narrowed. This applies to an `EXISTS` rooted at a system or at a block alias, in an assignment, an `IF … THEN` or an `if` condition. Paths inside `COUNT`, `FIRST`, `ONLY` and the other aggregates already narrowed. The language version does not change. The one new refusal is one a block already gave: a field or edge the named member does not have, read later in the same `EXISTS` path.
- A field a node declaration types as `<text>` refuses a number or a yes/no, wherever the value arrives: a `node { … }` handed to a parameter typed on the declaration, a write into a collecting node's `<Entry>` entries, and a spread into one. The refusal names the repair: `TOSTRING(…)` for a number, `IF … THEN "Yes" ELSE "No" END` for a yes/no. Before, `COALESCE(e.diverse, FALSE)` typed as nothing, so `node { diverse: COALESCE(e.diverse, FALSE) }` reached a `<text>` field unchecked and the system received the text `true` or `false`. `COALESCE` now types as the kind its arguments share (`a ?? b`), and a bare `TRUE`/`FALSE` in a write field is a boolean. A system's own text field keeps the lenient write rule. This applies under every language version rather than behind a version gate: no author meant `"true"` in a text field. The one language version 1 corpus test this reaches is triaged: it used `COALESCE` as its stand-in for a call the checker cannot type.
- `<T | null>` on a node declaration field is `T | absent` wherever the declaration is used: an extraction's shape, a parameter's type, a collecting node's entries, a spread, `IS`. Before, it counted only as an extraction's shape. A collecting node filled with `?...e` holds an unfound field null at run time, yet the checker typed it present and noted `x.via != null` as always true. Now `x.via != null` is a real test and narrows the field, as it already did on an extracted record, and a system's optional field narrows the same way. A plain write of such a field into a system's field is refused until it is guarded or written with `?:` (`?...d` for a spread). A plain write into another `<T | null>` field is accepted. This applies under every language version rather than behind a version gate: the refused writes were handing a system a null where it expected a value.

## [v0.9.0] - 2026-09-29

Language version stays **Bright Otter** (2): everything here is an addition or a refusal that became an acceptance, so no saved automation changes behaviour. Highlights: `node X extends Y`, `%`, `TEXT.PAIRS`, a scheme-less `URL.HOST`, a parameter typed on a declaration accepts any record with its fields, and the editor renders multi-line strings as one block.

### Added

- `%` remainder in the formula grammar (`a % b`), same precedence as `*` and `/`, TypeScript semantics — the sign follows the dividend (`-7 % 20` is `-7`).
- `URL.HOST` accepts a scheme-less address (`acme.com`, `acme.com:8080`, `www.Acme.com/path`), not just a full URL — an email is still not a host.
- `TEXT.PAIRS(record, separator?)` renders a record or dict as `key=value` pairs joined by `separator` (default `" | "`); nested node/edge fields are skipped.

### Changed
- The handbook now says what the checker and engine already do with a value that may be missing, such as an extracted `<boolean>` or `<text | null>` field. `==` and `!=` take one on either side with no guard: a missing value equals only `null`, so `o.stage == "Seed"` is false and `!=` is true. `if`, `IF … THEN`, `AND`, `OR` and `NOT` read a missing boolean as false, so `if o.viable { … }` needs no `COALESCE`. Ordered comparisons (`<`, `<=`, `>`, `>=`) still refuse one. Before, the reference chapter said every comparison other than `== null` needed both sides present. Nothing a movement does changes, under either language version. A `WHERE` done at a source may treat a record missing the tested field differently from one done here; the query section says so.
### Added

- `node X extends Y { … }` declares a node that is every field and nested node of `Y` (with `Y`'s types, words and `order by`), then its own, like TypeScript's `interface X extends Y`. `X` goes anywhere a declaration does: an extraction's shape, a parameter's type, a collecting node's type, `IS`, a spread, `export`. Its own record-level words follow the base: `node X extends Y: "…" { … }`. The base is a node declaration in scope, declared in the file or imported, and its words and types still read the file that declared it. Refused, by name: restating a field or nested node `Y` already has, a base that is not a node declaration, and a chain that comes back round. New syntax, so no language version changes.
- A parameter typed on a node declaration (`d: <Entry>`) accepts any record carrying every field the declaration names, with a compatible type: an extracted record, a record of another declaration (an identical one, or one that `extends` it), a record built with `node { … }`, or a system's record. This is the same comparison `x IS <Entry>` makes: extra fields are fine, and a nested node never decides the fit. Before, a record that arrived typed was accepted only when it named the same declaration, so an extracted `<Entry>` record was refused by an `<Entry>` parameter. A record that does not fit is refused with a message naming the missing or mistyped field. Only refusals became acceptances, so no language version changes.

## [v0.8.5] - 2026-09-29

### Added

- The company page warns when two prices apply to the same equity on the same day, and says which one the valuation uses.
- A company acquired for shares shows the position on the acquirer's page: shares received, cost carried over, value now. Fund totals are unchanged.

### Changed

- The portfolio list loads several times faster on a large portfolio. The valuation walk and the pricing ask the database once for every company at a level instead of once per company, the list returns its totals itself instead of valuing the portfolio a second time, the "How this was calculated" panel fetches its narration when opened instead of shipping it with every row, and API responses over a kilobyte are compressed (brotli or gzip, whichever the client accepts). Every figure on the list is unchanged. Where a company has a price recorded on itself and one on its equity on the same day, the valuation now always uses the price on the company; before, which one it used could vary between loads. The company page still warns about such a pair, since only one of them can be right.

### Fixed

- A payout to a fund holding several cheques in one company is split between them by the shares each cheque held just before the event. Before, a wind-down recorded as a share return and a cash payment on the same day, or a later distribution with nothing left held, could land wholly on one cheque. Transactions on the same day are now walked in a fixed order, so a cheque's figures no longer depend on what else is on the page.
- A company created through the REST API gets a slug, so it is reachable in the app. Before, only companies created by the seed script had one.

### Changed

- An `ORDER BY` that asks for the order a source already answers in is now done at the source: no "runs here, not at the source" note, and its `LIMIT` bounds the fetch. Gmail's `Messages` answer newest first, so `ORDER BY Date DESC LIMIT 3` now costs three message requests instead of a hundred; `ORDER BY Date ASC` still fetches up to the ceiling and sorts here. Adapters declare this as a collection's natural order (`naturalOrder` on the edge capability); Gmail's `Messages` and a Slack channel's `Messages` (`Timestamp` newest first) declare one.

## [v0.8.4] - 2026-09-29

### Fixed

- The upgrade warning that an identity key may be `""` now clears where a guard proves it is not: inside `if x != "" { … }`, `if LENGTH(x) > 0 { … }` or a conjunction containing one, and below `if x == "" { ERROR(…) }`. Before, the guard the warning itself suggested did not clear it.

## [v0.8.3] - 2026-09-29

### Added

- `NUMBER.FORMAT(number, "compact" | "grouped")` writes a number out — `"compact"` abbreviates with K/M/B/T (`1200000` → `"1.2M"`), `"grouped"` adds thousands separators (`1200000` → `"1,200,000"`). `CURRENCY.FORMAT_FIGURE(number, code)`, the inverse of `CURRENCY.GET_NUMBER_FROM_FIGURE`, writes a money figure with its symbol (`"€1.2M"`) or, for a code with none, the ISO code after the amount (`"1.2M CHF"`).

### Fixed
- A walk from a record held in a name now runs: `EXISTS(company-[:Notes WHERE …]->)`, `COUNT(…)`, `ONLY(…)` and hopped reads off a `FIRST(…)` result, a `match` result, a write handle or a block's returned records. These previously saved cleanly and then failed every run with MOVENG_UNSUPPORTED; `x = match …` / `x = link …` and a call spelled `x = plugin(…)` at file scope are now refused at save instead of at run.
- `!` is negation; it used to be dropped silently, so a condition written with it ran inverted. `!x` is `NOT x` (same precedence, so `!a == b` is `NOT (a == b)`), `!!x` is double negation, and `!=` is unchanged. This applies under every language version rather than behind a version gate: a saved automation that wrote `if !EXISTS(…)` was running the opposite of what it said, and now runs what it says.
- A character an expression has no meaning for (`&`, `&&`, `|`, `||`, `?`, `;`, `%`, a backslash outside a string, an en or em dash, a curly quote, …) is refused at save with its position, instead of being skipped. `&&` and `||` point at `AND` and `OR`; a typographic dash points at `-`.
- A source-built deployment names its release `dev+<short commit>` when the host supplies the commit (`RENDER_GIT_COMMIT`, `SOURCE_COMMIT`), so the deploy check runs once per deployed commit instead of once ever under a fixed `dev`; the health endpoint reports the same name.

## [v0.8.2] - 2026-09-29

### Added

- An extraction field, inline or in a node declaration, may be annotated `<text | null>`. A text the model did not find then arrives null instead of `""`, so `EXISTS(…)`, `!= null` and a guard clause test it and narrow it, and a plain write of it needs `?:` or a guard. The prompt is unchanged. `| null` on any other type (`<number | null>`, `<Thesis | null>`) means what the type already meant. It is accepted under every language version. `<null>` alone, a second `|`, and `| null` anywhere other than a field annotation are refused. The refusal of a null test on plain extracted text now names this annotation as the first fix.

### Fixed

- On Render the pre-deploy is one package script, `pnpm deploy:render-pre`; the previous two-command line was not run through a shell, so the deploy check never ran. Set the service's pre-deploy command to the new script. The expanded database URL also stops appearing in the deploy log.
- The audit-trigger check (CI's "Missing audit log triggers" step) was red since v0.8.0: the two tables it added, `automations.system_event` and `automations.deploy_check`, are system-written and only ever inserted, the same shape as `trigger_event` / `trigger_run`, so they now carry that same exemption instead of a needless audit trigger. No migration; `check_database_triggers.sh` also now prints which tables it flags.

## [v0.8.1] - 2026-09-29

### Changed

- The automations list's column is **Version**, and the version name renders as a monospace tag on the list and the automation page.

### Fixed

- The `migrate` one-shot carries every variable the api derives (the OAuth redirect origin among them), so the deploy check it runs can load. On v0.8.0 a missing one crashed the check and blocked the api from starting after the upgrade.
- Two integration tests: a saved run version is written with its language version; an automation source spells `Invocation` as the manual adapter does.

- The deploy check no longer keeps an automation on its older language version over a routine cost note (`WHERE on '…' runs here, not at the source`, `ORDER BY on '…' runs here`). An automation now moves up when the newer version reports no errors and nothing whose meaning changed between the versions; other warnings are printed as notes in the summary and never block. Only what blocks is stored, so the **Review** badge and `upgradeDiagnostics` mean there is something to look at. `upgradeAutomation` applies the same rule.
- `up.sh` never exits silently. When `docker compose up` fails it names the failed service, prints its log (the whole run for a one-shot such as `migrate`, the last 30 lines otherwise), and says which version the installation is still on, pointing at `deploy/UPGRADING.md`, Rolling back. It also no longer dies without a word on a machine where nothing is running yet.

## [v0.8.0] - 2026-09-29

Language versions arrive. Every automation is pinned to the language version it was written against and keeps that behaviour on every later release; a breaking change is delivered behind a version conditional and reaches an automation only when it is upgraded. Version 1 is **Quiet Heron**, the language as of v0.6.0. Version 2 is **Bright Otter**, the language as of v0.7.0 and after. Every automation saved before this release is pinned to Quiet Heron, so the v0.7.0 breaking changes below no longer apply to it until it is upgraded.

### Added

- Each automation carries a language version (name and number). `listAutomations` / `getAutomation` return `languageVersion`, `checkedAgainst` and, when an upgrade would not be clean, `upgradeDiagnostics`. The automations list shows the version with a **Review** badge when there is something to look at; the automation page lists the diagnostics.
- The deploy check: on every release the `migrate` step (Render: the pre-deploy command) re-validates every automation under its own version, then under the current one. A clean result moves the automation forward; anything else keeps it where it is and records why. `up.sh` prints the summary (advanced / to review / refused, by name); `pnpm deploy:check --summary` prints it again.
- `upgradeAutomation { automation, acknowledge }` (MCP): validates under the current version, returns the diagnostics, and moves the pin only on an acknowledged clean result. The editor and `validateAutomation` check a saved automation under its own version.
- An automation on a version a release no longer supports is refused to run, loudly, and named in the summary; on a deprecated version it runs with a warning.
- A `system` adapter, the platform as a system: `listen to sys { events: ["Run Failed"] }` fires when an automation's run fails; `Validation Issue`, `Deprecated Version` and `Release Applied` fire from the deploy check. Records carry the automation, the run, the version, the reason and a link; an automation never receives its own failure.
- A version-1 conformance corpus: the v0.6.0 test suites run against the current code under Quiet Heron (`pnpm --filter movement-lang test:conformance:v1`, `pnpm test:conformance:v1` in apps/api). Removing a version is deleting its conditionals and its corpus.
- Under an upgrade check only, two new warnings mark constructs whose meaning changed between versions: a direct plugin call whose output changed shape, and a `unique by` key that may be empty text.
- The agent dev loop (`pnpm dev:loop:agent`) runs its own Postgres and Redis (project `listen-fire-dev-agent`, ports 9434 and 6381) so it coexists with another stack on the shared ports.

### Changed

- The v0.7.0 breaking changes are now conditional on Bright Otter. Why each was made: `vc_url_retrieval` as a list — one string of all pages hid which page a fact came from, and a list lets `FIRST` and `_resources` keep the file; extracted text always present — every description already promised "empty otherwise", and `COALESCE` on every read was the cost of the type disagreeing; null tests on extracted text refused — with text always present they were always true, a silent bug; annotation required into typed fields — an unannotated field asks the model for words, and a number field given words failed at the adapter instead of at save; unknown type names refused — a typo silently became text with no option set; empty key is no key — an empty name matched every other empty name, merging unrelated records.


## [v0.7.0] - 2026-09-28

### Breaking

- `vc_url_retrieval` called on its own returns a list of records, one per fetched link (`name`, `url`, `file`, `text`), instead of one string of all the page text. Hold one first, then read its fields: `deck = FIRST(linked)`, then `deck.text`.
- A null test (`EXISTS`, `ISNULL`, `== null`, `!= null`) on an extracted text field is refused. Extracted text is always present — `""` when nothing was found — so test emptiness with `!= ""` instead.
- An extracted field written into a `number`, `date`, `boolean` or file field is refused until the field is annotated with that type.
- An unknown type name on a declared node's field is refused; it used to read silently as text.
- An empty `unique by` key component is treated as no key, and never matches.

### Added

- `match`: finds a record by identity without writing it. Same body and targets as `write` (`unique by` clauses plus asserted fields). A hit binds the record; a miss ends the enclosing scope quietly; used unbound it is a gate.
- `link` takes a match body as sugar for `match` then `link`; a body with no `unique by` identifies by all its fields.
- `FUZZY` is declared per field. The checker refuses `FUZZY` on a field the target does not list, and names the fields it does.
- Valuations Legal Entity resolves `unique by` by identity, with fuzzy matching on Name, Legal Name, Also Known As and Other Names.
- Files a `through` plugin fetched land on the extracted record's `_resources`, so the usual attach pattern puts them on any record with a file field.
- A record held in a variable (`deck = FIRST(pages)`) reads by field.
- `labels` listen option on a Gmail listener (default `["INBOX"]`) watches labels beyond the inbox, e.g. `["INBOX", "SPAM"]`.
- A node declaration can describe itself, each field and each nested node, and an extraction reuses it with `node entry: <Entry>` instead of repeating the shape inline.
- A write body can spread a record with `...e` / `?...e` — an extracted record, a declared parameter, or a record built in memory — writing each of its fields as a plain line.
- A dict literal is typed by its keys: `AT(d, "k")` on a key the literal wrote down reads that key's own type, present; an unknown key is refused with a did-you-mean.
- `AT(list, n)` reads a list by position. Like `FIRST`, it needs an ordered list and may miss.
- A `MAP` closure may run with no `return`, for its writes alone; a bare `MAP(...)` (and `FILTER`/`REDUCE`/`GROUPBY`/`KEYBY`) can run as a statement with no binding.
- `URL.HOST(text)` reads the lowercased host out of a link.
- Unary minus (`-x`) in formulas.
- A guard (`EXISTS(x.f)`, `x.f != null`, `NOT ISNULL(x.f)`) narrows a typed extracted field to present inside its arm.
- A field refused on a narrowable type (a hop landing on more than one member of a polymorphic type) names the narrowing test that admits it.
- The editor tints strings, so a multi-line prompt reads as text.

### Changed

- The handbook looks a single record up with `ONLY` and a guard (`x = ONLY(…)` then `if x == null { ERROR("…") }`) wherever one record is expected; a nested hop is for fanning out over many. Examples across the chapters and adapter sections follow it.
- The Bright Data SERP provider waits up to 90 s per request and retries a 429, a 5xx (including one reported only in `x-brd-status-code`), a timeout or an empty body, up to three attempts.
- A refusal from Google Custom Search is logged with its reason and fails the search, instead of reading as "no results".
- Website identity ignores scheme, `www.`, trailing slash and case.
- A Gmail poll reads every history page and holds an arrival the search has not indexed yet for 15 minutes, instead of dropping it.
- An imported declaration's refinements resolve in the library that declared it, instead of the importing file's own types.

### Fixed

- A PDF reached through a link is read from its own text layer before OCR, and is kept (with empty text and a warning) when no text can be read; it was sent straight to OCR and dropped when OCR was not configured. Any fetched document with no readable text is now kept rather than discarded.
- A write whose identity candidates were filtered could bind or update the wrong record.
- A valuations write with `unique by` created a new row every time instead of finding the existing one.
- `?:` on a valuations record now sees an existing value; a create no longer sends explicit nulls.
- An awaited `WHERE` stops at its first false condition, instead of reading every field it names off a candidate that already failed an earlier one.
- An extracted text field that finds nothing arrives as `""` instead of absent.

### Operator notes

- A deploy applies migration `20260928_123442_legal_entity_name_trigram.sql` (trigram indexes on legal entity names).
- Google has closed the Custom Search JSON API to new customers. New installations should set `WEB_SEARCH_PROVIDER=brightdata` with `BRIGHT_DATA_ACCESS_TOKEN` and `BRIGHT_DATA_SERP_ZONE`.

## [v0.6.2] - 2026-09-25

### Added

- Each run shows its model cost in the run history and the run detail, and on the MCP tools `listRuns`, `checkRun` and `inspectRun`.

## [v0.6.1] - 2026-09-25

### Changed

- `up.sh` refuses to start when the image store's disk has too little free space (`--no-space-check` skips this), and prunes older images after a healthy start, keeping one rollback tag in `LISTEN_FIRE_PREVIOUS_VERSION` (`--keep-images` skips this).
- The boot warning about a missing model key follows `MODEL_MAP`, so a deployment served entirely through a mapped provider is no longer warned.

## [v0.6.0] - 2026-09-25

### Breaking

- `MODEL_MAP` replaces `MODEL_ROUTE`, `ANTHROPIC_MODEL_ROUTE`, `OPENAI_MODEL_ROUTE` and `KNOWLEDGE_AGENT_PROVIDER`, which are no longer read. The map is a JSON object from a model name the product uses to `provider/wire-model`, with provider `anthropic`, `vertex`, `openai` or `gemini`. A deployment that set `MODEL_ROUTE=google` needs one of the Google maps in [`deploy/SELF_HOSTING.md`](deploy/SELF_HOSTING.md) before upgrading. Boot refuses a map it cannot serve.
- With no map set, the system, movement and ontology agents run on Claude (`claude-sonnet-5`) instead of GPT. Map `claude-sonnet-5` to `openai/gpt-5` to keep them on GPT.
- Image generation uses `gpt-image-1` on OpenAI (DALL-E 3 was shut down). Map `gpt-image-1` to a Gemini image model to keep Gemini images; a map naming `dall-e-3` is refused.
- `OPENAI_API_KEY` alone no longer powers the agents; every chat call names a Claude model, so it needs a map sending those names to `openai`.
- A team's own model key is no longer used; every call uses the deployment's credentials.

### Added

- Gemini as a native chat provider, and transcription, embeddings and image generation routed through the same map.
- Research running on `openai` or `gemini` answers its searches through the deployment's own web search service.
- `GEMINI_BASE_URL` points Gemini calls at a stand-in service, for testing.
- Prices for Fable 5.1, Opus 4.6, undated Haiku 4.5 and `gpt-image-1`.

### Fixed

- Sonnet 5 is priced at $2/$10 per million tokens; dated Haiku 4.5 is priced as Haiku 4.5.
- Gemini image generation is addressed in `GOOGLE_MODEL_REGION`, not the OCR location.

### Operator notes

- A deploy applies migration `20260924_212525_llm_usage_preferred_model.sql`. Usage rows name the provider that served each call, the wire model, and the model name the product asked for.
- Moving an embedding model to another vendor means re-embedding stored vectors; boot refuses an embedding model narrower than its column.

## [v0.5.0] - 2026-09-24

### Added

- A Gmail mailbox is connected by signing in as it. `GMAIL_CONNECT_METHOD` is `oauth` (the default) or `delegated`. The sign-in uses the Sheets and Drive OAuth client unless `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` are set.
- The Gmail connect form also accepts a pasted refresh token.
- `GMAIL_SEND_ENABLED=true` makes the sign-in ask for the send scope; without it, a signed-in mailbox is read-only.
- A team manages its own members from settings: grant and revoke access, add people directly, create service accounts, and edit the team's name, email and phone.

### Changed

- `GMAIL_MAILBOX_ALLOWLIST` is optional under `oauth`. It is still enforced when set, and still required under `delegated`.
- The dashboard is the landing page and settings sit inside the app shell. The separate onboarding flow is gone.

### Operator notes

- Existing delegated mailboxes keep working unchanged. Set `GMAIL_CONNECT_METHOD=delegated` to keep offering the delegated form for new connections.
- To use sign-in, add `<web origin>/gmail/callback` to the OAuth client's redirect URIs and list `gmail.readonly` (plus `gmail.send` if sending) on its consent screen. An Internal consent screen avoids Google's restricted-scope review.

## [v0.4.0] - 2026-09-24

### Breaking

- The Gmail connector refuses every mailbox not listed in `GMAIL_MAILBOX_ALLOWLIST` (comma separated, case insensitive). Installations already using Gmail must set it before upgrading, or their mailbox stops working.

### Added

- `ANTHROPIC_MODEL_ROUTE` and `OPENAI_MODEL_ROUTE` route each vendor separately (`direct` or `google`), overriding `MODEL_ROUTE`.
- `OPENAI_ORGANIZATION` sets the OpenAI organisation; unset, OpenAI bills the key's default organisation.

### Changed

- The Gmail send scope is optional: a read-only mailbox runs on arrival and can be searched, and a send says it lacks the scope.
- The in-app Gmail credential form checks the mailbox with Google before saving.

## [v0.3.0] - 2026-09-22

### Breaking

- The per-user Gmail sign-in is removed, with `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`. Credentials from it no longer work; connect the mailbox again through the new connector.

### Added

- `gmail` adapter: one mailbox per connection, reached through Google domain wide delegation. Automations can run when mail arrives (polled about once a minute), search it with `where`, read attachments, and send or reply as it. A write along the mailbox's `Messages` edge sends new mail; one along a message's `Replies` edge replies.

## [v0.2.0] - 2026-09-21

### Added

- `READ(file)` returns a file's text. `CHUNKS(text, { size, overlap })` or `CHUNKS(text, { entities })` cuts a text into pieces.
- A plugin can be called on its own (`page = fetch_url(url: c.website)`); every bundled plugin declares what it returns, so the result is typed.
- A `write` into a local node builds or merges by identity, like a write into a system.
- `order by arrival`, `document` or `chronological` on a local node's entry, or after a nested declared node, keeps its order for `FIRST`, `JOIN` and `LIMIT`.
- Records are values: lists and maps can hold them, and `MAP` returns what its closure returns.
- A block can start from a list of records or from an expression that ends in one (`AT(rows, 0)-[c:company]-> { … }`).
- `research` plugin: web research on a record, resolving one that arrived with only a name.
- `dealroom` adapter: read-only companies, investors, people and funding rounds.
- Web search through Bright Data's SERP API (`WEB_SEARCH_PROVIDER=brightdata`), and a page reader of the product's own where the model host has none.
- `MODEL_ROUTE=google` sends every model call through one Google Cloud project and service account.
- An optional external judge for duplicate detection (`JEV_KEY` with `JEV_ENTITY_RESOLUTION=true`).
- Born-digital PDFs are read from their text layer without an OCR service.
- Handbook: reading and chunking files, local node writes, and enrichment as plain plugin calls followed by a second extraction.

### Changed

- A lone fuzzy duplicate candidate goes to the judge; a fuzzy value equal outright is an exact match; a bare domain name no longer matches every other domain.
- An extraction's output ceiling follows its effort; a turn that runs out steps down once, then fails with a clear error. A continued answer shows as a warning on the run.
- A narrowed polymorphic hop lands only the member it narrowed to.
- Affinity requests are cached per run.
- The checker flags a field declared twice in one extract stage, a closure in an expression slot, and a hop off a value.

### Fixed

- `${…}` in an extract field or node description is interpolated.
- Scheduled runs run as their team, so fetches inside them work.
- A file or page a run could not read says so on the run.
- One large source file can no longer crowd the rest out of an extraction prompt.
- The valuations MCP connector lists its tools again.

### Operator notes

- A deploy applies migration `001_add_dealroom_external_service_type.sql`.
- New optional settings: `MODEL_ROUTE`, `GOOGLE_MODEL_REGION`, `KNOWLEDGE_AGENT_PROVIDER`, `WEB_SEARCH_PROVIDER`, `BRIGHT_DATA_ACCESS_TOKEN`, `BRIGHT_DATA_SERP_ZONE`, `BRIGHT_DATA_UNLOCKER_ZONE`, `EXTRACTION_FILE_CHARS`, `MAX_PDF_BUFFER_BYTES`, `JEV_KEY`, `JEV_ENTITY_RESOLUTION`.
- With `MODEL_ROUTE=google`, boot refuses a leftover vendor model key.

## [v0.1.2] - 2026-09-10

### Changed

- The bundled Postgres and Redis restart with the machine.
- `up.sh` supplies base URLs and ports as defaults that `.env` overrides; `LISTEN_FIRE_BIND` binds to one address, for installations behind a reverse proxy.
- A missing model key warns at boot instead of refusing to start.
- The published web image shows the Google and Microsoft sign-in buttons without a rebuild; client ids come from the api at runtime.
- A magic link has one expiry, and an expired link says so. A core installation prints its first sign-in link.

## [v0.1.1] - 2026-09-10

### Fixed

- Each migration applies in one transaction with its ledger row, so a failure leaves nothing half built. The runner creates the `agent` and `readonly` database roles itself when it may, and otherwise stops and names the file to run.

## [v0.1.0] - 2026-09-09

### Added

- First public release: five units (`core`, `knowledge`, `automations`, `valuations`, `asks`), the movement language and its handbook, and the adapters listed in the README.
- Tagged releases publish `api`, `web`, `admin` and `fake-channels` images to `ghcr.io/listen-fire` for amd64 and arm64.
- `LISTEN_FIRE_VERSION` pins an installation to a tag; `up.sh --build` builds from source instead.
- Each bundled datastore steps aside when an external one is configured.
- The running version shows at `/healthz/workers` and under Settings, About.
- Self-hosting guides for compose, Render, AWS and a GCP VM, and an upgrade runbook.

[Unreleased]: https://github.com/listen-fire/listen-fire/compare/v0.9.1...HEAD
[v0.9.1]: https://github.com/listen-fire/listen-fire/compare/v0.9.0...v0.9.1
[v0.9.0]: https://github.com/listen-fire/listen-fire/compare/v0.8.5...v0.9.0
[v0.8.5]: https://github.com/listen-fire/listen-fire/compare/v0.8.4...v0.8.5
[v0.8.4]: https://github.com/listen-fire/listen-fire/compare/v0.8.3...v0.8.4
[v0.8.3]: https://github.com/listen-fire/listen-fire/compare/v0.8.2...v0.8.3
[v0.8.2]: https://github.com/listen-fire/listen-fire/compare/v0.8.1...v0.8.2
[v0.8.1]: https://github.com/listen-fire/listen-fire/compare/v0.8.0...v0.8.1
[v0.8.0]: https://github.com/listen-fire/listen-fire/compare/v0.7.0...v0.8.0
[v0.7.0]: https://github.com/listen-fire/listen-fire/compare/v0.6.2...v0.7.0
[v0.6.2]: https://github.com/listen-fire/listen-fire/compare/v0.6.1...v0.6.2
[v0.6.1]: https://github.com/listen-fire/listen-fire/compare/v0.6.0...v0.6.1
[v0.6.0]: https://github.com/listen-fire/listen-fire/compare/v0.5.0...v0.6.0
[v0.5.0]: https://github.com/listen-fire/listen-fire/compare/v0.4.0...v0.5.0
[v0.4.0]: https://github.com/listen-fire/listen-fire/compare/v0.3.0...v0.4.0
[v0.3.0]: https://github.com/listen-fire/listen-fire/compare/v0.2.0...v0.3.0
[v0.2.0]: https://github.com/listen-fire/listen-fire/compare/v0.1.2...v0.2.0
[v0.1.2]: https://github.com/listen-fire/listen-fire/compare/v0.1.1...v0.1.2
[v0.1.1]: https://github.com/listen-fire/listen-fire/compare/v0.1.0...v0.1.1
[v0.1.0]: https://github.com/listen-fire/listen-fire/releases/tag/v0.1.0
