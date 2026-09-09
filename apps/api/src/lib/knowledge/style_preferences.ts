import { getKnowledgeQb } from '../kysely';

/**
 * Returns the style preferences system prompt block for a team, or empty string if none set.
 */
async function getStyleBlock(teamId: string): Promise<string> {
  const row = await getKnowledgeQb(['team_agent_settings'])
    .selectFrom('team_agent_settings')
    .select('style_preferences')
    .where('team_id', '=', teamId)
    .executeTakeFirst();
  const preferences = row?.style_preferences;
  if (!preferences?.trim()) return '';
  return `\n\n## Style preferences (set by your team)\n\n${preferences}\n\nFollow these preferences for tone, formatting, communication style, and conversational behavior.`;
}

export { getStyleBlock };
