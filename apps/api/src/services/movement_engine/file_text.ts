// The extraction-source FILE → TEXT seam (knowledge-pipeline parity).
//
// When an `extract from [ … ]` source resolves to a `FileRef` (an
// attachment — e.g. `msg-[:attachments]->.`File``), the extractor must read
// the file's TEXT, not a stringified handle. This mirrors the knowledge
// pipeline exactly:
//
//   FileRef
//     → resolveFileRef  (owner adapter fetches bytes → Readable, OWN creds)
//     → OCR/text extractor  (services.ocr.extractPdf for scanned PDFs;
//                            getPptxText / getXlsxContent for decks/sheets)
//     → getOrCreateRawTextId  (checksum dedup + store → stable id; the
//       Context-free Kysely twin of RawTextService — see raw_text_store.ts)
//
// Byte resolution goes through the FileRef's own `retrieve()` (`streamFileRef`):
// the producing source adapter closed over its credentials when it emitted the
// FileRef, so there's no owner-adapter to re-resolve here — the FileRef fetches
// itself (plans/2026-06-18-fileref-resolution-rework).
//
// Audio (voice notes / audio attachments) is the fourth kind: the bytes are
// transcribed (`services.transcription`) and the TRANSCRIPT is the file's
// text — so spoken words flow into `extract from [ … ]` exactly where a
// deck's slides do. The audio's duration is metered as its own ledger line.
//
// Unsupported types (anything past PDF/PPTX/XLSX/audio) and empty extractions
// return `null`: the materialiser then skips the file rather than emitting a
// garbage FRAGMENT. The text-extraction primitives are the SAME ones
// `lib/agent/tools/extract_document_text.ts` calls — we operate on the
// resolved stream directly because that tool is keyed by a `Document` record
// id, which a source `FileRef` doesn't have.

import { services } from '../../adapters/registry';
import { MB } from '../../constants';
import { getXlsxContent } from '../../lib/utils/excel';
import { getPptxText } from '../../lib/utils/powerpoint';
import { logger } from '../logger';
import type { FileRef, ResolveFileRefResult } from '../translation_graph/adapter';
import { streamFileRef } from '../translation_graph/engine/files/retrieve';
import { getOrCreateRawTextId } from './raw_text_store';
import type { FileTextResult } from './extraction';

type FileKind = 'pdf' | 'pptx' | 'xlsx' | 'audio';

const AUDIO_EXTENSIONS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.webm', '.flac'];

/** OpenAI's transcription endpoint rejects requests past 25 MB — cap just
 *  under it. Read per call so tests (and ops) can override via env. */
function maxTranscriptionBytes(): number {
  const fromEnv = Number(process.env.MAX_TRANSCRIPTION_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 24 * MB;
}

/**
 * Classify a `FileRef` to a supported extractor by its content type or its
 * display-name extension — the union the knowledge pipeline handles.
 * Unknown/binary types return `undefined` (the file is skipped).
 */
function fileKind(ref: FileRef): FileKind | undefined {
  const name = (ref.name ?? '').toLowerCase();
  const type = (ref.contentType ?? '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (
    type.includes('presentationml') ||
    type.includes('powerpoint') ||
    name.endsWith('.pptx')
  ) {
    return 'pptx';
  }
  if (
    type.includes('spreadsheetml') ||
    type.includes('excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.csv')
  ) {
    return 'xlsx';
  }
  if (type.startsWith('audio/') || AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return 'audio';
  }
  return undefined;
}

/** Buffer a stream up to `cap` bytes; null (the caller logs loudly) past it —
 *  a voice note must transcribe whole or not at all, never silently cut. */
async function bufferStreamCapped(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > cap) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * The audio kind: buffer the bytes (size-capped), transcribe via the
 * registered speech-to-text service, and report the audio's duration to the
 * run's cost meter (the `transcription` ledger line) off the ambient usage
 * context — mirroring how the plugin call sites reach the meter.
 */
async function transcribeAudio(resolved: ResolveFileRefResult, ref: FileRef): Promise<string | null> {
  const cap = maxTranscriptionBytes();
  const declaredSize = resolved.size ?? ref.size;
  if (declaredSize !== undefined && declaredSize > cap) {
    logger.warn('[movement:file-text] audio too large to transcribe — skipping', {
      name: ref.name,
      size: declaredSize,
      cap,
    });
    return null;
  }
  const audio = await bufferStreamCapped(resolved.stream, cap);
  if (audio === null) {
    logger.warn('[movement:file-text] audio too large to transcribe — skipping', {
      name: ref.name,
      cap,
    });
    return null;
  }
  const result = await services.transcription.transcribe(audio, {
    name: ref.name,
    contentType: ref.contentType,
  });
  if (!result) return null;
  return result.text;
}

async function extractTextFromStream(
  kind: FileKind,
  resolved: ResolveFileRefResult,
  ref: FileRef,
): Promise<string | null> {
  switch (kind) {
    case 'pdf':
      return services.ocr.extractPdf(resolved.stream, { size: resolved.size ?? ref.size ?? 0 });
    case 'pptx':
      return getPptxText(resolved.stream);
    case 'xlsx':
      return getXlsxContent(resolved.stream, ref.name);
    case 'audio':
      return transcribeAudio(resolved, ref);
  }
}

/**
 * The production `resolveFileText` seam handed to the extraction runtime. This
 * module owns the byte-resolution → text-extraction → store pipeline so it stays
 * injectable for tests. Byte resolution is the FileRef's own `retrieve()`.
 */
export function makeFileTextResolver(): (ref: FileRef) => Promise<FileTextResult | null> {
  return async (ref) => {
    const kind = fileKind(ref);
    if (!kind) {
      logger.debug('[movement:file-text] unsupported file type — skipping', {
        name: ref.name,
        contentType: ref.contentType,
      });
      return null;
    }
    let resolved: ResolveFileRefResult;
    try {
      resolved = await streamFileRef(ref);
    } catch (error) {
      logger.warn('[movement:file-text] failed to resolve file bytes', {
        name: ref.name,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
      return null;
    }

    let text: string | null;
    try {
      text = await extractTextFromStream(kind, resolved, ref);
    } catch (error) {
      logger.warn('[movement:file-text] text extraction failed', {
        name: ref.name,
        kind,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
      return null;
    }
    if (!text || text.trim().length === 0) return null;

    const rawTextId = await getOrCreateRawTextId(text);
    return { text, rawTextId };
  };
}
