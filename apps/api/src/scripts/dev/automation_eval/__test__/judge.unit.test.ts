/**
 * The judge's verdict is only averaged in when it has exactly the rubric's
 * shape: six integer scores 1–5. Anything else is an error, never a quiet zero.
 */
import { CRITERIA, parseJudgeVerdict, renderRubric, RUBRIC } from '../judge';

const valid = {
  scores: { modernForms: 4, noDeadCode: 5, sensibleNames: 3, businessTerms: 2, rightQuestions: 4, concise: 3 },
  askedClarifyingQuestion: true,
  notes: 'Good structure; said "listener" twice.',
};

describe('parsing the judge verdict', () => {
  it('derives the source, conversation and overall means', () => {
    const v = parseJudgeVerdict(valid);
    expect(v.sourceMean).toBeCloseTo(4);
    expect(v.conversationMean).toBeCloseTo(3);
    expect(v.overall).toBeCloseTo(3.5);
    expect(v.askedClarifyingQuestion).toBe(true);
  });

  it('accepts the verdict as JSON text', () => {
    expect(parseJudgeVerdict(JSON.stringify(valid)).overall).toBeCloseTo(3.5);
  });

  it('rejects a score outside 1–5', () => {
    expect(() => parseJudgeVerdict({ ...valid, scores: { ...valid.scores, concise: 6 } })).toThrow();
    expect(() => parseJudgeVerdict({ ...valid, scores: { ...valid.scores, concise: 0 } })).toThrow();
  });

  it('rejects a fractional score and a missing criterion', () => {
    expect(() => parseJudgeVerdict({ ...valid, scores: { ...valid.scores, concise: 3.5 } })).toThrow();
    const { concise: _dropped, ...fewer } = valid.scores;
    expect(() => parseJudgeVerdict({ ...valid, scores: fewer })).toThrow();
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseJudgeVerdict('four out of five')).toThrow();
  });
});

describe('the rubric', () => {
  it('names every criterion the verdict scores, and renders each one for the judge', () => {
    expect(CRITERIA).toEqual(Object.keys(valid.scores));
    const text = renderRubric();
    for (const c of CRITERIA) expect(text).toContain(`- ${c}:`);
    expect(Object.keys(RUBRIC)).toEqual(['source', 'conversation']);
  });
});
