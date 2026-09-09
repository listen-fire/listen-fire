// Pure RFC-4180 CSV serialization for knowledge-graph query results.
// Kept dependency-free and side-effect-free so it is trivially testable and
// reusable by the exportCsv handler.

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(input: { columns: string[]; rows: Record<string, unknown>[] }): string {
  const header = input.columns.map(cell).join(',');
  const lines = input.rows.map((row) =>
    input.columns.map((col) => cell(row[col])).join(','),
  );
  return [header, ...lines].join('\r\n');
}
