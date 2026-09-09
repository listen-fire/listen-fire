// Google Sheets' view of the generic granted-items store: the spreadsheets
// granted to a Google credential. Thin facade over `granted_items` filtered to
// the spreadsheet mime, so the Sheets adapter's many call sites are unchanged.
import {
  grantItem, listGrantedItems, revokeItem, SPREADSHEET_MIME,
} from '../../../credentials/granted_items';

export interface GrantedSpreadsheet {
  spreadsheetId: string;
  name: string | null;
}

export async function listGrantedSpreadsheets(
  credentialsId: string,
): Promise<GrantedSpreadsheet[]> {
  const items = await listGrantedItems(credentialsId, { mimeTypes: [SPREADSHEET_MIME] });
  return items.map((i) => ({ spreadsheetId: i.itemId, name: i.name }));
}

export async function listGrantedSpreadsheetIds(credentialsId: string): Promise<string[]> {
  return (await listGrantedSpreadsheets(credentialsId)).map((g) => g.spreadsheetId);
}

export async function grantSpreadsheet(input: {
  credentialsId: string;
  spreadsheetId: string;
  name?: string | null;
}): Promise<void> {
  await grantItem({
    credentialsId: input.credentialsId,
    itemId: input.spreadsheetId,
    mimeType: SPREADSHEET_MIME,
    name: input.name,
  });
}

export async function revokeSpreadsheet(input: {
  credentialsId: string;
  spreadsheetId: string;
}): Promise<void> {
  await revokeItem({ credentialsId: input.credentialsId, itemId: input.spreadsheetId });
}
