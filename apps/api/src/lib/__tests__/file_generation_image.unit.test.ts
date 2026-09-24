// A generated image is drawn by whatever the map sends gpt-image-1 to, and stored
// under the title with the extension its bytes call for.

const drawImage = jest.fn();
jest.mock('../models/image', () => ({ generateImage: (...args: unknown[]) => drawImage(...args) }));

const upload = jest.fn().mockResolvedValue({ objectUri: 's3://bucket/leaf.jpg' });
const getDownloadUrl = jest.fn().mockResolvedValue('https://example.com/leaf.jpg');
jest.mock('../../adapters/registry', () => ({ services: { document: { upload, getDownloadUrl } } }));

import { generateImage } from '../file_generation';

it('asks for gpt-image-1 by its registry name and stores what comes back', async () => {
  drawImage.mockResolvedValue({ bytes: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' });
  const file = await generateImage({ prompt: 'a leaf', title: 'A Leaf', size: '1024x1536', quality: 'low' });
  expect(drawImage).toHaveBeenCalledWith('gpt-image-1', {
    prompt: 'a leaf',
    size: '1024x1536',
    quality: 'low',
    label: 'file_generation',
  });
  expect(file).toEqual(
    expect.objectContaining({ filename: 'a-leaf.jpg', mimeType: 'image/jpeg', sizeBytes: 'jpeg-bytes'.length }),
  );
});
