/**
 * The dimensions a trial varies along, as the command line names them, and the
 * handbook choice reaching the API on every request the builder makes.
 */
import { mcpHeaders } from '../builder';
import { parseHandbookModes, parseVariants, trialFileName } from '../variants';
import { HANDBOOK_MODE_HEADER, handbookModeFor } from '../../../../lib/knowledge/movement_handbook/handbook_mode';

describe('the handbook dimension', () => {
  it('defaults to the full handbook, which is what a deployment serves today', () => {
    expect(parseHandbookModes(undefined)).toEqual(['full']);
  });

  it('runs every mode it is given, in order', () => {
    expect(parseHandbookModes('full, lean')).toEqual(['full', 'lean']);
    expect(parseHandbookModes('lean')).toEqual(['lean']);
  });

  it('refuses a mode the API does not have', () => {
    expect(() => parseHandbookModes('full,short')).toThrow(/unknown handbook "short"/);
  });

  it('asks the API for the mode on every request, the way the API reads it', () => {
    const headers = mcpHeaders({ apiKey: 'k', handbook: 'lean' });
    expect(headers.Authorization).toBe('Bearer k');
    // Node lower-cases incoming header names; the route reads them that way.
    expect(handbookModeFor(headers[HANDBOOK_MODE_HEADER], { NODE_ENV: 'development' })).toBe('lean');
  });

  it('names each trial file by every dimension, so two modes never overwrite each other', () => {
    const full = trialFileName({ taskId: 'inbound-intake', variant: 'noskill', handbook: 'full', rep: 0 });
    const lean = trialFileName({ taskId: 'inbound-intake', variant: 'noskill', handbook: 'lean', rep: 0 });
    expect(full).toBe('inbound-intake.noskill.full.1.json');
    expect(lean).not.toBe(full);
  });
});

describe('the skill dimension', () => {
  it('keeps its flags', () => {
    expect(parseVariants({ variants: undefined, skill: false })).toEqual(['noskill']);
    expect(parseVariants({ variants: 'noskill,skill', skill: false })).toEqual(['noskill', 'skill']);
    expect(parseVariants({ variants: 'noskill', skill: true })).toEqual(['skill']);
    expect(() => parseVariants({ variants: 'other', skill: false })).toThrow(/unknown variant/);
  });
});
