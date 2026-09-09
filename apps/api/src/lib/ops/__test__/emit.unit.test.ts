import { opsTypeFromSlack, deriveTitle } from '../types';
import OpsEventType from '../../../generated/kysely/public/OpsEventType';

describe('slack→ops mapping', () => {
  it('maps slack type strings 1:1 to ops event types', () => {
    expect(opsTypeFromSlack('SUPPORT')).toBe(OpsEventType.SUPPORT);
    expect(opsTypeFromSlack('DEALFLOW')).toBe(OpsEventType.DEALFLOW);
  });
  it('derives a single-line title and truncates', () => {
    expect(deriveTitle('first line\nsecond line')).toBe('first line');
    expect(deriveTitle(undefined)).toBe('(no title)');
    expect(deriveTitle('x'.repeat(200)).endsWith('…')).toBe(true);
  });
  it('strips slack formatting but keeps identifiers and emoji shortcodes', () => {
    expect(deriveTitle('*Run failed* — CRM write rejected')).toBe(
      'Run failed — CRM write rejected',
    );
    expect(deriveTitle('New message from _Tiny_')).toBe('New message from Tiny');
    expect(deriveTitle('<https://x.com/logs|View logs> for the run')).toBe(
      'View logs for the run',
    );
    // Underscores inside an identifier must survive.
    expect(deriveTitle('log_whatsapp_dealflow ran')).toBe('log_whatsapp_dealflow ran');
    // Emoji shortcodes are left intact for the client to expand.
    expect(deriveTitle(':tada: signed up')).toBe(':tada: signed up');
  });
  it('never truncates inside an emoji shortcode', () => {
    // 110 chars of filler, then a shortcode straddling the 117 cut point.
    const title = 'x'.repeat(110) + ' :envelope_with_arrow: tail';
    const out = deriveTitle(title);
    expect(out.endsWith('…')).toBe(true);
    // No dangling opening colon with an unclosed shortcode.
    expect(/:[a-z0-9_+-]*$/.test(out.slice(0, -1))).toBe(false);
  });
});
