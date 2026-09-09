// Unwrap the execute_agent_query / row_to_json wrapper that PostgreSQL adds.
// SELECT * FROM execute_agent_query(...) returns rows like { execute_agent_query: <json> }.
export function unwrapAgentQueryRows(rows: unknown[]): unknown[] {
  return rows.map((r: any) => {
    if (r && typeof r === 'object' && 'execute_agent_query' in r) return r.execute_agent_query;
    if (r && typeof r === 'object' && 'row_to_json' in r) return r.row_to_json;
    return r;
  });
}
