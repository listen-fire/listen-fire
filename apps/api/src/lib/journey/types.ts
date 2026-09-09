export const USER_MILESTONE_COLUMNS = {
  mcp_connected: 'mcp_connected_at',
  first_mcp_call: 'first_mcp_call_at',
  first_automation_saved: 'first_automation_saved_at',
} as const;

export type UserMilestone = keyof typeof USER_MILESTONE_COLUMNS;

export const TEAM_MILESTONE_COLUMNS = {
  first_automation_saved: 'first_automation_saved_at',
  first_run: 'first_run_at',
} as const;

export type TeamMilestone = keyof typeof TEAM_MILESTONE_COLUMNS;

export function userMilestoneTitle(milestone: UserMilestone, tool?: string): string {
  switch (milestone) {
    case 'mcp_connected':
      return 'Connected the Automation connector';
    case 'first_mcp_call':
      return tool ? `First automation call — ${tool}` : 'First automation call';
    case 'first_automation_saved':
      return 'Saved their first automation';
  }
}

/** null = record the milestone but emit no feed event (the user-level event
 *  already tells that story; two rows for one action is noise). */
export function teamMilestoneTitle(milestone: TeamMilestone): string | null {
  switch (milestone) {
    case 'first_automation_saved':
      return null;
    case 'first_run':
      return 'First automation run';
  }
}
