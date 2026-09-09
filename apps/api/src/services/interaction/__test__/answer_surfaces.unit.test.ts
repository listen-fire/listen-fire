// answer_surfaces — the shared family→view projection the ask surfaces render,
// plus the param-resolvability classification. (Token verification moved onto
// the new ask store in the router; the MCP `answerForTeam` door is covered
// end-to-end by ask_surfaces_new_store.integration.test.ts.) These pins are the
// pure decision/projection logic, no DB.

import { isParamResolvable, readAskCorrect, toAskDetail } from '../answer_surfaces';

describe('isParamResolvable', () => {
  it.each([
    ['Check', true],
    ['Choose', true],
    ['Pick', true],
    ['Review', true],
    ['Notify', true],
    ['Provide', false],
    ['Select', false],
    ['Correct', false],
    ['Draft', false],
  ])('%s → %s', (type, expected) => {
    expect(isParamResolvable(type)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(isParamResolvable('check')).toBe(true);
    expect(isParamResolvable('CORRECT')).toBe(false);
  });
});

describe('readAskCorrect — the editable table projection', () => {
  it('derives columns (first-seen union) + rows + a display label', () => {
    const args = {
      correct: {
        type: 'company',
        rows: [
          { ephemeralId: 'row-0', fields: { name: 'Acme', stage: 'seed' } },
          { ephemeralId: 'row-1', fields: { name: 'Beta' } },
        ],
      },
    };
    expect(readAskCorrect(args)).toEqual({
      columns: ['name', 'stage'],
      rows: [
        { ephemeralId: 'row-0', fields: { name: 'Acme', stage: 'seed' }, label: 'Acme' },
        { ephemeralId: 'row-1', fields: { name: 'Beta' }, label: 'Beta' },
      ],
    });
  });

  it('yields undefined on a malformed graph', () => {
    expect(readAskCorrect({})).toBeUndefined();
    expect(readAskCorrect({ correct: { type: 'x' } })).toBeUndefined();
  });
});

describe('toAskDetail — Correct surfaces its graph + is richRenderable', () => {
  it('projects the correct graph and flags richRenderable', () => {
    const detail = toAskDetail({
      requestId: 'req-1' as never,
      teamId: 'team-1' as never,
      interactionType: 'Correct',
      resultType: { graph: 'company', position: 'company' },
      args: {
        title: 'Review the companies',
        correct: { type: 'company', rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme' } }] },
      },
      status: 'open',
      paramResolvable: false,
      richRenderable: true,
    });
    expect(detail.richRenderable).toBe(true);
    expect(detail.correct).toEqual({
      columns: ['name'],
      rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme' }, label: 'Acme' }],
    });
  });
});
