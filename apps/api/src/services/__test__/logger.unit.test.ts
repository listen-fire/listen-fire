/**
 * `winston.format.simple()` stringifies metadata with plain JSON.stringify,
 * which drops Error.message/Error.stack (non-enumerable) → `{}`. The logger's
 * `simple()` replacement must apply the same Error-aware replacer used for
 * `info.message` to the rest-metadata too, in any NODE_ENV.
 */

import { logger } from '../logger';

describe('logger metadata Error serialization', () => {
  it('keeps message/stack for a top-level Error in metadata', () => {
    const chunks: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      chunks.push(chunk.toString());
      return true;
    });

    try {
      logger.warn('Plugin failed to fetch URL', { url: 'https://example.com', error: new Error('boom') });
    } finally {
      write.mockRestore();
    }

    const output = chunks.join('');
    expect(output).toContain('"message":"boom"');
    expect(output).toContain('"stack":"Error: boom');
    expect(output).not.toContain('"error":{}');
  });

  it('keeps message/stack for a nested Error in metadata', () => {
    const chunks: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      chunks.push(chunk.toString());
      return true;
    });

    try {
      logger.warn('Nested error case', { ctx: { error: new Error('nested') } });
    } finally {
      write.mockRestore();
    }

    const output = chunks.join('');
    expect(output).toContain('"message":"nested"');
    expect(output).toContain('"stack":"Error: nested');
  });

  it('omits trailing metadata json when there is none', () => {
    const chunks: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      chunks.push(chunk.toString());
      return true;
    });

    try {
      logger.warn('Plain message no metadata');
    } finally {
      write.mockRestore();
    }

    const output = chunks.join('');
    expect(output).toContain('Plain message no metadata');
    expect(output).not.toContain('{}');
  });
});
