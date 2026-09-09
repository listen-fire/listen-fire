import { register as registerRow, GOOGLE_SHEETS_ROW_NODE_TYPE } from './row';
import { register as registerTableRow, GOOGLE_SHEETS_TABLE_ROW_NODE_TYPE } from './tableRow';

export {
  GoogleSheetsFieldConfiguration,
  GoogleSheetsRowConfig,
  GOOGLE_SHEETS_ROW_NODE_TYPE,
} from './row';

export {
  GoogleSheetsColumnConfiguration,
  GoogleSheetsTableRowConfig,
  GOOGLE_SHEETS_TABLE_ROW_NODE_TYPE,
} from './tableRow';

export const GOOGLE_SHEETS_NODE_TYPES = {
  ROW: GOOGLE_SHEETS_ROW_NODE_TYPE,
  TABLE_ROW: GOOGLE_SHEETS_TABLE_ROW_NODE_TYPE,
} as const;

export function registerGoogleSheetsNodeTypes(): void {
  registerRow();
  registerTableRow();
}
