// A label is its NAME on every path: a message's `Labels` on a walk and an
// arrival, and a labeling's `Label`. Gmail's search takes a label by name, and
// so does the program that writes `m.Labels CONTAINS "Deals"` or
// `l.Label == "Deals"`. Gmail's own records carry ids, so a record is renamed
// when it is built. System labels are their own name (INBOX, SENT); an id the
// mailbox no longer lists stays as it is.

import type { GmailApiClient, GmailLabel } from './api_client';
import type { GmailMessageRecord } from './mime';

/** Gmail's own labels, which every mailbox has and no person made. */
const SYSTEM_LABELS = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT']);

export function isSystemLabel(id: string): boolean {
  return SYSTEM_LABELS.has(id) || id.startsWith('CATEGORY_');
}

/** The mailbox's label list, asked at most once and only when a record
 *  carries a user label. */
export class LabelNames {
  private known: Promise<GmailLabel[]> | undefined;

  constructor(private readonly client: Pick<GmailApiClient, 'listLabels'>) {}

  list(): Promise<GmailLabel[]> {
    this.known ??= this.client.listLabels();
    return this.known;
  }

  /** One label's name, from the id Gmail's history gives it. */
  async nameOf(id: string): Promise<string> {
    if (isSystemLabel(id)) return id;
    return (await this.list()).find((label) => label.id === id)?.name ?? id;
  }

  async named(records: readonly GmailMessageRecord[]): Promise<GmailMessageRecord[]> {
    if (records.every((record) => record.labels.every(isSystemLabel))) return [...records];
    const nameOf = new Map((await this.list()).map((label) => [label.id, label.name]));
    return records.map((record) => ({ ...record, labels: record.labels.map((id) => nameOf.get(id) ?? id) }));
  }
}
