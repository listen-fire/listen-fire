// What a catalog holds, as the one description every tool reads
// (crates/movement-checker/src/description.rs), through the movement
// artifact's `describe_query` export. Every name, type, hop and mark arrives
// spelled as `listen-fire catalog` spells it: a caller chooses how much to
// show (`Showing`) and lays the parts out, and never spells one itself.
//
// It loads with the engine artifact, which a browser never downloads.

import { callDescribeQuery } from '../wasm/loader';
import { RustCheckRefused } from '../checker/rust_checker';
import type { CatalogSnapshot } from './snapshot';

/** How much of a place to show. Absent: all of it. */
export interface Showing {
  /** At most this many fields per list: required first, then identifying. */
  fields?: number;
  /** At most this many options per enum, the rest counted (`"a" | "b" | …+3`). */
  enumOptions?: number;
}

export interface DescriptionLevels {
  /** How much of the place itself. */
  showing?: Showing;
  /** How much of where each of its edges lands. */
  landings?: Showing;
}

export interface DescribedField {
  name: string;
  /** The whole field as the catalog writes it: `` `Message Id`!* text ``,
   *  `` `Reply Markup` json (write only) ``. */
  written: string;
  /** Its name and marks alone, as a write's field list writes it: `Text!`. */
  markedName: string;
  /** Its type as a program writes it. */
  type: string;
  required: boolean;
  identifying: boolean;
  readOnly: boolean;
  /** A field only a write gives, on a type that can be read. */
  writeOnly: boolean;
  /** A read's WHERE must set it with `==`. */
  pinned: boolean;
  description?: string;
}

export interface DescribedFields {
  shown: DescribedField[];
  /** How many `Showing.fields` left out. */
  cut: number;
}

export interface DescribedEdge {
  name: string;
  /** The hop alone, as a walk writes it: ``-[:`Linked Users`]->``. */
  step: string;
  /** The hop, where it lands and what it can do: ``-[:Replies]-> Message [w]``. */
  hop: string;
  /** The type it lands on; null where its members land apart. */
  target: string | null;
  read: boolean;
  write: boolean;
  fires: boolean;
  description?: string;
  /** What a write along it takes, where one can be written. */
  writes?: DescribedFields;
  /** Where it lands, one level deep: its own edges carry no landing. */
  lands?: DescribedPlace;
}

export type Known = 'whole' | 'open' | 'undescribed';

export interface DescribedPlace {
  /** The type's name as its module shows it. */
  name: string;
  description?: string;
  /** `open`: its module has fields no description names; `undescribed`: nothing has looked at it. */
  known: Known;
  /** What it may be, where it is one of several types. */
  members: string[];
  fields: DescribedFields;
  edges: DescribedEdge[];
}

export interface DescribedDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

/** Every connection a snapshot describes, at its root. */
export interface CatalogDescription {
  /** The notation's one line, said once at the top of a text in it. */
  legend: string;
  connections: Array<{ adapter: string; key: string; place: DescribedPlace }>;
}

/** The one connection or place an address names. */
export interface AddressDescription {
  legend: string;
  diagnostics: DescribedDiagnostic[];
  /** Null where a diagnostic is an error, or nothing describes where it lands. */
  place: DescribedPlace | null;
  /** An address with no walk: each record type the connection holds, by the
   *  name a program's type writes (`<c-[:Message]->>`). */
  records?: Array<{ name: string; place: DescribedPlace }>;
}

/** Every connection `snapshot` describes, each at its root with where each of its edges lands. */
export function describeCatalog(snapshot: CatalogSnapshot, levels: DescriptionLevels = {}): CatalogDescription {
  const answer = ask(snapshot, levels);
  if (!isRecord(answer) || !Array.isArray(answer.connections)) throw malformed('catalog description', answer);
  return {
    legend: stringOf(answer.legend, 'legend'),
    connections: answer.connections.map((connection) => {
      if (!isRecord(connection)) throw malformed('connection', connection);
      return { adapter: stringOf(connection.adapter, 'adapter'), key: stringOf(connection.key, 'key'), place: placeOf(connection.place) };
    }),
  };
}

/**
 * The connection or place `address` names, written as `listen-fire catalog
 * '<address>'` takes one (`'@lf/slack:team_workspace-[:Channels]->'`): read,
 * checked and walked by the checker, so a misspelt edge comes back as its
 * diagnostic.
 */
export function describeAddress(snapshot: CatalogSnapshot, address: string, levels: DescriptionLevels = {}): AddressDescription {
  const answer = ask(snapshot, { address, ...levels });
  if (!isRecord(answer) || !Array.isArray(answer.diagnostics)) throw malformed('address description', answer);
  const records = answer.records;
  if (records !== undefined && !Array.isArray(records)) throw malformed('record types', records);
  return {
    legend: stringOf(answer.legend, 'legend'),
    diagnostics: answer.diagnostics.map(diagnosticOf),
    place: answer.place === null ? null : placeOf(answer.place),
    ...(records !== undefined
      ? {
          records: records.map((record) => {
            if (!isRecord(record)) throw malformed('record type', record);
            return { name: stringOf(record.name, 'record type name'), place: placeOf(record.place) };
          }),
        }
      : {}),
  };
}

function ask(snapshot: CatalogSnapshot, request: DescriptionLevels & { address?: string }): unknown {
  const reply = callDescribeQuery(JSON.stringify(snapshot), JSON.stringify(request));
  if (!reply.ok) throw RustCheckRefused.of(reply.json);
  return reply.json;
}

function placeOf(value: unknown): DescribedPlace {
  if (!isRecord(value) || !Array.isArray(value.members) || !Array.isArray(value.edges)) throw malformed('place', value);
  return {
    name: stringOf(value.name, 'place name'),
    ...optionalString(value.description, 'place description'),
    known: knownOf(value.known),
    members: value.members.map((member) => stringOf(member, 'member')),
    fields: fieldsOf(value.fields),
    edges: value.edges.map(edgeOf),
  };
}

function knownOf(value: unknown): Known {
  if (value === 'whole' || value === 'open' || value === 'undescribed') return value;
  throw malformed('known', value);
}

function fieldsOf(value: unknown): DescribedFields {
  if (!isRecord(value) || !Array.isArray(value.shown) || typeof value.cut !== 'number') throw malformed('field list', value);
  return { shown: value.shown.map(fieldOf), cut: value.cut };
}

function fieldOf(value: unknown): DescribedField {
  if (!isRecord(value)) throw malformed('field', value);
  return {
    name: stringOf(value.name, 'field name'),
    written: stringOf(value.written, 'field'),
    markedName: stringOf(value.markedName, 'field name and marks'),
    type: stringOf(value.type, 'field type'),
    required: booleanOf(value.required, 'required'),
    identifying: booleanOf(value.identifying, 'identifying'),
    readOnly: booleanOf(value.readOnly, 'readOnly'),
    writeOnly: booleanOf(value.writeOnly, 'writeOnly'),
    pinned: booleanOf(value.pinned, 'pinned'),
    ...optionalString(value.description, 'field description'),
  };
}

function edgeOf(value: unknown): DescribedEdge {
  if (!isRecord(value) || (value.target !== null && typeof value.target !== 'string')) throw malformed('edge', value);
  return {
    name: stringOf(value.name, 'edge name'),
    step: stringOf(value.step, 'step'),
    hop: stringOf(value.hop, 'hop'),
    target: value.target,
    read: booleanOf(value.read, 'read'),
    write: booleanOf(value.write, 'write'),
    fires: booleanOf(value.fires, 'fires'),
    ...optionalString(value.description, 'edge description'),
    ...(value.writes !== undefined ? { writes: fieldsOf(value.writes) } : {}),
    ...(value.lands !== undefined ? { lands: placeOf(value.lands) } : {}),
  };
}

function diagnosticOf(value: unknown): DescribedDiagnostic {
  if (!isRecord(value)) throw malformed('diagnostic', value);
  const { severity } = value;
  if (severity !== 'error' && severity !== 'warning' && severity !== 'info') throw malformed('severity', severity);
  return { code: stringOf(value.code, 'code'), message: stringOf(value.message, 'message'), severity };
}

function stringOf(value: unknown, what: string): string {
  if (typeof value !== 'string') throw malformed(what, value);
  return value;
}

function booleanOf(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw malformed(what, value);
  return value;
}

function optionalString(value: unknown, what: string): { description?: string } {
  return value === undefined ? {} : { description: stringOf(value, what) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(what: string, value: unknown): Error {
  return new Error(`the describing query answered a ${what} that is not one: ${JSON.stringify(value)?.slice(0, 200)}`);
}
