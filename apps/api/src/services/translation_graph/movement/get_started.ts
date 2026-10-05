// What an authoring agent reads before it writes anything, in one call: the
// handbook's first page, the team it is acting in, and that team's systems in
// digest form (connection_digest.ts). The point is a build that needs no other
// reading — everything here would otherwise cost a readHandbook, a listTeams,
// a listConnections and a describeConnection per system.

import type { TeamRef } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import { readBook } from '../../../lib/knowledge/library';
import type { HandbookMode } from '../../../lib/knowledge/movement_handbook/handbook_mode';
import { neverAsAny } from '../../../lib/utils/types';
import { describeMovementInstance, movementCatalogSnapshotForTeam } from './catalog';
import { renderConnectionsDigest, type SystemDigestInput } from './connection_digest';

/** A system slower than this to describe keeps its construction line only, so
 *  one slow connection cannot hold the whole first call up. */
const DESCRIBE_TIMEOUT_MS = 8_000;

/** The page the handbook mode starts an agent on: the front page (lean), or the
 *  foundations chapter (full). */
export function firstHandbookPage(mode: HandbookMode): string {
  switch (mode) {
    case 'lean': {
      const read = readBook({ bookId: 'automations', mode });
      return 'content' in read && typeof read.content === 'string' ? read.content : '';
    }
    case 'full': {
      const read = readBook({ bookId: 'automations', chapter: 'foundations', mode });
      return 'content' in read && typeof read.content === 'string' ? read.content : '';
    }
    default:
      return neverAsAny(mode);
  }
}

async function describeWithin(input: { teamId: TeamId; system: string; connection?: string }) {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DESCRIBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      describeMovementInstance({
        teamId: input.teamId,
        adapter: input.system,
        ...(input.connection !== undefined ? { credentialName: input.connection } : {}),
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The team's systems: those it connected first, then those that need no
 * connection, each described at its root. A system that needs a connection the
 * team lacks is only named, so the agent knows to connect it.
 */
export async function connectedSystemsDigest(teamId: TeamId): Promise<string> {
  const { snapshot, remoteConnections } = await movementCatalogSnapshotForTeam(teamId);
  const connected: Array<Pick<SystemDigestInput, 'system' | 'spec' | 'connections'>> = [];
  const builtIn: typeof connected = [];
  const notConnected: string[] = [];

  for (const [system, spec] of Object.entries(snapshot.adapters)) {
    const connections = Object.entries(snapshot.credentials)
      .filter(([, credential]) =>
        'adapters' in credential ? credential.adapters.includes(system) : credential.adapter === system,
      )
      .map(([name]) => name);
    const needsCredential = spec.constructionArgs.some((a) => a.kind === 'credential' && a.required);
    const remote = remoteConnections?.[system];
    if ((needsCredential && connections.length === 0) || remote === 'needs-secret') {
      notConnected.push(spec.connect === 'app-only' ? `${system} (connects in the app)` : system);
    } else if (needsCredential || remote === 'connected') {
      connected.push({ system, spec, connections });
    } else {
      builtIn.push({ system, spec, connections });
    }
  }

  const systems = await Promise.all(
    [...connected, ...builtIn].map(async (entry): Promise<SystemDigestInput> => {
      try {
        const described = await describeWithin({
          teamId,
          system: entry.system,
          ...(entry.connections[0] !== undefined ? { connection: entry.connections[0] } : {}),
        });
        if (described === null) return { ...entry, note: 'its records took too long to load' };
        return {
          ...entry,
          ...(described.node ? { node: described.node } : {}),
          schema: described.schema,
          ...(described.node ? {} : { note: described.notes[0] ?? 'its records could not be read' }),
        };
      } catch (err) {
        return { ...entry, note: `its records could not be read (${err instanceof Error ? err.message : String(err)})` };
      }
    }),
  );

  return renderConnectionsDigest({ systems, notConnected });
}

function teamSection(input: { teams: TeamRef[]; teamId: string | null }): string {
  const label = (t: TeamRef) => `${t.name} — \`${t.teamId}\`${t.isPersonal ? ' (personal)' : ''}`;
  if (input.teamId !== null) {
    const team = input.teams.find((t) => t.teamId === input.teamId);
    const others = input.teams.filter((t) => t.teamId !== input.teamId);
    return [
      `## Team: ${team ? label(team) : `\`${input.teamId}\``}`,
      ...(others.length > 0
        ? [`Other teams (pass one's id as \`team\` to act there): ${others.map(label).join('; ')}`]
        : []),
    ].join('\n\n');
  }
  return [
    '## Teams',
    "This connection spans several teams. Pass one's id as `team` to the tools that create or change things — and to getStarted to see that team's systems.",
    input.teams.map((t) => `- ${label(t)}`).join('\n'),
  ].join('\n\n');
}

/**
 * The whole first read, as markdown. `teamId` is null when the connection spans
 * several teams and none was named: the systems then wait for one.
 */
export async function renderGetStarted(input: {
  teams: TeamRef[];
  teamId: TeamId | null;
  mode: HandbookMode;
}): Promise<string> {
  const systems = input.teamId === null ? null : await connectedSystemsDigest(input.teamId);
  return [
    teamSection(input),
    ...(systems !== null ? ['## Systems', systems] : []),
    firstHandbookPage(input.mode),
  ].join('\n\n');
}
