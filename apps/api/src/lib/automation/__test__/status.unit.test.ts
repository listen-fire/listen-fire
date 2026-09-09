/**
 * Unit coverage for `deriveAutomationStatus`. The helper drives the
 * Live / Setting up / Error / Paused pill that U3 (home dashboard) and
 * U4 (automation detail) both render — getting it wrong means the two
 * surfaces disagree about what's happening, which is worse than
 * either surface being wrong in isolation. Lock the rules with a
 * matrix instead of one-test-per-case prose.
 *
 */

import { deriveAutomationStatus, statusLabel } from '../status';

describe('deriveAutomationStatus', () => {
  const recent = new Date(); // brand-new trigger
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  it('returns paused when explicit flag set, regardless of everything else', () => {
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: true,
        lastRunStatus: 'success',
        lastRunAt: new Date(),
        triggerCreatedAt: longAgo,
        paused: true,
      }),
    ).toBe('paused');
  });

  it('returns error when the most recent run failed, even if TG body is fine', () => {
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: true,
        lastRunStatus: 'failed',
        lastRunAt: new Date(),
        triggerCreatedAt: longAgo,
      }),
    ).toBe('error');
  });

  it('returns setting_up when TG body is empty', () => {
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: false,
        lastRunStatus: null,
        lastRunAt: null,
        triggerCreatedAt: longAgo,
      }),
    ).toBe('setting_up');
  });

  it('returns live when authored but never run (untested ≠ setting up), regardless of age', () => {
    // An authored automation is wired + listening — it's live, just
    // untested. Age no longer matters.
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: true,
        lastRunStatus: null,
        lastRunAt: null,
        triggerCreatedAt: recent,
      }),
    ).toBe('live');
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: true,
        lastRunStatus: null,
        lastRunAt: null,
        triggerCreatedAt: longAgo,
      }),
    ).toBe('live');
  });

  it('returns live when last run succeeded', () => {
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: true,
        lastRunStatus: 'success',
        lastRunAt: new Date(),
        triggerCreatedAt: longAgo,
      }),
    ).toBe('live');
  });

  it('returns live when last run was partial — partial isn\'t a hard error', () => {
    expect(
      deriveAutomationStatus({
        hasNonEmptyTgBody: true,
        lastRunStatus: 'partial',
        lastRunAt: new Date(),
        triggerCreatedAt: longAgo,
      }),
    ).toBe('live');
  });
});

describe('statusLabel', () => {
  it('pins user-facing labels so U3 and U4 never drift', () => {
    expect(statusLabel('live')).toBe('Live');
    expect(statusLabel('setting_up')).toBe('Setting up');
    expect(statusLabel('paused')).toBe('Paused');
    expect(statusLabel('error')).toBe('Error');
  });
});
