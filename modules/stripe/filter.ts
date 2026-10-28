// Pushing a hop's WHERE down to the query parameters of Stripe's listings.
//
// The engine ALWAYS satisfies the predicate itself over whatever comes back,
// so nothing here is needed for correctness — only how much is fetched. That
// is why only `==` CONJUNCTS of a field and a text literal push: a predicate
// under an OR or a NOT need not hold of every matching row. Matching is by
// both the field id and the display name, because a hop's WHERE may carry
// either; a miss just widens the fetch.
//
// One thing is not optional: Stripe's subscription listing leaves canceled
// subscriptions out unless asked. A WHERE that pins no status asks for `all`,
// or an unfiltered walk would silently lose every canceled one.
//
// Each translation also says whether it is EXACT — every conjunct pushed as
// Stripe evaluates it — because only then may the hop's LIMIT bound the fetch:
// n rows of a superset, narrowed afterwards, would be fewer than n.

import type { Expression } from 'engine-contracts/expression/expression';

import type { StripeListQuery } from './api_client';

/** The listing parameters each listing takes from a WHERE, by the names a
 *  WHERE may give the field, and the values Stripe accepts (any, for none). */
interface Pushable {
  param: string;
  names: readonly string[];
  values?: readonly string[];
}

const STATUS = (values: readonly string[]): Pushable => ({ param: 'status', names: ['status', 'Status'], values });
const COLLECTION_METHOD: Pushable = { param: 'collection_method', names: ['collection_method', 'Collection Method'], values: ['charge_automatically', 'send_invoice'] };
const EMAIL: Pushable = { param: 'email', names: ['email', 'Email'] };

function propertyName(expr: Expression): string | undefined {
  return expr.type === 'property' || expr.type === 'edge_property' ? expr.propertyTypeId : undefined;
}

function literalString(expr: Expression): string | undefined {
  return expr.type === 'static' && typeof expr.value === 'string' && expr.value !== '' ? expr.value : undefined;
}

/** The `field == "text"` leaves of an AND tree, and whether anything else
 *  (another comparison, an OR, a NOT, a call) sat in the tree. */
function equalitiesOf(where: Expression | undefined): { equalities: Array<{ field: string; value: string }>; other: boolean } {
  const equalities: Array<{ field: string; value: string }> = [];
  let other = false;
  const visit = (expr: Expression): void => {
    if (expr.type === 'logical' && expr.op === 'and') {
      expr.operands.forEach(visit);
      return;
    }
    if (expr.type === 'compare' && expr.op === 'eq') {
      const field = propertyName(expr.left) ?? propertyName(expr.right);
      const value = literalString(expr.left) ?? literalString(expr.right);
      if (field !== undefined && value !== undefined) {
        equalities.push({ field, value });
        return;
      }
    }
    other = true;
  };
  if (where !== undefined) visit(where);
  return { equalities, other };
}

/** A listing's query from a WHERE, over the parameters it takes. */
function queryFromWhere(where: Expression | undefined, pushable: readonly Pushable[]): { query: StripeListQuery; exact: boolean } {
  const { equalities, other } = equalitiesOf(where);
  const query: StripeListQuery = {};
  let exact = !other;
  for (const { field, value } of equalities) {
    const target = pushable.find((p) => p.names.includes(field));
    const accepted = target !== undefined && (target.values === undefined || target.values.includes(value));
    if (target === undefined || !accepted || query[target.param] !== undefined) {
      exact = false;
      continue;
    }
    query[target.param] = value;
  }
  return { query, exact };
}

/** `Customers`: `Email ==` reaches Stripe (its match is case-sensitive). */
export function customerQueryFromWhere(where: Expression | undefined): { query: StripeListQuery; exact: boolean } {
  return queryFromWhere(where, [EMAIL]);
}

/** `Invoices`: `Status ==` and `Collection Method ==` reach Stripe. */
export function invoiceQueryFromWhere(where: Expression | undefined, statuses: readonly string[]): { query: StripeListQuery; exact: boolean } {
  return queryFromWhere(where, [STATUS(statuses), COLLECTION_METHOD]);
}

/** `Subscriptions`: `Status ==` and `Collection Method ==` reach Stripe; no
 *  status asks for every status, canceled included. */
export function subscriptionQueryFromWhere(where: Expression | undefined, statuses: readonly string[]): { query: StripeListQuery; exact: boolean } {
  const { query, exact } = queryFromWhere(where, [STATUS(statuses), COLLECTION_METHOD]);
  return { query: { status: 'all', ...query }, exact };
}
