// Parser for the data-movement language statement layer.
// Spec: plans/2026-06-10-data-movement-language/3_syntax_sketch.md; design notes in PLAN.md (M1).
//
// Hand-rolled, line-oriented recursive descent. Statements and `field: expr` entries are
// newline-terminated; termination is suspended inside unbalanced ( ) [ ] { }, inside
// double-quoted strings (which may span newlines and carry ${…} interpolation), and inside
// backtick-quoted names. `#` starts a comment to end of line, outside strings/backticks.
// Expression positions are NOT parsed here — they are captured verbatim as ExprSlot spans
// for the expression bridge (existing formula grammar).

import {
  BindClause,
  BlockStatement,
  CallArg,
  CallStatement,
  ConstructionCall,
  DeleteStatement,
  DurationLiteral,
  ErrorStatement,
  ExprSlot,
  ExtractExpression,
  ExtractField,
  ExtractNode,
  ExtractStage,
  FieldEntry,
  IfStatement,
  ImportSource,
  ImportStatement,
  ImportedName,
  LinkExpression,
  LinkStatement,
  ListenDeclaration,
  Loc,
  CallbackExpression,
  CallbackSubject,
  LazyTraversal,
  MovementDeclaration,
  MovementParam,
  NamedArg,
  NodeEntry,
  NodeLiteral,
  PathHead,
  PluginCall,
  Program,
  RValue,
  ShapeDeclaration,
  ShapeNode,
  AwaitExpression,
  AwaitStatement,
  CombinatorExpression,
  CombinatorArms,
  CollectionOp,
  CollectionOpExpression,
  MembersExpression,
  CombinatorStatement,
  ArmExpression,
  RefreshStatement,
  UntilCondition,
  ClosureExpression,
  InlineBlockExpression,
  ReturnStatement,
  Span,
  Statement,
  TraversalBlock,
  TypeRef,
  TypeDeclaration,
  UniqueClause,
  UnlinkStatement,
  WriteExpression,
  WriteTarget,
} from './ast';
import { scanBacktickName, scanIdent, scanName } from './scan';

/** The two spellings of a movement declaration — `function` is a pure parser
 *  alias, so this is a surface fact only; the AST keeps one node kind. */
type MovementKeyword = 'movement' | 'function';

/** The statement forms that ACT. None of them is an expression, so none can
 *  appear as a node-literal entry — this list exists to say that by name
 *  (a node literal is effect-free) rather than by syntax error. */
const NODE_ENTRY_EFFECTS = new Set(['write', 'link', 'unlink', 'delete', 'extract', 'await', 'race', 'parallel', 'callback']);

/** `lazy` and `await` are duals in one slot, and composing them is nonsense —
 *  one of them has to happen first, and neither answer is a thing to mean. */
const LAZY_AWAIT =
  "'lazy await' can't be both: 'await' waits for the edge to resolve and continues the run there, 'lazy' waits to look until something reads. Pick the one you meant";

export class MovementParseError extends Error {
  readonly loc: Loc;

  constructor(message: string, loc: Loc) {
    super(`${message} (line ${loc.line}, col ${loc.col})`);
    this.name = 'MovementParseError';
    this.loc = loc;
  }
}

export function parseProgram(source: string): Program {
  return new Parser(source).parseProgram();
}

/**
 * The bare name a WHERE-less single hop lands on (`-[:company]->`; an alias is
 * tolerated), or undefined for anything pinned or longer. This is the same
 * judgement the checker's address reading makes (`eventAddressKey`: no pins ⇒
 * the bare event name) — an unpinned address IS the name.
 */
const UNPINNED_HOP = /^-\[\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*)?:\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\]->$/;

function unpinnedHopName(hopRaw: string): string | undefined {
  const match = UNPINNED_HOP.exec(hopRaw.trim());
  if (!match) return undefined;
  const name = match[1];
  return name.startsWith('`') ? name.slice(1, -1) : name;
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

// `?:` is EXCLUSIVELY the per-field set-if-empty write marker (parsed only in a
// write body's operator ladder). Anywhere else — an expression slot or a bare
// statement — it is a mistaken Kotlin/Groovy Elvis, so name the real semantics
// and the two constructs people actually reach for instead of leaving them with
// a generic "unexpected '?'" or a downstream expression-parse failure.
const ELVIS_MISUSE =
  "`?:` is the set-if-empty write-field marker (`Field ?: value`), only valid inside a write body — for a value fallback use `COALESCE(a, b)`; to branch, use an `if` block";

// The `ask` STATEMENT (and its `(link:)` delivery block and `fallback` rungs)
// was replaced by the ask adapter: an author now constructs `ask()` like any
// adapter, writes the question along a family edge, and `await`s the record's
// `Response`. `ask` is otherwise an ordinary name now — only the old
// CONSTRUCTION shape (`ask <Kind><…> { … }`) and a stray `fallback` rung are
// rejected, each with a pointer to the new form (the `?:` Elvis precedent).
const ASK_STATEMENT_REPLACED =
  'the `ask` statement was replaced by the ask adapter — construct `ask()`, write the question along a family edge (Check / Provide / Choose / Select / Review / Correct / Draft / Form), then `await` its Response:  asks = ask(); q = write asks-[:Check]-> { Prompt: "Ship it?" }; answer = await q-[:Response]->.  For a timeout or escalation, `race` the await against `await sleep(…)` (and a re-delivery branch); the delivery link is the record\'s readable `Url` field.';

const FALLBACK_RUNG_REPLACED =
  'a `fallback` rung has no meaning without an `ask` statement, and `ask` was replaced by the ask adapter — express a timeout or escalation by `race`-ing the `await` of the ask\'s Response against `await sleep(…)` (a losing branch may re-deliver or `ERROR("…")`):  race({ answer = await q-[:Response]-> }, { await sleep(4h); write …re-deliver… }).';

// The `sleep <duration>` STATEMENT was replaced by `await sleep(<duration>)` —
// one way to wait, matching every other wake source (`await <edge>`, `await
// until(…)`). The engine machinery is unchanged (the same durable timer park);
// only the surface spelling moved into the `await` expression family.
const SLEEP_STATEMENT_REPLACED =
  'the `sleep` statement was replaced — await it as an expression: `await sleep(4h)`; as a race arm: `await race([q, () => { await sleep(4h) }])`.';

// The concurrency statement forms went with naming-is-exporting (core calculus
// v2 R5): a `parallel { … }` block exported its arms' bindings by name, and a
// `race({ … }, { … })` exported a receipt of them. One construct replaces both
// — an EXPRESSION over function-valued arms, whose value is a positional
// receipt read by slot.
const PARALLEL_BLOCK_RETIRED =
  'the `parallel { … }` block was replaced by the parallel combinator, which takes its arms as functions and hands back one slot per arm: `r = await parallel([() => { … }, () => { … }])`. An arm that only acts needs no binding: `await parallel([() => { … }, () => { … }])`.';

const RACE_BRANCHES_RETIRED =
  'a race takes FUNCTIONS, not brace branches: `r = await race([q, () => { await sleep(4h) }])`. The value is one slot per arm, in the order written — the winner\'s slot holds what its function returned and every other slot is null, so a timeout is `AT(r, 1) != null`.';

// `all` is gone as a name: parallel implies all, all does not imply parallel.
const ALL_RETIRED =
  '`all` was replaced by `parallel` — parallel implies all, and all does not imply parallel: `r = await parallel([f, g])`.';

/** `until` takes a boolean condition and a NAMED cadence. The positional
 *  comparand it once took is not a slot any more — it is an equality inside
 *  the condition, where every other comparison already lives. */
const UNTIL_CADENCE_IS_NAMED =
  "'until' takes its cadence by name: `await until(<condition>, every: 5m)`. There is no second positional argument — a value to wait FOR is an equality in the condition itself (`await until(a.state == \"done\", every: 5m)`).";

/** The inline-block expression is retired with the rest of naming-is-exporting:
 *  a body hands its value back with `return`, and a body you want to run later
 *  is a closure. Still parsed, so the refusal can name the replacement. */
const INLINE_BLOCK_REPLACED =
  "an inline block read by one of its bindings (`{ … }.name`) is retired — a body hands its value back with `return`. Bind the value directly, or write a closure (`() => { … return <value> }`) where the body should run later.";

/** A declared type is a REFINEMENT of text — a closed set of the values a field
 *  may hold — so every member is written as text, exactly as it would arrive
 *  from the live option list a borrowed type reads. */
const typeValuesAreText = (name: string): string =>
  `'${name}' is a refinement of text, so each of its values is written as text: \`type ${name} = <"A" | "B">\`. To type a field as a number or a date, annotate it with that type directly (\`<number>\`, \`<date>\`).`;

/** Spec examples elide statement bodies with a bare ellipsis; accept it as a no-op. */
const ELISION = '…';

interface ScanOptions {
  /** Characters that end the scan when encountered at top level (not consumed). */
  stops: string;
  /** Allow the scan to end at end-of-file (only when nothing is left open). */
  allowEof?: boolean;
  /** Recognise `#`-comments at top level (off inside traversal-hop interiors). */
  comments?: boolean;
  /** Prose for error messages, e.g. "the 'if' condition". */
  context: string;
}

class Parser {
  private pos = 0;
  private readonly lineStarts: number[];

  constructor(private readonly src: string) {
    this.lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  parseProgram(): Program {
    const statements: Statement[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) return { statements };
      if (this.peekCh() === ELISION) {
        this.pos++;
        continue;
      }
      statements.push(this.parseStatement());
    }
  }

  // ── Source primitives ──

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peekCh(offset = 0): string | undefined {
    return this.src[this.pos + offset];
  }

  private startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  private locAt(offset: number): Loc {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo] + 1 };
  }

  private spanFrom(start: number, end = this.pos): Span {
    return { start: this.locAt(start), end: this.locAt(end) };
  }

  private error(message: string, offset = this.pos): never {
    throw new MovementParseError(message, this.locAt(offset));
  }

  private describeHere(): string {
    if (this.eof()) return 'end of file';
    const c = this.peekCh();
    if (c === '\n') return 'end of line';
    const id = this.peekIdent();
    if (id) return `'${id}'`;
    return `'${c}'`;
  }

  /** Spaces, tabs, and `#`-comments — never crosses a newline. */
  private skipInlineWs(): void {
    for (;;) {
      const c = this.peekCh();
      if (c === ' ' || c === '\t' || c === '\r') this.pos++;
      else if (c === '#') {
        while (!this.eof() && this.peekCh() !== '\n') this.pos++;
      } else break;
    }
  }

  /** All whitespace including newlines, plus `#`-comments. */
  private skipAllWs(): void {
    for (;;) {
      const c = this.peekCh();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.pos++;
      else if (c === '#') {
        while (!this.eof() && this.peekCh() !== '\n') this.pos++;
      } else break;
    }
  }

  private peekIdent(): string | undefined {
    return scanIdent(this.src, this.pos)?.name;
  }

  private readIdent(what: string): string {
    const id = this.peekIdent();
    if (!id) this.error(`Expected ${what}, found ${this.describeHere()}`);
    this.pos += id.length;
    return id;
  }

  /**
   * A NAME — the verbatim name the adapter / ontology exposes. A bare
   * identifier (`companies`) when the exposed name is identifier-safe;
   * backtick-quoted (`` `Funding Round` ``) when it carries spaces or
   * punctuation. Used everywhere a type / edge / collection / node name
   * is written (no sanitization — the program text is the adapter's own
   * vocabulary), mirroring the backtick mechanism property reads already
   * use. Returns the name verbatim (backticks stripped).
   */
  private readName(what: string): string {
    if (this.peekCh() === '`') return this.readBacktickName();
    return this.readIdent(what);
  }

  private tryConsume(text: string): boolean {
    if (this.startsWith(text)) {
      this.pos += text.length;
      return true;
    }
    return false;
  }

  private expect(text: string, context: string): void {
    if (!this.tryConsume(text)) {
      this.error(`Expected '${text}' ${context}, found ${this.describeHere()}`);
    }
  }

  private expectWord(word: string, context: string): void {
    if (this.peekIdent() !== word) {
      this.error(`Expected '${word}' ${context}, found ${this.describeHere()}`);
    }
    this.pos += word.length;
  }

  /**
   * One dotted identifier path (`crm`, `inbox.message`,
   * `crm.companies.funding_stage`) — the interior spelling of every type.
   */
  private readDottedPath(what: string): string {
    let path = this.readName(what);
    while (this.peekCh() === '.') {
      this.pos++;
      path += `.${this.readName(`a path segment after '${path}.'`)}`;
    }
    return path;
  }

  /**
   * A type slot: types ALWAYS wear angle brackets (`<number>`, `<company>`,
   * `<at-[:\`Record Change\`]->>`) — positions, scalars, and handles never
   * do. A bare spelling errors with the bracketed fix-it so the repair loop
   * lands on the fix instantly.
   *
   * THE DOTTED FORM IS RETIRED FOR EDGES: `.` reads a PROPERTY, `-[:…]->`
   * walks an EDGE, and `<inst.Type>` spelled a meta-edge target with property
   * syntax. It now parse-errors with the exact address replacement
   * (`<inst-[:\`Type\`]->>`); a borrowed field path hops the middle and keeps
   * the dotted tail (`<crm-[:companies]->.\`funding_stage\`>`).
   *
   */
  private readTypeMarker(
    context: string,
    options: { allowHops?: boolean; allowFieldTail?: boolean } = {},
  ): { text: string; hopsRaw?: string; position?: string; span: Span } {
    const start = this.pos;
    if (this.peekCh() !== '<') {
      if (this.peekIdent()) {
        this.readDottedPath('a type');
        const raw = this.src.slice(start, this.pos);
        const segments = raw.split('.');
        if (segments.length === 1) {
          this.error(
            `Types are written in angle brackets — wrap the type in angle brackets: <${raw}>`,
            start,
          );
        }
        // A bare DOTTED spelling has two fixes stacked (brackets, and the
        // retired dot-for-an-edge) — the fix-it lands on the valid spelling
        // in one hop rather than bouncing through the retired one.
        const tail = segments
          .slice(2)
          .map(segment => `.${segment.startsWith('\`') ? segment : `\`${segment}\``}`)
          .join('');
        this.error(
          `Types are written in angle brackets, and '.' reads a property — write it as: <${segments[0]}-[:${segments[1]}]->${tail}>`,
          start,
        );
      }
      this.error(`Expected a type in angle brackets ${context}, found ${this.describeHere()}`);
    }
    this.pos++; // '<'
    this.skipInlineWs();
    const rootStart = this.pos;
    const root = this.readName(`a type name inside '<…>' ${context}`);
    if (this.peekCh() === '.') {
      this.reportRetiredDottedType(root, this.src.slice(rootStart, this.pos), start, options);
    }
    this.skipInlineWs();
    if (this.startsHop()) {
      if (options.allowFieldTail === true) {
        const text = this.readBorrowedFieldTail(root, context);
        this.expect('>', `to close the type '<${root}-[:…]->.…'`);
        return { text, span: this.spanFrom(start) };
      }
      const { hopsRaw, position } = this.readTypeAddressHops(root, context, options);
      this.expect('>', `to close the type '<${root}'`);
      return {
        text: root,
        hopsRaw,
        ...(position !== undefined ? { position } : {}),
        span: this.spanFrom(start),
      };
    }
    this.expect('>', `to close the type '<${root}'`);
    return { text: root, span: this.spanFrom(start) };
  }

  /**
   * The retired `<inst.Type>` / `<inst.root.field>` spelling: a parse error
   * carrying the exact replacement for what the author wrote. The fix-it is
   * the author's upgrade tool — segment spellings are preserved verbatim
   * (backticks kept where the author wrote them; a bare hop stays bare, the
   * property tail keeps the backticks properties canonically wear).
   */
  private reportRetiredDottedType(
    root: string,
    rootRaw: string,
    markerStart: number,
    options: { allowHops?: boolean; allowFieldTail?: boolean },
  ): never {
    const rawSegments: string[] = [rootRaw];
    while (this.peekCh() === '.') {
      this.pos++;
      const segmentStart = this.pos;
      this.readName(`a path segment after '.'`);
      rawSegments.push(this.src.slice(segmentStart, this.pos));
    }
    const wrote = `<${rawSegments.join('.')}>`;
    const backtickedTail = (raw: string): string => (raw.startsWith('`') ? raw : `\`${raw}\``);
    if (rawSegments.length === 2) {
      const address = `<${root}-[:${rawSegments[1]}]->>`;
      this.error(
        `'.' reads a property — a type names an EDGE, and an edge is an address. Write '${address}' instead of '${wrote}'.`,
        markerStart,
      );
    }
    if (options.allowFieldTail === true) {
      const borrowed = `<${root}-[:${rawSegments[1]}]->${rawSegments
        .slice(2)
        .map(raw => `.${backtickedTail(raw)}`)
        .join('')}>`;
      this.error(
        `'.' reads a property — the middle of a borrowed type is an EDGE. Write '${borrowed}' instead of '${wrote}'.`,
        markerStart,
      );
    }
    this.error(
      `'.' reads a property — a type is a single name or an address ('<${root}-[:…]->>'), got '${wrote}'`,
      markerStart,
    );
  }

  private startsHop(): boolean {
    return this.peekCh() === '-' && this.peekCh(1) === '[';
  }

  /**
   * The ADDRESS form's hop chain inside a type marker: `<at-[:`Record Change`
   * WHERE …]->>`. Deliberately the SAME `scanHop` the traversal grammar uses —
   * an address is a walk, so it must mean in a type exactly what it means in a
   * movement, with nothing to drift.
   *
   * The `->>` close resolves without lookahead: `scanHop` consumes `-[…]->`,
   * leaving the `>` that closes the marker.
   *
   * An UNPINNED single hop (`<kg-[:company]->>`) also yields `position` — the
   * bare name it keys as (`eventAddressKey`: no pins ⇒ the event name), so
   * every consumer of "the name one hop from the root" (demand seeding, shape
   * conformance, the engine's surface type) reads the address exactly as it
   * read the retired dotted spelling. A WHERE pins, so it stays address-only.
   */
  private readTypeAddressHops(
    text: string,
    context: string,
    options: { allowHops?: boolean },
  ): { hopsRaw: string; position?: string } {
    if (options.allowHops !== true) {
      this.error(
        `A type address ('<${text}-[:…]->>') doesn't fit here — ${context} names a single type, e.g. <${text}>`,
      );
    }
    const hopsStart = this.pos;
    let hops = 0;
    for (;;) {
      this.scanHop();
      hops++;
      const afterHop = this.pos;
      this.skipInlineWs();
      if (!this.startsHop()) {
        this.pos = afterHop;
        break;
      }
    }
    const hopsRaw = this.src.slice(hopsStart, this.pos);
    const position = hops === 1 ? unpinnedHopName(hopsRaw) : undefined;
    return { hopsRaw, ...(position !== undefined ? { position } : {}) };
  }

  /**
   * A borrowed field type: `<crm-[:companies]->.\`funding_stage\`>` — one hop
   * (the root/collection the field lives on), then a property tail. Stored as
   * the resolver's `<instance>.<root>.<field>` segments, which is what
   * `borrowedTypeSegments` has always split; only the surface spelling
   * changed. A hop with no tail is an error — a borrowed type names a FIELD.
   */
  private readBorrowedFieldTail(root: string, context: string): string {
    this.expect('-[', 'to begin the borrowed type’s edge');
    this.skipInlineWs();
    this.expect(':', "after '-[' in the borrowed type");
    this.skipInlineWs();
    const edge = this.readName(`the borrowed root name ${context}`);
    this.skipInlineWs();
    this.expect(']', `after the borrowed root '${edge}'`);
    this.expect('->', 'to complete the borrowed type’s edge');
    if (this.peekCh() !== '.') {
      this.error(
        `A borrowed type names a FIELD — add the property tail: <${root}-[:${edge}]->.\`field\`>`,
      );
    }
    this.pos++; // '.'
    const field = this.readName(`the borrowed field name ${context}`);
    return `${root}.${edge}.${field}`;
  }

  /** `name` — a backtick-quoted name (single line). */
  private readBacktickName(): string {
    const start = this.pos;
    const scanned = scanBacktickName(this.src, start);
    if (scanned === null) {
      this.error("Unterminated backtick-quoted name — expected a closing '`'", start);
    }
    this.pos = scanned.end + 1; // past the closing backtick
    return scanned.name;
  }

  /** Consumes a complete double-quoted string (may span newlines; `${…}` is a balanced region). */
  private scanString(): void {
    const start = this.pos;
    this.pos++; // opening quote
    while (!this.eof()) {
      const c = this.peekCh();
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      if (c === '"') {
        this.pos++;
        return;
      }
      if (c === '$' && this.peekCh(1) === '{') {
        this.pos += 2;
        this.scanBalanced({ stops: '}', context: 'the ${…} interpolation' });
        this.pos++; // closing '}'
        continue;
      }
      this.pos++;
    }
    this.error('Unterminated string — expected a closing \'"\'', start);
  }

  private readQuotedString(context: string): { text: string; span: Span } {
    if (this.peekCh() !== '"') {
      this.error(`Expected a double-quoted string ${context}, found ${this.describeHere()}`);
    }
    const start = this.pos;
    this.scanString();
    return { text: this.src.slice(start + 1, this.pos - 1), span: this.spanFrom(start) };
  }

  /**
   * The same double-quoted string, read as an ordinary expression slot: the
   * literal WITH its quotes, so the expression bridge desugars its escapes and
   * its `${…}` exactly as it does in every other string position. A quoted
   * string is one thing wherever it is written.
   */
  private readStringSlot(context: string): ExprSlot {
    if (this.peekCh() !== '"') {
      this.error(`Expected a double-quoted string ${context}, found ${this.describeHere()}`);
    }
    const start = this.pos;
    this.scanString();
    return { raw: this.src.slice(start, this.pos), span: this.spanFrom(start) };
  }

  /**
   * The core raw scanner: advances until one of `stops` appears at top level — outside
   * ( ) [ ] { } nesting, strings, and backtick names. The stop character is not consumed.
   * Returns where meaningful content ended (trailing whitespace/comments excluded).
   */
  private scanBalanced(options: ScanOptions): { stop: string; contentEnd: number } {
    const comments = options.comments !== false;
    const brackets: Array<{ ch: string; offset: number }> = [];
    // Open value-level `IF … END` at top bracket level: while inside one, a
    // newline must not terminate the slot (an IF may span lines). `ELSE IF` is
    // the chain form — one END closes the whole chain — so it does NOT open a
    // new level; only a leading `IF` does. Tracked by remembering the previous
    // top-level word.
    let ifDepth = 0;
    let prevWord = '';
    let contentEnd = this.pos;
    while (!this.eof()) {
      const c = this.peekCh()!;
      if (brackets.length === 0 && ifDepth === 0 && options.stops.includes(c)) {
        return { stop: c, contentEnd };
      }
      if (c === '#' && comments && brackets.length === 0) {
        while (!this.eof() && this.peekCh() !== '\n') this.pos++;
        prevWord = '';
        continue;
      }
      if (c === '"') {
        this.scanString();
        contentEnd = this.pos;
        prevWord = '';
        continue;
      }
      if (c === '`') {
        this.readBacktickName();
        contentEnd = this.pos;
        prevWord = '';
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        brackets.push({ ch: c, offset: this.pos });
        this.pos++;
        contentEnd = this.pos;
        prevWord = '';
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        const open = brackets.pop();
        if (!open) this.error(`Unbalanced '${c}' in ${options.context}`);
        const want = CLOSER[open.ch];
        if (c !== want) {
          const openLoc = this.locAt(open.offset);
          this.error(
            `Expected '${want}' to close the '${open.ch}' opened at line ${openLoc.line}, col ${openLoc.col} — found '${c}'`,
          );
        }
        this.pos++;
        contentEnd = this.pos;
        prevWord = '';
        continue;
      }
      // `?:` is never valid in expression text — `?` is not a formula token, so
      // a captured `?:` is always the write-marker reached for outside a write
      // body. Catch it here (strings/backticks are already consumed above) with
      // the real semantics rather than letting it fall through to the bridge's
      // opaque expression-parse error.
      if (c === '?' && this.peekCh(1) === ':') {
        this.error(ELVIS_MISUSE, this.pos);
      }
      // Identifiers are consumed whole so `IF`/`END` never match inside a
      // longer word (`notify`, `endpoint`). Only tracked at top bracket level.
      if (brackets.length === 0 && /[A-Za-z_]/.test(c)) {
        const wordStart = this.pos;
        while (!this.eof() && /[A-Za-z0-9_]/.test(this.peekCh()!)) this.pos++;
        const word = this.src.slice(wordStart, this.pos);
        if (word === 'IF' && prevWord !== 'ELSE') ifDepth++;
        else if (word === 'END' && ifDepth > 0) ifDepth--;
        prevWord = word;
        contentEnd = this.pos;
        continue;
      }
      if (!/\s/.test(c)) {
        contentEnd = this.pos + 1;
        prevWord = '';
      }
      this.pos++;
    }
    if (brackets.length > 0) {
      const open = brackets[brackets.length - 1];
      this.error(
        `Unbalanced '${open.ch}' — no matching '${CLOSER[open.ch]}' before end of file`,
        open.offset,
      );
    }
    if (options.allowEof) return { stop: 'eof', contentEnd };
    this.error(`Unexpected end of file in ${options.context}`);
  }

  /** Captures a raw expression span (trimmed) for the expression bridge. */
  private readExprSlot(options: ScanOptions): { slot: ExprSlot; stop: string } {
    if (options.stops.includes('\n')) this.skipInlineWs();
    else this.skipAllWs();
    const start = this.pos;
    const { stop, contentEnd } = this.scanBalanced(options);
    const raw = this.src.slice(start, contentEnd);
    if (raw.length === 0) this.error(`Expected an expression ${options.context}`, start);
    return { slot: { raw, span: this.spanFrom(start, contentEnd) }, stop };
  }

  // ── Statements ──

  private parseStatement(): Statement {
    const start = this.pos;
    if (this.peekCh() === '-' && this.peekCh(1) === '[') {
      return this.parseTraversalBlockStatement();
    }
    // A backticked token is always a NAME, never a keyword — the switch below
    // dispatches on bare words only, so a leading backtick skips straight to
    // the identifier-led forms (assignment / call / traversal root) shared
    // with the bare path below.
    if (this.peekCh() === '`') {
      const name = this.readBacktickName();
      return this.parseIdentifierLedStatement(name, start, true);
    }
    const word = this.peekIdent();
    if (!word) {
      this.error(`Unexpected ${this.describeHere()} — expected a statement`);
    }
    switch (word) {
      case 'import':
        return this.parseImport();
      case 'export':
        return this.parseExport();
      case 'shape':
        // Retired: a declaration IS a node, so it is spelled like one.
        this.error(
          "'shape' is not a statement — a declaration IS the record it describes, so declare it as a node: `node <name> { title: <text>  node <edge name> { … } }`, and type a parameter against it with `<name>`",
          start,
        );
        break;
      case 'node':
        // Contextual, as everywhere else: only `node <name> {` declares. A bare
        // `node` is still an ordinary name (`node = e.`Subject``).
        if (this.atNodeLiteral()) {
          this.error(
            "a `node { … }` literal builds a record — bind it (`deal = node { … }`) or pass it as an argument. To DECLARE the structure a parameter is checked against, name it: `node <name> { title: <text> }`",
            start,
          );
        }
        if (this.atNodeDeclaration()) return this.parseNodeDeclaration();
        break;
      case 'type':
        // Contextual, like `node`: only `type <name> =` declares. A bare `type`
        // stays an ordinary name (`type = r.`type``), which the `_resources`
        // idiom already relies on.
        if (this.atTypeDeclaration()) return this.parseTypeDeclaration();
        break;
      case 'movement':
      case 'function':
        return this.parseMovement(word);
      case 'listen':
        return this.parseListen();
      case 'run':
        // Retired when time + manual runs collapsed into adapters:
        // `listen` is the only invoker. Hard retirement (like `edge`) —
        // nothing shipped, so the statement errors with the fix.
        this.error(
          "'run' is not a statement — movements are invoked only by listeners. For on-demand runs declare a manual channel: `go = manual()` + `listen to go {} fire <movement>` (\"Run now\" injects an event on that channel); for schedules, `timer = cron()` + `listen to timer { schedule: \"0 9 * * 1\" } fire <movement>`",
          start,
        );
        break;
      case 'write': {
        this.pos += word.length;
        const write = this.parseWriteExpression(start);
        this.expectStatementEnd();
        return { kind: 'write', write, span: write.span };
      }
      case 'link':
        return this.parseLinkStatement();
      case 'edge':
        // Retired everywhere — `link` absorbed the statement, and a node
        // declaration's nesting absorbed the declaration line.
        this.error(
          "'edge' is not a statement — connect two records with 'link a -[:e]-> b'. In a node declaration, nest the node instead: the nesting IS the edge",
          start,
        );
        break;
      case 'unlink':
        return this.parseUnlinkStatement();
      case 'delete':
        return this.parseDeleteStatement();
      case 'refresh':
        return this.parseRefreshStatement();
      case 'await':
        return this.parseAwaitStatement();
      case 'return':
        return this.parseReturnStatement();
      case 'race':
      case 'parallel': {
        // The combinators are EXPRESSIONS; unbound, they are still spelled
        // `await race([…])`. A bare `race([…])` reaches the checker (which
        // names the missing `await`); the retired brace forms are refused here.
        const combinator = this.tryParseCombinatorStatement(word, start);
        if (combinator) return combinator;
        break;
      }
      case 'all':
        this.refuseRetiredAll(start);
        break;
      case 'if':
        return this.parseIf();
      case 'ERROR':
        return this.parseErrorStatement();
      case 'extract':
        this.error(
          "An 'extract' must be bound to a name — write `name = extract from […] { … }`",
          start,
        );
        break;
      case 'callback':
        // Minting a callback nobody can address is a no-op: its whole value is
        // the `.id` platforms carry and the `.url` humans follow.
        this.error(
          "A 'callback' must be bound to a name — write `cb = callback({ … })`, then use `cb.id` in a button payload (or `cb.url` for a link)",
          start,
        );
        break;
      case 'else':
        this.error("'else' without a preceding 'if'", start);
        break;
      default:
        break;
    }

    // Identifier-led: assignment, call, or rooted traversal block.
    this.pos += word.length;
    return this.parseIdentifierLedStatement(word, start, false);
  }

  /**
   * The forms available once a statement's leading NAME has been read —
   * assignment, call, or rooted traversal block — shared by the bare-word and
   * backtick-quoted dispatch paths in `parseStatement` so a backticked lead
   * name can never reach a different grammar than a bare one.
   *
   * `quoted` says whether `word` came from a backtick (always a NAME) or a
   * bare word: the legacy `ask`/`fallback`/`sleep` retirement notices key off
   * the literal spelling of a bare keyword-shaped word, and must NOT fire for
   * a backtick-quoted name that merely happens to spell the same text — that
   * spelling is exactly how an author says "this is a name, not the word".
   */
  private parseIdentifierLedStatement(word: string, start: number, quoted: boolean): Statement {
    this.skipInlineWs();
    if (this.peekCh() === '=' && this.peekCh(1) !== '=') {
      this.pos++;
      const value = this.parseRValue();
      this.expectStatementEnd();
      return { kind: 'assign', name: word, value, span: this.spanFrom(start) };
    }
    if (this.peekCh() === '(') {
      return this.parseCallStatement(word, start);
    }
    if (this.peekCh() === '-' && this.peekCh(1) === '[') {
      this.pos = start;
      return this.parseTraversalBlockStatement();
    }
    if (this.peekCh() === '?' && this.peekCh(1) === ':') {
      this.error(ELVIS_MISUSE);
    }
    if (!quoted) {
      // `ask Check<…> { … }` and a stray `fallback after …` are the retired ask
      // statement — nothing else spells `ask <ident>` / `fallback after` at the
      // head of a statement — so point at the new form rather than a generic
      // "unexpected identifier".
      if (word === 'ask') this.error(ASK_STATEMENT_REPLACED, start);
      if (word === 'fallback') this.error(FALLBACK_RUNG_REPLACED, start);
      // `sleep <duration>` (the retired statement) — nothing else spells a bare
      // `sleep` identifier followed directly by another token at the head of a
      // statement, so point at the replacement rather than a generic
      // "unexpected identifier". `sleep` is otherwise an ordinary name now (like
      // `ask`): `sleep = foo()`, `x = sleep`, `sleep()` all hit the `=`/`(`
      // branches above and never reach here; `await sleep(<duration>)` is
      // recognised inside `parseAwait`, unaffected by this statement-head gate.
      if (word === 'sleep') this.error(SLEEP_STATEMENT_REPLACED, start);
    }
    this.error(
      `Unexpected ${this.describeHere()} after '${word}' — expected '=' (binding), '(' (a call), or '-[…]->' (a traversal)`,
    );
  }

  /** After a peeked `ask` in RValue position, is this the RETIRED ask-statement
   *  construction (`ask <Kind><…>` / `ask<…>`) rather than an ordinary read of a
   *  binding named `ask` (`= ask`, `= ask-[:E]->`, `= ask.field`, `= ask()`)?
   *  Peeks without consuming. */
  private looksLikeLegacyAsk(): boolean {
    const save = this.pos;
    this.pos += 'ask'.length;
    this.skipInlineWs();
    const legacy = this.peekCh() === '<' || this.peekIdent() !== undefined;
    this.pos = save;
    return legacy;
  }

  private expectStatementEnd(): void {
    this.skipInlineWs();
    // `;` is an explicit inline statement separator (a grammar note) — it
    // ends a statement just like a newline, enabling one-line block bodies
    // (`{ refresh a; ok = … }.ok`). Consume it; the block-body loop's skipAllWs
    // then finds the next statement.
    if (this.peekCh() === ';') {
      this.pos++;
      return;
    }
    if (this.eof() || this.peekCh() === '\n' || this.peekCh() === '}') return;
    this.error(`Unexpected ${this.describeHere()} — expected the end of the statement`);
  }

  /** Statements inside `{ … }`; expects and consumes both braces. */
  private parseBlockBody(context: string): Statement[] {
    this.skipInlineWs();
    const braceOffset = this.pos;
    this.expect('{', `to open ${context}`);
    const body: Statement[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error(`Expected '}' to close ${context}`, braceOffset);
      if (this.peekCh() === '}') {
        this.pos++;
        return body;
      }
      if (this.peekCh() === ELISION) {
        this.pos++;
        continue;
      }
      body.push(this.parseStatement());
    }
  }

  // ── import ──

  private parseImport(): ImportStatement {
    const start = this.pos;
    this.pos += 'import'.length;
    this.skipInlineWs();
    this.expect('{', "after 'import'");
    const names: ImportedName[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.peekCh() === '}') {
        this.pos++;
        break;
      }
      const name = this.readName('an imported name');
      this.skipAllWs();
      let alias: string | undefined;
      if (this.peekIdent() === 'as') {
        this.pos += 'as'.length;
        this.skipAllWs();
        alias = this.readName("a local name after 'as'");
        this.skipAllWs();
      }
      names.push(alias === undefined ? { name } : { name, alias });
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      if (this.peekCh() !== '}') {
        this.error(`Expected ',' or '}' in the import list, found ${this.describeHere()}`);
      }
    }
    if (names.length === 0) this.error('The import list is empty', start);
    this.skipInlineWs();
    this.expectWord('from', 'after the import list');
    this.skipInlineWs();
    let source: ImportSource;
    if (this.peekCh() === '"') {
      const { text } = this.readQuotedString('as the import path');
      source = { kind: 'file', path: text };
    } else {
      const nsOffset = this.pos;
      const ns = this.peekIdent();
      if (!ns) {
        this.error(
          `Expected an import source — 'adapters', 'credentials', 'plugins', or a "file path" — found ${this.describeHere()}`,
        );
      }
      if (ns !== 'adapters' && ns !== 'credentials' && ns !== 'plugins') {
        this.error(
          `Unknown import source '${ns}' — expected 'adapters', 'credentials', 'plugins', or a quoted "file path"`,
          nsOffset,
        );
      }
      this.pos += ns.length;
      source = { kind: 'builtin', namespace: ns };
    }
    this.expectStatementEnd();
    return { kind: 'import', names, source, span: this.spanFrom(start) };
  }

  // ── Assignment right-hand sides ──

  private parseRValue(): RValue {
    this.skipInlineWs();
    if (this.eof() || this.peekCh() === '\n') this.error("Expected a value after '='");
    const start = this.pos;
    const word = this.peekIdent();
    if (word === 'write') {
      this.pos += word.length;
      return { kind: 'write', write: this.parseWriteExpression(start) };
    }
    if (word === 'link') {
      this.pos += word.length;
      const link = this.parseLinkExpression(start);
      if (link.target.kind !== 'criteria') {
        this.error(
          "Binding a link takes the criteria form — `p = link c-[:edge]-> { …criteria… }` binds the FOUND target's handle; `link a -[:e]-> b` connects two already-bound handles and binds nothing",
          start,
        );
      }
      return { kind: 'link', link };
    }
    if (word === 'extract') {
      this.pos += word.length;
      return { kind: 'extract', extract: this.parseExtract(start) };
    }
    if (word === 'ask' && this.looksLikeLegacyAsk()) {
      this.error(ASK_STATEMENT_REPLACED, start);
    }
    if (word === 'await') {
      this.pos += word.length;
      return { kind: 'await', await: this.parseAwait(start) };
    }
    if (word === 'all') this.refuseRetiredAll(start);
    if (word === 'race' || word === 'parallel') {
      const save = this.pos;
      this.pos += word.length;
      this.skipInlineWs();
      if (this.peekCh() === '{') this.error(PARALLEL_BLOCK_RETIRED, start);
      if (this.peekCh() === '(') {
        return { kind: 'combinator', combinator: this.parseCombinator(start, word) };
      }
      this.pos = save;
    }
    if (word === 'callback') {
      this.pos += word.length;
      return { kind: 'callback', callback: this.parseCallback(start) };
    }
    // The collection ops and `MEMBERS` take a FUNCTION and a TYPE respectively,
    // neither of which an expression can hold — so, like the combinators, they
    // are read here rather than by the expression bridge.
    const op = word !== undefined ? Parser.COLLECTION_OPS.get(word) : undefined;
    if (op !== undefined && this.followedByCall(word!)) {
      this.pos += word!.length;
      return { kind: 'collection', collection: this.parseCollectionOp(start, word!, op) };
    }
    if (word === 'MEMBERS' && this.followedByCall(word)) {
      this.pos += word.length;
      return { kind: 'members', members: this.parseMembers(start) };
    }
    this.refuseNamedNodeAsValue();
    if (this.atNodeLiteral()) {
      this.pos += 'node'.length;
      return { kind: 'node', node: this.parseNodeLiteral(start) };
    }
    if (this.atLazy()) {
      this.pos += 'lazy'.length;
      return { kind: 'lazy', lazy: this.parseLazy(start) };
    }
    // A brace-led RValue is a DICT LITERAL (`{ k: v, … }`) — the one brace body
    // that announces itself with no keyword, because it is the one whose
    // contents are VALUES rather than statements. It falls through to the
    // ordinary expression slot below, which reads object literals already.
    //
    // The exception is the RETIRED inline block (`{ … }.binding`), told apart
    // by the `.name` that follows the closing brace — the read is what the form
    // WAS, so it is also what identifies it. Still parsed, so the checker
    // refuses it by name instead of failing on statements-read-as-entries.
    if (this.peekCh() === '{' && this.atRetiredInlineBlock()) {
      return { kind: 'inlineBlock', inlineBlock: this.parseInlineBlock(start) };
    }
    if (this.atClosure()) {
      return { kind: 'closure', closure: this.parseClosure(start) };
    }
    const block = this.tryParseTraversalBlock();
    if (block) return { kind: 'block', block };
    const invocation = this.tryParseInvocation();
    if (invocation) return invocation;
    const { slot } = this.readExprSlot({
      stops: '\n}',
      allowEof: true,
      context: "for the value after '='",
    });
    return { kind: 'expr', expr: slot };
  }

  /**
   * A bound NAMED INVOCATION — `crm = attio(credentials: acme_main)` and
   * `doc = email_to_doc(m: msg)`, which are the same surface form.
   *
   * Nothing lexical separates them, so the parser does not guess: it records
   * the shape and resolution decides the meaning (`constructionAsCall`). Two
   * results, for one reason only — an argument the CONSTRUCTION grammar cannot
   * hold (a `node { … }`, an inline write) proves the invocation is a call, and
   * a `construct` node has nowhere to put it. Everything else records as
   * `construct`, exactly as before.
   *
   * The callee is a NAME (bare or backtick-quoted), so an adapter whose slug
   * isn't identifier-safe — `` `native-valuations` `` — is constructable
   * directly, not only via an `as` alias.
   */
  private tryParseInvocation(): RValue | undefined {
    if (!this.atNamedInvocation()) {
      const construct = this.tryParseConstruction();
      return construct ? { kind: 'construct', construct } : undefined;
    }
    const start = this.pos;
    const callee = this.readName('the name being called');
    this.skipInlineWs();
    this.pos++; // '('
    const args = this.parseCallArgs(callee, start);
    const span = this.spanFrom(start);
    const plain: NamedArg[] = [];
    for (const arg of args) {
      // One argument a construction cannot hold settles the whole invocation.
      if (arg.kind !== 'expr') return { kind: 'call', call: { kind: 'call', callee, args, span } };
      plain.push({ name: arg.name, value: arg.expr });
    }
    return { kind: 'construct', construct: { callee, args: plain, span } };
  }

  /** A zero-argument or otherwise unnamed invocation — `go = manual()`. Only a
   *  construction is spelled that way (a callee that reads nothing from its
   *  caller has nothing to compose), and it BACKTRACKS, so anything that isn't
   *  one falls through to the expression slot as it always did. */
  private tryParseConstruction(): ConstructionCall | undefined {
    const save = this.pos;
    const scanned = scanName(this.src, this.pos);
    if (!scanned) return undefined;
    const callee = scanned.name;
    this.pos = scanned.end;
    this.skipInlineWs();
    if (this.peekCh() !== '(') {
      this.pos = save;
      return undefined;
    }
    this.pos++;
    const args: NamedArg[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) {
        this.pos = save;
        return undefined;
      }
      if (this.peekCh() === ')') {
        this.pos++;
        break;
      }
      const name = this.peekIdent();
      if (!name) {
        this.pos = save;
        return undefined;
      }
      this.pos += name.length;
      this.skipInlineWs();
      if (this.peekCh() !== ':') {
        this.pos = save;
        return undefined;
      }
      this.pos++;
      const { slot, stop } = this.readExprSlot({
        stops: ',)',
        context: `for the argument '${name}'`,
      });
      args.push({ name, value: slot });
      if (stop === ',') this.pos++;
    }
    const end = this.pos;
    this.skipInlineWs();
    if (!this.eof() && this.peekCh() !== '\n' && this.peekCh() !== '}') {
      this.pos = save;
      return undefined;
    }
    this.pos = end;
    return { callee, args, span: this.spanFrom(save, end) };
  }

  // ── Traversal heads and blocks ──

  /** `root-[a:edge]->-[b:other]->` — non-throwing on shape mismatch (restores position). */
  private tryParsePathHead(): PathHead | undefined {
    const start = this.pos;
    let root: string | undefined;
    const scanned = scanName(this.src, this.pos);
    if (scanned) {
      root = scanned.name;
      this.pos = scanned.end;
      this.skipInlineWs();
    }
    if (!(this.peekCh() === '-' && this.peekCh(1) === '[')) {
      this.pos = start;
      return undefined;
    }
    const hopsStart = this.pos;
    for (;;) {
      this.scanHop();
      const afterHop = this.pos;
      this.skipInlineWs();
      if (!(this.peekCh() === '-' && this.peekCh(1) === '[')) {
        this.pos = afterHop;
        break;
      }
    }
    return { root, hopsRaw: this.src.slice(hopsStart, this.pos), span: this.spanFrom(start) };
  }

  /** Consumes one `-[…]->` hop. Comments are off inside the brackets (so `#`-prefixed
   *  legacy heads like `#linked` survive; `_resources` is a plain edge name). */
  private scanHop(): void {
    this.expect('-[', 'to begin a traversal hop');
    this.scanBalanced({ stops: ']', comments: false, context: 'the traversal hop' });
    this.pos++; // ']'
    this.expect('->', "after ']' to complete the traversal hop");
  }

  private tryParseTraversalBlock(): TraversalBlock | undefined {
    const save = this.pos;
    const head = this.tryParsePathHead();
    if (!head) return undefined;
    this.skipInlineWs();
    if (this.peekCh() !== '{') {
      this.pos = save;
      return undefined;
    }
    const body = this.parseBlockBody('the traversal block');
    return { head, body, span: this.spanFrom(save) };
  }

  private parseTraversalBlockStatement(): BlockStatement {
    const start = this.pos;
    const head = this.tryParsePathHead();
    if (!head) this.error(`Expected a traversal head, found ${this.describeHere()}`, start);
    const body = this.parseBlockBody('the traversal block');
    const span = this.spanFrom(start);
    return { kind: 'block', block: { head, body, span }, span };
  }

  // ── Writes ──

  private parseWriteExpression(start: number): WriteExpression {
    this.skipInlineWs();
    const targetStart = this.pos;
    if (this.peekCh() === '(') {
      const target = this.parseTupleWriteTarget(targetStart);
      const bind = this.tryParseBindClause();
      const { uniqueBy, fields } = this.parseWriteBody();
      return { target, uniqueBy, fields, ...(bind ? { bind } : {}), span: this.spanFrom(start) };
    }
    const scannedFirst = scanName(this.src, this.pos);
    if (!scannedFirst) {
      this.error(
        `Expected a write target after 'write' — a linked path like '<instance>-[:edge]->' or 'parent-[:edge]->', or a tuple '(a-[:e]->, b-[:f]->)' — found ${this.describeHere()}`,
      );
    }
    const first = scannedFirst.name;
    this.pos = scannedFirst.end;
    let target: WriteTarget;
    if (this.peekCh() === '.') {
      const dotStart = this.pos;
      this.pos++;
      const type = this.readName(`a type name after '${first}.'`);
      // The flat `<instance>.<type>` write target is retired: a write names the
      // edge it creates, not the type. `write crm.company` becomes
      // `write crm-[:company]-> { … }` — the linked write mints the record and
      // its edge in one move.
      this.error(
        `Write targets name the edge, not the type — use 'write ${first}-[:${type}]-> { … }'. The flat '${first}.${type}' form is no longer a write target.`,
        dotStart,
      );
    } else if (this.peekCh() === '-' && this.peekCh(1) === '[') {
      const hopsStart = this.pos;
      do {
        this.scanHop();
      } while (this.peekCh() === '-' && this.peekCh(1) === '[');
      const hopsRaw = this.src.slice(hopsStart, this.pos);
      const explicitType = this.tryReadExplicitWriteType();
      const path: PathHead = { root: first, hopsRaw, span: this.spanFrom(targetStart) };
      target = { kind: 'linked', path, explicitType, span: this.spanFrom(targetStart) };
    } else {
      // A bare name → update the record at the bound position `first` in
      // place (`write a { … }`). The write body follows; the checker
      // validates that `first` is a writable stable record.
      target = { kind: 'position', alias: first, span: this.spanFrom(targetStart) };
    }
    const bind = this.tryParseBindClause();
    const { uniqueBy, fields } = this.parseWriteBody();
    return { target, uniqueBy, fields, ...(bind ? { bind } : {}), span: this.spanFrom(start) };
  }

  /**
   * `bind <name>` between the write target and the body — the optional
   * correspondence declaration. `bind` is a contextual keyword: it only
   * binds here, so a field literally named `bind` is still legal in the
   * body (the body starts at `{`). Returns undefined when no `bind`
   * follows the target.
   */
  private tryParseBindClause(): BindClause | undefined {
    this.skipInlineWs();
    if (this.peekIdent() !== 'bind') return undefined;
    const bindStart = this.pos;
    this.pos += 'bind'.length;
    this.skipInlineWs();
    const name = this.readName('the counterpart record name after \'bind\'');
    return { name, span: this.spanFrom(bindStart) };
  }

  /**
   * `(company-[:investments]->, investor-[:investments]->)` — the
   * tuple-path multi-parent target. Each element is a linked-write path
   * (root + hop chain); an optional explicit type after the `)` names
   * the written type for polymorphic edges, like linked writes.
   */
  private parseTupleWriteTarget(targetStart: number): Extract<WriteTarget, { kind: 'tuple' }> {
    this.expect('(', 'to open the tuple write target');
    const paths: PathHead[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.peekCh() === ')') {
        this.pos++;
        break;
      }
      const path = this.tryParsePathHead();
      if (!path) {
        this.error(
          `Expected a linked path like 'parent-[:edge]->' in the tuple write target, found ${this.describeHere()}`,
        );
      }
      if (path.root === undefined) {
        this.error('Every tuple path starts at a bound handle — name the parent', targetStart);
      }
      paths.push(path);
      this.skipAllWs();
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      if (this.peekCh() !== ')') {
        this.error(`Expected ',' or ')' in the tuple write target, found ${this.describeHere()}`);
      }
    }
    if (paths.length < 2) {
      this.error(
        "A tuple write target takes two or more parent paths — for one parent, write the linked form 'write parent-[:edge]-> { … }'",
        targetStart,
      );
    }
    this.skipInlineWs();
    const explicitType = this.tryReadExplicitWriteType();
    return { kind: 'tuple', paths, explicitType, span: this.spanFrom(targetStart) };
  }

  /**
   * The optional explicit written type on polymorphic linked/tuple write
   * targets — `write fr-[:related]-><company> { … }`. Bracketed like every
   * type; a bare ident here (the pre-bracket spelling) gets the fix-it.
   */
  private tryReadExplicitWriteType(): string | undefined {
    this.skipInlineWs();
    if (this.peekCh() === '<') {
      return this.readTypeMarker('for the written type').text;
    }
    const bare = this.peekIdent();
    // `bind` is the correspondence keyword that follows the target — leave
    // it for `tryParseBindClause`, never the mis-bracketed-type fix-it.
    if (bare && bare !== 'bind') {
      this.error(
        `Types are written in angle brackets — wrap the type in angle brackets: <${bare}>`,
      );
    }
    return undefined;
  }

  private parseWriteBody(): { uniqueBy: UniqueClause[]; fields: FieldEntry[] } {
    this.skipInlineWs();
    const braceOffset = this.pos;
    this.expect('{', 'to open the write body');
    const uniqueBy: UniqueClause[] = [];
    const fields: FieldEntry[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error("Expected '}' to close the write body", braceOffset);
      if (this.peekCh() === '}') {
        this.pos++;
        return { uniqueBy, fields };
      }
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      const entryStart = this.pos;
      if (this.peekIdent() === 'unique') {
        this.pos += 'unique'.length;
        this.skipInlineWs();
        this.expectWord('by', "after 'unique'");
        this.skipInlineWs();
        uniqueBy.push(this.parseUniqueClause(entryStart));
        continue;
      }
      const name = this.readName("a field name or 'unique by' in the write body");
      this.skipInlineWs();
      // Write-precedence operator before the colon (longest match first):
      //   `+?:` append-if-missing · `+:` append · `?:` set-if-empty · `:` replace.
      // Per-field grain — one write body mixes them.
      const semantics: 'fill' | 'append' | 'append-missing' | undefined =
        this.tryConsume('+?:')
          ? 'append-missing'
          : this.tryConsume('+:')
            ? 'append'
            : this.tryConsume('?:')
              ? 'fill'
              : undefined;
      if (semantics === undefined) this.expect(':', `after the field name '${name}'`);
      const { slot, stop } = this.readExprSlot({
        stops: ',\n}',
        allowEof: false,
        context: `for the field '${name}'`,
      });
      fields.push({
        name,
        value: slot,
        ...(semantics ? { semantics } : {}),
        span: { start: this.locAt(entryStart), end: slot.span.end },
      });
      if (stop === ',') this.pos++;
    }
  }

  private parseUniqueClause(entryStart: number): UniqueClause {
    this.expect('(', "after 'unique by'");
    // The clause is a full predicate expression — captured verbatim and bridged
    // like a hop WHERE. `)` (at top level) closes it; nested ( ) [ ] balance.
    const { slot } = this.readExprSlot({ stops: ')', context: "in 'unique by (…)'" });
    this.expect(')', "to close 'unique by (…)'");
    return { predicate: slot, span: this.spanFrom(entryStart) };
  }

  // ── Node literals ──

  /**
   * Is a `node { … }` literal next? `node` is CONTEXTUAL, exactly as it already
   * is inside shape and extract bodies: the word alone is still an ordinary
   * name, so `x = node` (a binding called `node`) keeps meaning what it always
   * meant. Only `node` immediately followed by `{` is the literal. Consumes
   * nothing.
   */
  private atNodeLiteral(): boolean {
    if (this.peekIdent() !== 'node') return false;
    const save = this.pos;
    this.pos += 'node'.length;
    this.skipInlineWs();
    const isLiteral = this.peekCh() === '{';
    this.pos = save;
    return isLiteral;
  }

  /** Is `node <name> { … }` — a NAMED declaration — next? Consumes nothing. */
  private atNodeDeclaration(): boolean {
    if (this.peekIdent() !== 'node') return false;
    const save = this.pos;
    this.pos += 'node'.length;
    this.skipInlineWs();
    let named = false;
    if (/[A-Za-z_`]/.test(this.peekCh() ?? '')) {
      try {
        this.readName('a name');
        this.skipInlineWs();
        named = this.peekCh() === '{';
      } catch {
        named = false;
      }
    }
    this.pos = save;
    return named;
  }

  /**
   * A NAMED node where a value is expected. Named-with-types declares a
   * structure and belongs at file level; anonymous-with-values builds a record
   * and belongs here. Refused rather than left to fail as "unexpected `doc`",
   * which says nothing about which of the two the author wanted.
   */
  private refuseNamedNodeAsValue(): void {
    if (!this.atNodeDeclaration()) return;
    this.error(
      "a named node DECLARES a structure and belongs at the top level of the file — here, build the record with an anonymous literal: `node { … }`",
    );
  }

  /**
   * Is a NAMED invocation — `f(x: …)` — next? Consumes nothing.
   *
   * That form is a call and nothing else: named arguments are the whole of a
   * call's grammar (`readCallArgName`), and every stdlib function is
   * POSITIONAL, so no expression wears this shape. A zero-argument `f()` is
   * deliberately NOT recognised here — a callee that reads nothing from its
   * caller has nothing to compose, and `f()` is also how a construction with no
   * config is spelled.
   */
  private atNamedInvocation(): boolean {
    const save = this.pos;
    const scanned = scanName(this.src, this.pos);
    if (!scanned) return false;
    this.pos = scanned.end;
    this.skipInlineWs();
    let named = false;
    if (this.peekCh() === '(') {
      this.pos++;
      this.skipAllWs();
      const arg = scanName(this.src, this.pos);
      if (arg) {
        this.pos = arg.end;
        this.skipInlineWs();
        named = this.peekCh() === ':';
      }
    }
    this.pos = save;
    return named;
  }

  /**
   * Is `lazy <traversal>` next? `lazy` is CONTEXTUAL, exactly as `node` is: the
   * word alone is still an ordinary name (`x = lazy` reads a binding called
   * `lazy`), and only `lazy` immediately followed by something that can BEGIN a
   * traversal — a root name, a backticked one, or a rootless `-[` — is the
   * modifier. Consumes nothing.
   */
  private atLazy(): boolean {
    if (this.peekIdent() !== 'lazy') return false;
    const save = this.pos;
    this.pos += 'lazy'.length;
    this.skipInlineWs();
    const ch = this.peekCh();
    const modifies = ch !== undefined && (ch === '-' || ch === '`' || /[A-Za-z_]/.test(ch));
    this.pos = save;
    return modifies;
  }

  /** The deferred traversal, with `lazy` already consumed. `start` is the offset
   *  of the `lazy` word so the span covers the whole thing. */
  private parseLazy(start: number): LazyTraversal {
    this.skipInlineWs();
    const sourceStart = this.pos;
    if (this.peekIdent() === 'await') this.error(LAZY_AWAIT, sourceStart);
    const head = this.tryParsePathHead();
    if (!head) {
      this.error(
        `Expected a traversal to defer (\`lazy crm-[c:Companies]->\`) after 'lazy', found ${this.describeHere()}`,
        sourceStart,
      );
    }
    const mapping = this.tryParsePerItemTail();
    return { head, ...(mapping ? { mapping } : {}), span: this.spanFrom(start) };
  }

  /** The literal's body, with `node` already consumed. `start` is the offset of
   *  the `node` word so the span covers the whole literal. */
  private parseNodeLiteral(start: number): NodeLiteral {
    this.skipInlineWs();
    const braceOffset = this.pos;
    this.expect('{', 'to open the node literal');
    const entries: NodeEntry[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error("Expected '}' to close the node literal", braceOffset);
      if (this.peekCh() === '}') {
        this.pos++;
        return { entries, span: this.spanFrom(start) };
      }
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      entries.push(this.parseNodeEntry());
    }
  }

  /** `name: <value>` — one entry. The value's KIND decides what it declares
   *  (ruling 1), so the shape is read here rather than marked by the author. */
  private parseNodeEntry(): NodeEntry {
    const entryStart = this.pos;
    const name = this.readName('an entry name in the node literal');
    this.skipInlineWs();
    this.expect(':', `after the entry name '${name}'`);
    this.skipInlineWs();

    // A nested literal — the single-landing synthesised edge.
    this.refuseNamedNodeAsValue();
    if (this.atNodeLiteral()) {
      const nodeStart = this.pos;
      this.pos += 'node'.length;
      const node = this.parseNodeLiteral(nodeStart);
      this.finishNodeEntry(name);
      return { kind: 'nodes', name, nodes: [node], span: this.spanFrom(entryStart) };
    }
    // `[node { … }, node { … }]` — the plural synthesised edge. A bracket that
    // does NOT open a literal is an ordinary list expression, so this backtracks
    // rather than claiming every `[`.
    if (this.peekCh() === '[') {
      const save = this.pos;
      const nodes = this.tryParseNodeLiteralList();
      if (nodes) {
        this.finishNodeEntry(name);
        return { kind: 'nodes', name, nodes, span: this.spanFrom(entryStart) };
      }
      this.pos = save;
    }
    // A TYPE — the declared edge, empty until `link` appends to it. Nothing in
    // the expression grammar opens with `<`, so the bracket decides this on
    // sight.
    if (this.peekCh() === '<') {
      const entry = this.parseDeclaredEdgeEntry(name, entryStart);
      this.finishNodeEntry(name);
      return entry;
    }
    // A source TRAVERSAL — the pass-through edge. `lazy` sits in front of it
    // exactly as it does on a binding: same word, same meaning, different
    // moment. What follows is the ordinary path head, so WHERE / ORDER BY /
    // LIMIT ride along with no grammar of their own here.
    const lazy = this.atLazy();
    if (lazy) {
      this.pos += 'lazy'.length;
      this.skipInlineWs();
    }
    const save = this.pos;
    const head = this.tryParsePathHead();
    if (head) {
      const mapping = this.tryParsePerItemTail();
      this.finishNodeEntry(name);
      return {
        kind: 'traversal',
        name,
        head,
        lazy,
        ...(mapping ? { mapping } : {}),
        span: this.spanFrom(entryStart),
      };
    }
    this.pos = save;
    this.refuseNonEntryValue(name, lazy);
    const { slot, stop } = this.readExprSlot({
      stops: ',\n}',
      allowEof: false,
      context: `for the entry '${name}'`,
    });
    if (stop === ',') this.pos++;
    return {
      kind: 'value',
      name,
      value: slot,
      span: { start: this.locAt(entryStart), end: slot.span.end },
    };
  }

  /** `[node { … }, node { … }]` — consumes through `]` and returns the
   *  literals, or `undefined` (position unchanged by the caller) when the
   *  bracket opens an ordinary list expression instead. */
  private tryParseNodeLiteralList(): NodeLiteral[] | undefined {
    this.pos++; // '['
    const nodes: NodeLiteral[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) return undefined;
      if (this.peekCh() === ']') {
        this.pos++;
        // An empty `[]` is a list VALUE, not a plural edge with no landings —
        // nothing in it says "node", so it stays an ordinary expression.
        return nodes.length > 0 ? nodes : undefined;
      }
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      if (!this.atNodeLiteral()) return undefined;
      const nodeStart = this.pos;
      this.pos += 'node'.length;
      nodes.push(this.parseNodeLiteral(nodeStart));
    }
  }

  /**
   * `messages: <slack-[:Channels]->-[:Messages]->>` — the DECLARED edge: an
   * address marker (the hop-allowing form a movement parameter takes) standing
   * where a value would, saying what the edge's landings are and starting with
   * none.
   *
   * A marker with no hops is a VALUE type, and a value type declares nothing to
   * land on — refused with the address spelling it should have had.
   */
  private parseDeclaredEdgeEntry(name: string, entryStart: number): NodeEntry {
    const markerStart = this.pos;
    const marker = this.readTypeMarker(`for the entry '${name}'`, { allowHops: true });
    if (marker.hopsRaw === undefined) {
      this.error(
        `'${name}: <${marker.text}>' names a value type, and an entry that starts EMPTY is an edge — give it the address its landings come from: '${name}: <${marker.text}-[:Edge]->>'`,
        markerStart,
      );
    }
    return {
      kind: 'declared',
      name,
      type: this.typeRefFromMarker(marker),
      span: this.spanFrom(entryStart),
    };
  }

  /** After an entry whose value was a literal (no expression slot to find the
   *  separator for): the entry ends at a comma, a newline, or the closing `}`. */
  private finishNodeEntry(name: string): void {
    this.skipInlineWs();
    if (this.peekCh() === ',') {
      this.pos++;
      return;
    }
    if (this.eof() || this.peekCh() === '\n' || this.peekCh() === '}') return;
    this.error(`Expected ',' or a newline after the entry '${name}', found ${this.describeHere()}`);
  }

  /**
   * An entry value that is neither a value, a literal, nor a traversal —
   * refused by NAME rather than left to fail as a confusing expression parse.
   *
   * A node literal is effect-free: `write` / `link` / `extract` / `await` /
   * `race` / `callback` are statement forms, so they are not in the entry
   * grammar at all — the refusal says so rather than reporting a syntax error
   * about a word the author meant exactly as written.
   */
  private refuseNonEntryValue(name: string, sawLazy: boolean): void {
    const word = this.peekIdent();
    if (sawLazy) {
      this.error(
        word === 'await'
          ? LAZY_AWAIT
          : `'lazy' defers a TRAVERSAL, and the entry '${name}' has none to defer — write 'lazy <source>-[:Edge]->', or drop 'lazy' and give the entry a value`,
      );
    }
    if (word !== undefined && NODE_ENTRY_EFFECTS.has(word)) {
      this.error(
        `A node literal only computes — '${word}' acts, and a node's entries can't. Move the '${word}' above the literal and read its result in the entry '${name}'`,
      );
    }
  }

  /**
   * `files: m-[a:Attachments]-> node { … }` — PER-ITEM synthesis, the RENAMED
   * view of each landing. The tail is the same `node { … }` literal the rest of
   * the grammar uses, written where the walk ends: it belongs to the traversal
   * (a mapped walk yields mapped landings, wherever the walk is bound), which
   * is why both the entry form and the `lazy` RValue take it here.
   *
   * Same LINE only, like every other entry continuation — a newline ends the
   * entry, so a `node` on the next line is the next entry's name and says so.
   */
  private tryParsePerItemTail(): NodeLiteral | undefined {
    this.skipInlineWs();
    if (!this.atNodeLiteral()) return undefined;
    const nodeStart = this.pos;
    this.pos += 'node'.length;
    return this.parseNodeLiteral(nodeStart);
  }

  // ── Calls ──

  private parseCallStatement(callee: string, start: number): CallStatement {
    this.pos++; // '('
    const args = this.parseCallArgs(callee, start);
    this.expectStatementEnd();
    return { kind: 'call', callee, args, span: this.spanFrom(start) };
  }

  /** A call's NAMED argument list, with the opening `(` already consumed;
   *  consumes through the closing `)`. Shared by the call statement and the
   *  named form of `callback(<movement>(…))`. */
  private parseCallArgs(callee: string, start: number): CallArg[] {
    const args: CallArg[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error(`Expected ')' to close the call to '${callee}'`, start);
      if (this.peekCh() === ')') {
        this.pos++;
        break;
      }
      const name = this.readCallArgName(callee);
      this.refuseNamedNodeAsValue();
      if (this.atNodeLiteral()) {
        const nodeStart = this.pos;
        this.pos += 'node'.length;
        const node = this.parseNodeLiteral(nodeStart);
        args.push({ kind: 'node', name, node });
        this.skipAllWs();
        if (this.peekCh() === ',') this.pos++;
        else if (this.peekCh() !== ')') {
          this.error(`Expected ',' or ')' after the node argument, found ${this.describeHere()}`);
        }
        continue;
      }
      // An argument is a VALUE or a position spelled out (`node { … }`, an
      // inline write). A bare traversal is neither — eager or lazy — so `lazy`
      // here is refused by name rather than left to fail as an expression.
      if (this.atLazy()) {
        this.error(
          `'lazy' defers a traversal, and an argument takes a value or a position — bind the deferred traversal above ('files = lazy …') and pass '${name}: files', or hand it through a 'node { ${name}: lazy … }'`,
        );
      }
      if (this.peekIdent() === 'write') {
        const writeStart = this.pos;
        this.pos += 'write'.length;
        const write = this.parseWriteExpression(writeStart);
        args.push({ kind: 'write', name, write });
        this.skipAllWs();
        if (this.peekCh() === ',') this.pos++;
        else if (this.peekCh() !== ')') {
          this.error(
            `Expected ',' or ')' after the write argument, found ${this.describeHere()}`,
          );
        }
        continue;
      }
      // A CALL passed on — the utility idiom, `log_doc(d: email_to_doc(m: msg))`.
      // Parsed structurally rather than left in the expression slot: a call's
      // value is a node, and an expression cannot hold one.
      if (this.atNamedInvocation()) {
        const callStart = this.pos;
        const nested = this.readName('the movement to call');
        this.skipInlineWs();
        this.pos++; // '('
        const nestedArgs = this.parseCallArgs(nested, callStart);
        args.push({
          kind: 'call',
          name,
          call: { kind: 'call', callee: nested, args: nestedArgs, span: this.spanFrom(callStart) },
        });
        this.skipAllWs();
        if (this.peekCh() === ',') this.pos++;
        else if (this.peekCh() !== ')') {
          this.error(`Expected ',' or ')' after the call argument, found ${this.describeHere()}`);
        }
        continue;
      }
      const { slot, stop } = this.readExprSlot({
        stops: ',)',
        context: `for the argument '${name}' of '${callee}'`,
      });
      args.push({ kind: 'expr', name, expr: slot });
      if (stop === ',') this.pos++;
    }
    return args;
  }

  /**
   * Call arguments are named after the callee's parameters — parens are
   * callable arguments, always named. A positional argument is a parse
   * error with the naming fix-it.
   */
  private readCallArgName(callee: string): string {
    const argStart = this.pos;
    const scanned = scanName(this.src, this.pos);
    if (scanned) {
      const save = this.pos;
      this.pos = scanned.end;
      this.skipInlineWs();
      if (this.tryConsume(':')) {
        this.skipInlineWs();
        return scanned.name;
      }
      this.pos = save;
    }
    this.error(
      `Arguments to '${callee}' are named — write each as '<parameter>: <value>', naming '${callee}'s parameters in order (e.g. ${callee}(param: value))`,
      argStart,
    );
  }

  // ── link / edge arrows ──

  private parseEdgeParts(): { from: string; edge: string; to: string } {
    this.skipInlineWs();
    const from = this.readName("the edge's source — a bound name");
    this.skipInlineWs();
    this.expect('-[', "to begin the edge arrow '-[:name]->'");
    this.expect(':', "after '-[' in the edge arrow");
    const edge = this.readName('the edge name');
    this.expect(']', `after the edge name '${edge}'`);
    this.expect('->', 'to complete the edge arrow');
    this.skipInlineWs();
    const to = this.readName("the edge's target — a bound name");
    return { from, edge, to };
  }

  /**
   * After the `link` keyword: `from -[:edge]->` then either a bound name
   * (handle form) or — optionally type-named for polymorphic edges — an
   * identity-criteria body (criteria form). Criteria are match values
   * ONLY: they ARE the identity, so a `unique by` inside the body is
   * rejected.
   */
  private parseLinkExpression(start: number): LinkExpression {
    this.skipInlineWs();
    const from = this.readName("the link's source — a bound name");
    this.skipInlineWs();
    this.expect('-[', "to begin the link arrow '-[:name]->'");
    this.expect(':', "after '-[' in the link arrow");
    const edge = this.readName('the edge name');
    this.expect(']', `after the edge name '${edge}'`);
    this.expect('->', 'to complete the link arrow');
    this.skipInlineWs();
    const targetStart = this.pos;
    let explicitType: string | undefined;
    if (this.peekCh() === '<') {
      // Criteria form with an explicit found type (polymorphic edges):
      // `link a -[:related]-> <company> { … }` — bracketed like every type.
      explicitType = this.readTypeMarker('for the found type').text;
      this.skipInlineWs();
    } else {
      const scannedIdent = scanName(this.src, this.pos);
      if (scannedIdent) {
        const ident = scannedIdent.name;
        this.pos = scannedIdent.end;
        this.skipInlineWs();
        if (this.peekCh() === '{') {
          // The pre-bracket spelling of the criteria form's explicit type.
          this.error(
            `Types are written in angle brackets — wrap the type in angle brackets: <${ident}>`,
            targetStart,
          );
        }
        // Bare-handle form: `link a -[:e]-> b`.
        return {
          from,
          edge,
          target: { kind: 'handle', name: ident },
          span: this.spanFrom(start),
        };
      }
    }
    if (this.peekCh() !== '{') {
      this.error(
        `Expected a bound handle or an identity-criteria body '{ … }' after the link arrow, found ${this.describeHere()}`,
        targetStart,
      );
    }
    const { uniqueBy, fields } = this.parseWriteBody();
    if (uniqueBy.length > 0) {
      throw new MovementParseError(
        "A link body takes identity criteria only — the criteria ARE the identity, so 'unique by' doesn't belong here",
        uniqueBy[0].span.start,
      );
    }
    return {
      from,
      edge,
      target: { kind: 'criteria', explicitType, fields, span: this.spanFrom(targetStart) },
      span: this.spanFrom(start),
    };
  }

  private parseLinkStatement(): LinkStatement {
    const start = this.pos;
    this.pos += 'link'.length;
    const link = this.parseLinkExpression(start);
    this.expectStatementEnd();
    return { kind: 'link', link, span: this.spanFrom(start) };
  }

  /** `unlink a -[:e]-> b` — the inverse of the bare-handle `link`, same arrow shape. */
  private parseUnlinkStatement(): UnlinkStatement {
    const start = this.pos;
    this.pos += 'unlink'.length;
    const { from, edge, to } = this.parseEdgeParts();
    this.expectStatementEnd();
    return { kind: 'unlink', from, edge, to, span: this.spanFrom(start) };
  }

  /** `delete <handle>` — one bound name, the record to remove. */
  private parseDeleteStatement(): DeleteStatement {
    const start = this.pos;
    this.pos += 'delete'.length;
    this.skipInlineWs();
    const name = this.readName("the handle to delete — a bound name after 'delete'");
    this.expectStatementEnd();
    return { kind: 'delete', name, span: this.spanFrom(start) };
  }

  /** `refresh <handle>` — re-fetch the record behind a stable handle, moving
   *  its field snapshot to now (F5). One bound name. */
  private parseRefreshStatement(): RefreshStatement {
    const start = this.pos;
    this.pos += 'refresh'.length;
    this.skipInlineWs();
    const nameStart = this.pos;
    const name = this.readName("the handle to refresh — a bound name after 'refresh'");
    const nameSpan = this.spanFrom(nameStart);
    this.expectStatementEnd();
    return { kind: 'refresh', name, nameSpan, span: this.spanFrom(start) };
  }

  // ── await (asks-as-adapter wake primitive) ──

  /**
   * `await <head>-[:Edge WHERE …]->` or `await sleep(<duration>)`. `start` is
   * the position of the `await` keyword; `pos` is just past it. The WHERE lives
   * inside the hop brackets (existing traversal grammar); the checker enforces
   * it is a PURE predicate.
   */
  private parseAwait(start: number): AwaitExpression {
    this.skipInlineWs();
    const sourceStart = this.pos;
    // `await sleep(<duration>)` — the clock wake source. A `sleep` IDENTIFIER
    // followed by `(` is the sleep form; anything else is a traversal head
    // (a handle literally named `sleep` would need the `(` to be a sleep, and
    // an edge off it reads as a traversal — unambiguous).
    if (this.peekIdent() === 'sleep') {
      const save = this.pos;
      this.pos += 'sleep'.length;
      this.skipInlineWs();
      if (this.peekCh() === '(') {
        this.pos++;
        this.skipInlineWs();
        const duration = this.parseDuration();
        this.skipInlineWs();
        this.expect(')', "to close 'await sleep(<duration>)'");
        return {
          source: { kind: 'sleep', duration, span: this.spanFrom(sourceStart) },
          span: this.spanFrom(start),
        };
      }
      this.pos = save;
    }
    // `await until(<condition>, every: <duration>)` — the recurring clock wake
    // source. Like `sleep`, an `until` IDENTIFIER followed by `(` is the until
    // form; anything else falls through to a traversal head.
    if (this.peekIdent() === 'until') {
      const save = this.pos;
      this.pos += 'until'.length;
      this.skipInlineWs();
      if (this.peekCh() === '(') {
        this.pos++;
        this.skipAllWs();
        // arg1 — the condition: a closure returning boolean, or the boolean
        // expression that is the same closure with the ceremony elided.
        let condition: UntilCondition;
        if (this.peekCh() === '{') {
          this.error(
            "an 'until' condition that needs statements is a closure: `await until(() => { refresh a; return a.`State` == \"done\" }, every: 5m)`",
            this.pos,
          );
        }
        if (this.atClosure()) {
          condition = { kind: 'closure', closure: this.parseClosure(this.pos) };
        } else {
          const { slot } = this.readExprSlot({
            stops: ',)',
            context: "for the 'until' condition",
          });
          condition = { kind: 'expr', expr: slot };
        }
        this.skipAllWs();
        // The cadence is the only other thing an `until` takes, and it is
        // NAMED — there is no second positional slot to guess at.
        let every: DurationLiteral | undefined;
        if (this.peekCh() === ',') {
          this.pos++;
          this.skipAllWs();
          const argStart = this.pos;
          if (this.peekIdent() !== 'every') this.error(UNTIL_CADENCE_IS_NAMED, argStart);
          this.pos += 'every'.length;
          this.skipInlineWs();
          this.expect(':', "after 'every' in 'await until(<condition>, every: <duration>)'");
          this.skipInlineWs();
          every = this.parseDuration();
          this.skipAllWs();
        }
        this.expect(')', "to close 'await until(<condition>, every: <duration>)'");
        return {
          source: {
            kind: 'until',
            condition,
            ...(every !== undefined ? { every } : {}),
            span: this.spanFrom(sourceStart),
          },
          span: this.spanFrom(start),
        };
      }
      this.pos = save;
    }
    // `await race([…])` / `await parallel([…])` — the combinator wake sources
    // (core calculus v2 R5). The IDENTIFIER followed by `(` claims the form,
    // like sleep/until.
    if (this.peekIdent() === 'all') this.refuseRetiredAll(sourceStart);
    for (const kind of ['race', 'parallel'] as const) {
      if (this.peekIdent() === kind) {
        const save = this.pos;
        this.pos += kind.length;
        this.skipInlineWs();
        if (this.peekCh() === '(') {
          const combinator = this.parseCombinator(sourceStart, kind);
          return {
            source: { kind: 'combinator', combinator, span: this.spanFrom(sourceStart) },
            span: this.spanFrom(start),
          };
        }
        this.pos = save;
      }
    }
    // `await FIRST(<head>)` — the parked FIRST (layer 13 C1). Same shape as
    // sleep/until: the IDENTIFIER followed by `(` claims the form.
    if (this.peekIdent() === 'FIRST') {
      const save = this.pos;
      this.pos += 'FIRST'.length;
      this.skipInlineWs();
      if (this.peekCh() === '(') {
        this.pos++;
        this.skipInlineWs();
        const head = this.tryParsePathHead();
        if (!head) {
          this.error(
            `Expected a traversal inside 'await FIRST(…)' (\`await FIRST(a-[:Response]->)\`), found ${this.describeHere()}`,
            sourceStart,
          );
        }
        this.skipInlineWs();
        this.expect(')', "to close 'await FIRST(<traversal>)'");
        return {
          source: { kind: 'first', head, span: this.spanFrom(sourceStart) },
          span: this.spanFrom(start),
        };
      }
      this.pos = save;
    }
    const head = this.tryParsePathHead();
    if (!head) {
      this.error(
        `Expected \`await FIRST(a-[:Response]->)\`, \`await sleep(<duration>)\`, or \`await until(<condition>)\` after 'await', found ${this.describeHere()}`,
        sourceStart,
      );
    }
    return {
      source: { kind: 'traversal', head, span: this.spanFrom(sourceStart) },
      span: this.spanFrom(start),
    };
  }

  /** The unbound statement form (`await a-[:Response]->`, `await sleep(2d)`). The
   *  bound RValue form's terminator is enforced by the assign path;
   *  `parseAwait` itself no longer consumes it (so an `await` may sit inside a
   *  `;`-separated inline block), so the statement form enforces it here. */
  private parseAwaitStatement(): AwaitStatement {
    const start = this.pos;
    this.pos += 'await'.length;
    const expr = this.parseAwait(start);
    this.expectStatementEnd();
    return { kind: 'await', await: expr, span: this.spanFrom(start) };
  }

  // ── the concurrency combinators (core calculus v2 R5) ──

  /**
   * `race([…])` / `parallel([…])` written as a STATEMENT — the missing-`await`
   * spelling, plus the two retired brace forms, each refused by name. Returns
   * undefined when the word is an ordinary name here (`race = 5`), so the
   * caller falls through to the identifier-led grammar.
   */
  private tryParseCombinatorStatement(
    kind: 'race' | 'parallel',
    start: number,
  ): CombinatorStatement | undefined {
    const save = this.pos;
    this.pos += kind.length;
    this.skipInlineWs();
    if (this.peekCh() === '{') this.error(PARALLEL_BLOCK_RETIRED, start);
    if (this.peekCh() !== '(') {
      this.pos = save;
      return undefined;
    }
    const combinator = this.parseCombinator(start, kind);
    this.expectStatementEnd();
    return { kind: 'combinator', combinator, span: this.spanFrom(start) };
  }

  /** `all` is not a name any more — wherever it leads a combinator call, say
   *  what replaced it. A bare `all` is still an ordinary identifier. */
  private refuseRetiredAll(start: number): void {
    const save = this.pos;
    this.pos += 'all'.length;
    this.skipInlineWs();
    const isCall = this.peekCh() === '(';
    this.pos = save;
    if (isCall) this.error(ALL_RETIRED, start);
  }

  /**
   * `race(<arms>)` / `parallel(<arms>)`. `start` is the keyword's position;
   * `pos` is just past it. The argument is ordinary: a LITERAL bracket of arms,
   * or any expression yielding a collection of them. There is no evaluation
   * zone here — an arm is a function value, and the combinator is what calls it.
   */
  private parseCombinator(start: number, kind: 'race' | 'parallel'): CombinatorExpression {
    this.skipInlineWs();
    this.expect('(', `to open '${kind}([…])'`);
    this.skipAllWs();
    // The retired brace form: `race({ … }, { … })`.
    if (this.peekCh() === '{') this.error(RACE_BRANCHES_RETIRED, start);
    const arms = this.peekCh() === '['
      ? this.parseLiteralArms(kind)
      : this.parseDynamicArms(kind);
    this.skipAllWs();
    this.expect(')', `to close '${kind}([…])'`);
    return { kind, arms, span: this.spanFrom(start) };
  }

  /** `[f, () => { … }]` — the arms written down, so each slot is its own. */
  private parseLiteralArms(kind: 'race' | 'parallel'): CombinatorArms {
    const start = this.pos;
    this.pos++; // '['
    const arms: ArmExpression[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error(`Expected an arm or ']' to close '${kind}([…])'`, start);
      if (this.peekCh() === ']') {
        this.pos++;
        break;
      }
      arms.push(this.parseArm(kind));
      this.skipAllWs();
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      if (this.peekCh() === ']') {
        this.pos++;
        break;
      }
      this.error(
        `Expected ',' between arms or ']' to close, found ${this.describeHere()}`,
      );
    }
    if (arms.length === 0) {
      this.error(
        kind === 'race'
          ? "A race over no arms can never settle — give it at least one function to run: `await race([q, () => { await sleep(4h) }])`"
          : "A parallel over no arms runs nothing — give it at least one function: `await parallel([f, g])`",
        start,
      );
    }
    return { kind: 'literal', arms, span: this.spanFrom(start) };
  }

  /**
   * A function written where a function VALUE is expected — a closure in place,
   * or the name of one. Shared by the combinators' arms and the collection ops'
   * function argument, which are the same thing under two names: `role` and
   * `what` supply the words, so each site says what it wanted.
   */
  private parseArm(what: string, role = 'An arm of'): ArmExpression {
    const start = this.pos;
    if (this.atClosure()) {
      return { kind: 'closure', closure: this.parseClosure(start), span: this.spanFrom(start) };
    }
    if (this.peekCh() === '{') {
      this.error(
        `${role} '${what}' is a FUNCTION, not a block — wrap the statements in a closure: \`() => { … }\``,
        start,
      );
    }
    const name = this.peekCh() === '`' ? this.readBacktickName() : this.peekIdent();
    if (name === undefined || name.length === 0) {
      this.error(
        `Expected ${role.toLowerCase()} '${what}' — a function's name, or a closure (\`() => { … }\`) — found ${this.describeHere()}`,
        start,
      );
    }
    if (this.peekCh() !== '`') this.pos += name.length;
    this.skipInlineWs();
    if (this.peekCh() === '(') {
      this.error(
        `'${name}(…)' CALLS the function here; '${what}' is given the function itself, so it can call it. Write '${name}', or wrap the call: \`() => { ${name}(…) }\``,
        start,
      );
    }
    return { kind: 'ref', name, span: this.spanFrom(start) };
  }

  // ── the collection ops ──

  /** The surface spelling of each op, and the op it names. Uppercase, like
   *  every other function the language ships. */
  static readonly COLLECTION_OPS: ReadonlyMap<string, CollectionOp> = new Map([
    ['MAP', 'map'],
    ['FILTER', 'filter'],
    ['REDUCE', 'reduce'],
    ['GROUPBY', 'groupby'],
    ['KEYBY', 'keyby'],
  ] as const);

  /**
   * `MAP(xs, f)` / `FILTER(xs, f)` / `GROUPBY(xs, key)` / `KEYBY(xs, key)` —
   * a collection and a function; `REDUCE(xs, init, f)` puts the starting value
   * between them, where a reader expects it (the value the fold begins at,
   * then what carries it forward).
   */
  private parseCollectionOp(start: number, spelling: string, op: CollectionOp): CollectionOpExpression {
    this.skipInlineWs();
    this.expect('(', `to open '${spelling}(…)'`);
    const shape = op === 'reduce'
      ? `${spelling}(<collection>, <starting value>, <function>)`
      : `${spelling}(<collection>, <function>)`;
    const source = this.readCollectionArg(spelling, `the collection '${spelling}' reads`, shape);
    const init = op === 'reduce'
      ? this.readCollectionArg(spelling, `the value '${spelling}' starts from`, shape)
      : undefined;
    this.skipAllWs();
    const fn = this.parseArm(spelling, 'The function for');
    this.skipAllWs();
    this.expect(')', `to close '${spelling}(…)'`);
    return {
      op,
      source,
      ...(init !== undefined ? { init } : {}),
      fn,
      span: this.spanFrom(start),
    };
  }

  /** One value argument of a collection op, up to the comma that ends it. The
   *  function is always last, so every value argument has one. */
  private readCollectionArg(spelling: string, what: string, shape: string): ExprSlot {
    const start = this.pos;
    const { slot, stop } = this.readExprSlot({ stops: ',)', context: `for ${what}` });
    if (stop !== ',') {
      this.error(`'${spelling}' takes ${shape} — the function is missing`);
    }
    this.pos++; // the ','
    // A collection op (or `MEMBERS`) written INSIDE this one: they take a
    // function and a type, which an expression cannot hold, so they are read
    // as their own statement. Name the fix rather than let the expression
    // bridge report a stray character.
    const nested = nestedCollectionValue(slot.raw);
    if (nested !== undefined) {
      this.error(
        `'${nested}' is read on its own line, not inside '${spelling}(…)' — bind it first, then pass the name: \`answer = ${nested}(…)\` then \`${spelling}(answer, …)\``,
        start,
      );
    }
    return slot;
  }

  /**
   * `MEMBERS(<Thesis>)` — the values of a closed type. The argument is a TYPE,
   * so it is read with the type-marker grammar an extract field's annotation
   * uses (`allowFieldTail` for the borrowed spelling), not as an expression.
   */
  private parseMembers(start: number): MembersExpression {
    this.skipInlineWs();
    this.expect('(', "to open 'MEMBERS(<…>)'");
    this.skipAllWs();
    const typeStart = this.pos;
    const marker = this.readTypeMarker(
      "for 'MEMBERS' — a type you declare (<Thesis>) or another field's option set (<crm-[:companies]->.`funding_stage`>)",
      { allowFieldTail: true },
    );
    const typeSpan = this.spanFrom(typeStart);
    this.skipAllWs();
    this.expect(')', "to close 'MEMBERS(<…>)'");
    return { type: marker.text, span: this.spanFrom(start), typeSpan };
  }

  /** Arms built at run time — an ordinary expression yielding a collection of
   *  functions. Same-typed by construction, so the receipt is a list. */
  private parseDynamicArms(kind: 'race' | 'parallel'): CombinatorArms {
    const start = this.pos;
    const { slot } = this.readExprSlot({
      stops: ')',
      context: `for the arms of '${kind}(…)'`,
    });
    return { kind: 'dynamic', expr: slot, span: this.spanFrom(start) };
  }

  // ── callback (the deferred, addressable invocation) ──

  /**
   * `callback(<subject>)` / `callback(<subject>, { …config… })`. `start` is the
   * `callback` keyword's position; `pos` is just past it. The subject is one of:
   *
   *   callback({ … })                        an anonymous inline movement
   *   callback((d: <date>) => { … })         …with fire-time parameters
   *   callback(send_reminder)                a named movement
   *   callback(send_reminder(who: "sam"))    …with its fixed arguments
   *
   * The parameter list is the movement-declaration grammar verbatim, and the
   * argument list is the call grammar verbatim — a callback invents neither.
   * Config is always the SECOND argument, so nothing has to guess whether a
   * brace object is arguments or config.
   */
  private parseCallback(start: number): CallbackExpression {
    this.skipInlineWs();
    this.expect('(', "to open 'callback(…)'");
    this.skipAllWs();
    const subject = this.parseCallbackSubject();
    this.skipAllWs();
    let config: NamedArg[] = [];
    let configSpan: Span | undefined;
    if (this.peekCh() === ',') {
      this.pos++;
      this.skipAllWs();
      const configStart = this.pos;
      config = this.parseCallbackConfig();
      configSpan = this.spanFrom(configStart);
      this.skipAllWs();
    }
    this.expect(')', "to close 'callback(…)'");
    return {
      subject,
      config,
      ...(configSpan !== undefined ? { configSpan } : {}),
      span: this.spanFrom(start),
    };
  }

  private parseCallbackSubject(): CallbackSubject {
    const start = this.pos;
    // `callback()` — the BODY-LESS form. Not a special case: an anonymous
    // movement with an empty body. Firing it records the call and wakes
    // whoever awaits `Called`, which is exactly what an empty body does.
    if (this.peekCh() === ')') {
      return {
        kind: 'inline',
        closure: { params: [], body: [], span: this.spanFrom(start) },
        span: this.spanFrom(start),
      };
    }
    // `callback({ … })` — the closure with its parameter list elided.
    if (this.peekCh() === '{') {
      const body = this.parseBlockBody('a callback body');
      return {
        kind: 'inline',
        closure: { params: [], body, span: this.spanFrom(start) },
        span: this.spanFrom(start),
      };
    }
    // `callback((d: <date>) => { … })` — an ordinary closure, whose parameters
    // are what the PLATFORM supplies at fire time; and `callback((d: <date>))`
    // — body-less, whose call the author reads off `Called` instead of acting
    // on inline (the same closure with an empty body).
    if (this.peekCh() === '(') {
      const closureStart = this.pos;
      this.pos++;
      const params = this.parseParamList();
      this.skipAllWs();
      if (this.peekCh() === ')' || this.peekCh() === ',') {
        return {
          kind: 'inline',
          closure: { params, body: [], span: this.spanFrom(closureStart) },
          span: this.spanFrom(start),
        };
      }
      this.expect('=>', "between a callback's parameters and its body");
      this.skipAllWs();
      const body = this.parseBlockBody('a callback body');
      return {
        kind: 'inline',
        closure: { params, body, span: this.spanFrom(closureStart) },
        span: this.spanFrom(start),
      };
    }
    // `callback(<movementName>)` / `callback(<movementName>(…))` — the one
    // position where a movement is a VALUE.
    const nameStart = this.pos;
    const movement = this.readName(
      "a callback body ('{ … }' or '(<params>) => { … }') or the name of a movement",
    );
    const nameSpan = this.spanFrom(nameStart);
    let args: CallArg[] = [];
    if (this.peekCh() === '(') {
      this.pos++;
      args = this.parseCallArgs(movement, nameStart);
    }
    return { kind: 'named', movement, args, nameSpan, span: this.spanFrom(start) };
  }

  /**
   * `{ once: FALSE, ttl: 2d }` — the config object. Entries are read as RAW
   * named args and interpreted by the CHECKER (which owns the closed
   * vocabulary), so the parser never dispatches on a key's spelling.
   */
  private parseCallbackConfig(): NamedArg[] {
    const braceOffset = this.pos;
    this.expect('{', "to open a callback's config (e.g. { once: FALSE, ttl: 2d })");
    const config: NamedArg[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error("Expected '}' to close the callback's config", braceOffset);
      if (this.peekCh() === '}') {
        this.pos++;
        return config;
      }
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      const name = this.readIdent("a callback config key (e.g. 'once', 'ttl')");
      this.skipInlineWs();
      this.expect(':', `after the callback config key '${name}'`);
      const { slot } = this.readExprSlot({
        stops: ',}\n',
        context: `for the callback config '${name}'`,
      });
      config.push({ name, value: slot });
    }
  }

  // ── return + closures ──

  /**
   * `return <value>` — the one way a body hands a value back. What follows is
   * an ordinary right-hand side, so everything bindable is returnable and the
   * grammar gains nothing of its own.
   */
  private parseReturnStatement(): ReturnStatement {
    const start = this.pos;
    this.pos += 'return'.length;
    this.skipInlineWs();
    if (this.eof() || this.peekCh() === '\n' || this.peekCh() === '}' || this.peekCh() === ';') {
      this.error(
        "'return' hands a value back — write `return <value>`. A body that hands nothing back simply has no 'return'.",
        start,
      );
    }
    const value = this.parseRValue();
    this.expectStatementEnd();
    return { kind: 'return', value, span: this.spanFrom(start) };
  }

  /**
   * Is the parser at `(<params>) => {`? The parameter list and a traversal
   * head both start with characters an expression may also start with, so the
   * ARROW is what claims the form — found by scanning to the matching `)`
   * (the same balanced scanner every raw slot uses) and looking past it.
   * Restores the position either way.
   */
  /** Is this word immediately CALLED — `MAP(` rather than a name that happens
   *  to be spelled MAP? Restores the position either way. */
  private followedByCall(word: string): boolean {
    const save = this.pos;
    this.pos += word.length;
    this.skipInlineWs();
    const called = this.peekCh() === '(';
    this.pos = save;
    return called;
  }

  /**
   * Is the parser at `{ … }.name` — the retired inline block, rather than a
   * dict literal? Found the same way `atClosure` finds an arrow: scan to the
   * matching brace and look past it. Restores the position either way.
   */
  private atRetiredInlineBlock(): boolean {
    const save = this.pos;
    try {
      this.pos++; // the '{'
      this.scanBalanced({ stops: '}', context: 'a brace-led value' });
      this.pos++; // the '}'
      this.skipInlineWs();
      return this.peekCh() === '.';
    } catch {
      // Unbalanced, so nothing here can say what it is; let the expression
      // bridge report what it makes of the text.
      return false;
    } finally {
      this.pos = save;
    }
  }

  private atClosure(): boolean {
    if (this.peekCh() !== '(') return false;
    const save = this.pos;
    try {
      this.pos++;
      this.scanBalanced({ stops: ')', context: "a closure's parameter list" });
      this.pos++; // the ')'
      this.skipAllWs();
      return this.peekCh() === '=' && this.peekCh(1) === '>';
    } catch {
      // Not balanced, so not a parameter list; whatever it is, it is not ours
      // to report — the expression bridge will say what it makes of it.
      return false;
    } finally {
      this.pos = save;
    }
  }

  /**
   * `(<params>) => { … }` — an anonymous closure. `start` is the opening
   * paren's position (already at `(`). The parameter list is the movement
   * declaration's grammar verbatim; the body is an ordinary block body, so it
   * `return`s like every other body.
   */
  private parseClosure(start: number): ClosureExpression {
    this.expect('(', 'to open the closure parameter list');
    const params = this.parseParamList();
    this.skipAllWs();
    this.expect('=>', "between a closure's parameters and its body");
    this.skipAllWs();
    const body = this.parseBlockBody('a closure body');
    return { params, body, span: this.spanFrom(start) };
  }

  /**
   * `{ …statements… }.binding` — the RETIRED inline block expression. `start`
   * is the opening brace's position (already at `{`). Parsed so the checker
   * can refuse it by name and point at `return`.
   */
  private parseInlineBlock(start: number): InlineBlockExpression {
    const body = this.parseBlockBody('an inline block expression');
    this.skipInlineWs();
    if (this.peekCh() !== '.') {
      this.error(
        `An inline block expression is read by one of its bindings — write \`{ … }.name\`, found ${this.describeHere()}`,
        start,
      );
    }
    this.pos++;
    const bindingStart = this.pos;
    const binding = this.readName("a binding name after '{ … }.'");
    const bindingSpan = this.spanFrom(bindingStart);
    // No `expectStatementEnd()` here: the RValue assign path calls it after
    // `parseRValue` returns, and the `until(…)` condition path terminates on
    // `,`/`)` instead — so the terminator is the caller's to enforce.
    return { body, binding, bindingSpan, span: this.spanFrom(start) };
  }

  // ── if / parallel ──

  private parseIf(): IfStatement {
    const start = this.pos;
    this.pos += 'if'.length;
    const arms: IfStatement['arms'] = [];
    let elseArm: IfStatement['elseArm'];
    let armStart = start;
    for (;;) {
      // The condition runs up to the block's `{` and may wrap across lines —
      // a newline does NOT terminate it (a long `AND`/`OR` chain stays one
      // condition). A forgotten `{` is reported when the scan reaches EOF.
      const { slot, stop } = this.readExprSlot({
        stops: '{',
        context: "for the 'if' condition",
      });
      if (stop !== '{') this.error("Expected '{' after the 'if' condition");
      const body = this.parseBlockBody("the 'if' branch");
      arms.push({ condition: slot, body, span: this.spanFrom(armStart) });
      const save = this.pos;
      this.skipAllWs();
      if (this.peekIdent() !== 'else') {
        this.pos = save;
        break;
      }
      const elseStart = this.pos;
      this.pos += 'else'.length;
      this.skipInlineWs();
      if (this.peekIdent() === 'if') {
        this.pos += 'if'.length;
        armStart = elseStart;
        continue;
      }
      const elseBody = this.parseBlockBody("the 'else' branch");
      elseArm = { body: elseBody, span: this.spanFrom(elseStart) };
      break;
    }
    return { kind: 'if', arms, ...(elseArm ? { elseArm } : {}), span: this.spanFrom(start) };
  }

  /** A `<…>` type marker → TypeRef (`<graph>` or `<graph-[:position]->>`). */
  private typeRefFromMarker(
    marker: { text: string; hopsRaw?: string; position?: string; span: Span },
  ): TypeRef {
    return {
      graph: marker.text,
      ...(marker.position !== undefined ? { position: marker.position } : {}),
      ...(marker.hopsRaw !== undefined ? { hopsRaw: marker.hopsRaw } : {}),
      span: marker.span,
    };
  }

  /** A bare unit-suffixed duration literal (`4h`, `2d`, `90m`, `1h30m`). The
   *  exact unit grammar is validated in the checker. */
  private parseDuration(): DurationLiteral {
    const start = this.pos;
    while (!this.eof() && /[0-9A-Za-z]/.test(this.peekCh()!)) this.pos++;
    const raw = this.src.slice(start, this.pos);
    if (raw.length === 0 || !/[0-9]/.test(raw)) {
      this.error('Expected a duration literal (e.g. 4h, 2d, 90m, 1h30m)', start);
    }
    return { raw, span: this.spanFrom(start) };
  }

  /** `ERROR("message")` as a statement — fail the whole run with a reason. */
  private parseErrorStatement(): ErrorStatement {
    const start = this.pos;
    const message = this.parseErrorCall();
    this.expectStatementEnd();
    return { kind: 'error', message, span: this.spanFrom(start) };
  }

  /** Shared `ERROR( <expr> )` reader (statement + fallback terminal). Expects
   *  `pos` at the `ERROR` keyword; consumes through the closing ')'. */
  private parseErrorCall(): ExprSlot {
    this.expectWord('ERROR', "an 'ERROR(…)' call");
    this.skipInlineWs();
    this.expect('(', "after 'ERROR'");
    const { slot } = this.readExprSlot({ stops: ')', context: 'for the ERROR message' });
    this.expect(')', "to close the 'ERROR(…)' message");
    return slot;
  }

  // ── node declarations ──

  /**
   * `node doc { … }` — a NAMED node declaration, with `node` already at `this.pos`.
   *
   * Named-with-types is the declaration; anonymous-with-values is the literal
   * (`atNodeLiteral`). The two never overlap, so the grammar decides which one
   * an author wrote from the name alone and each refuses the other's position.
   */
  private parseNodeDeclaration(): ShapeDeclaration {
    const start = this.pos;
    this.pos += 'node'.length;
    this.skipInlineWs();
    const name = this.readName("a name after 'node'");
    const root = this.parseDeclaredNode(name, start);
    return { kind: 'shape', name, root, span: this.spanFrom(start) };
  }

  /** Is `type <name> = …` — a REFINEMENT declaration — next? Consumes nothing. */
  private atTypeDeclaration(): boolean {
    if (this.peekIdent() !== 'type') return false;
    const save = this.pos;
    this.pos += 'type'.length;
    this.skipInlineWs();
    let declares = false;
    if (/[A-Za-z_`]/.test(this.peekCh() ?? '')) {
      try {
        this.readName('a name');
        this.skipInlineWs();
        declares = this.peekCh() === '=';
      } catch {
        declares = false;
      }
    }
    this.pos = save;
    return declares;
  }

  /** `type Thesis = <"A" | "B">` — a closed set of text values, written where a
   *  borrowed option set would otherwise be fetched. */
  private parseTypeDeclaration(): TypeDeclaration {
    const start = this.pos;
    this.pos += 'type'.length;
    this.skipInlineWs();
    const name = this.readName("a name after 'type'");
    this.skipInlineWs();
    this.expect('=', `after the declared type '${name}' (\`type ${name} = <"A" | "B">\`)`);
    this.skipInlineWs();
    this.expect('<', `to open '${name}'s values (\`<"A" | "B">\`)`);
    const options: string[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.peekCh() !== '"') this.error(typeValuesAreText(name), this.pos);
      options.push(this.readQuotedString(`as a value of '${name}'`).text);
      this.skipAllWs();
      if (!this.tryConsume('|')) break;
    }
    this.expect('>', `to close '${name}'s values`);
    this.expectStatementEnd();
    return { kind: 'type', name, options, span: this.spanFrom(start) };
  }

  /** One node of a declaration tree: its fields, then its nested named children.
   *  A child's name IS the edge that reaches it, so nesting is the whole edge
   *  grammar — there is no separate edge line. */
  private parseDeclaredNode(name: string, start: number): ShapeNode {
    this.skipInlineWs();
    const braceOffset = this.pos;
    this.expect('{', `to open the node '${name}'`);
    const fields: ShapeNode['fields'] = [];
    const children: ShapeNode[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error(`Expected '}' to close the node '${name}'`, braceOffset);
      if (this.peekCh() === '}') {
        this.pos++;
        break;
      }
      if (this.peekIdent() === 'edge') {
        this.error(
          `'edge' lines are retired — nest the node inside the one that reaches it, and the nesting IS the edge: 'node ${name} { … node <edge name> { … } }'`,
        );
      }
      if (this.atNodeLiteral()) {
        this.error(
          `a nested node in the declaration '${name}' is NAMED, and its name is the relationship that reaches it — write 'node <edge name> { … }'`,
        );
      }
      if (this.peekIdent() === 'node') {
        const childStart = this.pos;
        this.pos += 'node'.length;
        this.skipInlineWs();
        const childName = this.readName("a name after 'node'");
        children.push(this.parseDeclaredNode(childName, childStart));
        continue;
      }
      const fieldStart = this.pos;
      const fieldName = this.readName('a field name');
      this.skipInlineWs();
      this.expect(':', `after the field name '${fieldName}'`);
      this.skipInlineWs();
      // The type wears angle brackets: a primitive (`name: <text>`) or a
      // borrowed path into another graph's schema — the same annotation
      // extract fields take: `crm_stage: <crm-[:companies]->.\`funding_stage\`>`.
      const marker = this.readTypeMarker(
        `for the field '${fieldName}' (e.g. <text>, <number>)`,
        { allowFieldTail: true },
      );
      fields.push({ name: fieldName, type: marker.text, span: this.spanFrom(fieldStart) });
      this.expectStatementEnd();
    }
    return { name, fields, children, span: this.spanFrom(start) };
  }

  // ── export ──

  /**
   * `export movement …` / `export node …` — marks the declaration as
   * offered to other files. A file with at least one export is a
   * LIBRARY; the categorisation is explicit vocabulary, not inferred
   * from what happens to be un-fired.
   */
  private parseExport(): Statement {
    const start = this.pos;
    this.pos += 'export'.length;
    this.skipInlineWs();
    const next = this.peekIdent();
    if (next === 'movement' || next === 'function') {
      const declaration = this.parseMovement(next);
      return { ...declaration, exported: true, span: this.spanFrom(start) };
    }
    if (next === 'node' && this.atNodeDeclaration()) {
      const declaration = this.parseNodeDeclaration();
      return { ...declaration, exported: true, span: this.spanFrom(start) };
    }
    this.error(
      "'export' marks a declaration as offered to other files — write `export movement <name>(…) { … }` or `export node <name> { … }`",
      start,
    );
  }

  // ── movement ──

  /** `movement <name>(…) { … }` / `function <name>(…) { … }` — one declaration,
   *  two spellings (`function` is a pure parser alias; the AST keeps one kind).
   *  `keyword` is the spelling the author used, so diagnostics echo it. */
  private parseMovement(keyword: MovementKeyword = 'movement'): MovementDeclaration {
    const start = this.pos;
    this.pos += keyword.length;
    this.skipInlineWs();
    const name = this.readName(`a name after '${keyword}'`);
    this.skipInlineWs();
    this.expect('(', `after the ${keyword} name '${name}'`);
    const params = this.parseParamList();
    const body = this.parseBlockBody(`the ${keyword} '${name}'`);
    return { kind: 'movement', name, params, body, span: this.spanFrom(start) };
  }

  /**
   * A typed parameter list — `(m: <inbox-[:message]->>, d: <date>)` — with the
   * opening `(` already consumed; consumes through the closing `)`. The ONE
   * parameter grammar: a movement declaration's, and an anonymous inline
   * movement's inside `callback((d: <date>) => { … })`.
   */
  private parseParamList(): MovementParam[] {
    const params: MovementParam[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.peekCh() === ')') {
        this.pos++;
        break;
      }
      const paramStart = this.pos;
      const paramName = this.readName('a parameter name');
      this.skipInlineWs();
      // A parameter with no `: <type>` is one whose type the CALLER supplies —
      // legal only where something does (a collection op's function). The
      // checker owns that rule; the grammar just records what was written.
      if (this.peekCh() === ',' || this.peekCh() === ')') {
        params.push({ name: paramName, span: this.spanFrom(paramStart) });
        if (this.peekCh() === ',') {
          this.pos++;
          continue;
        }
        this.pos++; // the ')'
        break;
      }
      this.expect(':', `after the parameter '${paramName}'`);
      this.skipAllWs();
      // A parameter's type names what the callable accepts — a bare graph
      // (`<inbox>`), a scalar, or an ADDRESS (`<at-[:\`Record Change\`
      // WHERE …]->>`): the surface a listen is checked against.
      const marker = this.readTypeMarker(
        `for the parameter '${paramName}' (e.g. <inbox-[:message]->>)`,
        { allowHops: true },
      );
      params.push({ name: paramName, type: this.typeRefFromMarker(marker), span: this.spanFrom(paramStart) });
      this.skipAllWs();
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      if (this.peekCh() !== ')') {
        this.error(`Expected ',' or ')' in the parameter list, found ${this.describeHere()}`);
      }
    }
    return params;
  }

  // ── listen ──

  /**
   * `listen to <name> { <named-config> } fire <movement>` — config optional.
   * `<name>` references a CONSTRUCTED instance (`go = manual()` then `listen
   * to go {}`) or the ambient `kg`. An inline construction call —
   * `listen to manual() {}` — still PARSES (the call lands in `construct`)
   * but the checker rejects it with a "construct an instance and name it
   * first" diagnostic; parsing it (rather than erroring on the `(`) lets the
   * checker point at the real fix instead of emitting a confusing
   * "expected fire" parse error.
   */
  private parseListen(): ListenDeclaration {
    const start = this.pos;
    this.pos += 'listen'.length;
    this.skipInlineWs();
    let alias: string | undefined;
    if (this.peekIdent() === 'as') {
      this.pos += 'as'.length;
      this.skipInlineWs();
      alias = this.readQuotedString('after `listen as` (e.g. listen as "Alice\'s meetings")').text;
      this.skipInlineWs();
    }
    this.expectWord('to', "after 'listen'");
    this.skipInlineWs();
    const instanceStart = this.pos;
    const instance = this.readName("an instance name after 'listen to'");
    let construct: ConstructionCall | undefined;
    if (this.peekCh() === '(') {
      const constructStart = instanceStart;
      this.pos++;
      const args: NamedArg[] = [];
      for (;;) {
        this.skipAllWs();
        if (this.eof()) {
          this.error(`Expected ')' to close 'listen to ${instance}(…)'`, constructStart);
        }
        if (this.peekCh() === ')') {
          this.pos++;
          break;
        }
        if (this.peekCh() === ',') {
          this.pos++;
          continue;
        }
        const argName = this.readIdent(`a construction argument of '${instance}'`);
        this.skipInlineWs();
        this.expect(':', `after the construction argument '${argName}'`);
        const { slot, stop } = this.readExprSlot({
          stops: ',)',
          context: `for the construction argument '${argName}'`,
        });
        args.push({ name: argName, value: slot });
        if (stop === ',') this.pos++;
      }
      construct = { callee: instance, args, span: this.spanFrom(constructStart) };
    }
    this.skipInlineWs();
    const config: NamedArg[] = [];
    if (this.peekCh() === '{') {
      const braceOffset = this.pos;
      this.pos++;
      for (;;) {
        this.skipAllWs();
        if (this.eof()) this.error("Expected '}' to close the listener config", braceOffset);
        if (this.peekCh() === '}') {
          this.pos++;
          break;
        }
        if (this.peekCh() === ',') {
          this.pos++;
          continue;
        }
        const name = this.readIdent('a config key in the listener config');
        this.skipInlineWs();
        this.expect(':', `after the config key '${name}'`);
        this.skipInlineWs();
        if (this.peekCh() === '<') {
          // A TYPE value — `type: <company>` in a kg listen. Types wear
          // angle brackets everywhere; the AST stores the bare spelling.
          const marker = this.readTypeMarker(`for the config key '${name}'`);
          config.push({
            name,
            value: { raw: marker.text, span: marker.span },
            isType: true,
          });
          this.skipInlineWs();
          if (this.peekCh() === ',') this.pos++;
          continue;
        }
        const { slot, stop } = this.readExprSlot({
          stops: ',\n}',
          allowEof: false,
          context: `for the config key '${name}'`,
        });
        config.push({ name, value: slot });
        if (stop === ',') this.pos++;
      }
      this.skipInlineWs();
    }
    this.expectWord('fire', `after 'listen to ${instance}${config.length > 0 ? ' { … }' : ''}'`);
    this.skipInlineWs();
    const movement = this.readName("a movement name after 'fire'");
    this.expectStatementEnd();
    return {
      kind: 'listen',
      instance,
      ...(alias !== undefined ? { alias } : {}),
      ...(construct !== undefined ? { construct } : {}),
      config,
      movement,
      span: this.spanFrom(start),
    };
  }

  // ── extract ──

  private parseExtract(start: number): ExtractExpression {
    this.skipInlineWs();
    // `extract "thorough" from […]` — the optional tier sits between the
    // keyword and `from`, the one slot in this statement that already demands
    // a specific word, so a string literal there is unambiguous by
    // construction: no lookahead against `through` or the stage brace. Read
    // verbatim; WHICH words are tiers is the checker's.
    let tier: string | undefined;
    if (this.peekCh() === '"') {
      tier = this.readQuotedString("as the extract's tier").text;
      this.skipInlineWs();
    }
    this.expectWord('from', "after 'extract'");
    this.skipInlineWs();
    const bracketOffset = this.pos;
    this.expect('[', "after 'extract from'");
    const from: ExprSlot[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.peekCh() === ']') {
        this.pos++;
        break;
      }
      const { slot, stop } = this.readExprSlot({
        stops: ',]',
        context: "in the 'extract from […]' data list",
      });
      from.push(slot);
      if (stop === ',') this.pos++;
    }
    if (from.length === 0) {
      this.error("'extract from […]' needs at least one data item", bracketOffset);
    }
    const stages: ExtractStage[] = [];
    const firstThrough = this.tryParseThrough();
    this.skipAllWs();
    if (this.peekCh() !== '{') {
      this.error(`Expected '{' to open the extraction stage, found ${this.describeHere()}`);
    }
    stages.push(this.parseExtractStage(firstThrough));
    this.parseChainedStages(stages);
    return { from, stages, ...(tier !== undefined ? { tier } : {}), span: this.spanFrom(start) };
  }

  /** Repeated `through [plugins] { stage }` chains following a stage. */
  private parseChainedStages(stages: ExtractStage[]): void {
    for (;;) {
      const through = this.tryParseThrough();
      if (!through) return;
      this.skipAllWs();
      if (this.peekCh() !== '{') {
        this.error(
          `Expected '{' to open the extraction stage after 'through […]', found ${this.describeHere()}`,
        );
      }
      stages.push(this.parseExtractStage(through));
    }
  }

  /** `through [scrub, fetch(urls: urls)]` — restores position if 'through' isn't next. */
  private tryParseThrough(): PluginCall[] | undefined {
    const save = this.pos;
    this.skipAllWs();
    if (this.peekIdent() !== 'through') {
      this.pos = save;
      return undefined;
    }
    const throughOffset = this.pos;
    this.pos += 'through'.length;
    this.skipInlineWs();
    this.expect('[', "after 'through'");
    const plugins: PluginCall[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.peekCh() === ']') {
        this.pos++;
        break;
      }
      const pluginStart = this.pos;
      const plugin = this.readIdent("a plugin name in 'through […]'");
      const args: NamedArg[] = [];
      this.skipInlineWs();
      if (this.peekCh() === '(') {
        this.pos++;
        for (;;) {
          this.skipAllWs();
          if (this.peekCh() === ')') {
            this.pos++;
            break;
          }
          const argName = this.readIdent(`an argument name for the plugin '${plugin}'`);
          this.skipInlineWs();
          this.expect(':', `after the argument '${argName}'`);
          const { slot, stop } = this.readExprSlot({
            stops: ',)',
            context: `for the argument '${argName}'`,
          });
          args.push({ name: argName, value: slot });
          if (stop === ',') this.pos++;
        }
      }
      plugins.push({ plugin, args, span: this.spanFrom(pluginStart) });
      this.skipAllWs();
      if (this.peekCh() === ',') {
        this.pos++;
        continue;
      }
      if (this.peekCh() !== ']') {
        this.error(`Expected ',' or ']' in 'through […]', found ${this.describeHere()}`);
      }
    }
    if (plugins.length === 0) {
      this.error("'through […]' needs at least one plugin", throughOffset);
    }
    return plugins;
  }

  private parseExtractStage(through: PluginCall[] | undefined): ExtractStage {
    const braceOffset = this.pos;
    this.expect('{', 'to open the extraction stage');
    const fields: ExtractField[] = [];
    const children: ExtractNode[] = [];
    for (;;) {
      this.skipAllWs();
      if (this.eof()) this.error("Expected '}' to close the extraction stage", braceOffset);
      if (this.peekCh() === '}') {
        this.pos++;
        break;
      }
      if (this.peekIdent() === 'node') {
        children.push(this.parseExtractNode());
        continue;
      }
      const fieldStart = this.pos;
      const name = this.readName("a field name or 'node' in the extraction stage");
      this.skipInlineWs();
      this.expect(':', `after '${name}'`);
      this.skipInlineWs();
      let type: string | undefined;
      if (this.peekCh() !== '"') {
        // An explicit annotation wears angle brackets: a primitive
        // (`amount: <number> "…"`) or a borrowed path into another graph's
        // schema (`stage: <crm-[:companies]->.\`funding_stage\`> "…"`).
        const marker = this.readTypeMarker(
          `or a double-quoted description for the extract field '${name}'`,
          { allowFieldTail: true },
        );
        type = marker.text;
        this.skipAllWs();
        if (this.peekCh() !== '"') {
          this.error(
            `Expected a double-quoted description for the extract field '${name}' after the type '<${type}>', found ${this.describeHere()}`,
          );
        }
      }
      const description = this.readStringSlot(`for the extract field '${name}'`);
      fields.push({ name, type, description, span: this.spanFrom(fieldStart) });
      this.expectStatementEnd();
    }
    return { through, fields, children, span: this.spanFrom(braceOffset) };
  }

  private parseExtractNode(): ExtractNode {
    const start = this.pos;
    this.pos += 'node'.length;
    this.skipInlineWs();
    const name = this.readName("a node name after 'node'");
    this.skipInlineWs();
    this.expect(':', `after the node name '${name}'`);
    this.skipAllWs();
    if (this.peekCh() !== '"') {
      this.error(
        `Expected a double-quoted description for the node '${name}', found ${this.describeHere()}`,
      );
    }
    const description = this.readStringSlot(`for the node '${name}'`);
    this.skipAllWs();
    if (this.peekCh() !== '{') {
      this.error(
        `Expected '{' to open the node '${name}'s extraction stage, found ${this.describeHere()}`,
      );
    }
    const stages: ExtractStage[] = [this.parseExtractStage(undefined)];
    this.parseChainedStages(stages);
    return { name, description, stages, span: this.spanFrom(start) };
  }
}

/** The name of a collection op (or `MEMBERS`) written at the head of an
 *  expression slot — a form that is a statement, not a value. */
function nestedCollectionValue(raw: string): string | undefined {
  const head = /^\s*([A-Z]+)\s*\(/.exec(raw)?.[1];
  if (head === undefined) return undefined;
  return head === 'MEMBERS' || Parser.COLLECTION_OPS.has(head) ? head : undefined;
}
