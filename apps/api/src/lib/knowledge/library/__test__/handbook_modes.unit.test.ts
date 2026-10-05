// What `readHandbook` serves an authoring agent in each handbook mode, and how
// a request's mode is chosen.

import { readBook } from '../index';
import {
  HANDBOOK_MODE_VAR,
  handbookModeFor,
  handbookModeFromEnv,
} from '../../movement_handbook/handbook_mode';
import { renderFrontPage } from '../../movement_handbook/front_page';

type Read = {
  chapter?: string;
  content?: string;
  note?: string;
  whenToReadWhat?: string;
  chapters?: Array<{ id: string; content?: string; note?: string; error?: string }>;
};

const read = (args: Parameters<typeof readBook>[0]) => readBook(args) as Read;

describe('the full handbook (today)', () => {
  it('is the default, and serves the index and whole chapters as before', () => {
    expect(read({ bookId: 'automations' }).whenToReadWhat).toMatch(/When you need to/);
    expect(read({ bookId: 'automations', chapter: 'writes' }).content).toContain('unique by');
    expect(read({ bookId: 'automations', chapter: 'writes', mode: 'full' }).content).toContain('unique by');
  });

  it('serves the front page too, so a diagnostic pointing at it resolves', () => {
    expect(read({ bookId: 'automations', chapter: 'front' }).content).toBe(renderFrontPage());
    expect(read({ bookId: 'automations', chapter: 'front#maybe-absent' }).content).toMatch(/absent/);
  });
});

describe('the lean handbook', () => {
  it('serves the front page where the book index was', () => {
    const r = read({ bookId: 'automations', mode: 'lean' });
    expect(r.chapter).toBe('front');
    expect(r.content).toBe(renderFrontPage());
    expect(r.whenToReadWhat).toBeUndefined();
  });

  it('answers a whole hand-written chapter with a pointer to the search', () => {
    const r = read({ bookId: 'automations', chapter: 'writes', mode: 'lean' });
    expect(r.content).toBeUndefined();
    expect(r.note).toMatch(/searchLanguage/);
  });

  it('still serves a section, a system chapter, and the front page sections', () => {
    expect(read({ bookId: 'automations', chapter: 'writes#identity', mode: 'lean' }).content).toContain('unique by');
    expect(read({ bookId: 'automations', chapter: 'system:slack', mode: 'lean' }).content?.length).toBeGreaterThan(100);
    expect(read({ bookId: 'automations', chapter: 'front#identity', mode: 'lean' }).content).toContain('unique by');
  });

  it('mixes pointers and bodies in one read of several', () => {
    const r = read({ bookId: 'automations', chapters: ['patterns', 'writes#identity'], mode: 'lean' });
    expect(r.chapters?.[0]?.note).toMatch(/searchLanguage/);
    expect(r.chapters?.[1]?.content).toContain('unique by');
  });

  it('lists the automations book as its front page on the shelf, and leaves other books alone', () => {
    const shelf = (readBook({ mode: 'lean' }) as { shelf: Array<{ bookId: string; chapters: Array<{ id: string }> }> }).shelf;
    expect(shelf.find((b) => b.bookId === 'automations')?.chapters.map((c) => c.id)).toEqual(['front']);
    expect(shelf.find((b) => b.bookId === 'knowledge-model')?.chapters.length).toBeGreaterThan(1);
  });

  it('an unknown chapter is still an error, not a pointer', () => {
    const r = readBook({ bookId: 'automations', chapter: 'nope', mode: 'lean' }) as { chapters?: Array<{ error?: string }> };
    expect(r.chapters?.[0]?.error).toMatch(/No chapter/);
  });
});

describe('choosing the mode', () => {
  it('reads the deployment flag, full when unset, loudly on a bad value', () => {
    expect(handbookModeFromEnv({})).toBe('full');
    expect(handbookModeFromEnv({ [HANDBOOK_MODE_VAR]: 'lean' })).toBe('lean');
    expect(() => handbookModeFromEnv({ [HANDBOOK_MODE_VAR]: 'tiny' })).toThrow(/not a handbook mode/);
  });

  it('lets a request choose outside production, and never in it', () => {
    expect(handbookModeFor('lean', { NODE_ENV: 'development' })).toBe('lean');
    expect(handbookModeFor('lean', { NODE_ENV: 'production' })).toBe('full');
    expect(handbookModeFor(undefined, { NODE_ENV: 'development', [HANDBOOK_MODE_VAR]: 'lean' })).toBe('lean');
    expect(() => handbookModeFor('tiny', { NODE_ENV: 'development' })).toThrow(/not a handbook mode/);
  });
});
