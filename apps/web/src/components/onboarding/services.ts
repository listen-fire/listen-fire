/**
 * The curated service set for the lobby's Step 3 picker.
 *
 * Deliberately a hand-picked onboarding set (not the full adapter roster the
 * marketing grid pulls from `/api/public/integrations`), because we need brand
 * colours the manifests don't carry and want only the recognisable systems a
 * new user is likely to name. Categories + order mirror the marketing landing
 * page; alphabetical within each group.
 *
 * `key` is a `ServiceIcon` type key (see service-icon.tsx). `brand` is the
 * logo/holo colour; `brandBg` optionally overrides the background/glow colour
 * where the logo colour makes a poor wash (e.g. Granola's near-brown mark → a
 * green background).
 *
 * The picker renders this list flat, in this order — the grouping lives in the
 * ordering, not in any on-screen category chrome.
 *
 */

export type ServiceCategory =
  | "CRM"
  | "Email"
  | "Messaging"
  | "Files"
  | "Spreadsheets"
  | "Meetings";

export interface PickerService {
  /** ServiceIcon type key. */
  key: string;
  label: string;
  category: ServiceCategory;
  /** Brand colour for the logo + holo reveal. */
  brand: string;
  /** Optional secondary colour for the card tint / glow when the logo colour
   *  would make a poor background wash. */
  brandBg?: string;
}

export const PICKER_SERVICES: PickerService[] = [
  { key: "ATTIO", label: "Attio", category: "CRM", brand: "#1D1D1F" },
  { key: "AFFINITY", label: "Affinity", category: "CRM", brand: "#3A5BFF" },
  { key: "EVERTRACE", label: "Evertrace", category: "CRM", brand: "#111827" },
  { key: "EMAIL", label: "Email", category: "Email", brand: "#64748B" },
  { key: "SLACK", label: "Slack", category: "Messaging", brand: "#611F69" },
  { key: "TELEGRAM", label: "Telegram", category: "Messaging", brand: "#26A5E4" },
  { key: "WHATSAPP", label: "WhatsApp", category: "Messaging", brand: "#25D366" },
  { key: "DROPBOX", label: "Dropbox", category: "Files", brand: "#0061FF" },
  { key: "GOOGLE_DRIVE", label: "Google Drive", category: "Files", brand: "#1DA462" },
  { key: "AIRTABLE", label: "Airtable", category: "Spreadsheets", brand: "#1CA7EC" },
  { key: "GOOGLE_SHEETS", label: "Google Sheets", category: "Spreadsheets", brand: "#0F9D58" },
  { key: "GRANOLA", label: "Granola", category: "Meetings", brand: "#8B5E34", brandBg: "#3D9A5B" },
];

/** The labels the workflow-idea generator may reference, used to highlight
 *  system names in the returned prompts. Longest first so "Google Sheets"
 *  matches before "Google". */
export const PICKER_SERVICE_LABELS = [...PICKER_SERVICES]
  .map((s) => s.label)
  .sort((a, b) => b.length - a.length);
