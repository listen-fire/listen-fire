import {
  USER_MILESTONE_COLUMNS,
  TEAM_MILESTONE_COLUMNS,
  userMilestoneTitle,
  teamMilestoneTitle,
} from '../types';

describe('journey milestone metadata', () => {
  it('maps every user milestone to a distinct column', () => {
    const cols = Object.values(USER_MILESTONE_COLUMNS);
    expect(new Set(cols).size).toBe(cols.length);
    expect(USER_MILESTONE_COLUMNS.first_mcp_call).toBe('first_mcp_call_at');
  });

  it('maps every team milestone to a distinct column', () => {
    const cols = Object.values(TEAM_MILESTONE_COLUMNS);
    expect(new Set(cols).size).toBe(cols.length);
    expect(TEAM_MILESTONE_COLUMNS.first_run).toBe('first_run_at');
  });

  it('names the tool in the first-call title when known', () => {
    expect(userMilestoneTitle('first_mcp_call', 'listAutomations')).toBe(
      'First automation call — listAutomations',
    );
    expect(userMilestoneTitle('first_mcp_call')).toBe('First automation call');
  });

  it('keeps the team first-save silent so one action emits one event', () => {
    expect(teamMilestoneTitle('first_automation_saved')).toBeNull();
    expect(teamMilestoneTitle('first_run')).toBe('First automation run');
  });
});
