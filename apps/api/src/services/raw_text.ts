import * as db from '@prisma/client';

import { checksum } from '../lib/utils/hash';
import { getKnowledgeQb } from '../lib/kysely';
import { currentContext } from './context';
import { EmbeddingService } from './embedding';
import { ModelService } from './utils';
import { retry } from '../lib/utils/async';
import { RawTextId } from '../generated/kysely/knowledge/RawText';

type RawTextCreateArgs = {
  content: string;
};

type RawTextCreateOptions = {
  embedMode: 'IMMEDIATE' | 'DEFERRED' | 'SKIP';
};

const defaultOptions: RawTextCreateOptions = {
  embedMode: 'IMMEDIATE',
};

class RawText extends ModelService<'rawText'> {
  protected readonly objectName = 'rawText';

  async getByChecksumOrCreate(
    data: RawTextCreateArgs & { checksum: string },
    options?: Partial<RawTextCreateOptions>,
  ): Promise<db.RawText> {
    return retry(async () => {
      const ctx = currentContext();
      const existing = await this.model.findFirst({
        where: { checksum: data.checksum, teamId: ctx.user.teamId },
      });
      return existing ?? this.create(data, options);
    });
  }

  async getOrCreateFromContent(content: string, options?: Partial<RawTextCreateOptions>) {
    const trimmedContent = content.trim();
    const result = await this.getByChecksumOrCreate(
      { content: trimmedContent, checksum: checksum(trimmedContent) },
      options,
    );

    return result;
  }

  async create(data: RawTextCreateArgs, options?: Partial<RawTextCreateOptions>) {
    const ctx = currentContext();
    const rawText = await this.model.create({
      data: {
        ...data,
        checksum: checksum(data.content),
        teamId: ctx.user.teamId,
      },
    });

    const opts = { ...defaultOptions, ...options };
    if (opts.embedMode === 'SKIP') {
      return rawText;
    }

    const embeddingPromise = EmbeddingService.embedAndStore(
      rawText.id,
      data.content,
      ctx.user.teamId,
    );

    if (opts.embedMode === 'IMMEDIATE') {
      await embeddingPromise;
    } else if (opts.embedMode === 'DEFERRED') {
      embeddingPromise.catch((err) => console.error(err));
    }

    return rawText;
  }

  async ensureIndexed(id: string, options?: Partial<RawTextCreateOptions>) {
    const ctx = currentContext();
    const opts = { ...defaultOptions, ...options };
    if (opts.embedMode === 'SKIP') {
      return;
    }

    const rawText = await this.getById(id);

    const existing = await getKnowledgeQb(['raw_text'])
      .selectFrom('raw_text')
      .select(['embedding', 'is_chunked'])
      .where('id', '=', id as RawTextId)
      .executeTakeFirst();

    if (existing?.embedding || existing?.is_chunked) {
      return;
    }

    const embeddingPromise = EmbeddingService.embedAndStore(
      rawText.id,
      rawText.content,
      ctx.user.teamId,
    );

    if (opts.embedMode === 'IMMEDIATE') {
      await embeddingPromise;
    } else if (opts.embedMode === 'DEFERRED') {
      embeddingPromise.catch((err) => console.error(err));
    }
  }

  // `findManyByLegalEntityId` was DELETED here. It traversed the
  // `inbound_payload_segment` relation into dealflow's payload tables; the
  // source-material move made that FK cross-schema, so Prisma stopped modelling
  // the relation. Zero callers in the repo — the same disposition as
  // `ResourceService`'s namesake, and for the same reason.

  async addPart({
    rawTextId,
    start,
    end,
    content,
    type,
    classifications,
  }: {
    rawTextId: string;
    start: number;
    end: number;
    content: string | null;
    type: db.RawTextPartType;
    classifications?: string[];
  }) {
    const ctx = currentContext();
    return ctx.prisma.rawTextPart.create({
      data: {
        rawTextId,
        type,
        start,
        end,
        compressedContent: content,
        classifications,
        teamId: ctx.user.teamId,
      },
    });
  }

  async getPartById(partId: string) {
    const ctx = currentContext();
    return ctx.prisma.rawTextPart.findFirstOrThrow({
      where: {
        id: partId,
        teamId: ctx.user.teamId,
      },
    });
  }

  async getParts({
    rawTextId,
    start,
    end,
    classifications,
  }: {
    rawTextId: string;
    start?: number | null;
    end?: number | null;
    classifications?: string[];
  }) {
    const ctx = currentContext();
    return ctx.prisma.rawTextPart.findMany({
      where: {
        rawTextId,
        teamId: ctx.user.teamId,
        ...(end ? { start: { lte: end } } : null),
        ...(start ? { end: { gte: start } } : null),
        ...(classifications?.length ? { classifications: { hasSome: classifications } } : null),
      },
      orderBy: { start: 'asc' },
    });
  }
}

const RawTextService = new RawText();

export { RawTextService };
