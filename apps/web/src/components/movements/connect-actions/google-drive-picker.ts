// The `google-drive-picker` connect-action handler.
//
// Ported from the legacy Sheets output config
// (apps/app/src/pages/PipelineConfiguration/Output/GoogleSheets.tsx): load the
// Google Picker API, open a spreadsheet-only DocsView, and on PICKED capture
// the file id + name. Here the picked file is GRANTED to the movement's Google
// credential (persisted server-side) and the instance schema is refreshed so
// the newly-granted spreadsheet's tables appear in the editor's suggestions.
//
// The browser-side OAuth token carries `drive.file` scope (the credential's
// existing scope — see apps/api/src/adapters/google/authClient.ts); it's
// sourced fresh from the `googleSheets.pickerToken` endpoint, which refreshes
// an expired token before handing it out.
//
// Vite→Next env: VITE_GOOGLE_APP_ID / VITE_GOOGLE_API_KEY became
// NEXT_PUBLIC_GOOGLE_APP_ID / NEXT_PUBLIC_GOOGLE_API_KEY.

import {
  registerConnectActionHandler,
  type ConnectActionContext,
} from "./registry";

/** A spreadsheet the user picked from the Drive Picker. */
export interface PickedSpreadsheet {
  id: string;
  name: string;
}

/** Load the Google Picker API once (idempotent). Resolves when
 *  `window.google.picker` is available. */
function loadPickerApi(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as {
      google?: { picker?: unknown };
      gapi?: { load: (name: string, cfg: { callback: () => void; onerror: () => void }) => void };
    };
    if (w.google?.picker) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.onload = () => {
      w.gapi?.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("picker load failed")) });
    };
    script.onerror = () => reject(new Error("gapi script load failed"));
    document.body.appendChild(script);
  });
}

/**
 * Open the Drive Picker (spreadsheets only) with the given OAuth token.
 * Resolves with the picked spreadsheets when the user picks, or an empty
 * array if they cancel.
 */
export function openDriveSpreadsheetPicker(accessToken: string): Promise<PickedSpreadsheet[]> {
  return new Promise((resolve, reject) => {
    loadPickerApi()
      .then(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const google = (window as any).google;
        const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS);
        view.setMimeTypes("application/vnd.google-apps.spreadsheet");
        view.setMode(google.picker.DocsViewMode.LIST);

        const builder = new google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(accessToken)
          .setAppId(process.env.NEXT_PUBLIC_GOOGLE_APP_ID)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .setCallback((data: any) => {
            if (data.action === google.picker.Action.PICKED) {
              const docs = (data.docs ?? [])
                .filter((d: { id?: string }) => !!d.id)
                .map((d: { id: string; name?: string }) => ({ id: d.id, name: d.name ?? d.id }));
              resolve(docs);
            } else if (data.action === google.picker.Action.CANCEL) {
              resolve([]);
            }
          });

        if (process.env.NEXT_PUBLIC_GOOGLE_API_KEY) {
          builder.setDeveloperKey(process.env.NEXT_PUBLIC_GOOGLE_API_KEY);
        }
        builder.build().setVisible(true);
      })
      .catch(reject);
  });
}

/**
 * The connect-action handler: source a picker token for the instance's
 * credential, open the Picker, then persist each picked spreadsheet as a
 * grant and refresh the instance so its tables surface.
 */
async function googleDrivePickerHandler(ctx: ConnectActionContext): Promise<void> {
  // The credential ref the server resolves: the movement editor knows the
  // credential by its import name; the picker token + grant ride that.
  const ref = ctx.credential !== undefined ? { credentialName: ctx.credential } : undefined;
  if (!ref) {
    // No credential in play — nothing to grant against. (google_sheets always
    // constructs with a credential, so this only guards a misuse.)
    throw new Error("Connecting a Google Sheet needs a Google credential on the instance.");
  }

  const token = await ctx.client.views.googleSheets.pickerToken.query(ref);
  const picked = await openDriveSpreadsheetPicker(token);
  if (picked.length === 0) return; // user cancelled

  for (const sheet of picked) {
    await ctx.client.views.googleSheets.grant.mutate({
      ...ref,
      spreadsheetId: sheet.id,
      name: sheet.name,
    });
  }

  ctx.refreshInstance({
    adapter: ctx.adapter,
    ...(ctx.credential !== undefined ? { credential: ctx.credential } : {}),
  });
}

registerConnectActionHandler("google-drive-picker", googleDrivePickerHandler);
