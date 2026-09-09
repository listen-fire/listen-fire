import type { CollectedNode } from './import_sandbox';

// Turn parsed CSV rows into CollectedNodes for applyImport. Only mapped,
// non-empty cells become properties: an empty cell must NOT overwrite an
// existing value when the row matches an existing entity on re-import.
export function rowsToCollectedNodes(input: {
  rows: Record<string, string>[];
  typeName: string;
  mapping: Record<string, string>;
}): CollectedNode[] {
  return input.rows.map((row, i) => {
    const properties: Record<string, unknown> = {};
    for (const [column, propertyName] of Object.entries(input.mapping)) {
      const value = row[column];
      if (value !== undefined && value !== '') properties[propertyName] = value;
    }
    return { id: `row-${i}`, type: input.typeName, properties };
  });
}
