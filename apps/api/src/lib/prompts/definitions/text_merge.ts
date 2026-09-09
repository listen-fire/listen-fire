import { promptDef } from '../definition';

const textMergeDef = promptDef({
  description: 'Merge two texts into one.',
  arguments: ['text1', 'text2'],
  messages: [
    {
      role: 'system',
      content: `
You have previously generated some text.
I'll send you back the text you generated in consecutive messages.
Please combine them into a single text.
`,
    },
    { role: 'user', content: '{{{text1}}}' },
    { role: 'user', content: '{{{text2}}}' },
  ],
} as const);

export { textMergeDef };
