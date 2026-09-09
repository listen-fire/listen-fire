// The "Using Listen-Fire" handbook — orients agent and user in the product
// itself: where pages live, how to connect an integration, how the
// pieces fit. Same registry shape as the other handbooks, with one
// twist: the "connecting" chapter is rendered live from the adapter
// manifests (see index.ts) so the credential facts can't go stale.

export type ChapterId =
  | 'getting-around'
  | 'connecting-integrations'
  | 'connect-build-automate';

export interface Chapter {
  id: ChapterId;
  title: string;
  /** Full chapter body, consumer-neutral (serves the agent's readBook
   *  tool and the Library page identically — no tool names, no agent-loop
   *  mechanics). */
  content: string;
}

export interface IntentEntry {
  intent: string;
  chapter: ChapterId;
  section?: string;
}

export interface UsingListenFireHandbook {
  chapters: Record<ChapterId, Chapter>;
  intentIndex: IntentEntry[];
}
