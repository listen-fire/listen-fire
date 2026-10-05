// The connected systems in a few hundred tokens: what an authoring agent needs
// to write its first program without a describe call per system — how to
// construct each one, its record types with their fields, and what a listen on
// it may say. describeConnection stays the way to go deeper; the digest says
// so wherever it cut something.
//
// Pure: get_started.ts gathers the catalog and the root describes, this module
// turns them into text under a fixed budget.

import type { AdapterSpec, FieldType, InstanceSchema } from 'movement-lang';

import { neverAsAny } from '../../../lib/utils/types';
import type { WalkedEdge, WalkedNode, WalkedProperty } from './walk';

/** One system's block, in characters (about a quarter as many tokens). */
export const SYSTEM_DIGEST_CHAR_CAP = 1_000;
/** Every block together. Past it, the remaining systems get a header line. */
export const CONNECTIONS_DIGEST_CHAR_CAP = 6_000;

const FIELDS_PER_TYPE = 10;
const ENUM_OPTIONS_SHOWN = 4;

export interface SystemDigestInput {
  /** The adapter name, as imported from `adapters`. */
  system: string;
  spec: Pick<AdapterSpec, 'constructionArgs' | 'triggerConfig' | 'triggerConfigOptions' | 'triggerConfigRequired'>;
  /** The credential import names that serve this system; empty when it needs none. */
  connections: string[];
  /** The root of a describe: absent when the system could not be described. */
  node?: WalkedNode;
  /** The same describe's schema — read only for each record's identity fields. */
  schema?: InstanceSchema | null;
  /** Why there is no node, when there is none. */
  note?: string;
}

export const DIGEST_LEGEND =
  'Marks: `!` required to create · `*` identifies the record (a `unique by` candidate) · `~` read-only · [r] readable, [w] writable, [fires] a listen can fire on it.';

const moreHint = (system: string) => `describeConnection("${system}") for more`;

/** A type in as few characters as stay unambiguous. */
export function compactType(type: FieldType): string {
  if (typeof type === 'string') return type === 'absent' ? 'null' : type;
  switch (type.kind) {
    case 'list':
      return `${compactType(type.of)}[]`;
    case 'maybeAbsent':
      return `${compactType(type.of)}?`;
    case 'enum': {
      const shown = type.options.slice(0, ENUM_OPTIONS_SHOWN).join('|');
      const more = type.options.length > ENUM_OPTIONS_SHOWN || type.open !== undefined;
      return `enum(${shown}${more ? '|…' : ''})`;
    }
    case 'union':
      return type.of.map(compactType).join('|');
    case 'tuple':
      return 'tuple';
    case 'dict':
      return 'dict';
    case 'record':
      return 'record';
    default:
      return neverAsAny(type);
  }
}

/** `attio(credentials: acme)`; a second connection is named after it. */
function constructionSpelling(input: SystemDigestInput): string {
  const args = input.spec.constructionArgs.flatMap((arg) => {
    if (arg.kind === 'credential') return [`${arg.name}: ${input.connections[0] ?? '…'}`];
    return arg.required ? [`${arg.name}: …`] : [];
  });
  const others = input.connections.slice(1);
  return `\`${input.system}(${args.join(', ')})\`${others.length > 0 ? ` (other connections: ${others.join(', ')})` : ''}`;
}

/** `listen { key! }`, `listen { events: record.created|record.updated, channels }`. */
function listenSpelling(spec: SystemDigestInput['spec']): string | null {
  const keys = spec.triggerConfig ?? [];
  if (keys.length === 0) return null;
  const required = new Set(spec.triggerConfigRequired ?? []);
  const parts = keys.map((key) => {
    const options = spec.triggerConfigOptions?.[key];
    const mark = required.has(key) ? '!' : '';
    return options && options.length > 0 ? `${key}${mark}: ${options.join('|')}` : `${key}${mark}`;
  });
  return `listen { ${parts.join(', ')} }`;
}

function identityFields(input: SystemDigestInput, edge: WalkedEdge): Set<string> {
  const schema = input.schema;
  const targetName = edge.target?.name;
  const rules =
    schema?.writableRoots[edge.name]?.nativeUniqueness ??
    (targetName !== undefined ? schema?.createShapes?.[targetName]?.nativeUniqueness : undefined) ??
    [];
  return new Set(rules.flat());
}

function access(edge: WalkedEdge): string {
  const flags = [
    `${edge.readable ? 'r' : ''}${edge.writable ? 'w' : ''}`,
    ...(edge.fires ? ['fires'] : []),
    ...(edge.awaitable ? ['await'] : []),
  ].filter(Boolean);
  return flags.length > 0 ? ` [${flags.join(' ')}]` : '';
}

function fieldSpelling(name: string, property: WalkedProperty, identity: Set<string>, writableType: boolean): string {
  const marks = `${property.required ? '!' : ''}${identity.has(name) ? '*' : ''}${writableType && !property.writable ? '~' : ''}`;
  return `${name} ${compactType(property.type)}${marks}`;
}

/** Required and identifying fields first: they are the ones a first write needs. */
function fieldsLine(input: SystemDigestInput, edge: WalkedEdge): string {
  const target = edge.target;
  if (target === undefined) {
    if (edge.landsOn) return ` → ${edge.landsOn.join('|')}`;
    if (edge.members) {
      const shown = edge.members.slice(0, ENUM_OPTIONS_SHOWN).map((m) => m.name);
      return `: one of ${shown.join(', ')}${edge.members.length > shown.length ? ', …' : ''} (narrow with WHERE)`;
    }
    return '';
  }
  if (target.stub === true) return ': fields not loaded — describe it';
  const identity = identityFields(input, edge);
  const entries = Object.entries(target.properties);
  const rank = ([name, p]: [string, WalkedProperty]) => (p.required ? 0 : identity.has(name) ? 1 : 2);
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  const shown = ordered
    .slice(0, FIELDS_PER_TYPE)
    .map(([name, property]) => fieldSpelling(name, property, identity, edge.writable));
  const hidden = ordered.length - shown.length;
  return shown.length === 0 ? ': no fields' : `: ${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

/** One system's block, never longer than {@link SYSTEM_DIGEST_CHAR_CAP}. */
export function renderSystemDigest(input: SystemDigestInput): string {
  const header = `### ${input.system} — ${constructionSpelling(input)}`;
  const lines = [header];
  const listen = listenSpelling(input.spec);
  if (listen) lines.push(`- ${listen}`);
  if (!input.node) {
    lines.push(`- ${input.note ?? 'not described'} — ${moreHint(input.system)}`);
    return fitLines(lines, input.system);
  }
  const edges = input.node.edges.filter((edge) => !edge.ephemeral || edge.writable);
  for (const edge of edges) lines.push(`- ${edge.name}${access(edge)}${fieldsLine(input, edge)}`);
  return fitLines(lines, input.system);
}

/** Room kept for the line that says what was cut. */
const CUT_LINE_ROOM = 90;

/** Keep whole lines while they fit, then say how many were cut and where they are. */
function fitLines(lines: string[], system: string): string {
  const longest = SYSTEM_DIGEST_CHAR_CAP - CUT_LINE_ROOM;
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const clipped = line.length > longest / 2 ? `${line.slice(0, longest / 2 - 1)}…` : line;
    const room = index === lines.length - 1 ? SYSTEM_DIGEST_CHAR_CAP : longest;
    if (used + clipped.length + 1 > room) {
      kept.push(`- … ${lines.length - index} more — ${moreHint(system)}`);
      break;
    }
    kept.push(clipped);
    used += clipped.length + 1;
  }
  return kept.join('\n');
}

/**
 * Every system's block, together never longer than
 * {@link CONNECTIONS_DIGEST_CHAR_CAP}. Systems come in the order given — the
 * caller puts the ones the team connected first — and those past the budget
 * keep only their construction line.
 */
export function renderConnectionsDigest(input: {
  systems: SystemDigestInput[];
  /** Systems that need a connection the team does not have yet. */
  notConnected: string[];
}): string {
  const footer =
    input.notConnected.length > 0
      ? `Not connected yet (connectSystem first): ${input.notConnected.join(', ')}.`
      : '';
  const budget = CONNECTIONS_DIGEST_CHAR_CAP - DIGEST_LEGEND.length - footer.length - 4;
  const blocks: string[] = [];
  let used = 0;
  for (const [index, system] of input.systems.entries()) {
    const full = renderSystemDigest(system);
    const block = used + full.length + 2 <= budget ? full : `### ${system.system} — ${constructionSpelling(system)}`;
    if (used + block.length + 2 > budget) {
      blocks.push(`… ${input.systems.length - index} more systems — listConnections names them.`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return [DIGEST_LEGEND, ...blocks, ...(footer ? [footer] : [])].join('\n\n');
}
