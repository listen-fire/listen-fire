/**
 * The dimension a trial varies along, as the command line names it, and how
 * each trial's file is named.
 */
import { parseVariants, trialFileName } from '../variants';

describe('the skill dimension', () => {
  it('keeps its flags', () => {
    expect(parseVariants({ variants: undefined, skill: false })).toEqual(['noskill']);
    expect(parseVariants({ variants: 'noskill,skill', skill: false })).toEqual(['noskill', 'skill']);
    expect(parseVariants({ variants: 'noskill', skill: true })).toEqual(['skill']);
    expect(() => parseVariants({ variants: 'other', skill: false })).toThrow(/unknown variant/);
  });

  it('names each trial file by task, variant and repetition', () => {
    expect(trialFileName({ taskId: 'inbound-intake', variant: 'noskill', rep: 0 })).toBe('inbound-intake.noskill.1.json');
  });
});
