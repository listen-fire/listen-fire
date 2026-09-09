/**
 * SlackV3 preview — empty-block guards (the `invalid_attachments` fix).
 *
 * Slack's chat.postMessage rejects any Block Kit block whose `text.text` is an
 * empty string. A content-less resource (e.g. an email with a blank subject)
 * used to produce such a block and 400 the whole post. These cover the two
 * guards: the subject fallback (so a blank subject still yields a non-empty
 * header) and `pruneEmptyBlocks` (so any remaining empty block is dropped).
 */

import { pruneEmptyBlocks, buildEmailHeaderBlocks } from '../../output_v3/adapters/slack';

const headerText = (built: { blocks: Record<string, unknown>[] }): unknown => {
  const header = built.blocks.find((b) => b.type === 'header') as
    | { text: { text: unknown } }
    | undefined;
  return header?.text.text;
};

describe('SlackV3 preview empty-block guards', () => {
  describe('pruneEmptyBlocks', () => {
    it('drops blocks whose text is empty or whitespace, keeps the rest', () => {
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'Title' } },
        { type: 'section', text: { type: 'mrkdwn', text: '' } },
        { type: 'section', text: { type: 'mrkdwn', text: '   ' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Body' } },
      ];
      expect(pruneEmptyBlocks(blocks)).toEqual([
        { type: 'header', text: { type: 'plain_text', text: 'Title' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Body' } },
      ]);
    });

    it('preserves structural blocks that carry no text (divider)', () => {
      expect(pruneEmptyBlocks([{ type: 'divider' }])).toEqual([{ type: 'divider' }]);
    });
  });

  describe('buildEmailHeaderBlocks subject fallback', () => {
    it('falls back to "No subject" for a blank subject (the reported bug: payload.subject === "")', () => {
      expect(headerText(buildEmailHeaderBlocks({ subject: '' }, {}))).toBe('No subject');
      expect(headerText(buildEmailHeaderBlocks({ subject: '   ' }, {}))).toBe('No subject');
    });

    it('falls back when the subject is absent', () => {
      expect(headerText(buildEmailHeaderBlocks({}, {}))).toBe('No subject');
    });

    it('preserves a real subject', () => {
      expect(headerText(buildEmailHeaderBlocks({ subject: 'Q3 numbers' }, {}))).toBe('Q3 numbers');
    });

    it('a content-less email (blank subject, no From/To/Cc) prunes to just the non-empty title', () => {
      const { blocks } = buildEmailHeaderBlocks({ subject: '' }, {});
      expect(pruneEmptyBlocks(blocks)).toEqual([
        { type: 'header', text: { type: 'plain_text', text: 'No subject', emoji: true } },
      ]);
    });
  });
});
