import { flattenMessages } from '../execute';

describe('flattenMessages', () => {
  it('splits system-role messages into system and the rest into userMessage', () => {
    const { system, userMessage } = flattenMessages([
      { role: 'system', content: 'You are a classifier.' },
      { role: 'user', content: 'Classify this.' },
    ]);
    expect(system).toBe('You are a classifier.');
    expect(userMessage).toBe('Classify this.');
  });

  it('joins system messages with a blank line and tags each of several turns', () => {
    const { system, userMessage } = flattenMessages([
      { role: 'system', content: 'Rule one.' },
      { role: 'system', content: 'Rule two.' },
      { role: 'user', content: 'Part A.' },
      { role: 'user', content: 'Part B.' },
    ]);
    expect(system).toBe('Rule one.\n\nRule two.');
    expect(userMessage).toBe(
      '<user_message>\nPart A.\n</user_message>\n\n<user_message>\nPart B.\n</user_message>',
    );
  });

  it('folds any non-system role into the user turn (no assistant turn for Claude)', () => {
    const { system, userMessage } = flattenMessages([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'prior' },
      { role: 'user', content: 'now' },
    ]);
    expect(system).toBe('sys');
    expect(userMessage).toBe(
      '<assistant_message>\nprior\n</assistant_message>\n\n<user_message>\nnow\n</user_message>',
    );
  });

  it('returns empty system when there are no system messages', () => {
    const { system, userMessage } = flattenMessages([{ role: 'user', content: 'hi' }]);
    expect(system).toBe('');
    expect(userMessage).toBe('hi');
  });
});
