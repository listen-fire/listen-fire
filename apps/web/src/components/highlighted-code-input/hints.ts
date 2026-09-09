// Unified caret hint for the source-traversal / formula editor. Resolves,
// in priority order: the function-call signature (most specific), then the
// meta-edge config argument the caret is in, then the meta-edge itself.
// This carries the guidance that used to live in the standing "Extract"
// inspector section into contextual, caret-driven hints.

import {
  functionStackAtCaret,
  functionNameHintAt,
  type SignatureHint,
  type ExtraSignatures,
} from "./function-signatures";

export type EditorHint =
  | ({ kind: "function" } & SignatureHint)
  | { kind: "meta-edge"; label: string; summary: string }
  | { kind: "meta-edge-arg"; label: string; summary: string }
  | { kind: "token"; label: string; summary: string };

/** Resolve the leaf token the caret is on (a field / edge / alias) into a
 *  hint. Injected by the consumer, which has the descriptor / ontology to
 *  resolve semantics — the editor primitive only knows structure. */
export type ResolveLeaf = (
  text: string,
  caret: number,
) => { label: string; summary: string } | null;

const META_EDGES: Record<string, { label: string; summary: string }> = {
  extract: {
    label: "#extract",
    summary:
      "The model reads the data fields and materialises one node per match — one extraction per entity the description asks for.",
  },
  transform: {
    label: "#transform",
    summary: "Runs a plugin that augments the source with derived nodes.",
  },
  resources: {
    label: "#resources",
    summary: "Selects a resource bundle (e.g. an email's attachments) to read.",
  },
};

const META_EDGE_ARGS: Record<
  string,
  Record<string, { label: string; summary: string }>
> = {
  extract: {
    description: {
      label: "description:",
      summary:
        "What the model should extract — usually a static string; expressions are allowed.",
    },
    data: {
      label: "data:",
      summary:
        "Which source fields hold the text / File the model reads (for an email, usually the body).",
    },
    enrich_with: {
      label: "enrich_with:",
      summary:
        "Per-entity enrichment: { transform, argument } pairs run for each extracted entity.",
    },
  },
  transform: {
    plugin: {
      label: "plugin:",
      summary: "The transform plugin to run.",
    },
    config: {
      label: "config:",
      summary: "Plugin-specific configuration.",
    },
  },
};

const isIdentChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);

/**
 * Which meta-edge (and config key, if any) the caret sits in. Scans the
 * full active region — from the last complete `]->` before the caret to the
 * end of text — so a `#extract` keyword or a `key:` label the caret sits
 * *within* is still recognised (not just text before the caret). The config
 * is split into top-level `key: value` segments with character ranges; the
 * key is whichever segment's range contains the caret. String / backtick
 * literals are skipped so brackets or the word "data" inside the
 * description don't mislead.
 */
export function metaEdgeContextAtCaret(
  text: string,
  caret: number,
): { metaEdge: string; key?: string } | null {
  const lastClose = text.lastIndexOf("]->", Math.max(0, caret - 1));
  const regionStart = lastClose >= 0 ? lastClose + 3 : 0;
  const region = text.slice(regionStart);
  const c = caret - regionStart;

  const m = /#(extract|transform|resources)(?![A-Za-z0-9_])/.exec(region);
  if (!m) return null;
  const metaEdge = m[1];
  const metaEnd = m.index + m[0].length;

  // Caret on (or before) the meta-edge keyword itself → meta-edge level.
  if (c <= metaEnd) return { metaEdge };

  // Walk the config object, collecting top-level `key: value` segments with
  // their character ranges.
  const segments: { key?: string; start: number; end: number }[] = [];
  let i = metaEnd;
  let inConfig = false;
  let depth = 0;
  let segStart = -1;
  let currentKey: string | undefined;
  while (i < region.length) {
    const ch = region[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < region.length && region[i] !== quote) {
        if (region[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (!inConfig) {
      if (ch === "{") {
        inConfig = true;
        depth = 1;
        segStart = i + 1;
        currentKey = undefined;
      } else if (ch === "]") {
        break; // token closed with no config
      }
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) {
        segments.push({ key: currentKey, start: segStart, end: i });
        inConfig = false;
      }
      i++;
      continue;
    }
    if (ch === "," && depth === 1) {
      segments.push({ key: currentKey, start: segStart, end: i });
      segStart = i + 1;
      currentKey = undefined;
      i++;
      continue;
    }
    if (depth === 1 && currentKey === undefined && isIdentChar(ch)) {
      let j = i;
      while (j < region.length && isIdentChar(region[j])) j++;
      let k = j;
      while (k < region.length && (region[k] === " " || region[k] === "\t")) k++;
      if (region[k] === ":") {
        currentKey = region.slice(i, j);
        i = k + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  // Caret inside a still-open config — the final segment runs to the end.
  if (inConfig) segments.push({ key: currentKey, start: segStart, end: region.length });

  for (const seg of segments) {
    if (c >= seg.start && c <= seg.end) {
      return seg.key ? { metaEdge, key: seg.key } : { metaEdge };
    }
  }
  return { metaEdge };
}

/**
 * The full inside-out hint stack at the caret (innermost layer first):
 * the leaf token → enclosing function calls → meta-edge config arg →
 * meta-edge. The renderer slices this to its configured depth. `resolveLeaf`
 * (consumer-injected) adds the leaf field / edge / alias layer; without it
 * the stack is structural-only.
 */
export function contextStackAtCaret(
  text: string,
  caret: number,
  opts?: { resolveLeaf?: ResolveLeaf; functionSignatures?: ExtraSignatures },
): EditorHint[] {
  const layers: EditorHint[] = [];

  // Leaf: a function name the caret sits ON, else a consumer-resolved
  // field / edge / alias token.
  const fnName = functionNameHintAt(text, caret, opts?.functionSignatures);
  if (fnName) {
    layers.push({ kind: "function", ...fnName });
  } else {
    const leaf = opts?.resolveLeaf?.(text, caret);
    if (leaf) layers.push({ kind: "token", label: leaf.label, summary: leaf.summary });
  }

  // Enclosing function calls (innermost-first).
  for (const fn of functionStackAtCaret(text, caret, opts?.functionSignatures)) {
    layers.push({ kind: "function", ...fn });
  }

  // Meta-edge config arg, then the meta-edge itself.
  const ctx = metaEdgeContextAtCaret(text, caret);
  if (ctx) {
    if (ctx.key) {
      const arg = META_EDGE_ARGS[ctx.metaEdge]?.[ctx.key];
      if (arg) layers.push({ kind: "meta-edge-arg", label: arg.label, summary: arg.summary });
    }
    const me = META_EDGES[ctx.metaEdge];
    if (me) layers.push({ kind: "meta-edge", label: me.label, summary: me.summary });
  }

  return layers;
}

export function editorHintAtCaret(
  text: string,
  caret: number,
  opts?: { resolveLeaf?: ResolveLeaf; functionSignatures?: ExtraSignatures },
): EditorHint | null {
  return contextStackAtCaret(text, caret, opts)[0] ?? null;
}
