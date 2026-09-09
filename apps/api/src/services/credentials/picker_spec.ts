// The per-adapter Google Picker configuration — the ONLY thing that differs
// between the Sheets and Drive pickers. Keyed by the manifest action block's
// actionKind so a token's adapter_slug resolves its picker config with no new
// token column.
import { getAdapterManifest } from '../translation_graph/adapters/registry';

export type PickerActionKind = 'google-sheets-picker' | 'google-drive-picker';

const PICKER_ACTION_KINDS: readonly PickerActionKind[] = [
  'google-sheets-picker',
  'google-drive-picker',
];

export interface PickerSpec {
  title: string;
  blurb: string;
  /** Exact Drive mimetypes to show; empty = all types. */
  mimeTypes: string[];
  allowFolders: boolean;
}

const SPECS: Record<PickerActionKind, PickerSpec> = {
  'google-sheets-picker': {
    title: 'Choose a spreadsheet',
    blurb:
      'Listen-Fire can only see the spreadsheets you explicitly choose — picking one ' +
      'here grants access to that file and nothing else in your Drive.',
    mimeTypes: ['application/vnd.google-apps.spreadsheet'],
    allowFolders: false,
  },
  'google-drive-picker': {
    title: 'Choose files or folders',
    blurb:
      'Listen-Fire can only see the files and folders you explicitly choose — picking ' +
      'here grants access to those items and nothing else in your Drive.',
    mimeTypes: [],
    allowFolders: true,
  },
};

export function pickerSpecForActionKind(kind: PickerActionKind): PickerSpec {
  return SPECS[kind];
}

function isPickerActionKind(v: string): v is PickerActionKind {
  return (PICKER_ACTION_KINDS as readonly string[]).includes(v);
}

/** The picker action kind an adapter declares, or null if it has no picker. */
export function pickerActionKindForAdapter(slug: string): PickerActionKind | null {
  const manifest = getAdapterManifest(slug);
  if (!manifest) return null;
  for (const block of manifest.construction ?? []) {
    if (block.kind === 'action' && isPickerActionKind(block.actionKind)) {
      return block.actionKind;
    }
  }
  return null;
}
