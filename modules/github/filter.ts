// Pushing a hop's WHERE down to GitHub's query parameters.
//
// The engine ALWAYS satisfies the predicate itself over whatever comes back,
// so nothing here is needed for correctness — only how much is fetched. That
// is why only CONJUNCTS push: a predicate under an OR or a NOT need not hold
// of every matching row, so narrowing on it would drop rows the hop should
// have seen. Matching is by both the internal field id and the display name,
// because a hop's WHERE may carry either; a miss just widens the fetch.
//
// One thing is not optional: GitHub's issue and pull request listings default
// to `state=open`. A WHERE that names no state must ask for `all`, or an
// unfiltered walk would silently lose every closed record.
//
// Each translation also says whether it is EXACT — every conjunct pushed as
// GitHub evaluates it — because only then may the hop's LIMIT bound the fetch:
// n rows of a superset, narrowed afterwards, would be fewer than n.

import type { Expression } from 'engine-contracts/expression/expression';
import type { GithubIssueQuery } from './api_client';

type Op = 'eq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

interface Conjunct {
  field: string;
  op: Op;
  value: Expression;
}

/** The field a WHERE operand reads: a bare backticked field in a hop is an
 *  `edge_property`, a body-level one a `property`. Alias-qualified reads are
 *  deliberately not pushed (the alias may name an outer position). */
function propertyName(expr: Expression): string | undefined {
  return expr.type === 'property' || expr.type === 'edge_property' ? expr.propertyTypeId : undefined;
}

function literalString(expr: Expression): string | undefined {
  return expr.type === 'static' && typeof expr.value === 'string' && expr.value !== '' ? expr.value : undefined;
}

/** The `compare` leaves of an AND tree, field on the left, and whether
 *  anything else (an OR, a NOT, a call) sat in the tree. */
function conjunctsOf(where: Expression | undefined): { conjuncts: Conjunct[]; other: boolean } {
  const conjuncts: Conjunct[] = [];
  let other = false;
  const MIRROR = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte', eq: 'eq' } as const;
  const visit = (expr: Expression): void => {
    if (expr.type === 'logical' && expr.op === 'and') {
      expr.operands.forEach(visit);
      return;
    }
    if (expr.type !== 'compare') {
      other = true;
      return;
    }
    const { op } = expr;
    if (op === 'contains') {
      const field = propertyName(expr.left);
      if (field !== undefined) conjuncts.push({ field, op, value: expr.right });
      else other = true;
      return;
    }
    if (op === 'in') {
      // `"bug" IN i.Labels`: a value that is one of a multi field's members.
      const field = propertyName(expr.right);
      if (field !== undefined) conjuncts.push({ field, op: 'contains', value: expr.left });
      else other = true;
      return;
    }
    if (op !== 'eq' && op !== 'gt' && op !== 'gte' && op !== 'lt' && op !== 'lte') {
      other = true;
      return;
    }
    const left = propertyName(expr.left);
    if (left !== undefined) conjuncts.push({ field: left, op, value: expr.right });
    else {
      const right = propertyName(expr.right);
      if (right !== undefined) conjuncts.push({ field: right, op: MIRROR[op], value: expr.left });
      else other = true;
    }
  };
  if (where !== undefined) visit(where);
  return { conjuncts, other };
}

const STATE_NAMES = new Set(['state', 'State']);
const AUTHOR_NAMES = new Set(['author', 'Author']);
const LABEL_NAMES = new Set(['label_names', 'Label Names']);
const ASSIGNEE_NAMES = new Set(['assignees', 'Assignees']);
const UPDATED_NAMES = new Set(['updated_at', 'Updated At']);
const FULL_NAME_NAMES = new Set(['full_name', 'Full Name']);

/** The `state` a conjunct pins, when it is one GitHub's listing takes. */
function stateOf(conjunct: Conjunct): 'open' | 'closed' | undefined {
  if (!STATE_NAMES.has(conjunct.field) || conjunct.op !== 'eq') return undefined;
  const value = literalString(conjunct.value);
  return value === 'open' || value === 'closed' ? value : undefined;
}

/** What a repository's `Pull Requests` walk asks GitHub for. Only the state
 *  reaches the pulls listing; the rest of the WHERE runs over what returns. */
export function pullQueryFromWhere(where: Expression | undefined): { state: 'open' | 'closed' | 'all'; exact: boolean } {
  const { conjuncts, other } = conjunctsOf(where);
  let state: 'open' | 'closed' | undefined;
  let exact = !other;
  for (const conjunct of conjuncts) {
    const pinned = stateOf(conjunct);
    if (pinned !== undefined && state === undefined) state = pinned;
    else exact = false;
  }
  return { state: state ?? 'all', exact };
}

/** What a repository's `Issues` walk asks GitHub for: state, labels (all of
 *  them, as GitHub ANDs them), one assignee, the author, and an `Updated At`
 *  lower bound as `since`. */
export function issueQueryFromWhere(where: Expression | undefined): { query: GithubIssueQuery; exact: boolean } {
  const { conjuncts, other } = conjunctsOf(where);
  let state: 'open' | 'closed' | undefined;
  const labels: string[] = [];
  let assignee: string | undefined;
  let creator: string | undefined;
  let since: string | undefined;
  let exact = !other;
  for (const conjunct of conjuncts) {
    const pinned = stateOf(conjunct);
    if (pinned !== undefined && state === undefined) {
      state = pinned;
      continue;
    }
    const value = literalString(conjunct.value);
    if (value !== undefined && conjunct.op === 'contains' && LABEL_NAMES.has(conjunct.field)) {
      labels.push(value);
      continue;
    }
    if (value !== undefined && conjunct.op === 'contains' && ASSIGNEE_NAMES.has(conjunct.field) && assignee === undefined) {
      assignee = value;
      continue;
    }
    if (value !== undefined && conjunct.op === 'eq' && AUTHOR_NAMES.has(conjunct.field) && creator === undefined) {
      creator = value;
      continue;
    }
    // `since` narrows to a superset (its boundary is GitHub's to draw), so the
    // bound is pushed and the translation stops being exact.
    if (value !== undefined && (conjunct.op === 'gt' || conjunct.op === 'gte') && UPDATED_NAMES.has(conjunct.field) && !Number.isNaN(Date.parse(value))) {
      if (since === undefined || value > since) since = value;
    }
    exact = false;
  }
  return {
    query: {
      state: state ?? 'all',
      ...(labels.length > 0 ? { labels } : {}),
      ...(assignee !== undefined ? { assignee } : {}),
      ...(creator !== undefined ? { creator } : {}),
      ...(since !== undefined ? { since } : {}),
    },
    exact,
  };
}

/** The `Updated At` window a `Notifications` or `Comments` walk can push as
 *  `since` / `before`. Never exact: the boundaries are GitHub's. */
export function updatedWindowFromWhere(where: Expression | undefined): { since?: string; before?: string } {
  let since: string | undefined;
  let before: string | undefined;
  for (const conjunct of conjunctsOf(where).conjuncts) {
    if (!UPDATED_NAMES.has(conjunct.field)) continue;
    const value = literalString(conjunct.value);
    if (value === undefined || Number.isNaN(Date.parse(value))) continue;
    if ((conjunct.op === 'gt' || conjunct.op === 'gte') && (since === undefined || value > since)) since = value;
    if ((conjunct.op === 'lt' || conjunct.op === 'lte') && (before === undefined || value < before)) before = value;
  }
  return { ...(since !== undefined ? { since } : {}), ...(before !== undefined ? { before } : {}) };
}

/** The one repository a `Repositories` walk pins by `Full Name ==
 *  "owner/name"`, fetched directly instead of listing every repository. The
 *  full name is GitHub's own `{owner}/{repo}` path. */
export function pinnedRepository(where: Expression | undefined): { owner: string; repo: string } | undefined {
  for (const conjunct of conjunctsOf(where).conjuncts) {
    if (!FULL_NAME_NAMES.has(conjunct.field) || conjunct.op !== 'eq') continue;
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(literalString(conjunct.value) ?? '');
    if (match?.[1] !== undefined && match[2] !== undefined) return { owner: match[1], repo: match[2] };
  }
  return undefined;
}
