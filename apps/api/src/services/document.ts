import { Readable } from 'node:stream';

import { currentContext } from './context';
import { ModelService } from './utils';
import { services } from '../adapters/registry';

const DEMO_DECK_CHECKSUMS = [
  '69d3f7f3b5622903de8f2cbd2fa34fbd', // Wise
  '1ca585d934d3a13d250878c14c13f8ef', // Square
  'e8e992d0dcc3f5c607d8b3511a6c4141', // Airbnb
];

type CreateDocumentArgs = {
  description: string;
  objectUri: string;
  checksum: string;
};
class Document extends ModelService<'document'> {
  protected readonly objectName = 'document';

  async create({ description, objectUri, checksum }: CreateDocumentArgs) {
    const ctx = currentContext();

    return this.model.create({
      data: {
        description,
        objectUri,
        checksum,
        teamId: ctx.user.teamId,
        createdBy: ctx.user.id,
      },
    });
  }

  async setRawTextId(id: string, rawTextId: string) {
    return this.model.update({
      where: { id },
      data: { rawTextId },
    });
  }

  async createAndUpload(
    readable: Readable,
    {
      mimeType,
      contentLength,
      description,
    }: {
      mimeType?: string;
      contentLength: number;
      description: string;
    },
  ) {
    const { objectUri, checksum } = await services.document.upload(readable, {
      filename: description,
      mimeType,
      contentLength,
    });

    return this.create({ description, objectUri, checksum });
  }

  async uploadImageFromUrl(url: string, filename?: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch file from URL: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const readable = Readable.from(Buffer.from(buffer));

    return this.createAndUpload(readable, {
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      contentLength: response.headers.get('content-length')
        ? parseInt(response.headers.get('content-length')!)
        : buffer.byteLength,
      description: filename ?? 'file',
    });
  }

  async findFirstWithContentByChecksum(checksum: string) {
    const ctx = currentContext();
    return this.model.findFirst({
      where: { checksum, rawTextId: { not: null }, teamId: ctx.user.teamId },
    });
  }

  async uploadFromUrl(url: string, filename: string) {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();

    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length')
      ? parseInt(response.headers.get('content-length')!)
      : buffer.byteLength;

    const readable = Readable.from(Buffer.from(buffer));
    const { objectUri, checksum } = await services.document.upload(readable, {
      filename,
      mimeType,
      contentLength,
    });

    const document = await this.create({ description: filename, objectUri, checksum });

    return {
      id: document.id,
      objectUri,
      checksum,
      description: filename,
      mimeType,
      contentLength,
    };
  }

  async getDownloadUrl(id: string) {
    const doc = await this.getById(id);
    return services.document.getDownloadUrl(doc);
  }

  async isDemoDeck(_id: string) {
    // Disable demo decks
    return false;
    // const doc = await this.getById(id);
    // return doc.checksum ? DEMO_DECK_CHECKSUMS.includes(doc.checksum) : false;
  }
}

const DocumentService = new Document();

export { DocumentService };
