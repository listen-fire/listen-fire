// Where the browser sends API calls when the image was built without a baked
// origin: same-origin, through the Next rewrites.

describe('apiOrigin', () => {
  const REAL = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (REAL === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = REAL;
    jest.resetModules();
  });

  it('uses the baked origin when there is one', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
    jest.resetModules();
    expect(require('../api-origin').apiOrigin()).toBe('https://api.example.com');
  });

  it('treats an EMPTY baked origin as absent — not as an origin', () => {
    process.env.NEXT_PUBLIC_API_URL = '';
    jest.resetModules();
    expect(require('../api-origin').apiOrigin()).toBe('');
  });

  it('is empty when unset outside a browser, so callers resolve relatively', () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    jest.resetModules();
    expect(require('../api-origin').apiOrigin()).toBe('');
  });
});
