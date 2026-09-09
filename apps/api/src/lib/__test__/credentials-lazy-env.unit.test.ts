// Guards the lazy-env-read contract in lib/credentials.ts: the module must
// load without ENCRYPTION_MASTER_KEY set (so the whole adapter chain can be
// imported by metadata-only views/tests), and only read the env on first
// encrypt/decrypt. A regression here would reintroduce the import-time crash
// that the lazy `require` dance used to work around.
// NOTE: deliberately does NOT stub ENCRYPTION_MASTER_KEY before importing.
describe('credentials lazy env read', () => {
  const saved = {
    key: process.env.ENCRYPTION_MASTER_KEY,
    salt: process.env.ENCRYPTION_SALT_BASE64,
  };
  afterEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = saved.key;
    process.env.ENCRYPTION_SALT_BASE64 = saved.salt;
  });

  it('imports without the env var set (no throw at module load)', () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ENCRYPTION_SALT_BASE64;
    jest.resetModules();
    expect(() => require('../credentials')).not.toThrow();
  });

  it('round-trips encrypt/decrypt once the env is set', async () => {
    process.env.ENCRYPTION_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.ENCRYPTION_SALT_BASE64 = Buffer.alloc(16, 3).toString('base64');
    jest.resetModules();
    const { encryptToken, decryptToken } = require('../credentials');
    const blob = await encryptToken('hunter2', 'ctx');
    expect(await decryptToken(blob, 'ctx')).toBe('hunter2');
  });
});
