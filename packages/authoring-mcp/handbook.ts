// The handbook as the authoring tools serve it: the front page, then lookups.
// An agent with searchLanguage looks things up rather than reading chapters
// through, so a whole hand-written chapter answers with a pointer to the
// search; a section of one (`writes#identity`), the front page and its
// sections (`front#maybe-absent`), and a host's system and plugin chapters
// read in full. Those are the anchors search results and diagnostics hand
// out, so each must resolve.

import {
  CORE_CHAPTERS,
  frontSection,
  readChapter,
  renderFrontPage,
  searchLanguage,
  type Chapter,
  type LanguageSearchKind,
  type LanguageSearchResult,
} from '@listen-fire/handbook';
import { splitChapterRoute } from 'engine-contracts/handbook_section';

import type { AuthoringHost } from './host';

export const HANDBOOK_ID = 'automations';
const FRONT_PAGE_ID = 'front';
const FRONT_PAGE_TITLE = 'Front page: where TypeScript habits mislead, and what the language adds';
const CHAPTER_POINTER =
  'This handbook is the front page plus lookups: call searchLanguage with what you need (a built-in, a system, a recipe, a concept) and read the anchor a result names, or read the front page (no chapter).';

export type HostChapters = NonNullable<AuthoringHost['chapters']>;

/** The book: the language's chapters and the host's. */
function bookOf(hostChapters: HostChapters): Readonly<Record<string, Chapter>> {
  const host = Object.values(hostChapters).filter((chapter): chapter is Chapter => chapter !== undefined);
  return { ...CORE_CHAPTERS, ...Object.fromEntries(host.map((chapter) => [chapter.id, chapter])) };
}

interface ChapterRead {
  id: string;
  section?: string;
  title?: string;
  content?: string;
  error?: string;
  note?: string;
}

function readOne(book: Readonly<Record<string, Chapter>>, route: string): ChapterRead {
  const { chapter: id, section } = splitChapterRoute(route);
  if (id === FRONT_PAGE_ID) {
    if (section === undefined) return { id, title: FRONT_PAGE_TITLE, content: renderFrontPage() };
    const entry = frontSection(section);
    return entry.ok ? { id, section, title: FRONT_PAGE_TITLE, content: entry.content } : { id, error: entry.error };
  }
  // A hand-written chapter is the teaching the front page and search replace;
  // a system's or plugin's chapter is reference, and reads whole.
  if (section === undefined && id in CORE_CHAPTERS) return { id, note: CHAPTER_POINTER };
  const read = readChapter(book, id, section);
  if (!read.ok) return { id, error: read.error };
  return { id, ...(read.section !== undefined ? { section: read.section } : {}), title: book[id]?.title ?? id, content: read.content };
}

/** readHandbook: the shelf, the front page, or the anchors asked for. */
export function readHandbook(
  input: { handbook?: string; chapter?: string; chapters?: string[] },
  hostChapters: HostChapters = {},
) {
  const book = bookOf(hostChapters);
  const hostIds = Object.keys(book).filter((id) => !(id in CORE_CHAPTERS));
  const requested = input.chapters !== undefined && input.chapters.length > 0 ? input.chapters : input.chapter !== undefined ? [input.chapter] : [];
  if (input.handbook === undefined && requested.length === 0) {
    return {
      shelf: [
        {
          handbook: HANDBOOK_ID,
          title: 'Writing automations',
          chapters: [{ id: FRONT_PAGE_ID, title: FRONT_PAGE_TITLE }, ...hostIds.map((id) => ({ id, title: book[id]?.title ?? id }))],
        },
      ],
    };
  }
  if (input.handbook !== undefined && input.handbook !== HANDBOOK_ID) {
    return { error: `No handbook '${input.handbook}'. Available: ${HANDBOOK_ID}.` };
  }
  if (requested.length === 0) return { handbook: HANDBOOK_ID, chapter: FRONT_PAGE_ID, title: FRONT_PAGE_TITLE, content: renderFrontPage() };
  const read = requested.map((route) => readOne(book, route));
  const only = read.length === 1 ? read[0] : undefined;
  if (only !== undefined && only.error === undefined) {
    const { id, ...read } = only;
    return { handbook: HANDBOOK_ID, chapter: id, ...read };
  }
  return { handbook: HANDBOOK_ID, chapters: read };
}

/** searchLanguage over the language's chapters and the host's. */
export function searchHandbook(input: { query: string; kind?: LanguageSearchKind }, hostChapters: HostChapters = {}): LanguageSearchResult {
  return searchLanguage(input, bookOf(hostChapters));
}
