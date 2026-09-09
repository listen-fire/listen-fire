import type { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult } from './types';

function createGoogleSheetsV3Adapter(client: GoogleSheetsApiClient): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const [, actionType] = input.type.split(':');

      if (actionType === 'row') {
        return executeRow(client, input);
      } else if (actionType === 'table-row') {
        return executeTableRow(client, input);
      }

      return { skipped: true, skipReason: `Unknown Google Sheets action type "${actionType}"` };
    },
  };
}

async function executeRow(
  client: GoogleSheetsApiClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as {
    spreadsheetId: string;
    sheetId: number;
  };

  if (!config.spreadsheetId) {
    return { skipped: true, skipReason: 'Missing spreadsheetId' };
  }

  // Build row from pre-resolved field values
  const row: Record<string, string | number | boolean | Date> = {};
  for (const [key, value] of Object.entries(input.fieldValues)) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      row[key] = value;
    } else if (value instanceof Date) {
      row[key] = value;
    } else {
      row[key] = String(value);
    }
  }

  if (Object.keys(row).length === 0) {
    return { skipped: true, skipReason: 'No fields to write' };
  }

  await client.addRow({
    spreadsheetId: config.spreadsheetId,
    sheetId: config.sheetId,
    row,
  });
  return {};
}

async function executeTableRow(
  client: GoogleSheetsApiClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as {
    spreadsheetId: string;
    tableId: string;
  };

  if (!config.spreadsheetId || !config.tableId) {
    return { skipped: true, skipReason: 'Missing spreadsheetId or tableId' };
  }

  // Look up column indices from table metadata using targetField as column name
  const columns = await client.getTableColumns({
    spreadsheetId: config.spreadsheetId,
    tableId: config.tableId,
  });
  const columnByName = new Map(columns.map((c) => [c.columnName, c.columnIndex]));

  const valuesByColumn: { columnIndex: number; value: string | number | boolean }[] = [];
  for (const [key, value] of Object.entries(input.fieldValues)) {
    if (value == null) continue;
    const columnIndex = columnByName.get(key);
    if (columnIndex == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      valuesByColumn.push({ columnIndex, value });
    } else {
      valuesByColumn.push({ columnIndex, value: String(value) });
    }
  }

  if (valuesByColumn.length === 0) {
    return { skipped: true, skipReason: 'No column values to write' };
  }

  await client.addTableRow({
    spreadsheetId: config.spreadsheetId,
    tableId: config.tableId,
    valuesByColumn,
  });
  return {};
}

export { createGoogleSheetsV3Adapter };
