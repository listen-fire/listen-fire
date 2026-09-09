// CodeMirror language support for `.mvt` movement scripts.
//
// A StreamLanguage tokenizer (no Lezer grammar — the movement parser owns
// real syntax; highlighting only needs token classes) covering:
//   - `#` comments (but `#resources`-style meta names inside `-[` hops);
//   - double-quoted strings, multiline, with `${…}` interpolation islands
//     tokenized as code;
//   - backtick-quoted field names;
//   - lowercase statement keywords vs UPPERCASE expression keywords and
//     functions;
//   - `-[` `]->` traversal punctuation.

import {
  HighlightStyle,
  StreamLanguage,
  StringStream,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

const STATEMENT_KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "as",
  "to",
  "through",
  "node",
  "type",
  "movement",
  "function",
  "listen",
  "fire",
  "extract",
  "write",
  "unique",
  "by",
  "bind",
  "link",
  "unlink",
  "delete",
  "refresh",
  "await",
  "lazy",
  "race",
  "callback",
  "sleep",
  "until",
  "if",
  "else",
  "parallel",
]);

const EXPRESSION_KEYWORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "IS",
  "CONTAINS",
  "IN",
  "EXISTS",
  "WHERE",
  "IF",
  "THEN",
  "ELSE",
  "END",
  "TRUE",
  "FALSE",
  "NULL",
  "AS",
  "ERROR",
]);

// A string frame remembers the quote that opened it, so " and ' are equivalent
// string delimiters and a ' inside a "…" string (or vice versa) doesn't close
// it early. (CodeMirror's default copyState slices the stack array.)
type Frame = { mode: "string"; quote: '"' | "'" } | { mode: "interp" };

interface MvtState {
  stack: Frame[];
}

function tokenInString(stream: StringStream, state: MvtState): string {
  const top = state.stack[state.stack.length - 1];
  const quote = top?.mode === "string" ? top.quote : '"';
  while (!stream.eol()) {
    if (stream.match("${")) {
      state.stack.push({ mode: "interp" });
      return "meta";
    }
    const ch = stream.next();
    if (ch === "\\") {
      stream.next();
    } else if (ch === quote) {
      state.stack.pop();
      break;
    }
  }
  return "string";
}

function tokenize(stream: StringStream, state: MvtState): string | null {
  const top = state.stack[state.stack.length - 1];
  if (top?.mode === "string") return tokenInString(stream, state);

  if (stream.eatWhile(/[ \t]/)) return null;

  // Interpolation island closes on `}` (braces never nest inside `${…}` —
  // the expression grammar has no block braces).
  if (top?.mode === "interp" && stream.peek() === "}") {
    stream.next();
    state.stack.pop();
    return "meta";
  }

  // Comments — except `#name` right after `[` (meta edges like `-[#resources`).
  if (stream.peek() === "#") {
    const prev = stream.string[stream.pos - 1];
    if (prev === "[") {
      stream.next();
      stream.eatWhile(/\w/);
      return "labelName";
    }
    stream.skipToEnd();
    return "comment";
  }

  const quote = stream.peek();
  if (quote === '"' || quote === "'") {
    stream.next();
    state.stack.push({ mode: "string", quote });
    return "string";
  }

  // Backticks are just whitespace-safe quoting around an identifier, so a
  // backtick-quoted name highlights the same as a bare one (variableName) —
  // the quoting is a spelling detail, not a different kind of thing.
  if (stream.match("`")) {
    while (!stream.eol()) {
      if (stream.next() === "`") break;
    }
    return "variableName";
  }

  // Type markers — types always wear angle brackets (`<inbox-[:message]->>`,
  // `<number>`, `<crm-[:companies]->.\`funding_stage\`>`). A single-name
  // marker is one token; an ADDRESS marker highlights its root as the type
  // name and leaves the hop to the traversal punctuation below — an address
  // IS a walk, so it reads like one. The expression `<` (comparison) never
  // abuts an identifier this way.
  if (stream.match(/^<[A-Za-z_]\w*>/)) return "typeName";
  if (stream.match(/^<[A-Za-z_]\w*(?=\s*-\[)/)) return "typeName";

  // Traversal punctuation.
  if (stream.match("<-[") || stream.match("-[") || stream.match("]->")) return "angleBracket";

  if (stream.match(/^\d+(\.\d+)?/)) return "number";

  if (stream.match(/^@[A-Za-z_][\w.]*/)) return "atom";

  const word = stream.match(/^[A-Za-z_]\w*/);
  if (word) {
    const text = (word as RegExpMatchArray)[0];
    if (STATEMENT_KEYWORDS.has(text)) return "keyword";
    if (/^[A-Z][A-Z0-9_]*$/.test(text)) {
      if (EXPRESSION_KEYWORDS.has(text)) return "operatorKeyword";
      return "macroName"; // CONCAT, AI, COUNT, … — expression functions
    }
    return "variableName";
  }

  if (stream.match("==") || stream.match("!=") || stream.match("<=") || stream.match(">=")) {
    return "operator";
  }
  const ch = stream.next();
  if (ch === undefined) return null;
  if ("=<>+-*/".includes(ch)) return "operator";
  if ("(){}[],.:".includes(ch)) return "punctuation";
  return null;
}

export interface MvtToken {
  text: string;
  style: string | null;
}

// Unit-test seam: drives `tokenize` exactly the way StreamLanguage's
// Parse.parseLine does — one StringStream per line, state threaded
// across lines, blank lines skipped (the language has no blankLine
// hook). Returns per-line token lists.
export function tokenizeDocument(source: string): MvtToken[][] {
  const state: MvtState = { stack: [] };
  return source.split("\n").map((line) => {
    const tokens: MvtToken[] = [];
    if (line === "") return tokens;
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = tokenize(stream, state);
      if (stream.pos === stream.start) {
        throw new Error(`Tokenizer failed to advance at "${line.slice(stream.pos)}"`);
      }
      tokens.push({ text: stream.current(), style });
    }
    return tokens;
  });
}

export const movementLanguage = StreamLanguage.define<MvtState>({
  name: "movement",
  startState: () => ({ stack: [] }),
  token: tokenize,
  languageData: {
    commentTokens: { line: "#" },
  },
});

// Palette anchored on the Listen-Fire violet (primary #8778F7): the violet
// family carries the language's own words (statement + expression
// keywords, interpolation), with a handful of restrained semantic hues —
// green strings, teal functions, amber field names, fuchsia traversal.
export const movementHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#6B5BD4", fontWeight: "600" },
  { tag: tags.operatorKeyword, color: "#5242A8", fontWeight: "600" },
  { tag: tags.macroName, color: "#0e7490" },
  { tag: tags.typeName, color: "#1d4ed8", fontWeight: "500" },
  { tag: tags.string, color: "#15803d" },
  { tag: tags.meta, color: "#8778F7", fontWeight: "600" },
  { tag: tags.comment, color: "#9ca3af", fontStyle: "italic" },
  { tag: tags.angleBracket, color: "#a21caf" },
  { tag: tags.labelName, color: "#a21caf", fontStyle: "italic" },
  { tag: tags.number, color: "#0369a1" },
  { tag: tags.atom, color: "#b45309" },
  { tag: tags.operator, color: "#6b7280" },
  { tag: tags.variableName, color: "#1f2937" },
]);

export const movementSyntax = [movementLanguage, syntaxHighlighting(movementHighlightStyle)];
