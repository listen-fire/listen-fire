// The Library shelf — one handbook per system capability, assembled
// from the per-capability registries. Each registry keeps its own
// chapter content (consumer-neutral: agents and the Library page read
// the same bodies); this module is only the catalogue: which books
// exist, what state they're in, and in what order they sit on the
// shelf.

import { chapterRoute, sliceChapterSection, splitChapterRoute } from '../../handbook_section';
import { adapterHandbook } from '../adapter_handbook';
import { getMovementHandbook } from '../movement_handbook';
import { modelHandbook } from '../model_handbook';
import { queryHandbook } from '../query_handbook';
import { getUsingListenFireHandbook } from '../using_listen_fire_handbook';

export type BookStatus = 'available' | 'legacy' | 'coming_soon';

export interface BookChapter {
  id: string;
  title: string;
  content: string;
}

export interface BookIntentEntry {
  intent: string;
  chapter: string;
  section?: string;
}

export interface LibraryBook {
  bookId: string;
  title: string;
  description: string;
  status: BookStatus;
  /** Short note shown next to the status badge (e.g. what superseded a legacy book). */
  statusNote?: string;
  /** External pointer for books that live elsewhere (e.g. a public repo). */
  link?: { label: string; url: string };
  chapters: BookChapter[];
  intentIndex: BookIntentEntry[];
}

interface RegistryHandbook {
  chapters: Record<string, { id: string; title: string; content: string }>;
  intentIndex: BookIntentEntry[];
}

function bookFrom(
  registry: RegistryHandbook,
  meta: Omit<LibraryBook, 'chapters' | 'intentIndex'>,
): LibraryBook {
  return {
    ...meta,
    chapters: Object.values(registry.chapters).map((c) => ({
      id: c.id,
      title: c.title,
      content: c.content,
    })),
    intentIndex: registry.intentIndex,
  };
}

function stub(meta: Omit<LibraryBook, 'chapters' | 'intentIndex'>): LibraryBook {
  return { ...meta, chapters: [], intentIndex: [] };
}

/**
 * The Library reader — the single source the `readBook` tool calls, on both
 * the agent path (lib/knowledge/unified_agent.ts) and the direct MCP path
 * (interfaces/rest/v1/knowledge_agent_tools.ts).
 *
 * No args → the shelf. bookId → that book's chapter index (+ when-to-read-what,
 * as compact `intent → chapter#section` lines). bookId + chapter(s) → the
 * bodies (a single chapter keeps its flat shape for back-compat; several come
 * back as a `chapters` array).
 *
 * A chapter id may carry a `#section` suffix — `writes#identity` — and a single
 * chapter may also take a separate `section` argument. Section addressing works
 * for any book whose chapters use `###` headings; one whose chapters don't says
 * so rather than failing obscurely.
 */
export function readBook(args: {
  bookId?: string;
  chapter?: string;
  chapters?: string[];
  section?: string;
}) {
  const shelf = getLibraryShelf();
  if (!args.bookId) {
    return {
      shelf: shelf.map((b) => ({
        bookId: b.bookId,
        title: b.title,
        status: b.status,
        description: b.description,
        chapters: b.chapters.map((c) => ({ id: c.id, title: c.title })),
      })),
    };
  }
  const book = shelf.find((b) => b.bookId === args.bookId);
  if (!book) {
    return {
      error: `No book '${args.bookId}'. Available: ${shelf.map((b) => b.bookId).join(', ')}`,
    };
  }
  if (book.status === 'coming_soon') {
    return {
      bookId: book.bookId,
      title: book.title,
      status: book.status,
      description: book.description,
      ...(book.link ? { link: book.link } : {}),
      note: 'This handbook is not written yet.',
    };
  }
  const requested =
    args.chapters && args.chapters.length > 0
      ? args.chapters
      : args.chapter
        ? [args.chapter]
        : [];
  if (requested.length === 0) {
    return {
      bookId: book.bookId,
      title: book.title,
      status: book.status,
      ...(book.statusNote ? { statusNote: book.statusNote } : {}),
      chapters: book.chapters.map((c) => ({ id: c.id, title: c.title })),
      // Compact lines, not objects: this index is paid by whoever is lost, and
      // the same routing in JSON cost roughly twice as much to say.
      whenToReadWhat: [
        'When you need to → read (a chapter, or chapter#section for one part of it):',
        ...book.intentIndex.map((e) => `${e.intent} → ${chapterRoute(e)}`),
      ].join('\n'),
    };
  }
  const known = `Chapters: ${book.chapters.map((c) => c.id).join(', ')}`;
  const read: ChapterRead[] = requested.map((requestedId) => {
    // The section may ride on the id (`writes#identity`) or, for a single
    // chapter, come as its own argument — one address, two spellings.
    const route = splitChapterRoute(requestedId);
    const section = route.section ?? (requested.length === 1 ? args.section : undefined);
    const id = route.chapter;
    const ch = book.chapters.find((c) => c.id === id);
    if (!ch) return { id, error: `No chapter '${id}' in '${book.bookId}'. ${known}` };
    if (section === undefined) return { id: ch.id, title: ch.title, content: ch.content };
    const slice = sliceChapterSection(ch.content, section);
    return slice.ok
      ? { id: ch.id, section: slice.section, title: ch.title, content: slice.content }
      : { id: ch.id, error: `${slice.error} (chapter '${ch.id}' in '${book.bookId}')` };
  });
  const only = read.length === 1 ? read[0] : undefined;
  if (only && only.content !== undefined) {
    return {
      bookId: book.bookId,
      chapter: only.id,
      ...(only.section ? { section: only.section } : {}),
      title: only.title,
      content: only.content,
    };
  }
  return { bookId: book.bookId, title: book.title, chapters: read };
}

/** One requested chapter (or section of one): its body, or why not. */
interface ChapterRead {
  id: string;
  section?: string;
  title?: string;
  content?: string;
  error?: string;
}

export function getLibraryShelf(): LibraryBook[] {
  return [
    bookFrom(getUsingListenFireHandbook(), {
      bookId: 'using-listen-fire',
      title: 'Using Listen-Fire',
      description:
        'Finding your way around the product: what each page is for, how to connect an integration, and how connecting, building automations, and automating fit together.',
      status: 'available',
    }),
    bookFrom(getMovementHandbook(), {
      bookId: 'automations',
      title: 'Writing automations',
      description:
        'Automations are small programs that move data when something happens — an email arrives, a record changes. How to write them: sources and targets, writes, extraction, branching, and going live.',
      status: 'available',
    }),
    bookFrom(modelHandbook, {
      bookId: 'knowledge-model',
      title: 'Knowledge model design & editing',
      description:
        'The structure behind everything Listen-Fire tracks: choosing entity types, fields, and relationships, teaching the system when two mentions are the same thing, and evolving a model that already holds data.',
      status: 'available',
    }),
    bookFrom(queryHandbook, {
      bookId: 'querying',
      title: 'Querying the knowledge model',
      description:
        'Working with your data in conversation: how to aim a question, how stated facts become records, merging duplicates, and tracing any answer back to its source.',
      status: 'available',
    }),
    stub({
      bookId: 'plugin-authoring',
      title: 'Plugin authoring',
      description:
        'How to write transform plugins — reusable steps an automation can import to reshape, clean, or enrich data as it moves.',
      status: 'coming_soon',
    }),
    bookFrom(adapterHandbook, {
      bookId: 'adapter-authoring',
      title: 'Adapter authoring',
      description:
        'How to build a remote adapter — an HTTP server that speaks Listen-Fire\'s small JSON protocol so a system you host reads and writes like a built-in integration: the wire contract, describing your data model, and a runnable reference server with its manifest.',
      status: 'available',
    }),
    stub({
      bookId: 'build-on-listen-fire',
      title: 'Build on Listen-Fire',
      description:
        'Building applications and integrations on top of Listen-Fire. This handbook is maintained in a public repository.',
      status: 'coming_soon',
      link: {
        label: 'github.com/listen-fire/build-on-listen-fire',
        url: 'https://github.com/listen-fire/build-on-listen-fire',
      },
    }),
  ];
}
