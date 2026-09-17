/**
 * The default arm of an exhaustive `switch`. Hand it the value the switch has
 * run out of cases for: when every case is covered that value is `never` and
 * this compiles, and the moment a variant is added it is a type error HERE,
 * which is the whole point — the compiler, not a survey, finds the sites.
 *
 * It returns `any` so the arm can sit in a function of any return type without
 * the call site restating one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function neverAsAny(x: never): any {
  return x;
}
