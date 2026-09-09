import { sql } from 'kysely';
import uniq from 'lodash/uniq';
import OpenAI from 'openai';

import { getEnvVar } from '../lib/utils/environment';
import { getKnowledgeQb } from '../lib/kysely';
import { chunkText, isWithinTokenLimit, CHUNK_SIZE, truncateToTokenLimit } from '../lib/chunking';
import { UserService } from '../services/user';
import { currentContext } from './context';
import { RawTextId } from '../generated/kysely/knowledge/RawText';
import RawTextPartType from '../generated/kysely/knowledge/RawTextPartType';
import { recordLlmUsage } from '../lib/llm_usage';

// Read at first USE: the module instantiates its services at import, so an
// eager read meant a production deployment with no OpenAI key could not boot.
const openAIApiKey = () =>
  getEnvVar('OPENAI_API_KEY', { devDefault: 'test', because: 'embeddings are computed by OpenAI' });

interface EmbedResult {
  isChunked: boolean;
  chunkCount: number;
}

class Embedding {
  private client: OpenAI | undefined;
  private get openai(): OpenAI {
    return (this.client ??= new OpenAI({ apiKey: openAIApiKey() }));
  }

  async createEmbedding(text: string, label?: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      input: truncateToTokenLimit(text),
      model: 'text-embedding-3-large',
    });

    recordLlmUsage({
      provider: 'openai',
      model: 'text-embedding-3-large',
      callType: 'embedding',
      label,
      inputTokens: response.usage.total_tokens,
      outputTokens: 0,
    }).catch(() => {});

    return response.data[0].embedding;
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

class OpenAIEmbedding {
  async createEmbedding(
    text: string | null | undefined,
    model: string = 'text-embedding-3-large',
    label?: string,
  ): Promise<number[] | null> {
    if (!text) {
      return null;
    }
    const client = new OpenAI({
      apiKey: openAIApiKey(),
    });

    try {
      const response = await client.embeddings.create({
        input: truncateToTokenLimit(text),
        model: model,
      });

      recordLlmUsage({
        provider: 'openai',
        model,
        callType: 'embedding',
        label,
        inputTokens: response.usage.total_tokens,
        outputTokens: 0,
      }).catch(() => {});

      return response.data[0].embedding;
    } catch (error) {
      console.error(
        `Error getting embedding for text: ${text}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

const EmbeddingService = new Embedding();
const OpenAIEmbeddingService = new OpenAIEmbedding();

export { EmbeddingService, OpenAIEmbeddingService };
