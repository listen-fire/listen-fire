// A tenant's connected systems in compact text, read off its catalog
// snapshot through the language's describing query (movement-lang
// `describeCatalog`, `describeAddress`): how to construct each, and what a
// program reads, writes and listens to along each edge. Two readers share one
// notation, the one `listen-fire catalog` writes:
//
//   - getStarted's digest: every system at its root, under a fixed budget.
//   - describeConnection's compact answer: one place in one system, with the
//     edges leaving it and what each lands on, one level deep.
//
// Every field, edge and mark arrives spelled; here is only how much to ask
// for and where each line goes. The snapshot holds what an introspection
// already read, so this needs no adapter call. A host that walks schemas live
// (`TenantHost.describe`) answers describeConnection itself; this is the
// answer without it.

import {
  RUN_HOST_UNITS,
  describeAddress,
  describeCatalog,
  type AdapterSnapshot,
  type CatalogSnapshot,
  type DescribedDiagnostic,
  type DescribedEdge,
  type DescribedFields,
  type DescribedPlace,
  type Showing,
} from 'movement-lang';

import type { TenantCatalog } from './host';

/** One system's block in getStarted, in characters (about a quarter as many
 *  tokens). Sized so a CRM's main record types keep their fields. */
export const SYSTEM_DIGEST_CHAR_CAP = 1_600;
/** Every block together. Past it, the remaining systems keep a header line. */
export const CONNECTIONS_DIGEST_CHAR_CAP = 8_000;

const ENUM_OPTIONS_SHOWN = 4;
/** Fields shown per type in getStarted, and on an edge's landing in a describe. */
const AT_LANDINGS: Showing = { fields: 10, enumOptions: ENUM_OPTIONS_SHOWN };
/** Fields shown for the place a describe stands on. */
const AT_PLACE: Showing = { fields: 40, enumOptions: ENUM_OPTIONS_SHOWN };

const moreHint = (system: string) => `describeConnection("${system}") for more`;

// ── Lines from the description ──────────────────────────────────────────────

/** A field list, the count of those cut after it as an enum counts its options. */
function fieldList(fields: DescribedFields, place: Pick<DescribedPlace, 'known'>): string {
  if (place.known === 'undescribed') return '(fields not described)';
  const parts = fields.shown.map((field) => field.written);
  if (fields.cut > 0) parts.push(`…+${fields.cut}`);
  if (place.known === 'open') parts.push('… (others its module does not name)');
  return parts.length === 0 ? '(no fields)' : parts.join(', ');
}

/** An edge, then what a program has of it: a write's fields where it is
 *  only written along, else the fields where it lands. */
function edgeLine(edge: DescribedEdge): string {
  const fields = fieldsOf(edge);
  return fields === undefined ? `- ${edge.hop}` : `- ${edge.hop}: ${fieldList(fields.list, fields.place)}`;
}

/** An edge with how many fields it has, for a block short of room. */
function shortEdgeLine(edge: DescribedEdge): string {
  const fields = fieldsOf(edge);
  return fields === undefined ? `- ${edge.hop}` : `- ${edge.hop}: ${fields.list.shown.length + fields.list.cut} fields`;
}

function fieldsOf(edge: DescribedEdge): { list: DescribedFields; place: Pick<DescribedPlace, 'known'> } | undefined {
  if (edge.writes !== undefined && (!edge.read || edge.lands === undefined)) return { list: edge.writes, place: { known: 'whole' } };
  return edge.lands === undefined ? undefined : { list: edge.lands.fields, place: edge.lands };
}

function diagnosticLines(diagnostics: DescribedDiagnostic[]): string[] {
  return diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`);
}

// ── The system's header lines ───────────────────────────────────────────────

type SpecLike = Pick<AdapterSnapshot, 'constructionArgs' | 'package'>;

/** ``connect `@lf/attio` using acme { list: … }``: the system, by its
 *  package else `#` and its key, and its connection, named there with no import; a second connection is named after it. A
 *  run host unit is in every program's scope, never connected. */
function constructionSpelling(system: string, spec: SpecLike, connections: string[]): string {
  // Its edges are listed below it: a listen names one (`manual-[:Invocations]->`).
  if (RUN_HOST_UNITS.includes(system)) return `\`listen to ${system}-[:…]->\` (in scope with no import or connect)`;
  const using = spec.constructionArgs.some((arg) => arg.kind === 'credential') ? ` using ${connections[0] ?? '…'}` : '';
  const settings = spec.constructionArgs.filter((arg) => arg.kind !== 'credential' && arg.required).map((arg) => `${camelCase(arg.name)}: …`);
  const others = connections.slice(1);
  // A package module is connected by its package name, the host's own module by `#` and its key.
  const adapter = spec.package !== undefined ? `\`${spec.package}\`` : `#${system}`;
  const code = `connect ${adapter}${using}${settings.length > 0 ? ` { ${settings.join(', ')} }` : ''}`;
  const span = code.includes('`') ? `\`\`${code}\`\`` : `\`${code}\``;
  return `${span}${others.length > 0 ? ` (other connections: ${others.join(', ')})` : ''}`;
}

/** A setting as `connect` writes it (`base_id` → `baseId`). */
function camelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** A system and how this tenant reaches it. */
interface SystemView {
  system: string;
  spec: AdapterSnapshot;
  connections: string[];
  /** What its first connection (or its credential-free one) is filed under. */
  key: string;
  /** Its schema's root, described; absent with `note` saying why. */
  root?: DescribedPlace;
  note?: string;
}

function needsConnection(spec: AdapterSnapshot): boolean {
  return spec.constructionArgs.some((arg) => arg.kind === 'credential' && arg.required);
}

/** Every connection's root, by system and the key its schema is filed under,
 *  and the notation's legend. */
interface Roots {
  legend: string;
  of(system: string, key: string): DescribedPlace | undefined;
}

function rootsOf(snapshot: CatalogSnapshot): Roots {
  const described = describeCatalog(snapshot, { landings: AT_LANDINGS });
  return { legend: described.legend, of: (system, key) => described.connections.find((c) => c.adapter === system && c.key === key)?.place };
}

function systemView(catalog: TenantCatalog, roots: Roots, system: string, connection?: string): SystemView | null {
  const spec = catalog.snapshot.adapters[system];
  if (spec === undefined) return null;
  const named = catalog.connections.filter((c) => c.system === system).map((c) => c.name);
  const ordered = connection !== undefined ? [connection, ...named.filter((n) => n !== connection)] : named;
  const key = ordered[0] ?? '';
  const root = roots.of(system, key);
  const note = root === undefined ? (spec.schemaNotes?.[key]?.[0] ?? 'its records could not be read') : undefined;
  return { system, spec, connections: ordered, key, ...(root !== undefined ? { root } : {}), ...(note !== undefined ? { note } : {}) };
}

/** Where a describe stands, as `listen-fire catalog` takes it: the module as
 *  `connect` names it, the connection, then the walk. */
function addressOf(view: SystemView, walk: string): string {
  const module = view.spec.package !== undefined ? view.spec.package : `#${view.system}`;
  const credential = view.spec.constructionArgs.some((arg) => arg.kind === 'credential') && view.key !== '' ? `:${view.key}` : '';
  return `${module}${credential}${walk}`;
}

// ── getStarted's digest ─────────────────────────────────────────────────────

/** One system's block, never longer than {@link SYSTEM_DIGEST_CHAR_CAP}. */
function renderSystemDigest(view: SystemView): string {
  const lines = [`### ${view.system} — ${constructionSpelling(view.system, view.spec, view.connections)}`];
  if (view.root === undefined) {
    lines.push(`- ${view.note ?? 'not described'} — ${moreHint(view.system)}`);
    return fitLines(lines, view.system);
  }
  const edges = view.root.edges;
  const chosen = edges.map(edgeLine);
  const size = () => [...lines, ...chosen].reduce((sum, line) => sum + line.length + 1, 0);
  // Edges that only read give up their fields first, then those a listen
  // starts on, and those written along last: a wrong field name in a write
  // costs a failed run.
  const rank = (edge: DescribedEdge) => (edge.write ? 2 : edge.fires ? 1 : 0);
  const order = edges.map((edge, index) => ({ edge, index })).sort((a, b) => rank(a.edge) - rank(b.edge) || b.index - a.index);
  let cut = false;
  for (const { edge, index } of order) {
    if (size() + CUT_LINE_ROOM <= SYSTEM_DIGEST_CHAR_CAP) break;
    chosen[index] = shortEdgeLine(edge);
    cut = true;
  }
  const cutHint = cut ? [`- fields cut for space — describeConnection({ system: "${view.system}" }) shows each type's`] : [];
  return fitLines([...lines, ...chosen, ...cutHint], view.system);
}

/** Room kept for the line that says what was cut. */
const CUT_LINE_ROOM = 120;

/** Keep whole lines while they fit, then say how many were left out and where. */
function fitLines(lines: string[], system: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const room = index === lines.length - 1 ? SYSTEM_DIGEST_CHAR_CAP : SYSTEM_DIGEST_CHAR_CAP - CUT_LINE_ROOM;
    if (used + line.length + 1 > room) {
      kept.push(`- … ${lines.length - index} more — ${moreHint(system)}`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}

/**
 * Every system's block, together never longer than
 * {@link CONNECTIONS_DIGEST_CHAR_CAP}, under the notation's one legend line:
 * the systems the tenant connected first, then those that need no
 * connection. A system that needs a connection the tenant lacks is only named.
 */
export function renderConnectionsDigest(catalog: TenantCatalog): string {
  const roots = rootsOf(catalog.snapshot);
  const legend = roots.legend;
  const connected: SystemView[] = [];
  const builtIn: SystemView[] = [];
  const notConnected: string[] = [];
  for (const system of Object.keys(catalog.snapshot.adapters)) {
    const view = systemView(catalog, roots, system);
    if (view === null) continue;
    if (needsConnection(view.spec) && view.connections.length === 0) notConnected.push(system);
    else (view.connections.length > 0 ? connected : builtIn).push(view);
  }
  const footer = notConnected.length > 0 ? `Not connected yet: ${notConnected.join(', ')}.` : '';
  const systems = [...connected, ...builtIn];
  const budget = CONNECTIONS_DIGEST_CHAR_CAP - legend.length - footer.length - 4;
  const blocks: string[] = [];
  let used = 0;
  for (const [index, view] of systems.entries()) {
    const full = renderSystemDigest(view);
    const block = used + full.length + 2 <= budget ? full : `### ${view.system} — ${constructionSpelling(view.system, view.spec, view.connections)}`;
    if (used + block.length + 2 > budget) {
      blocks.push(`… ${systems.length - index} more systems — listConnections names them.`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return [legend, ...blocks, ...(footer ? [footer] : [])].join('\n\n');
}

// ── describeConnection's compact answer ─────────────────────────────────────

/** A place: its fields, then each edge leaving it with the fields where it lands. */
function placeLines(place: DescribedPlace): string[] {
  const members = place.members.length > 0 ? [`may be: ${place.members.join(', ')}`] : [];
  const pinned = place.fields.shown.filter((field) => field.pinned).map((field) => field.markedName);
  return [
    `${place.name}: ${fieldList(place.fields, place)}`,
    ...members,
    ...(pinned.length > 0 ? [`pinned (a read's WHERE must set each with ==): ${pinned.join(', ')}`] : []),
    ...(place.edges.length > 0 ? ['edges:', ...place.edges.map(edgeLine)] : ['edges: none']),
  ];
}

export type ConnectionDescription = { ok: true; text: string } | { ok: false; error: string };

/**
 * One place in one system, in the digest's notation. At the root: how to
 * construct and listen, what the system is, and each edge leaving the
 * connection with what lands there. At a position (a walk, as a program
 * writes one from the connection) or a named type: its fields, then every
 * edge leaving it with what it lands on.
 */
export function describeFromSnapshot(
  catalog: TenantCatalog,
  request: { system: string; connection?: string; position?: string; types?: string[] },
): ConnectionDescription {
  const view = systemView(catalog, rootsOf(catalog.snapshot), request.system, request.connection);
  if (view === null) {
    return { ok: false, error: `No system "${request.system}". Systems: ${Object.keys(catalog.snapshot.adapters).join(', ') || 'none'}.` };
  }
  const { system, spec, root } = view;
  if (request.position !== undefined || request.types !== undefined) {
    if (root === undefined) return { ok: false, error: `${system}: ${view.note ?? 'not described'}.` };
    const blocks =
      request.position !== undefined ? [positionBlock(catalog.snapshot, view, root, request.position)] : (request.types ?? []).map((type) => typeBlock(catalog.snapshot, view, type));
    return { ok: true, text: blocks.join('\n\n') };
  }

  const lines = [`### ${system} — ${constructionSpelling(system, spec, view.connections)}`];
  if (spec.description) lines.push(spec.description);
  if (spec.triggerExpectation) lines.push(`- What a listen fires on: ${spec.triggerExpectation}`);
  if (needsConnection(spec) && view.connections.length === 0) lines.push('- Not connected yet: a program cannot construct it until the user connects it.');
  if (root === undefined) {
    lines.push(`Note: ${view.note ?? 'not described'}`);
    return { ok: true, text: lines.join('\n') };
  }
  if (spec.schemas[view.key]?.supportsInPlaceUpdate !== true) lines.push('- Records here cannot be updated in place: a write creates.');
  lines.push(...(root.edges.length > 0 ? ['From the connection:', ...root.edges.map(edgeLine)] : ['No edges leave the connection.']));
  const first = root.edges[0];
  lines.push(
    [first !== undefined ? `Stand on a place with its position, e.g. position: ${JSON.stringify(first.step)}.` : '', 'detail: "full" returns the JSON (the system and its schema).']
      .filter(Boolean)
      .join(' '),
  );
  return { ok: true, text: lines.join('\n') };
}

/** Where `position` lands, through the checker: a misspelt edge is its diagnostic. */
function positionBlock(snapshot: CatalogSnapshot, view: SystemView, root: DescribedPlace, position: string): string {
  const header = `### ${view.system} at ${position}`;
  // A run host unit is no connection an address connects: its places are the
  // edges its root lists.
  if (RUN_HOST_UNITS.includes(view.system)) {
    const lands = root.edges.find((edge) => edge.step === position)?.lands;
    if (lands === undefined) return [header, `No such place. Positions: ${root.edges.map((edge) => edge.step).join(', ')}.`].join('\n');
    return [header, ...placeLines(lands)].join('\n');
  }
  const described = describeAddress(snapshot, addressOf(view, position), { showing: AT_PLACE, landings: AT_LANDINGS });
  if (described.place === null) return [header, ...diagnosticLines(described.diagnostics)].join('\n');
  const further = described.place.edges[0];
  return [
    header,
    ...diagnosticLines(described.diagnostics),
    ...placeLines(described.place),
    ...(further !== undefined ? [`Go further with this position and an edge's hop, e.g. position: ${JSON.stringify(position + further.step)}.`] : []),
  ].join('\n');
}

/** A record type by the name a program's type writes (`<c-[:Message]->>`). */
function typeBlock(snapshot: CatalogSnapshot, view: SystemView, type: string): string {
  const header = `### ${view.system} type ${type}`;
  if (RUN_HOST_UNITS.includes(view.system)) return [header, 'A run host unit has no types of its own: its root lists what lands on each edge.'].join('\n');
  const described = describeAddress(snapshot, addressOf(view, ''), { showing: AT_PLACE, landings: AT_LANDINGS });
  const records = described.records ?? [];
  const record = records.find((r) => r.name === type);
  if (record === undefined) {
    const diagnostics = diagnosticLines(described.diagnostics);
    return [header, ...(diagnostics.length > 0 ? diagnostics : [`No such type. Types: ${records.map((r) => r.name).join(', ') || 'none'}.`])].join('\n');
  }
  return [header, ...placeLines(record.place)].join('\n');
}

/** describeConnection's `detail: "full"`: the system as the catalog holds it,
 *  with the one connection's schema. */
export function describeFull(catalog: TenantCatalog, request: { system: string; connection?: string }) {
  const spec = catalog.snapshot.adapters[request.system];
  if (spec === undefined) return { error: `No system "${request.system}".` };
  const named = catalog.connections.filter((c) => c.system === request.system).map((c) => c.name);
  const connections = request.connection !== undefined ? [request.connection, ...named.filter((n) => n !== request.connection)] : named;
  const key = connections[0] ?? '';
  const { schemas, schemaNotes, ...declared } = spec;
  const schema = schemas[key];
  return {
    system: request.system,
    connections,
    spec: declared,
    ...(schema !== undefined ? { schema } : { note: schemaNotes?.[key]?.[0] ?? 'its records could not be read' }),
  };
}

/** listConnections: the systems a program may connect, how each is
 *  constructed and listened to, and the tenant's connections. */
export function connectionsView(catalog: TenantCatalog) {
  return {
    systems: Object.entries(catalog.snapshot.adapters).map(([system, spec]) => ({
      system,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      constructionArgs: spec.constructionArgs.map((arg) => ({ name: arg.name, kind: arg.kind, required: arg.required })),
      ...(spec.triggerExpectation !== undefined ? { triggerExpectation: spec.triggerExpectation } : {}),
      canFire: spec.canFire === true,
      connected: catalog.connections.some((c) => c.system === system) || !needsConnection(spec),
    })),
    connections: catalog.connections,
    plugins: Object.keys(catalog.snapshot.plugins),
  };
}
