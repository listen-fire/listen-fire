export type ChapterId = 'shape' | 'identity' | 'relationships' | 'editing';

export interface Chapter {
  id: ChapterId;
  title: string;
  /** Full chapter body in formal-doc register:
   *  synopsis · the moves · worked example · common mistakes.
   *  Consumer-neutral: the same body can serve a design agent's reference
   *  tool and the Library reader, so no tool names or agent-loop mechanics. */
  content: string;
}

/** An index entry: a situation phrased as the designer's likely intent,
 *  routing to a chapter (and optionally a section anchor within it). */
export interface IntentEntry {
  intent: string;
  chapter: ChapterId;
  section?: string;
}

export interface Handbook {
  preface: string;
  conventions: string;
  intentIndex: IntentEntry[];
  chapters: Record<ChapterId, Chapter>;
}
