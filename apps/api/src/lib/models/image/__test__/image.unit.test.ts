// Image generation behind the map: who draws it, what each vendor is sent, and
// what comes back as bytes.

const imagesGenerate = jest.fn();
jest.mock('../../providers/openai', () => ({
  openAiClient: () => ({ images: { generate: imagesGenerate } }),
}));

const generateContent = jest.fn();
const geminiClient = jest.fn(() => ({ models: { generateContent } }));
jest.mock('../../providers/gemini', () => ({
  geminiClient: (...args: unknown[]) => geminiClient(...(args as [])),
}));

jest.mock('../../../../services/logger', () => ({ logger: { info: jest.fn() } }));

import { generateImage } from '..';

const PNG_B64 = Buffer.from('png-bytes').toString('base64');

const GEMINI_ENV = {
  MODEL_MAP: JSON.stringify({ 'dall-e-3': 'gemini/gemini-3.1-flash-image-preview' }),
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
  GOOGLE_PROJECT_LOCATION: 'europe-west4',
};

beforeEach(() => {
  imagesGenerate.mockReset().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
  generateContent.mockReset().mockResolvedValue({
    candidates: [
      { content: { parts: [{ text: 'Here it is.' }, { inlineData: { mimeType: 'image/jpeg', data: PNG_B64 } }] } },
    ],
  });
  geminiClient.mockClear();
});

describe('OpenAI, where the map leaves dall-e-3 at home', () => {
  it('asks DALL·E 3 for base64 with its defaults, whatever Google credentials exist', async () => {
    const image = await generateImage('dall-e-3', { prompt: 'a leaf' }, { ...GEMINI_ENV, MODEL_MAP: '' });
    expect(imagesGenerate).toHaveBeenCalledWith({
      model: 'dall-e-3',
      prompt: 'a leaf',
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      style: 'vivid',
      response_format: 'b64_json',
    });
    expect(image).toEqual({ bytes: Buffer.from('png-bytes'), mimeType: 'image/png' });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('refuses an option DALL·E 3 does not take, naming the field', async () => {
    await expect(generateImage('dall-e-3', { prompt: 'a leaf', size: '640x480' }, {})).rejects.toThrow(/size/);
    expect(imagesGenerate).not.toHaveBeenCalled();
  });
});

describe('Gemini, where the map sends dall-e-3', () => {
  it('asks the mapped image model for an image, in the project region, at the size’s aspect ratio', async () => {
    const image = await generateImage('dall-e-3', { prompt: 'a leaf', size: '1792x1024' }, GEMINI_ENV);
    expect(geminiClient).toHaveBeenCalledWith(GEMINI_ENV, { location: 'europe-west4' });
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-image-preview',
      contents: [{ role: 'user', parts: [{ text: 'a leaf' }] }],
      config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } },
    });
    expect(image).toEqual({ bytes: Buffer.from('png-bytes'), mimeType: 'image/jpeg' });
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('says so when the reply carries no picture', async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'I cannot.' }] } }] });
    await expect(generateImage('dall-e-3', { prompt: 'a leaf' }, GEMINI_ENV)).rejects.toThrow(
      /gemini-3.1-flash-image-preview returned no image data/,
    );
  });
});
