import { SLACK_APP_ID, isLegacyApp, defaultAppIdForType } from '../app_id';

describe('credential app_id', () => {
  it('isLegacyApp: null / the legacy value are legacy, the modern one is not', () => {
    expect(isLegacyApp(null)).toBe(true);
    expect(isLegacyApp(undefined)).toBe(true);
    expect(isLegacyApp(SLACK_APP_ID.legacy)).toBe(true);
    expect(isLegacyApp(SLACK_APP_ID.movements)).toBe(false);
    expect(isLegacyApp('listen-fire')).toBe(false);
  });

  it('defaultAppIdForType: Slack defaults to the modern app; others undefined', () => {
    expect(defaultAppIdForType('SLACK')).toBe('listen-fire');
    expect(defaultAppIdForType('ATTIO')).toBeUndefined();
    expect(defaultAppIdForType('GOOGLE')).toBeUndefined();
  });
});
