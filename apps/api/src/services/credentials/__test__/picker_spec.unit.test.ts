import { pickerSpecForActionKind, pickerActionKindForAdapter } from '../picker_spec';

describe('picker_spec', () => {
  it('sheets picker: spreadsheets only, no folders', () => {
    const s = pickerSpecForActionKind('google-sheets-picker');
    expect(s.mimeTypes).toEqual(['application/vnd.google-apps.spreadsheet']);
    expect(s.allowFolders).toBe(false);
  });
  it('drive picker: all types, folders on', () => {
    const s = pickerSpecForActionKind('google-drive-picker');
    expect(s.mimeTypes).toEqual([]);
    expect(s.allowFolders).toBe(true);
  });
  it('maps the google_sheets manifest to its picker action kind', () => {
    // The Sheets manifest's action block carries actionKind
    // 'google-sheets-picker' (renamed here from the old, misleading
    // 'google-drive-picker'); mintItemPickerLink keys the slug + spec off this.
    expect(pickerActionKindForAdapter('google_sheets')).toBe('google-sheets-picker');
  });
  it('maps the google_drive manifest to its picker action kind', () => {
    // Drive's own manifest now carries a `google-drive-picker` action block
    // (Task 6) — the picker mechanism resolves it the same way as Sheets.
    expect(pickerActionKindForAdapter('google_drive')).toBe('google-drive-picker');
  });
  it('has no picker action kind for an adapter with no picker block', () => {
    // google_drive's positive mapping lands in Task 6 once its manifest carries
    // a picker action block; only the stable negative belongs here.
    expect(pickerActionKindForAdapter('attio')).toBeNull();
  });
});
