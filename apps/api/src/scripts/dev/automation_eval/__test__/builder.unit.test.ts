/**
 * What a trial keeps of each builder response: its reasoning and its prose, in
 * the order they came, so a reviewer can read why it acted.
 */
import type Anthropic from '@anthropic-ai/sdk';

import { proseSteps } from '../builder';

const thinking = (text: string): Anthropic.ContentBlock => ({ type: 'thinking', thinking: text, signature: 'sig' });
const text = (t: string): Anthropic.ContentBlock => ({ type: 'text', text: t, citations: null });

describe('proseSteps', () => {
  it('keeps thinking and text in the order the response gave them, tagged with the model call', () => {
    const steps = proseSteps([thinking('Repeats are open; ask first.'), text('Two quick questions…')], 3);
    expect(steps).toEqual([
      { kind: 'thinking', modelCall: 3, text: 'Repeats are open; ask first.' },
      { kind: 'text', modelCall: 3, text: 'Two quick questions…' },
    ]);
  });

  it('drops empty thinking, which is what an omitted display returns', () => {
    expect(proseSteps([thinking(''), text('Done.')], 1)).toEqual([{ kind: 'text', modelCall: 1, text: 'Done.' }]);
  });
});
