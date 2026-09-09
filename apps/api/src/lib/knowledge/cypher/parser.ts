import {
  str,
  regex,
  char,
  choice,
  sequenceOf,
  many,
  many1,
  possibly,
  recursiveParser,
  between,
  sepBy1,
  optionalWhitespace,
  endOfInput,
  type Parser,
} from 'arcsecond';

import type {
  CypherQuery,
  MutationCypherQuery,
  MutationClause,
  SetItem,
  SetClause,
  RemoveClause,
  DeleteClause,
  CreateClause,
  MergeClause,
  ParseResult,
  MatchClause,
  PatternPath,
  NodePattern,
  RelationshipPattern,
  Expression,
  PropertyAccess,
  ParameterRef,
  ReturnClause,
  ReturnItem,
  OrderByItem,
} from './types';

// Arcsecond's generic inference is loose — helper to cast
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P<T> = Parser<T, any, any>;

// --- Whitespace helpers ---

const ws = optionalWhitespace;
const eof: P<null> = sequenceOf([ws, endOfInput]).map(() => null) as P<null>;

// Consume leading whitespace before parser
function tok<T>(parser: P<T>): P<T> {
  return sequenceOf([ws, parser]).map((r: unknown) => (r as [unknown, T])[1]);
}

function sym(c: string): P<string> {
  return tok(char(c) as P<string>);
}

// Case-insensitive keyword (must be followed by word boundary)
function kw(keyword: string): P<string> {
  return regex(new RegExp(`^${keyword}\\b`, 'i')).map(() => keyword) as P<string>;
}

// --- Identifiers ---

const unquotedIdent: P<string> = regex(/^[a-zA-Z_][a-zA-Z0-9_]*/) as P<string>;
const backtickIdent: P<string> = (
  between(char('`'))(char('`'))(regex(/^[^`]+/)) as P<string>
);
const ident: P<string> = choice([backtickIdent, unquotedIdent]) as P<string>;
const tokIdent: P<string> = tok(ident);

// Label identifier: used after : inside () and [] — allows spaces (reads up to closing bracket)
// e.g. (:Funding Round) or [:Member Of]
// Surrounding whitespace is never meaningful in a label, so trim it in the
// backticked form too — LLM-generated queries occasionally emit
// [:` Deal For`], which would otherwise silently resolve to nothing.
const labelIdent: P<string> = choice([
  (backtickIdent as P<string>).map((s: string) => s.trim()),
  (regex(/^[a-zA-Z_][a-zA-Z0-9_ ]*/) as P<string>).map((s: string) => s.trimEnd()),
]) as P<string>;

// --- Literals ---

function escapedString(quote: string): P<string> {
  const escapes = [
    str(`\\${quote}`).map(() => quote),
    str('\\n').map(() => '\n'),
    str('\\t').map(() => '\t'),
    str('\\\\').map(() => '\\'),
    regex(new RegExp(`^[^${quote === "'" ? "'" : '"'}\\\\]+`)),
  ] as P<string>[];

  return (
    between(char(quote))(char(quote))(
      (many(choice(escapes)) as P<string[]>).map((parts: string[]) => parts.join('')),
    ) as P<string>
  );
}

const stringLiteral: P<Expression> = choice([
  escapedString("'"),
  escapedString('"'),
]).map((value: unknown): Expression => ({ kind: 'literal', value: value as string })) as P<Expression>;

const numberLiteral: P<Expression> = (regex(/^-?\d+(\.\d+)?/) as P<string>).map(
  (s: string): Expression => ({ kind: 'literal', value: parseFloat(s) }),
);

const booleanLiteral: P<Expression> = choice([
  kw('TRUE').map((): Expression => ({ kind: 'literal', value: true })),
  kw('FALSE').map((): Expression => ({ kind: 'literal', value: false })),
]) as P<Expression>;

const nullLiteral: P<Expression> = kw('NULL').map(
  (): Expression => ({ kind: 'literal', value: null }),
);

const literal: P<Expression> = tok(
  choice([booleanLiteral, nullLiteral, numberLiteral, stringLiteral]) as P<Expression>,
);

// List literal: [expr, expr, ...]
const listLiteral: P<Expression> = (
  between(sym('['))(sym(']'))(
    sepBy1(sym(','))(tok(recursiveParser(() => expression) as P<Expression>)),
  ) as P<unknown>
).map((elements: unknown): Expression => ({
  kind: 'list',
  elements: elements as Expression[],
}));

// Map literal: {key: expr, key: expr, ...}
const mapEntry: P<{ key: string; value: Expression }> = (
  sequenceOf([
    tokIdent,
    sym(':'),
    tok(recursiveParser(() => expression) as P<Expression>),
  ]) as P<unknown>
).map((parts: unknown) => {
  const [key, , value] = parts as [string, unknown, Expression];
  return { key, value };
});

const mapLiteral: P<Expression> = (
  between(sym('{'))(sym('}'))(
    sepBy1(sym(','))(mapEntry as P<{ key: string; value: Expression }>),
  ) as P<unknown>
).map((entries: unknown): Expression => ({
  kind: 'map',
  entries: entries as { key: string; value: Expression }[],
}));

// --- Node property predicate: {key: value, ...} ---

const nodePropertyEntry: P<{ key: string; value: Expression }> = (
  sequenceOf([
    tokIdent,
    sym(':'),
    tok(recursiveParser(() => expression) as P<Expression>),
  ]) as P<unknown>
).map((parts: unknown) => {
  const [key, , value] = parts as [string, unknown, Expression];
  return { key, value };
});

const nodeProperties: P<{ key: string; value: Expression }[]> = (
  between(sym('{'))(sym('}'))(
    sepBy1(sym(','))(nodePropertyEntry as P<{ key: string; value: Expression }>),
  ) as P<unknown>
).map((entries: unknown) => entries as { key: string; value: Expression }[]);

// --- Node pattern: (var:Label {key: value}) ---

const nodePattern: P<NodePattern> = (
  between(sym('('))(sym(')'))(
    sequenceOf([
      possibly(tokIdent),
      possibly(sequenceOf([sym(':'), tok(labelIdent)])),
      possibly(tok(nodeProperties)),
    ]),
  ) as P<unknown>
).map((parts: unknown): NodePattern => {
  const [variable, labelPart, props] = parts as [
    string | null,
    [string, string] | null,
    { key: string; value: Expression }[] | null,
  ];
  return {
    kind: 'node',
    ...(variable ? { variable } : {}),
    ...(labelPart ? { label: labelPart[1] } : {}),
    ...(props ? { properties: props } : {}),
  };
});

// --- Relationship pattern ---

const relDetail: P<{ variable?: string; type?: string }> = (
  between(char('['))(char(']'))(
    sequenceOf([possibly(tok(ident)), possibly(sequenceOf([sym(':'), tok(labelIdent)]))]),
  ) as P<unknown>
).map((parts: unknown) => {
  const [variable, typePart] = parts as [string | null, [string, string] | null];
  return {
    ...(variable ? { variable } : {}),
    ...(typePart ? { type: typePart[1] } : {}),
  };
});

const optRelDetail: P<{ variable?: string; type?: string }> = (
  possibly(relDetail) as P<{ variable?: string; type?: string } | null>
).map((d) => d ?? {});

const relationshipPattern: P<RelationshipPattern> = (
  choice([
    // <-[...]- (incoming)
    sequenceOf([str('<-'), tok(optRelDetail), tok(char('-'))]).map(
      (r: unknown): RelationshipPattern => ({
        kind: 'relationship',
        ...(r as [unknown, { variable?: string; type?: string }])[1],
        direction: 'incoming',
      }),
    ),
    // -[...]-> (outgoing)
    sequenceOf([char('-'), tok(optRelDetail), tok(str('->'))]).map(
      (r: unknown): RelationshipPattern => ({
        kind: 'relationship',
        ...(r as [unknown, { variable?: string; type?: string }])[1],
        direction: 'outgoing',
      }),
    ),
    // -[...]- (undirected)
    sequenceOf([char('-'), tok(optRelDetail), tok(char('-'))]).map(
      (r: unknown): RelationshipPattern => ({
        kind: 'relationship',
        ...(r as [unknown, { variable?: string; type?: string }])[1],
        direction: 'undirected',
      }),
    ),
  ]) as P<RelationshipPattern>
);

// --- Pattern path ---

const patternPath: P<PatternPath> = (
  sequenceOf([
    tok(nodePattern),
    many(sequenceOf([tok(relationshipPattern), tok(nodePattern)])),
  ]) as P<unknown>
).map((parts: unknown): PatternPath => {
  const [first, rest] = parts as [NodePattern, [RelationshipPattern, NodePattern][]];
  const elements: (NodePattern | RelationshipPattern)[] = [first];
  for (const [rel, node] of rest) {
    elements.push(rel, node);
  }
  return { elements };
});

// --- MATCH clause ---

const matchClause: P<MatchClause> = (
  sequenceOf([tok(kw('MATCH')), sepBy1(sym(','))(tok(patternPath))]) as P<unknown>
).map((parts: unknown): MatchClause => {
  const [, patterns] = parts as [unknown, PatternPath[]];
  return { patterns };
});

// --- Expressions (recursive, precedence climbing) ---

const expression: P<Expression> = recursiveParser(() => orExpr) as P<Expression>;

// Property access: var.prop
const propertyAccess: P<Expression> = (
  sequenceOf([tokIdent, char('.'), ident]) as P<unknown>
).map((parts: unknown): Expression => {
  const [variable, , property] = parts as [string, string, string];
  return { kind: 'property_access', variable, property };
});

// Parameter name: standard ident OR digit run (positional: $0, $1, ...)
const paramName: P<string> = choice([ident, regex(/^\d+/) as P<string>]) as P<string>;

// Parameter ref: $paramName
const parameterRef: P<Expression> = (
  tok(sequenceOf([char('$'), paramName]) as P<unknown>)
).map((parts: unknown): Expression => ({ kind: 'parameter', name: (parts as [string, string])[1] }));

// Variable ref
const variableRef: P<Expression> = tokIdent.map(
  (name: unknown): Expression => ({ kind: 'variable', name: name as string }),
);

// Scalar functions (string, math, etc.)
// ID is a pseudo-function that resolves to the node's primary-key column.
const SCALAR_FUNCTIONS = ['TOLOWER', 'TOUPPER', 'TRIM', 'TOSTRING', 'TOINTEGER', 'TOFLOAT', 'SIZE', 'ID'];

const scalarCall: P<Expression> = (
  sequenceOf([
    tok(choice(SCALAR_FUNCTIONS.map((f) => kw(f))) as P<string>),
    sym('('),
    recursiveParser(() => expression) as P<Expression>,
    sym(')'),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [name, , arg] = parts as [string, unknown, Expression];
  return {
    kind: 'function_call',
    name: name.toUpperCase(),
    args: [arg],
  };
});

// Variadic functions: CONCAT, COALESCE
const VARIADIC_FUNCTIONS = ['CONCAT', 'COALESCE'];

const variadicCall: P<Expression> = (
  sequenceOf([
    tok(choice(VARIADIC_FUNCTIONS.map((f) => kw(f))) as P<string>),
    sym('('),
    sepBy1(sym(','))(tok(recursiveParser(() => expression) as P<Expression>)),
    sym(')'),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [name, , args] = parts as [string, unknown, Expression[]];
  return { kind: 'function_call', name: name.toUpperCase(), args };
});

// Aggregate functions
const AGGREGATES = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COLLECT'];

const aggregateCall: P<Expression> = (
  sequenceOf([
    tok(choice(AGGREGATES.map((a) => kw(a))) as P<string>),
    sym('('),
    possibly(tok(kw('DISTINCT'))),
    choice([
      sym('*').map(() => ({ star: true as const })),
      expression.map((e: unknown) => ({ expr: e as Expression })),
    ]),
    sym(')'),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [name, , distinct, inner] = parts as [
    string,
    unknown,
    string | null,
    { star: true } | { expr: Expression },
  ];
  return {
    kind: 'function_call',
    name: name.toUpperCase(),
    args: 'star' in inner ? [] : [inner.expr],
    ...(distinct ? { distinct: true } : {}),
  };
});

// Zero-arg date function: date()
const dateFunction: P<Expression> = (
  sequenceOf([tok(kw('DATE')), sym('('), sym(')')]) as P<unknown>
).map((): Expression => ({ kind: 'function_call', name: 'DATE', args: [] }));

// duration('P7D') — single string argument
const durationFunction: P<Expression> = (
  sequenceOf([
    tok(kw('DURATION')),
    sym('('),
    tok(choice([escapedString("'"), escapedString('"')]) as P<string>),
    sym(')'),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [, , value] = parts as [unknown, unknown, string];
  return { kind: 'function_call', name: 'DURATION', args: [{ kind: 'literal', value }] };
});

// CASE WHEN ... THEN ... [ELSE ...] END
const whenClause: P<{ condition: Expression; result: Expression }> = (
  sequenceOf([
    tok(kw('WHEN')),
    recursiveParser(() => expression) as P<Expression>,
    tok(kw('THEN')),
    recursiveParser(() => expression) as P<Expression>,
  ]) as P<unknown>
).map((parts: unknown) => {
  const [, condition, , result] = parts as [unknown, Expression, unknown, Expression];
  return { condition, result };
});

const caseExpression: P<Expression> = (
  sequenceOf([
    tok(kw('CASE')),
    many1(whenClause) as P<{ condition: Expression; result: Expression }[]>,
    possibly(
      sequenceOf([tok(kw('ELSE')), recursiveParser(() => expression) as P<Expression>]),
    ),
    tok(kw('END')),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [, whens, elsePart] = parts as [
    unknown,
    { condition: Expression; result: Expression }[],
    [unknown, Expression] | null,
    unknown,
  ];
  return {
    kind: 'case',
    whens,
    ...(elsePart ? { elseResult: elsePart[1] } : {}),
  };
});

// Parenthesized expression
const parenExpr: P<Expression> = between(sym('('))(sym(')'))(expression) as P<Expression>;

// EXISTS { MATCH pattern [, pattern] [WHERE expr] } — correlated subquery predicate
const existsSubquery: P<Expression> = (
  sequenceOf([
    tok(kw('EXISTS')),
    sym('{'),
    tok(kw('MATCH')),
    sepBy1(sym(','))(tok(patternPath)),
    possibly(
      sequenceOf([
        tok(kw('WHERE')),
        tok(recursiveParser(() => expression) as P<Expression>),
      ]),
    ),
    sym('}'),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [, , , patterns, wherePart] = parts as [
    unknown,
    unknown,
    unknown,
    PatternPath[],
    [unknown, Expression] | null,
    unknown,
  ];
  return {
    kind: 'exists_subquery',
    match: { patterns },
    ...(wherePart ? { where: wherePart[1] } : {}),
  };
});

// Primary: literal | map | list | case | date | duration | scalar fn | variadic fn | aggregate | paren | exists | param | property access | variable
const primary: P<Expression> = choice([
  literal,
  mapLiteral,
  listLiteral,
  caseExpression,
  dateFunction,
  durationFunction,
  scalarCall,
  variadicCall,
  aggregateCall,
  parenExpr,
  existsSubquery,
  parameterRef,
  propertyAccess,
  variableRef,
]) as P<Expression>;

// --- Arithmetic ---

// Multiplicative: * / %
const multiplicativeOp: P<string> = tok(choice([char('*'), char('/'), char('%')]) as P<string>);

const multiplicative: P<Expression> = (
  sequenceOf([
    tok(primary),
    many(sequenceOf([multiplicativeOp, tok(primary)])) as P<[string, Expression][]>,
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [first, rest] = parts as [Expression, [string, Expression][]];
  return rest.reduce(
    (left, [op, right]): Expression => ({
      kind: 'binary',
      operator: op as '*' | '/' | '%',
      left,
      right,
    }),
    first,
  );
});

// Additive: + -
const additiveOp: P<string> = tok(choice([char('+'), char('-')]) as P<string>);

const additive: P<Expression> = (
  sequenceOf([
    tok(multiplicative),
    many(sequenceOf([additiveOp, tok(multiplicative)])) as P<[string, Expression][]>,
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [first, rest] = parts as [Expression, [string, Expression][]];
  return rest.reduce(
    (left, [op, right]): Expression => ({
      kind: 'binary',
      operator: op as '+' | '-',
      left,
      right,
    }),
    first,
  );
});

// --- Postfix / infix operators ---

type ExprTransform = (e: Expression) => Expression;

const isNullSuffix: P<ExprTransform> = (
  sequenceOf([tok(kw('IS')), possibly(tok(kw('NOT'))), tok(kw('NULL'))]) as P<unknown>
).map(
  (parts: unknown): ExprTransform =>
    (operand) => ({
      kind: 'is_null',
      operand,
      negated: (parts as [unknown, string | null])[1] !== null,
    }),
);

const containsSuffix: P<ExprTransform> = (
  sequenceOf([tok(kw('CONTAINS')), tok(additive)]) as P<unknown>
).map(
  (parts: unknown): ExprTransform =>
    (left) => ({
      kind: 'binary',
      operator: 'CONTAINS',
      left,
      right: (parts as [unknown, Expression])[1],
    }),
);

const startsWithSuffix: P<ExprTransform> = (
  sequenceOf([tok(kw('STARTS')), tok(kw('WITH')), tok(additive)]) as P<unknown>
).map(
  (parts: unknown): ExprTransform =>
    (left) => ({
      kind: 'binary',
      operator: 'STARTS WITH',
      left,
      right: (parts as [unknown, unknown, Expression])[2],
    }),
);

const endsWithSuffix: P<ExprTransform> = (
  sequenceOf([tok(kw('ENDS')), tok(kw('WITH')), tok(additive)]) as P<unknown>
).map(
  (parts: unknown): ExprTransform =>
    (left) => ({
      kind: 'binary',
      operator: 'ENDS WITH',
      left,
      right: (parts as [unknown, unknown, Expression])[2],
    }),
);

const inSuffix: P<ExprTransform> = (
  sequenceOf([possibly(tok(kw('NOT'))), tok(kw('IN')), tok(additive)]) as P<unknown>
).map(
  (parts: unknown): ExprTransform =>
    (operand) => ({
      kind: 'in',
      operand,
      list: (parts as [string | null, unknown, Expression])[2],
      negated: (parts as [string | null, unknown, Expression])[0] !== null,
    }),
);

const compOp: P<string> = tok(
  choice([str('<>'), str('<='), str('>='), char('<'), char('>'), char('=')]) as P<string>,
);

const compSuffix: P<ExprTransform> = (
  sequenceOf([compOp, tok(additive)]) as P<unknown>
).map(
  (parts: unknown): ExprTransform =>
    (left) => {
      const [operator, right] = parts as [string, Expression];
      return { kind: 'binary', operator: operator as any, left, right };
    },
);

// comparison: additive with optional postfix
const comparison: P<Expression> = (
  sequenceOf([
    tok(additive),
    possibly(
      choice([
        isNullSuffix,
        inSuffix,
        containsSuffix,
        startsWithSuffix,
        endsWithSuffix,
        compSuffix,
      ]) as P<ExprTransform>,
    ),
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [left, suffix] = parts as [Expression, ExprTransform | null];
  return suffix ? suffix(left) : left;
});

// NOT prefix
const notExpr: P<Expression> = (
  choice([
    (sequenceOf([tok(kw('NOT')), recursiveParser(() => notExpr)]) as P<unknown>).map(
      (parts: unknown): Expression => ({
        kind: 'unary',
        operator: 'NOT',
        operand: (parts as [unknown, Expression])[1],
      }),
    ),
    comparison,
  ]) as P<Expression>
);

// AND (left-associative)
const andExpr: P<Expression> = (
  sequenceOf([
    notExpr,
    many(sequenceOf([tok(kw('AND')), notExpr])) as P<[string, Expression][]>,
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [first, rest] = parts as [Expression, [string, Expression][]];
  return rest.reduce(
    (left, [, right]): Expression => ({ kind: 'binary', operator: 'AND', left, right }),
    first,
  );
});

// OR (left-associative)
const orExpr: P<Expression> = (
  sequenceOf([
    andExpr,
    many(sequenceOf([tok(kw('OR')), andExpr])) as P<[string, Expression][]>,
  ]) as P<unknown>
).map((parts: unknown): Expression => {
  const [first, rest] = parts as [Expression, [string, Expression][]];
  return rest.reduce(
    (left, [, right]): Expression => ({ kind: 'binary', operator: 'OR', left, right }),
    first,
  );
});

// --- WHERE clause ---

const whereClause: P<Expression> = (
  sequenceOf([tok(kw('WHERE')), tok(expression)]) as P<unknown>
).map((parts: unknown): Expression => (parts as [unknown, Expression])[1]);

// --- RETURN clause ---

const returnItem: P<ReturnItem> = (
  sequenceOf([tok(expression), possibly(sequenceOf([tok(kw('AS')), tokIdent]))]) as P<unknown>
).map((parts: unknown): ReturnItem => {
  const [expr, aliasPart] = parts as [Expression, [string, string] | null];
  return {
    expression: expr,
    ...(aliasPart ? { alias: aliasPart[1] } : {}),
  };
});

const returnClause: P<ReturnClause> = (
  sequenceOf([
    tok(kw('RETURN')),
    possibly(tok(kw('DISTINCT'))),
    sepBy1(sym(','))(tok(returnItem)),
  ]) as P<unknown>
).map((parts: unknown): ReturnClause => {
  const [, distinct, items] = parts as [unknown, string | null, ReturnItem[]];
  return {
    items,
    ...(distinct ? { distinct: true } : {}),
  };
});

// --- WITH clause (rewrites to RETURN + HAVING) ---

interface WithClause {
  items: ReturnItem[];
  distinct?: boolean;
  where?: Expression;
}

const withClause: P<WithClause> = (
  sequenceOf([
    tok(kw('WITH')),
    possibly(tok(kw('DISTINCT'))),
    sepBy1(sym(','))(tok(returnItem)),
    possibly(whereClause),
  ]) as P<unknown>
).map((parts: unknown): WithClause => {
  const [, distinct, items, where] = parts as [unknown, string | null, ReturnItem[], Expression | null];
  return {
    items,
    ...(distinct ? { distinct: true } : {}),
    ...(where ? { where } : {}),
  };
});

// --- HAVING clause ---

const havingClause: P<Expression> = (
  sequenceOf([tok(kw('HAVING')), tok(expression)]) as P<unknown>
).map((parts: unknown): Expression => (parts as [unknown, Expression])[1]);

// --- ORDER BY ---

const orderByItem: P<OrderByItem> = (
  sequenceOf([
    tok(expression),
    possibly(
      tok(
        choice([
          kw('DESC').map(() => 'DESC' as const),
          kw('DESCENDING').map(() => 'DESC' as const),
          kw('ASC').map(() => 'ASC' as const),
          kw('ASCENDING').map(() => 'ASC' as const),
        ]) as P<'ASC' | 'DESC'>,
      ),
    ),
  ]) as P<unknown>
).map((parts: unknown): OrderByItem => {
  const [expr, dir] = parts as [Expression, 'ASC' | 'DESC' | null];
  return { expression: expr, direction: dir ?? 'ASC' };
});

const orderByClause: P<OrderByItem[]> = (
  sequenceOf([tok(kw('ORDER')), tok(kw('BY')), sepBy1(sym(','))(tok(orderByItem))]) as P<unknown>
).map((parts: unknown): OrderByItem[] => (parts as [unknown, unknown, OrderByItem[]])[2]);

// --- SKIP ---

const skipValue: P<number | ParameterRef> = choice([
  (tok(sequenceOf([char('$'), paramName]) as P<unknown>)).map(
    (parts: unknown): ParameterRef => ({ kind: 'parameter', name: (parts as [string, string])[1] }),
  ),
  (tok(regex(/^\d+/) as P<string>)).map((s: unknown): number => parseInt(s as string, 10)),
]) as P<number | ParameterRef>;

const skipClause: P<number | ParameterRef> = (
  sequenceOf([tok(kw('SKIP')), skipValue]) as P<unknown>
).map((parts: unknown): number | ParameterRef => (parts as [unknown, number | ParameterRef])[1]);

// --- LIMIT ---

const limitValue: P<number | ParameterRef> = choice([
  (tok(sequenceOf([char('$'), paramName]) as P<unknown>)).map(
    (parts: unknown): ParameterRef => ({ kind: 'parameter', name: (parts as [string, string])[1] }),
  ),
  (tok(regex(/^\d+/) as P<string>)).map((s: unknown): number => parseInt(s as string, 10)),
]) as P<number | ParameterRef>;

const limitClause: P<number | ParameterRef> = (
  sequenceOf([tok(kw('LIMIT')), limitValue]) as P<unknown>
).map((parts: unknown): number | ParameterRef => (parts as [unknown, number | ParameterRef])[1]);

// --- OPTIONAL MATCH ---

const optionalMatchClause: P<MatchClause> = (
  sequenceOf([tok(kw('OPTIONAL')), tok(kw('MATCH')), sepBy1(sym(','))(tok(patternPath))]) as P<unknown>
).map((parts: unknown): MatchClause => {
  const [, , patterns] = parts as [unknown, unknown, PatternPath[]];
  return { patterns };
});

// --- Mutation clauses ---

// Property access target (not wrapped as Expression — returns PropertyAccess directly)
const propertyTarget: P<PropertyAccess> = (
  sequenceOf([tokIdent, char('.'), ident]) as P<unknown>
).map((parts: unknown): PropertyAccess => {
  const [variable, , property] = parts as [string, string, string];
  return { kind: 'property_access', variable, property };
});

// SET variable.prop = expr [, ...]
const setItem: P<SetItem> = (
  sequenceOf([tok(propertyTarget), sym('='), tok(expression)]) as P<unknown>
).map((parts: unknown): SetItem => {
  const [target, , value] = parts as [PropertyAccess, unknown, Expression];
  return { target, value };
});

const setClause: P<SetClause> = (
  sequenceOf([tok(kw('SET')), sepBy1(sym(','))(tok(setItem))]) as P<unknown>
).map((parts: unknown): SetClause => {
  const [, items] = parts as [unknown, SetItem[]];
  return { kind: 'set', items };
});

// REMOVE variable.prop [, ...]
const removeClause: P<RemoveClause> = (
  sequenceOf([tok(kw('REMOVE')), sepBy1(sym(','))(tok(propertyTarget))]) as P<unknown>
).map((parts: unknown): RemoveClause => {
  const [, properties] = parts as [unknown, PropertyAccess[]];
  return { kind: 'remove', properties };
});

// [DETACH] DELETE variable [, ...]
const deleteClause: P<DeleteClause> = (
  sequenceOf([
    possibly(tok(kw('DETACH'))),
    tok(kw('DELETE')),
    sepBy1(sym(','))(tokIdent),
  ]) as P<unknown>
).map((parts: unknown): DeleteClause => {
  const [detach, , variables] = parts as [string | null, unknown, string[]];
  return { kind: 'delete', variables, detach: detach !== null };
});

// CREATE pattern [, ...]
const createClause: P<CreateClause> = (
  sequenceOf([tok(kw('CREATE')), sepBy1(sym(','))(tok(patternPath))]) as P<unknown>
).map((parts: unknown): CreateClause => {
  const [, patterns] = parts as [unknown, PatternPath[]];
  return { kind: 'create', patterns };
});

// ON CREATE SET ... / ON MATCH SET ...
const onCreateSet: P<SetItem[]> = (
  sequenceOf([tok(kw('ON')), tok(kw('CREATE')), tok(kw('SET')), sepBy1(sym(','))(tok(setItem))]) as P<unknown>
).map((parts: unknown): SetItem[] => (parts as [unknown, unknown, unknown, SetItem[]])[3]);

const onMatchSet: P<SetItem[]> = (
  sequenceOf([tok(kw('ON')), tok(kw('MATCH')), tok(kw('SET')), sepBy1(sym(','))(tok(setItem))]) as P<unknown>
).map((parts: unknown): SetItem[] => (parts as [unknown, unknown, unknown, SetItem[]])[3]);

// MERGE pattern [ON CREATE SET ...] [ON MATCH SET ...]
const mergeClause: P<MergeClause> = (
  sequenceOf([
    tok(kw('MERGE')),
    tok(patternPath),
    possibly(onCreateSet),
    possibly(onMatchSet),
  ]) as P<unknown>
).map((parts: unknown): MergeClause => {
  const [, pattern, onCreate, onMatch] = parts as [
    unknown,
    PatternPath,
    SetItem[] | null,
    SetItem[] | null,
  ];
  return {
    kind: 'merge',
    pattern,
    ...(onCreate ? { onCreateSet: onCreate } : {}),
    ...(onMatch ? { onMatchSet: onMatch } : {}),
  };
});

const mutationClause: P<MutationClause> = choice([
  setClause,
  removeClause,
  deleteClause,
  createClause,
  mergeClause,
]) as P<MutationClause>;

// --- Helpers for merging multiple MATCH/OPTIONAL MATCH clauses ---

function mergeMatchClauses(clauses: MatchClause[]): MatchClause {
  return { patterns: clauses.flatMap((c) => c.patterns) };
}

// --- Full query ---

// A WITH block: WITH items [WHERE cond] followed by optional OPTIONAL MATCH clauses
interface WithBlock {
  with: WithClause;
  optionalMatches: MatchClause[];
}

const withBlock: P<WithBlock> = (
  sequenceOf([withClause, many(optionalMatchClause) as P<MatchClause[]>]) as P<unknown>
).map((parts: unknown): WithBlock => {
  const [wit, optMatches] = parts as [WithClause, MatchClause[]];
  return { with: wit, optionalMatches: optMatches };
});

// Chain alias resolution across multiple WITH blocks.
// Each WITH's aliases resolve forward into the next WITH and ultimately into RETURN.
function chainWithBlocks(
  blocks: WithBlock[],
  ret: ReturnClause,
  orderBy: OrderByItem[] | null,
): { resolvedReturn: ReturnClause; resolvedOrderBy?: OrderByItem[]; havingExprs: Expression[]; allOptMatches: MatchClause[] } {
  // Accumulate aliases across all WITH blocks — later WITHs resolve earlier aliases
  let cumulativeAliases = new Map<string, Expression>();
  const havingExprs: Expression[] = [];
  const allOptMatches: MatchClause[] = [];
  let propagateDistinct = false;

  for (const block of blocks) {
    const wit = block.with;

    // First resolve this WITH's expressions against prior aliases
    const localAliases = new Map<string, Expression>();
    for (const item of wit.items) {
      const resolved = resolveWithAliases(item.expression, cumulativeAliases);
      if (item.alias) {
        localAliases.set(item.alias, resolved);
      }
    }

    // Merge: local aliases override, but prior aliases that aren't shadowed persist
    const merged = new Map(cumulativeAliases);
    for (const [k, v] of localAliases) {
      merged.set(k, v);
    }
    cumulativeAliases = merged;

    if (wit.where) {
      havingExprs.push(resolveWithAliases(wit.where, cumulativeAliases));
    }
    if (wit.distinct) {
      propagateDistinct = true;
    }

    allOptMatches.push(...block.optionalMatches);
  }

  // Resolve aliases in RETURN
  const resolvedReturn: ReturnClause = {
    ...ret,
    ...(propagateDistinct && !ret.distinct ? { distinct: true } : {}),
    items: ret.items.map((item) => {
      const resolved = resolveWithAliases(item.expression, cumulativeAliases);
      const needsAlias =
        !item.alias &&
        item.expression.kind === 'variable' &&
        cumulativeAliases.has(item.expression.name);
      return {
        ...item,
        expression: resolved,
        ...(needsAlias ? { alias: (item.expression as { name: string }).name } : {}),
      };
    }),
  };

  const resolvedOrderBy = orderBy?.map((o) => ({
    ...o,
    expression: resolveWithAliases(o.expression, cumulativeAliases),
  }));

  return { resolvedReturn, resolvedOrderBy, havingExprs, allOptMatches };
}

// WITH form: MATCH+ [OPTIONAL MATCH+] [WHERE ...] (WITH items [WHERE cond] [OPTIONAL MATCH+])+ RETURN items [ORDER BY ...] [SKIP n] [LIMIT n]
const cypherQueryWithWith: P<CypherQuery> = (
  sequenceOf([
    many1(tok(matchClause)) as P<MatchClause[]>,
    many(optionalMatchClause) as P<MatchClause[]>,
    possibly(whereClause),
    many1(withBlock) as P<WithBlock[]>,
    returnClause,
    possibly(orderByClause),
    possibly(skipClause),
    possibly(limitClause),
    eof,
  ]) as P<unknown>
).map((parts: unknown): CypherQuery => {
  const [matches, optMatchesBefore, where, withBlocks, ret, orderBy, skip, limit] = parts as [
    MatchClause[],
    MatchClause[],
    Expression | null,
    WithBlock[],
    ReturnClause,
    OrderByItem[] | null,
    (number | ParameterRef) | null,
    (number | ParameterRef) | null,
    unknown,
  ];
  const match = mergeMatchClauses(matches);

  const { resolvedReturn, resolvedOrderBy, havingExprs, allOptMatches } = chainWithBlocks(
    withBlocks,
    ret,
    orderBy,
  );

  // Merge all OPTIONAL MATCHes: before first WITH + from all WITH blocks
  const mergedOptMatches = [...optMatchesBefore, ...allOptMatches];
  const optMatch = mergedOptMatches.length > 0 ? mergeMatchClauses(mergedOptMatches) : null;

  // Combine HAVING expressions with AND
  let having: Expression | undefined;
  if (havingExprs.length === 1) {
    having = havingExprs[0];
  } else if (havingExprs.length > 1) {
    having = havingExprs.reduce((left, right): Expression => ({
      kind: 'binary',
      operator: 'AND',
      left,
      right,
    }));
  }

  return {
    match,
    ...(optMatch ? { optionalMatch: optMatch } : {}),
    return: resolvedReturn,
    ...(where ? { where } : {}),
    ...(having ? { having } : {}),
    ...(resolvedOrderBy ? { orderBy: resolvedOrderBy } : {}),
    ...(skip !== null ? { skip } : {}),
    ...(limit !== null ? { limit } : {}),
  };
});

function resolveWithAliases(expr: Expression, aliases: Map<string, Expression>): Expression {
  switch (expr.kind) {
    case 'variable':
      return aliases.get(expr.name) ?? expr;
    case 'binary':
      return {
        ...expr,
        left: resolveWithAliases(expr.left, aliases),
        right: resolveWithAliases(expr.right, aliases),
      };
    case 'unary':
      return { ...expr, operand: resolveWithAliases(expr.operand, aliases) };
    case 'is_null':
      return { ...expr, operand: resolveWithAliases(expr.operand, aliases) };
    case 'in':
      return {
        ...expr,
        operand: resolveWithAliases(expr.operand, aliases),
        list: resolveWithAliases(expr.list, aliases),
      };
    case 'function_call':
      return { ...expr, args: expr.args.map((a) => resolveWithAliases(a, aliases)) };
    case 'map':
      return { ...expr, entries: expr.entries.map((e) => ({ ...e, value: resolveWithAliases(e.value, aliases) })) };
    case 'case':
      return {
        ...expr,
        whens: expr.whens.map((w) => ({
          condition: resolveWithAliases(w.condition, aliases),
          result: resolveWithAliases(w.result, aliases),
        })),
        ...(expr.elseResult ? { elseResult: resolveWithAliases(expr.elseResult, aliases) } : {}),
      };
    default:
      return expr;
  }
}

// Standard form: MATCH+ [OPTIONAL MATCH+] [WHERE ...] RETURN ... [HAVING ...] [ORDER BY ...] [SKIP n] [LIMIT n]
const cypherQueryStandard: P<CypherQuery> = (
  sequenceOf([
    many1(tok(matchClause)) as P<MatchClause[]>,
    many(optionalMatchClause) as P<MatchClause[]>,
    possibly(whereClause),
    returnClause,
    possibly(havingClause),
    possibly(orderByClause),
    possibly(skipClause),
    possibly(limitClause),
    eof,
  ]) as P<unknown>
).map((parts: unknown): CypherQuery => {
  const [matches, optMatches, where, ret, having, orderBy, skip, limit] = parts as [
    MatchClause[],
    MatchClause[],
    Expression | null,
    ReturnClause,
    Expression | null,
    OrderByItem[] | null,
    (number | ParameterRef) | null,
    (number | ParameterRef) | null,
    unknown,
  ];
  const match = mergeMatchClauses(matches);
  const optMatch = optMatches.length > 0 ? mergeMatchClauses(optMatches) : null;
  return {
    match,
    ...(optMatch ? { optionalMatch: optMatch } : {}),
    return: ret,
    ...(where ? { where } : {}),
    ...(having ? { having } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(skip !== null ? { skip } : {}),
    ...(limit !== null ? { limit } : {}),
  };
});

const cypherQuery: P<CypherQuery> = choice([
  cypherQueryWithWith,
  cypherQueryStandard,
]) as P<CypherQuery>;

// --- Mutation query forms ---

// With MATCH: MATCH+ [OPTIONAL MATCH+] [WHERE ...] mutation+ [RETURN ...] [ORDER BY ...] [SKIP n] [LIMIT n]
const mutationQueryWithMatch: P<MutationCypherQuery> = (
  sequenceOf([
    many1(tok(matchClause)) as P<MatchClause[]>,
    many(optionalMatchClause) as P<MatchClause[]>,
    possibly(whereClause),
    many1(tok(mutationClause)) as P<MutationClause[]>,
    possibly(returnClause),
    possibly(orderByClause),
    possibly(skipClause),
    possibly(limitClause),
    eof,
  ]) as P<unknown>
).map((parts: unknown): MutationCypherQuery => {
  const [matches, optMatches, where, mutations, ret, orderBy, skip, limit] = parts as [
    MatchClause[],
    MatchClause[],
    Expression | null,
    MutationClause[],
    ReturnClause | null,
    OrderByItem[] | null,
    (number | ParameterRef) | null,
    (number | ParameterRef) | null,
    unknown,
  ];
  const match = mergeMatchClauses(matches);
  const optMatch = optMatches.length > 0 ? mergeMatchClauses(optMatches) : null;
  return {
    match,
    ...(optMatch ? { optionalMatch: optMatch } : {}),
    ...(where ? { where } : {}),
    mutations,
    ...(ret ? { return: ret } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(skip !== null ? { skip } : {}),
    ...(limit !== null ? { limit } : {}),
  };
});

// Without MATCH: CREATE/MERGE only [RETURN ...] [ORDER BY ...] [SKIP n] [LIMIT n]
const mutationQueryStandalone: P<MutationCypherQuery> = (
  sequenceOf([
    many1(tok(mutationClause)) as P<MutationClause[]>,
    possibly(returnClause),
    possibly(orderByClause),
    possibly(skipClause),
    possibly(limitClause),
    eof,
  ]) as P<unknown>
).map((parts: unknown): MutationCypherQuery => {
  const [mutations, ret, orderBy, skip, limit] = parts as [
    MutationClause[],
    ReturnClause | null,
    OrderByItem[] | null,
    (number | ParameterRef) | null,
    (number | ParameterRef) | null,
    unknown,
  ];
  return {
    mutations,
    ...(ret ? { return: ret } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(skip !== null ? { skip } : {}),
    ...(limit !== null ? { limit } : {}),
  };
});

const mutationQuery: P<MutationCypherQuery> = choice([
  mutationQueryWithMatch,
  mutationQueryStandalone,
]) as P<MutationCypherQuery>;

// Combined: try read-only first, then mutation
const anyQuery: P<ParseResult> = choice([
  cypherQuery.map((q: unknown): ParseResult => q as CypherQuery),
  mutationQuery.map((q: unknown): ParseResult => q as MutationCypherQuery),
]) as P<ParseResult>;

// --- Public API ---

class ParseError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message);
    this.name = 'CypherParseError';
  }
}

function parseCypher(input: string): CypherQuery {
  const result = cypherQuery.run(input.trim());
  if (result.isError) {
    throw new ParseError(result.error, result.index);
  }
  return result.result;
}

function parseAnyCypher(input: string): ParseResult {
  const result = anyQuery.run(input.trim());
  if (result.isError) {
    throw new ParseError(result.error, result.index);
  }
  return result.result;
}

export { parseCypher, parseAnyCypher, ParseError };
