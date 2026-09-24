import { sql } from 'kysely';
import uniq from 'lodash/uniq';
import OpenAI from 'openai';
import { z } from 'zod';

import { getEnvVar } from '../lib/utils/environment';
import { getKnowledgeQb } from '../lib/kysely';
import {
  chunkText,
  countTokens,
  isWithinTokenLimit,
  CHUNK_SIZE,
  truncateToTokenLimit,
} from '../lib/chunking';
import { googleBearerTokens, googleModelUrl } from '../lib/google_cloud';
import { openAiRoute } from '../lib/model_route';
import { neverAsAny } from '../lib/utils/types';
import { UserService } from '../services/user';
import { currentContext } from './context';
import { RawTextId } from '../generated/kysely/knowledge/RawText';
import RawTextPartType from '../generated/kysely/knowledge/RawTextPartType';
import { recordLlmUsage } from '../lib/llm_usage';

// Read at first USE: the module instantiates its services at import, so an
// eager read meant a production deployment with no OpenAI key could not boot.
const openAIApiKey = () =>
  getEnvVar('OPENAI_API_KEY', { devDefault: 'test', because: 'embeddings are computed by OpenAI' });

/**
 * Every pgvector column this repo writes, and the request that fills it on each
 * route. A vector's width belongs to the COLUMN, not to the model: the same text
 * embedded for `extraction_fact` is 256 numbers wide because that column is, and
 * asking the provider for anything else writes a row Postgres refuses.
 *
 * Vectors written on one route are deliberately NOT required to be comparable
 * with vectors written on the other, so nothing here tries to reconcile the two
 * models' spaces.
 */
const EMBEDDING_DESTINATIONS = {
  /** knowledge.raw_text.embedding and knowledge.raw_text_part.embedding */
  raw_text: {
    vectorWidth: 3072,
    // No `dimensions`: 3072 is this model's native width, and asking for it
    // explicitly would change a request that works today for no gain.
    openAi: { model: 'text-embedding-3-large', dimensions: undefined },
  },
  /** knowledge.extraction_fact.embedding */
  extraction_fact: {
    vectorWidth: 256,
    openAi: { model: 'text-embedding-3-small', dimensions: 256 },
  },
} as const;

type EmbeddingDestination = keyof typeof EMBEDDING_DESTINATIONS;

/**
 * Google's text embedding model, verified 2026-09-17 against
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings
 *
 * Chosen over the newer `gemini-embedding-2` because this one's REST surface —
 * request AND response, including `outputDimensionality` — is documented
 * verbatim, and `gemini-embedding-2` is only documented through its SDK.
 */
const GOOGLE_EMBEDDING_MODEL = 'gemini-embedding-001';

/** Per-text ceiling for that model. Our texts are chunks of at most
 *  {@link CHUNK_SIZE} tokens and subject-predicate-object triples, so nothing we
 *  send comes near it — which is exactly why exceeding it should be an error
 *  rather than a shrug (see `autoTruncate` below). */
const GOOGLE_EMBEDDING_MAX_TOKENS = 2048;

/**
 * One text per request.
 *
 * The docs give three different numbers on one page — 250 input texts, then five,
 * then "for gemini-embedding-001, each request can only include a single input
 * text". One is the only figure all three readings allow.
 */
const GOOGLE_EMBEDDING_TEXTS_PER_REQUEST = 1;

/** The vector, and what Google says it cost. PARSED rather than asserted: this
 *  is a boundary, and a shape we assert is a shape we have stopped checking. */
const EmbeddingPredictions = z.object({
  predictions: z.array(
    z.object({
      embeddings: z.object({
        values: z.array(z.number()),
        statistics: z.object({ token_count: z.number().optional() }).optional(),
      }),
    }),
  ),
});

function readEmbeddingPredictions(body: unknown): Array<{ values: number[]; tokens: number }> {
  const parsed = EmbeddingPredictions.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Google answered an embedding request in a shape we do not recognise: ${parsed.error.message.slice(0, 300)}`,
    );
  }
  return parsed.data.predictions.map(({ embeddings }) => ({
    values: embeddings.values,
    tokens: embeddings.statistics?.token_count ?? 0,
  }));
}

/**
 * `gemini-embedding-001` truncates a vector to `outputDimensionality` WITHOUT
 * renormalising it, and the whole reason cosine distance and dot product agree
 * on the full-length vector is that it arrives normalised. A truncated one has
 * to be put back on the unit sphere here, or every distance the database
 * computes against it is measuring length as well as direction.
 *
 * (Google's own guidance, on the Gemini API docs for the same model: "If you are
 * using gemini-embedding-001, you must manually normalize non-3072 dimensions".)
 */
function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return magnitude === 0 ? values : values.map((v) => v / magnitude);
}

async function googleEmbed(options: {
  texts: string[];
  destination: EmbeddingDestination;
  label?: string;
}): Promise<number[][]> {
  const { vectorWidth } = EMBEDDING_DESTINATIONS[options.destination];
  const url = googleModelUrl({ model: GOOGLE_EMBEDDING_MODEL, method: 'predict' });
  const tokens = googleBearerTokens();
  const vectors: number[][] = [];

  for (let i = 0; i < options.texts.length; i += GOOGLE_EMBEDDING_TEXTS_PER_REQUEST) {
    const batch = options.texts.slice(i, i + GOOGLE_EMBEDDING_TEXTS_PER_REQUEST);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await tokens()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // No `task_type`. The two embedding entry points here do not divide into
        // a document side and a query side — `batchEmbed` serves both — so there
        // is no honest pair to map onto Google's, and the default it documents
        // (RETRIEVAL_QUERY) is what an unset field means.
        instances: batch.map((content) => ({ content })),
        parameters: {
          // Google silently truncates a text past the model's limit by default.
          // Nothing we send can reach 2048 tokens without something upstream
          // having broken, so a refusal names that break instead of embedding a
          // prefix and calling it the text.
          autoTruncate: false,
          outputDimensionality: vectorWidth,
        },
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Google embedding error ${response.status}: ${detail}`);
    }

    const predictions = readEmbeddingPredictions(await response.json());
    if (predictions.length !== batch.length) {
      throw new Error(
        `Google returned ${predictions.length} embeddings for ${batch.length} texts.`,
      );
    }

    for (const prediction of predictions) {
      if (prediction.values.length !== vectorWidth) {
        throw new Error(
          `Google returned a ${prediction.values.length}-dimension vector for ` +
            `${options.destination}, which stores ${vectorWidth}.`,
        );
      }
      vectors.push(vectorWidth === 3072 ? prediction.values : normalize(prediction.values));
    }

    recordLlmUsage({
      provider: 'google',
      model: GOOGLE_EMBEDDING_MODEL,
      callType: 'embedding',
      label: options.label,
      inputTokens: predictions.reduce((sum, p) => sum + p.tokens, 0),
      outputTokens: 0,
    }).catch(() => {});
  }

  return vectors;
}

/**
 * Embed some texts for one destination column, whichever vendor this deployment
 * routes model calls to. The caller names where the vectors are going, not which
 * model to use: the model and the width are the destination's business.
 */
export async function embedTexts(options: {
  texts: string[];
  destination: EmbeddingDestination;
  label?: string;
}): Promise<number[][]> {
  if (options.texts.length === 0) return [];
  const route = openAiRoute();
  switch (route) {
    case 'direct': {
      const { openAi } = EMBEDDING_DESTINATIONS[options.destination];
      const client = new OpenAI({ apiKey: openAIApiKey() });
      const response = await client.embeddings.create({
        model: openAi.model,
        input: options.texts,
        ...(openAi.dimensions === undefined ? {} : { dimensions: openAi.dimensions }),
      });

      recordLlmUsage({
        provider: 'openai',
        model: openAi.model,
        callType: 'embedding',
        label: options.label,
        inputTokens: response.usage.total_tokens,
        outputTokens: 0,
      }).catch(() => {});

      return response.data.map((d) => d.embedding);
    }
    case 'google': {
      const tooLong = options.texts.find((text) => countTokens(text) > GOOGLE_EMBEDDING_MAX_TOKENS);
      if (tooLong !== undefined) {
        throw new Error(
          `A text of ${countTokens(tooLong)} tokens was sent for embedding, over the ` +
            `${GOOGLE_EMBEDDING_MAX_TOKENS}-token limit of ${GOOGLE_EMBEDDING_MODEL}. ` +
            'Chunk it before embedding rather than embedding a prefix of it.',
        );
      }
      return googleEmbed(options);
    }
    default:
      return neverAsAny(route);
  }
}

interface EmbedResult {
  isChunked: boolean;
  chunkCount: number;
}

class Embedding {
  async createEmbedding(text: string, label?: string): Promise<number[]> {
    const [embedding] = await embedTexts({
      // Truncation stays on the caller's side of the route switch: it is what
      // this path has always done, and the google branch refuses rather than
      // truncates.
      texts: [truncateToTokenLimit(text)],
      destination: 'raw_text',
      label,
    });
    return embedding;
  }

  async embedAndStore(rawTextId: string, content: string, teamId: string): Promise<EmbedResult> {
    if (isWithinTokenLimit(content, CHUNK_SIZE)) {
      const embedding = await this.createEmbedding(content);

      await getKnowledgeQb(['raw_text'])
        .updateTable('raw_text')
        .set({
          embedding: JSON.stringify(embedding),
          is_chunked: false,
        })
        .where('id', '=', rawTextId as RawTextId)
        .execute();

      return { isChunked: false, chunkCount: 0 };
    }

    const chunks = chunkText(content, { maxTokens: CHUNK_SIZE, strategy: 'paragraph' });

    await getKnowledgeQb(['raw_text'])
      .updateTable('raw_text')
      .set({
        embedding: null,
        is_chunked: true,
      })
      .where('id', '=', rawTextId as RawTextId)
      .execute();

    for (const chunk of chunks) {
      const embedding = await this.createEmbedding(chunk.content);

      await getKnowledgeQb(['raw_text_part'])
        .insertInto('raw_text_part')
        .values({
          team_id: teamId,
          raw_text_id: rawTextId as RawTextId,
          type: RawTextPartType.EMBEDDING_CHUNK,
          start: chunk.start,
          end: chunk.end,
          content: chunk.content,
          embedding: JSON.stringify(embedding),
        })
        .execute();
    }

    return { isChunked: true, chunkCount: chunks.length };
  }


}

const EmbeddingService = new Embedding();

export { EmbeddingService };
