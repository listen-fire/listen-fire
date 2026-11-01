// The part of a listen's WHERE a module takes (adapter protocol 2.6's
// `filter`), read as comparisons. The checker hands a module only conjuncts
// it can take: each compares one landing field with literals (`==`, `IN`, an
// OR of `==` or of `CONTAINS` on one field, or an operator the field
// declares), joined by AND.
// A module reads them here, applies what its provider can upstream, and
// applies the rest itself with `holds`, so it can say `takenApplied: true`.

/** One taken conjunct: `field op value`, an OR of `==` read as `in` and an
 *  OR of `CONTAINS` as `containsAny` (the field contains any of the values). */
export interface TakenComparison {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'contains' | 'containsAny' | 'gt' | 'gte' | 'lt' | 'lte';
  /** A scalar, or the list an `in` or a `containsAny` compares with. */
  value: Scalar | Scalar[];
}

type Scalar = string | number | boolean | null;

/** The operators a `compare` node carries; `containsAny` is only ever an OR. */
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
    let first: TakenComparison | undefined;
    const values: Scalar[] = [];
    for (const operand of operands) {
      const one = comparison(operand);
      // `x == null` asks for absence, which an `in` list cannot say: left to the host.
      if (one === undefined || (one.op !== 'eq' && one.op !== 'contains') || Array.isArray(one.value) || one.value === null) return undefined;
      if (first !== undefined && (one.field !== first.field || one.op !== first.op)) return undefined;
      first ??= one;
      values.push(one.value);
    }
    return first === undefined ? undefined : { field: first.field, op: first.op === 'eq' ? 'in' : 'containsAny', value: values };
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

/** A finite number, or a text that reads as one (`Number`, blank refused):
 *  what orders numerically. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const read = Number(value);
  return Number.isFinite(read) ? read : undefined;
}

/** Days from 1970-01-01 to a proleptic Gregorian date. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

const ISO_INSTANT = /^(?:([+-])(\d{6})|(\d{4}))(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO 8601 / RFC 3339 text as an instant (epoch ms), a text with no
 *  offset read as UTC; undefined for any other text, a day its month lacks,
 *  the hour 24 (crates/movement-engine js_date.rs `parse`). */
function isoInstant(text: string): number | undefined {
  const m = ISO_INSTANT.exec(text);
  if (m === null) return undefined;
  const [, sign, signed, plain, mm, dd, hh, mi, ss, fraction, offset] = m;
  if (sign === '-' && Number(signed) === 0) return undefined;
  const year = plain !== undefined ? Number(plain) : (sign === '-' ? -1 : 1) * Number(signed);
  const month = mm !== undefined ? Number(mm) : 1;
  const day = dd !== undefined ? Number(dd) : 1;
  const nextMonth = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  if (month < 1 || month > 12 || day < 1 || day > nextMonth - daysFromCivil(year, month, 1)) return undefined;
  let ms = daysFromCivil(year, month, day) * 86_400_000;
  if (hh !== undefined) {
    const [hour, minute, second] = [Number(hh), Number(mi), ss !== undefined ? Number(ss) : 0];
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    ms += hour * 3_600_000 + minute * 60_000 + second * 1000 + (fraction !== undefined ? Number(fraction.slice(0, 3).padEnd(3, '0')) : 0);
    if (offset !== undefined && offset.toUpperCase() !== 'Z') {
      const [hours, minutes] = [Number(offset.slice(1, 3)), Number(offset.slice(-2))];
      if (hours > 23 || minutes > 59) return undefined;
      ms += (offset.startsWith('+') ? -1 : 1) * (hours * 60 + minutes) * 60_000;
    }
  }
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? Math.trunc(ms) + 0 : undefined;
}

/** A value as an instant: a finite number as itself, a boolean as 0 or 1,
 *  anything else by its text, as an ISO instant. */
function instant(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return isoInstant(String(value));
}

/** How two values order for `> >= < <=`: as numbers when both are (numeric
 *  texts included), else as instants when both are, else as texts when both
 *  are; undefined when they do not order (crates/movement-engine filter.rs
 *  `relational_order`). */
function order(left: unknown, right: unknown): number | undefined {
  const [ln, rn] = [finiteNumber(left), finiteNumber(right)];
  if (ln !== undefined && rn !== undefined) return Math.sign(ln - rn);
  const [li, ri] = [instant(left), instant(right)];
  if (li !== undefined && ri !== undefined) return Math.sign(li - ri);
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  return undefined;
}

/** SameValueZero: `===`, but NaN is NaN. */
function same(left: unknown, right: unknown): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

/** Two lists equal as sets: the same distinct members. */
function setEquals(left: readonly unknown[], right: readonly unknown[]): boolean {
  const distinct = (items: readonly unknown[]) => items.filter((item, i) => items.findIndex((other) => same(other, item)) === i).length;
  return distinct(left) === distinct(right) && left.every((v) => right.some((r) => same(v, r)));
}

/** Whether `value` (a landing's field) satisfies the comparison, exactly as
 *  the engine's judge decides it (crates/movement-engine filter.rs
 *  `compare_values` and `compare_to_null`), held to
 *  engine-contracts/conformance/taken-comparisons.json. */
export function holds(value: unknown, comparison: TakenComparison): boolean {
  const right = comparison.value;
  // `x == null` / `x != null` ask whether it is there; any other operator
  // against null holds nothing.
  if (right === null) return comparison.op === 'eq' ? value === null || value === undefined : comparison.op === 'neq' && value !== null && value !== undefined;
  switch (comparison.op) {
    case 'eq':
      return Array.isArray(value) && Array.isArray(right) ? setEquals(value, right) : value === right;
    case 'neq':
      return Array.isArray(value) && Array.isArray(right) ? !setEquals(value, right) : value !== right;
    case 'in':
      return Array.isArray(right) && right.some((r) => same(r, value));
    case 'contains':
      if (typeof value === 'string' && typeof right === 'string') return value.includes(right);
      return Array.isArray(value) && value.some((v) => same(v, right));
    case 'containsAny':
      return Array.isArray(right) && right.some((r) => holds(value, { field: comparison.field, op: 'contains', value: r }));
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
