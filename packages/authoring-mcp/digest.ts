// A tenant's connected systems in compact text, read off its catalog
// snapshot: how to construct each, what a listen on it may say, and its
// record types with their fields. Two readers share one notation:
//
//   - getStarted's digest: every system at its root, under a fixed budget.
//   - describeConnection's compact answer: one place in one system, with the
//     edges leaving it and what each lands on, one level deep.
//
// The snapshot holds what an introspection already read, so this needs no
// adapter call. A host that walks schemas live (`TenantHost.describe`)
// answers describeConnection itself; this is the answer without it, and it is
// complete for a flat schema.

import {
  RUN_HOST_UNITS,
  spellName,
  type AdapterSnapshot,
  type CatalogSnapshot,
  type EdgeSchema,
  type InstanceSchema,
  type PositionSchema,
  type SchemaFieldType,
  type WritableRootSchema,
} from 'movement-lang';

import type { TenantCatalog } from './host';

/** One system's block in getStarted, in characters (about a quarter as many
 *  tokens). Sized so a CRM's main record types keep their fields. */
export const SYSTEM_DIGEST_CHAR_CAP = 1_600;
/** Every block together. Past it, the remaining systems keep a header line. */
export const CONNECTIONS_DIGEST_CHAR_CAP = 8_000;

/** Fields shown per type in getStarted, and on an edge's landing in a describe. */
const FIELDS_PER_TYPE = 10;
/** Fields shown for the place a describe stands on. */
const FIELDS_AT_POSITION = 40;
const ENUM_OPTIONS_SHOWN = 4;
/** How deep a describe's positions are offered. */
const POSITION_DEPTH = 4;

export const DIGEST_LEGEND =
  'Marks: `!` required to create · `*` identifies the record (a `unique by` candidate) · `~` read-only · [r] readable, [w] writable, [fires] a listen can fire on it · a `backticked` name is written with its backticks in code.';

const moreHint = (system: string) => `describeConnection("${system}") for more`;

/** A type in as few characters as stay unambiguous. */
export function compactType(type: SchemaFieldType): string {
  if (typeof type === 'string') return type === 'absent' ? 'null' : type;
  switch (type.kind) {
    case 'list':
      return `${compactType(type.of)}[]`;
    case 'maybeAbsent':
      return `${compactType(type.of)}?`;
    case 'enum': {
      const shown = type.options.slice(0, ENUM_OPTIONS_SHOWN);
      const hidden = type.options.length - shown.length;
      // `…+N` counts the options cut; a bare `…` says other values are legal too.
      const more = hidden > 0 ? [`…+${hidden}`] : type.open !== undefined ? ['…'] : [];
      return `enum(${[...shown, ...more].join('|')})`;
    }
    case 'tuple':
      return 'tuple';
    case 'dict':
      return 'dict';
    default:
      return unreachable(type);
  }
}

function unreachable(value: never): never {
  throw new Error(`unexpected field type ${JSON.stringify(value)}`);
}

// ── What a system's schema says, as record types ────────────────────────────

interface RecordField {
  name: string;
  type: SchemaFieldType;
  required: boolean;
  identifies: boolean;
  readOnly: boolean;
  writeOnly: boolean;
}

/** A record type: a root of the system (a collection, a writable root, an
 *  event), or a place an edge lands on. */
interface RecordType {
  name: string;
  readable: boolean;
  writable: boolean;
  fires: boolean;
  firesOn?: string[];
  fields: RecordField[];
}

function fieldsOf(position: PositionSchema | undefined, write: WritableRootSchema | undefined): RecordField[] {
  const required = new Set(write?.requiredFields ?? []);
  const identity = new Set((write?.nativeUniqueness ?? []).flat());
  const read = position?.properties ?? {};
  const written = write?.fields ?? {};
  const names = [...new Set([...Object.keys(read), ...Object.keys(written)])];
  return names.map((name) => ({
    name,
    type: read[name] ?? written[name],
    required: required.has(name),
    identifies: identity.has(name),
    readOnly: write !== undefined && !(name in written),
    writeOnly: position !== undefined && !(name in read),
  }));
}

function eventPositionsOf(schema: InstanceSchema): Array<{ position: string; on?: string[] }> {
  if (schema.eventPositions !== undefined) return schema.eventPositions;
  return schema.eventPosition !== undefined ? [{ position: schema.eventPosition }] : [];
}

/** The system's roots: its collections and writable roots by name, and each
 *  event position no root already names. */
function rootsOf(schema: InstanceSchema): RecordType[] {
  const events = eventPositionsOf(schema);
  const firing = (target: string) => events.find((e) => e.position === target);
  const names = [...new Set([...Object.keys(schema.collections), ...Object.keys(schema.writableRoots)])];
  const roots = names.map((name): RecordType => {
    const target = schema.collections[name]?.target ?? schema.writableRoots[name]?.position ?? name;
    const fired = firing(target);
    return {
      name,
      readable: name in schema.collections,
      writable: name in schema.writableRoots,
      fires: fired !== undefined,
      ...(fired?.on !== undefined ? { firesOn: fired.on } : {}),
      fields: fieldsOf(schema.positions[target], schema.writableRoots[name] ?? schema.createShapes?.[target]),
    };
  });
  const named = new Set(roots.map((r) => schema.collections[r.name]?.target ?? r.name));
  for (const event of events) {
    if (named.has(event.position)) continue;
    named.add(event.position);
    roots.push({
      name: schema.positions[event.position]?.displayName ?? event.position,
      readable: false,
      writable: false,
      fires: true,
      ...(event.on !== undefined ? { firesOn: event.on } : {}),
      fields: fieldsOf(schema.positions[event.position], undefined),
    });
  }
  return roots;
}

function access(type: Pick<RecordType, 'readable' | 'writable' | 'fires' | 'firesOn'>): string {
  const fires = type.fires ? [type.firesOn !== undefined && type.firesOn.length > 0 ? `fires(${type.firesOn.join('|')})` : 'fires'] : [];
  const flags = [`${type.readable ? 'r' : ''}${type.writable ? 'w' : ''}`, ...fires].filter(Boolean);
  return flags.length > 0 ? ` [${flags.join(' ')}]` : '';
}

function fieldSpelling(field: RecordField): string {
  const marks = `${field.required ? '!' : ''}${field.identifies ? '*' : ''}${field.readOnly ? '~' : ''}`;
  return `${spellName(field.name)} ${compactType(field.type)}${marks}${field.writeOnly ? ' (write-only)' : ''}`;
}

/** Required and identifying fields first: a first write needs them. */
function fieldList(fields: RecordField[], limit: number): string {
  const rank = (f: RecordField) => (f.required ? 0 : f.identifies ? 1 : 2);
  const ordered = fields.map((field, index) => ({ field, index })).sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index);
  const shown = ordered.slice(0, limit).map(({ field }) => fieldSpelling(field));
  const hidden = ordered.length - shown.length;
  return shown.length === 0 ? 'no fields' : `${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

// ── The system's header lines ───────────────────────────────────────────────

type SpecLike = Pick<AdapterSnapshot, 'constructionArgs' | 'triggerConfig' | 'triggerConfigOptions' | 'triggerConfigRequired'>;

/** `attio(credentials: acme)`; a second connection is named after it. A
 *  run host unit is in every program's scope, never constructed. */
function constructionSpelling(system: string, spec: SpecLike, connections: string[]): string {
  if (RUN_HOST_UNITS.includes(system)) return `\`listen to ${system}\` (in scope with no import or connect)`;
  const args = spec.constructionArgs.flatMap((arg) => {
    if (arg.kind === 'credential') return [`${arg.name}: ${connections[0] ?? '…'}`];
    return arg.required ? [`${arg.name}: …`] : [];
  });
  const others = connections.slice(1);
  return `\`${system}(${args.join(', ')})\`${others.length > 0 ? ` (other connections: ${others.join(', ')})` : ''}`;
}

/** `listen { key! }`, `listen { events: company.created|company.updated }`. */
function listenSpelling(spec: SpecLike): string | null {
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

/** A system and how this tenant reaches it. */
interface SystemView {
  system: string;
  spec: AdapterSnapshot;
  connections: string[];
  /** The schema of its first connection (or its credential-free one). */
  schema?: InstanceSchema;
  note?: string;
}

function needsConnection(spec: AdapterSnapshot): boolean {
  return spec.constructionArgs.some((arg) => arg.kind === 'credential' && arg.required);
}

function systemView(snapshot: CatalogSnapshot, connections: TenantCatalog['connections'], system: string, connection?: string): SystemView | null {
  const spec = snapshot.adapters[system];
  if (spec === undefined) return null;
  const named = connections.filter((c) => c.system === system).map((c) => c.name);
  const ordered = connection !== undefined ? [connection, ...named.filter((n) => n !== connection)] : named;
  const key = ordered[0] ?? '';
  const schema = spec.schemas[key];
  const note = schema === undefined ? (spec.schemaNotes?.[key]?.[0] ?? 'its records could not be read') : undefined;
  return { system, spec, connections: ordered, ...(schema !== undefined ? { schema } : {}), ...(note !== undefined ? { note } : {}) };
}

// ── getStarted's digest ─────────────────────────────────────────────────────

/** One system's block, never longer than {@link SYSTEM_DIGEST_CHAR_CAP}. */
export function renderSystemDigest(view: SystemView): string {
  const lines = [`### ${view.system} — ${constructionSpelling(view.system, view.spec, view.connections)}`];
  const listen = listenSpelling(view.spec);
  if (listen) lines.push(`- ${listen}`);
  if (view.schema === undefined) {
    lines.push(`- ${view.note ?? 'not described'} — ${moreHint(view.system)}`);
    return fitLines(lines, view.system);
  }
  const roots = rootsOf(view.schema);
  const full = roots.map((root) => `- ${spellName(root.name)}${access(root)}: ${fieldList(root.fields, FIELDS_PER_TYPE)}`);
  const short = roots.map((root) => `- ${spellName(root.name)}${access(root)}: ${root.fields.length} fields`);
  const chosen = [...full];
  const size = () => [...lines, ...chosen].reduce((sum, line) => sum + line.length + 1, 0);
  // Read-only types give up their fields first, then event payloads, and
  // writable types last: a wrong field name in a write costs a failed run.
  const rank = (root: RecordType) => (root.writable ? 2 : root.fires ? 1 : 0);
  const order = roots.map((root, index) => ({ root, index })).sort((a, b) => rank(a.root) - rank(b.root) || b.index - a.index);
  let cut = false;
  for (const { index } of order) {
    if (size() + CUT_LINE_ROOM <= SYSTEM_DIGEST_CHAR_CAP) break;
    chosen[index] = short[index];
    cut = true;
  }
  const cutHint = cut ? [`- fields cut for space — describeConnection({ system: "${view.system}" }) shows each type's`] : [];
  return fitLines([...lines, ...chosen, ...cutHint], view.system);
}

/** Room kept for the line that says what was cut. */
const CUT_LINE_ROOM = 120;

/** Keep whole lines while they fit, then say how many were cut and where. */
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
 * {@link CONNECTIONS_DIGEST_CHAR_CAP}: the systems the tenant connected first,
 * then those that need no connection. A system that needs a connection the
 * tenant lacks is only named.
 */
export function renderConnectionsDigest(catalog: TenantCatalog): string {
  const connected: SystemView[] = [];
  const builtIn: SystemView[] = [];
  const notConnected: string[] = [];
  for (const system of Object.keys(catalog.snapshot.adapters)) {
    const view = systemView(catalog.snapshot, catalog.connections, system);
    if (view === null) continue;
    if (needsConnection(view.spec) && view.connections.length === 0) notConnected.push(system);
    else (view.connections.length > 0 ? connected : builtIn).push(view);
  }
  const footer = notConnected.length > 0 ? `Not connected yet: ${notConnected.join(', ')}.` : '';
  const systems = [...connected, ...builtIn];
  const budget = CONNECTIONS_DIGEST_CHAR_CAP - DIGEST_LEGEND.length - footer.length - 4;
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
  return [DIGEST_LEGEND, ...blocks, ...(footer ? [footer] : [])].join('\n\n');
}

// ── describeConnection's compact answer ─────────────────────────────────────

/** A place in the system: where a path of hops from its root lands. */
interface Place {
  /** The hops that reach it, as an author writes them (`-[:Company]->`). */
  position: string;
  /** The position type it lands on. */
  target: string;
  /** The root or edge that reached it. */
  via: RecordType;
}

const hop = (name: string) => `-[:${spellName(name)}]->`;

/**
 * Every place reachable from the root within {@link POSITION_DEPTH} hops, by
 * the position string that reaches it. A requested position is looked up
 * here by comparison, so only a position this answer could have handed out
 * is ever honoured.
 */
function placesOf(schema: InstanceSchema): Map<string, Place> {
  const places = new Map<string, Place>();
  const roots = rootsOf(schema);
  let frontier: Place[] = roots.map((root) => ({
    position: hop(root.name),
    target: schema.collections[root.name]?.target ?? schema.writableRoots[root.name]?.position ?? root.name,
    via: root,
  }));
  for (let depth = 0; depth < POSITION_DEPTH && frontier.length > 0; depth++) {
    const next: Place[] = [];
    for (const place of frontier) {
      if (places.has(place.position)) continue;
      places.set(place.position, place);
      for (const [edge, schemaEdge] of Object.entries(schema.positions[place.target]?.edges ?? {})) {
        next.push({ position: place.position + hop(edge), target: schemaEdge.target, via: edgeType(schema, edge, schemaEdge) });
      }
    }
    frontier = next;
  }
  return places;
}

function edgeType(schema: InstanceSchema, name: string, edge: EdgeSchema): RecordType {
  const writable = edge.writable === true;
  return {
    name,
    readable: edge.readable !== false,
    writable,
    fires: false,
    fields: fieldsOf(schema.positions[edge.target], writable ? schema.createShapes?.[edge.target] : undefined),
  };
}

function edgeLines(schema: InstanceSchema, place: { target: string; position: string }): string[] {
  return Object.entries(schema.positions[place.target]?.edges ?? {}).map(([name, edge]) => {
    const landing = edgeType(schema, name, edge);
    return `- -[:${spellName(name)}]-> ${spellName(edge.target)}${access(landing)}: ${fieldList(landing.fields, FIELDS_PER_TYPE)} — position ${JSON.stringify(place.position + hop(name))}`;
  });
}

export type ConnectionDescription = { ok: true; text: string } | { ok: false; error: string };

/**
 * One place in one system, in the digest's notation. At the root: how to
 * construct and listen, what the system is, and each record type with its
 * fields. At a position (one an earlier answer handed out) or a named type:
 * its fields, then every edge leaving it with what it lands on.
 */
export function describeFromSnapshot(
  catalog: TenantCatalog,
  request: { system: string; connection?: string; position?: string; types?: string[] },
): ConnectionDescription {
  const view = systemView(catalog.snapshot, catalog.connections, request.system, request.connection);
  if (view === null) {
    return { ok: false, error: `No system "${request.system}". Systems: ${Object.keys(catalog.snapshot.adapters).join(', ') || 'none'}.` };
  }
  const { system, spec, schema } = view;
  if (request.position !== undefined || request.types !== undefined) {
    if (schema === undefined) return { ok: false, error: `${system}: ${view.note ?? 'not described'}.` };
    const places = placesOf(schema);
    const wanted = request.position !== undefined ? [request.position] : (request.types ?? []).map(hop);
    const blocks = wanted.map((position) => {
      const place = places.get(position) ?? [...places.values()].find((p) => p.target === position || hop(p.target) === position);
      if (place === undefined) {
        return `### ${system} at ${position}\nNo such place. Positions: ${[...places.keys()].slice(0, 20).join(', ')}.`;
      }
      const edges = edgeLines(schema, place);
      return [
        `### ${system} at ${place.position}`,
        `${spellName(place.via.name)}${access(place.via)}: ${fieldList(place.via.fields, FIELDS_AT_POSITION)}`,
        ...(edges.length > 0 ? ['Edges:', ...edges] : ['No edges leave this node.']),
      ].join('\n');
    });
    return { ok: true, text: blocks.join('\n\n') };
  }

  const lines = [`### ${system} — ${constructionSpelling(system, spec, view.connections)}`];
  if (spec.description) lines.push(spec.description);
  const listen = listenSpelling(spec);
  if (listen) lines.push(`- ${listen}`);
  if (spec.triggerExpectation) lines.push(`- What a listen fires on: ${spec.triggerExpectation}`);
  if (needsConnection(spec) && view.connections.length === 0) lines.push('- Not connected yet: a program cannot construct it until the user connects it.');
  if (schema === undefined) {
    lines.push(`Note: ${view.note ?? 'not described'}`);
    return { ok: true, text: lines.join('\n') };
  }
  if (schema.supportsInPlaceUpdate !== true) lines.push('- Records here cannot be updated in place: a write creates.');
  const roots = rootsOf(schema);
  if (roots.length > 0) {
    lines.push('Record types:');
    for (const root of roots) {
      lines.push(`- ${hop(root.name)}${access(root)}: ${fieldList(root.fields, FIELDS_PER_TYPE)}`);
    }
  } else {
    lines.push('No record types.');
  }
  const deeper = [...placesOf(schema).keys()][0];
  lines.push(
    [
      deeper !== undefined ? `Stand on a record type with its position, e.g. position: ${JSON.stringify(deeper)}.` : '',
      'detail: "full" returns the JSON (the system and its schema).',
    ]
      .filter(Boolean)
      .join(' '),
  );
  return { ok: true, text: lines.join('\n') };
}

/** describeConnection's `detail: "full"`: the system as the catalog holds it,
 *  with the one connection's schema. */
export function describeFull(catalog: TenantCatalog, request: { system: string; connection?: string }) {
  const view = systemView(catalog.snapshot, catalog.connections, request.system, request.connection);
  if (view === null) return { error: `No system "${request.system}".` };
  const { schemas: _schemas, schemaNotes: _notes, ...spec } = view.spec;
  return {
    system: view.system,
    connections: view.connections,
    spec,
    ...(view.schema !== undefined ? { schema: view.schema } : { note: view.note ?? 'not described' }),
  };
}

/** listConnections: the systems a program may import, how each is
 *  constructed and listened to, and the tenant's connections. */
export function connectionsView(catalog: TenantCatalog) {
  return {
    systems: Object.entries(catalog.snapshot.adapters).map(([system, spec]) => ({
      system,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      constructionArgs: spec.constructionArgs.map((arg) => ({ name: arg.name, kind: arg.kind, required: arg.required })),
      ...(spec.triggerConfig !== undefined ? { listenConfig: spec.triggerConfig } : {}),
      ...(spec.triggerConfigOptions !== undefined ? { listenConfigOptions: spec.triggerConfigOptions } : {}),
      ...(spec.triggerExpectation !== undefined ? { triggerExpectation: spec.triggerExpectation } : {}),
      canFire: spec.canFire === true,
      connected: catalog.connections.some((c) => c.system === system) || !needsConnection(spec),
    })),
    connections: catalog.connections,
    plugins: Object.keys(catalog.snapshot.plugins),
  };
}
