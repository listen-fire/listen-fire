// Each destination column asks for its own registry model at its own width;
// the vendor behind that model is the map's business, tested beside it.

const embed = jest.fn();
jest.mock('../../lib/models/embedding', () => ({
  embed: (...args: unknown[]) => embed(...args),
}));

// The knowledge query builder is only reached by `embedAndStore`, which these
// tests do not exercise — but the module builds one at import.
jest.mock('../../lib/kysely', () => ({ getKnowledgeQb: jest.fn(), getQb: jest.fn() }));

import { EmbeddingService, embedTexts } from '../embedding';

beforeEach(() => {
  embed.mockReset().mockResolvedValue({ embeddings: [[0.1]] });
});

it('sends raw_text to the large model at 3072', async () => {
  await embedTexts({ texts: ['hello'], destination: 'raw_text', label: 'l' });
  expect(embed).toHaveBeenCalledWith('text-embedding-3-large', { input: ['hello'], dimensions: 3072, label: 'l' });
});

it('sends extraction_fact to the small model at 256', async () => {
  await embedTexts({ texts: ['hello'], destination: 'extraction_fact' });
  expect(embed).toHaveBeenCalledWith('text-embedding-3-small', {
    input: ['hello'],
    dimensions: 256,
    label: undefined,
  });
});

it('truncates a long text before it reaches any vendor', async () => {
  await EmbeddingService.createEmbedding('word '.repeat(20000));
  const [, { input }] = embed.mock.calls[0];
  expect(input[0].length).toBeLessThan('word '.repeat(20000).length);
});
