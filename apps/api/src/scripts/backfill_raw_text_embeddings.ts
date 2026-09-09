import OpenAI from 'openai';

import { getKnowledgeQb } from '../lib/kysely';
import { getEnvVar } from '../lib/utils/environment';
import { chunkText, isWithinTokenLimit, CHUNK_SIZE } from '../lib/chunking';
import { RawTextId } from '../generated/kysely/knowledge/RawText';
import { RawTextPartId } from '../generated/kysely/knowledge/RawTextPart';
import RawTextPartType from '../generated/kysely/knowledge/RawTextPartType';

const BATCH_SIZE = 100;
const CONCURRENT_EMBEDDINGS = 10;
const CONCURRENT_CONTENT_UPDATES = 50;

const openAIApiKey = getEnvVar('OPENAI_API_KEY', { devDefault: 'test' });
const openai = new OpenAI({ apiKey: openAIApiKey });

async function createEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    input: text,
    model: 'text-embedding-3-large',
  });
  return response.data[0].embedding;
}

async function embedRawText(record: { id: string; content: string; team_id: string }): Promise<{
  isChunked: boolean;
  chunkCount: number;
}> {
  const kysely = getKnowledgeQb(['raw_text', 'raw_text_part']);

  if (isWithinTokenLimit(record.content, CHUNK_SIZE)) {
    const embedding = await createEmbedding(record.content);

    await kysely
      .updateTable('raw_text')
      .set({
        embedding: JSON.stringify(embedding),
        is_chunked: false,
      })
      .where('id', '=', record.id as RawTextId)
      .execute();

    return { isChunked: false, chunkCount: 0 };
  }

  const chunks = chunkText(record.content, { maxTokens: CHUNK_SIZE, strategy: 'paragraph' });

  await kysely
    .updateTable('raw_text')
    .set({
      embedding: null,
      is_chunked: true,
    })
    .where('id', '=', record.id as RawTextId)
    .execute();

  await processInParallel(chunks, CONCURRENT_EMBEDDINGS, async (chunk) => {
    const embedding = await createEmbedding(chunk.content);

    await kysely
      .insertInto('raw_text_part')
      .values({
        team_id: record.team_id,
        raw_text_id: record.id as RawTextId,
        type: RawTextPartType.EMBEDDING_CHUNK,
        start: chunk.start,
        end: chunk.end,
        content: chunk.content,
        embedding: JSON.stringify(embedding),
      })
      .execute();
  });

  return { isChunked: true, chunkCount: chunks.length };
}

async function processInParallel<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = processor(item).then((result) => {
      results.push(result);
    });
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(
        0,
        executing.length,
        ...executing.filter((p) => {
          let resolved = false;
          p.then(() => (resolved = true)).catch(() => (resolved = true));
          return !resolved;
        }),
      );
    }
  }

  await Promise.all(executing);
  return results;
}

async function backfillMissingContent() {
  const kysely = getKnowledgeQb(['raw_text', 'raw_text_part']);

  console.log('Phase 1: Backfilling content for existing chunks...');

  const chunksWithoutContent = await kysely
    .selectFrom('raw_text_part as rtp')
    .innerJoin('raw_text as rt', 'rt.id', 'rtp.raw_text_id')
    .select(['rtp.id', 'rtp.start', 'rtp.end', 'rt.content as parent_content'])
    .where('rtp.type', '=', RawTextPartType.EMBEDDING_CHUNK)
    .where('rtp.embedding', 'is not', null)
    .where('rtp.content', 'is', null)
    .execute();

  console.log(`Found ${chunksWithoutContent.length} chunks missing content`);

  if (chunksWithoutContent.length === 0) {
    console.log('Phase 1 complete: No chunks to update\n');
    return;
  }

  let contentBackfilled = 0;

  await processInParallel(chunksWithoutContent, CONCURRENT_CONTENT_UPDATES, async (chunk) => {
    const chunkContent = chunk.parent_content.slice(chunk.start, chunk.end);
    await kysely
      .updateTable('raw_text_part')
      .set({ content: chunkContent })
      .where('id', '=', chunk.id as RawTextPartId)
      .execute();

    contentBackfilled++;
    if (contentBackfilled % 100 === 0) {
      console.log(`  Content backfilled: ${contentBackfilled}/${chunksWithoutContent.length}`);
    }
  });

  console.log(`Phase 1 complete: ${contentBackfilled} chunks updated with content\n`);
}

async function backfillEmbeddings() {
  const kysely = getKnowledgeQb(['raw_text', 'raw_text_part']);

  await backfillMissingContent();

  console.log('Phase 2: Creating embeddings for raw_text records...');

  const totalCount = await kysely
    .selectFrom('raw_text')
    .select(({ fn }) => fn.count<number>('id').as('count'))
    .where('embedding', 'is', null)
    .where('is_chunked', '=', false)
    .executeTakeFirstOrThrow();

  console.log(`Found ${totalCount.count} raw_text records without embeddings`);

  let processed = 0;
  let chunked = 0;
  let failed = 0;

  while (true) {
    const batch = await kysely
      .selectFrom('raw_text')
      .select(['id', 'content', 'team_id'])
      .where('embedding', 'is', null)
      .where('is_chunked', '=', false)
      .limit(BATCH_SIZE)
      .execute();

    if (batch.length === 0) {
      break;
    }

    await processInParallel(batch, CONCURRENT_EMBEDDINGS, async (record) => {
      try {
        const result = await embedRawText(record);
        processed++;
        if (result.isChunked) {
          chunked++;
        }
      } catch (error) {
        console.error(
          `Failed to embed raw_text ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed++;
      }
    });

    console.log(`Progress: ${processed} processed (${chunked} chunked), ${failed} failed`);
  }

  console.log(`\nPhase 2 complete: ${processed} processed (${chunked} chunked), ${failed} failed`);
}

backfillEmbeddings()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });
