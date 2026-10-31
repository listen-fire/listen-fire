// The part of a listen's WHERE a module takes (adapter protocol 2.6's
// `filter`), read as comparisons. The checker hands a module only conjuncts
// it can take: each compares one landing field with literals (`==`, `IN`, an
// OR of `==` on one field, or an operator the field declares), joined by AND.
// A module reads them here, applies what its provider can upstream, and
// applies the rest itself with `holds`, so it can say `takenApplied: true`.

/** One taken conjunct: `field op value`, an OR of `==` read as `in`. */
export interface TakenComparison {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
  /** A scalar, or the list an `in` compares with. */
  value: Scalar | Scalar[];
}

type Scalar = string | number | boolean | null;

const OPS: readonly TakenComparison['op'][] = ['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte'];

function isOp(op: string): op is TakenComparison['op'] {
  return OPS.some((known) => known === op);
}
const MIRRORED: Record<string, TakenComparison['op']> = { eq: 'eq', neq: 'neq', gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte' };

function field(expr: unknown): string | undefined {
  if (typeof expr !== 'object' || expr === null) return undefined;
  const type: unknown = Reflect.get(expr, 'type');
  const name: unknown = Reflect.get(expr, 'propertyTypeId');
  return (type === 'property' || type === 'edge_property') && typeof name === 'string' ? name : undefined;
}

function scalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function literal(expr: unknown): Scalar | Scalar[] | undefined {
  if (typeof expr !== 'object' || expr === null) return undefined;
  const type: unknown = Reflect.get(expr, 'type');
  if (type === 'static') {
    const value: unknown = Reflect.get(expr, 'value');
    if (Array.isArray(value)) return value.every(scalar) ? value : undefined;
    return scalar(value) ? value : undefined;
  }
  if (type !== 'list') return undefined;
  const elements: unknown = Reflect.get(expr, 'elements');
  if (!Array.isArray(elements)) return undefined;
  const values: Scalar[] = [];
  for (const element of elements) {
    const value = literal(element);
    if (value === undefined || Array.isArray(value)) return undefined;
    values.push(value);
  }
  return values;
}

function comparison(expr: unknown): TakenComparison | undefined {
  if (typeof expr !== 'object' || expr === null) return undefined;
  const type: unknown = Reflect.get(expr, 'type');
  if (type === 'logical' && Reflect.get(expr, 'op') === 'or') {
    const operands: unknown = Reflect.get(expr, 'operands');
    if (!Array.isArray(operands)) return undefined;
    let name: string | undefined;
    const values: Scalar[] = [];
    for (const operand of operands) {
      const one = comparison(operand);
      if (one === undefined || one.op !== 'eq' || Array.isArray(one.value) || (name !== undefined && one.field !== name)) return undefined;
      name = one.field;
      values.push(one.value);
    }
    return name === undefined ? undefined : { field: name, op: 'in', value: values };
  }
  if (type !== 'compare') return undefined;
  const op: unknown = Reflect.get(expr, 'op');
  if (typeof op !== 'string' || !isOp(op)) return undefined;
  const left: unknown = Reflect.get(expr, 'left');
  const right: unknown = Reflect.get(expr, 'right');
  const onLeft = field(left);
  if (onLeft !== undefined) {
    const value = literal(right);
    return value === undefined || !isOp(op) ? undefined : { field: onLeft, op, value };
  }
  const onRight = field(right);
  const mirrored = MIRRORED[op];
  const value = literal(left);
  return onRight === undefined || mirrored === undefined || value === undefined ? undefined : { field: onRight, op: mirrored, value };
}

/**
 * The taken filter's conjuncts, in order. Absent filter: none. Undefined when
 * a part is not a comparison this reads, so the module applies none of it and
 * leaves the whole filter to the host (`takenApplied` false).
 */
export function takenComparisons(filter: unknown): TakenComparison[] | undefined {
  if (filter === undefined || filter === null) return [];
  const out: TakenComparison[] = [];
  const visit = (expr: unknown): boolean => {
    if (typeof expr === 'object' && expr !== null && Reflect.get(expr, 'type') === 'logical' && Reflect.get(expr, 'op') === 'and') {
      const operands: unknown = Reflect.get(expr, 'operands');
      return Array.isArray(operands) && operands.every(visit);
    }
    const one = comparison(expr);
    if (one !== undefined) out.push(one);
    return one !== undefined;
  };
  return visit(filter) ? out : undefined;
}

/** The texts a comparison narrows its field to: `==` one, `IN` several;
 *  undefined for any other comparison. */
export function narrowedTo(comparison: TakenComparison): string[] | undefined {
  if (comparison.op === 'eq' && !Array.isArray(comparison.value) && comparison.value !== null) return [String(comparison.value)];
  if (comparison.op === 'in' && Array.isArray(comparison.value)) return comparison.value.filter((v) => v !== null).map(String);
  return undefined;
}

function order(left: unknown, right: unknown): number | undefined {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') {
    const a = Date.parse(left);
    const b = Date.parse(right);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return undefined;
}

function same(left: unknown, right: unknown): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

/** Whether `value` (a landing's field) satisfies the comparison, as the
 *  engine compares (crates/movement-engine filter.rs `compare_values`). */
export function holds(value: unknown, comparison: TakenComparison): boolean {
  const right = comparison.value;
  switch (comparison.op) {
    case 'eq':
      return Array.isArray(value) && Array.isArray(right) ? value.length === right.length && value.every((v) => right.some((r) => same(v, r))) : same(value, right);
    case 'neq':
      return !holds(value, { ...comparison, op: 'eq' });
    case 'in':
      return Array.isArray(right) && right.some((r) => same(r, value));
    case 'contains':
      if (typeof value === 'string' && typeof right === 'string') return value.includes(right);
      return Array.isArray(value) && value.some((v) => same(v, right));
    case 'gt':
      return (order(value, right) ?? NaN) > 0;
    case 'gte':
      return (order(value, right) ?? NaN) >= 0;
    case 'lt':
      return (order(value, right) ?? NaN) < 0;
    case 'lte':
      return (order(value, right) ?? NaN) <= 0;
    default:
      return unknownOp(comparison.op);
  }
}

function unknownOp(op: never): never {
  throw new Error(`a taken comparison with an unknown operator ${String(op)}`);
}
