// AST types for the Cypher subset we support

export interface CypherQuery {
  match: MatchClause;
  optionalMatch?: MatchClause;
  where?: Expression;
  return: ReturnClause;
  having?: Expression;
  orderBy?: OrderByItem[];
  skip?: number | ParameterRef;
  limit?: number | ParameterRef;
}

export interface MatchClause {
  patterns: PatternPath[];
}

export interface PatternPath {
  elements: PatternElement[];
}

export type PatternElement = NodePattern | RelationshipPattern;

export interface NodePattern {
  kind: 'node';
  variable?: string;
  label?: string;
  properties?: { key: string; value: Expression }[];
}

export interface RelationshipPattern {
  kind: 'relationship';
  variable?: string;
  type?: string;
  direction: 'outgoing' | 'incoming' | 'undirected';
}

export type Expression =
  | PropertyAccess
  | Literal
  | ListLiteral
  | MapLiteral
  | FunctionCall
  | BinaryExpression
  | UnaryExpression
  | VariableRef
  | ParameterRef
  | IsNullExpression
  | InExpression
  | CaseExpression
  | ExistsSubquery;

export interface ExistsSubquery {
  kind: 'exists_subquery';
  match: MatchClause;
  where?: Expression;
}

export interface MapLiteral {
  kind: 'map';
  entries: { key: string; value: Expression }[];
}

export interface PropertyAccess {
  kind: 'property_access';
  variable: string;
  property: string;
}

export interface Literal {
  kind: 'literal';
  value: string | number | boolean | null;
}

export interface ListLiteral {
  kind: 'list';
  elements: Expression[];
}

export interface FunctionCall {
  kind: 'function_call';
  name: string;
  args: Expression[];
  distinct?: boolean;
}

export interface BinaryExpression {
  kind: 'binary';
  operator:
    | '='
    | '<>'
    | '<'
    | '>'
    | '<='
    | '>='
    | 'AND'
    | 'OR'
    | '+'
    | '-'
    | 'CONTAINS'
    | 'STARTS WITH'
    | 'ENDS WITH'
    | '*'
    | '/'
    | '%';
  left: Expression;
  right: Expression;
}

export interface UnaryExpression {
  kind: 'unary';
  operator: 'NOT';
  operand: Expression;
}

export interface IsNullExpression {
  kind: 'is_null';
  operand: Expression;
  negated: boolean;
}

export interface InExpression {
  kind: 'in';
  operand: Expression;
  list: Expression;
  negated: boolean;
}

export interface CaseExpression {
  kind: 'case';
  operand?: Expression;
  whens: { condition: Expression; result: Expression }[];
  elseResult?: Expression;
}

export interface VariableRef {
  kind: 'variable';
  name: string;
}

export interface ParameterRef {
  kind: 'parameter';
  name: string;
}

export interface ReturnClause {
  items: ReturnItem[];
  distinct?: boolean;
}

export interface ReturnItem {
  expression: Expression;
  alias?: string;
}

export interface OrderByItem {
  expression: Expression;
  direction: 'ASC' | 'DESC';
}

// --- Mutation AST types ---

export interface SetItem {
  target: PropertyAccess;
  value: Expression;
}

export interface SetClause {
  kind: 'set';
  items: SetItem[];
}

export interface RemoveClause {
  kind: 'remove';
  properties: PropertyAccess[];
}

export interface DeleteClause {
  kind: 'delete';
  variables: string[];
  detach: boolean;
}

export interface CreateClause {
  kind: 'create';
  patterns: PatternPath[];
}

export interface MergeClause {
  kind: 'merge';
  pattern: PatternPath;
  onCreateSet?: SetItem[];
  onMatchSet?: SetItem[];
}

export type MutationClause = SetClause | RemoveClause | DeleteClause | CreateClause | MergeClause;

export interface MutationCypherQuery {
  match?: MatchClause;
  optionalMatch?: MatchClause;
  where?: Expression;
  mutations: MutationClause[];
  return?: ReturnClause;
  orderBy?: OrderByItem[];
  skip?: number | ParameterRef;
  limit?: number | ParameterRef;
}

export type ParseResult = CypherQuery | MutationCypherQuery;

export function isMutation(result: ParseResult): result is MutationCypherQuery {
  return 'mutations' in result;
}
