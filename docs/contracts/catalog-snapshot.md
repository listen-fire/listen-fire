# The catalog snapshot

Version: 3

A catalog snapshot is a tenant's catalog as plain JSON: the adapters it can construct and their schemas, its credential names, its plugins, the models it can reach, and its saved movement files. The checker, the editor and both engines read it; nothing in it is a live object, and it never carries a credential's secret or id (those travel beside it, as a run's `credentialIds`).

- **The type:** `CatalogSnapshot` (`packages/movement-lang/service/snapshot.ts`, re-exported by `engine-contracts`).
- **Read by:** `fromCatalogSnapshot` (the TypeScript checker, the editor, the TypeScript engine's check) and `CatalogSnapshot::load` (`crates/movement-parser/src/catalog/`, the Rust catalog the Rust engine and the browser parser load). The Rust reader refuses any member the TypeScript does not declare.
- **Built by:** a host, per tenant and per run (lf-platform builds it per team in `apps/api/src/services/translation_graph/movement/catalog.ts`; `listen-fire` builds it from the project), and `catalogSnapshotOf` (`service/snapshot.ts`) over any live `Catalog`.

## Versions

- **The version is an integer**, stated at the top of this document and held by `CATALOG_SNAPSHOT_VERSION`. This release writes and reads version 3 (`SUPPORTED_CATALOG_SNAPSHOT_VERSIONS`; [the index](README.md) lists each release).
- **On the wire:** a snapshot carries `contractVersion`. Both builders set it. It is optional on read: a snapshot without one (a hand-written fixture) reads as the current version, and any member a later version retired is still refused.
- **Refusal:** a reader handed a version it does not read refuses it rather than reading it as the current one. The TypeScript reader throws, and the Rust reader answers an error, with the same message: `the catalog snapshot carries contract version 4, which this release does not read (supported: 3)`. Versions 1 and 2 are refused by name: `the catalog snapshot carries contract version 2, written before 0.13 retired the settings listen; this release reads version 3: rebuild the catalog with it`.
- **What bumps it:** a change in meaning. A member removed or renamed, a member whose meaning changed, or a required member added. A new optional member keeps the version, but note the Rust reader's strictness: a new member must be declared in its types before a builder may write it, or every Rust read of a snapshot carrying it fails.
- **How a break lands:** the builder writes the new version; a reader that reads both branches on `contractVersion` at the point of difference.

## The shapes

The shapes are TypeScript-ish: `x?: T` may be absent, and an absent member and one that is `undefined` are the same.

```ts
interface CatalogSnapshot {
  contractVersion?: number;                       // absent: the current version
  adapters: Record<string, AdapterSnapshot>;      // by adapter type
  credentials: Record<string, { adapters: string[]; credential?: string } | { adapter: string }>;   // by import name; `{ adapter }` is the older single-adapter form; `credential`: the module's declared credential it fills
  plugins: Record<string, PluginSpec>;            // by key: module and name (`@lf/web/render`) for a package's plugin, else the name
  files?: Record<string, { source: string }>;     // saved movement files, by import path
  models?: string[];                              // logical model names this deployment reaches; absent: models unchecked
}

interface AdapterSnapshot extends AdapterSpec {
  schemas: Record<string, InstanceSchema>;        // by instance key: the credential import name, plus `::<entry position>` when the construction pins one; '' is credential-free
  schemaNotes?: Record<string, string[]>;         // why a key's schema is missing, keyed like `schemas`
  constructionArgOptions?: Record<string, Record<string, string[]>>;   // entry-position arg values, by credential import name then arg name
}

interface AdapterSpec {
  constructionArgs: ConstructionArg[];
  declaredCredentials?: string[];                 // a module's declared credentials, by name; a credential naming another (`credential`) is refused at check
  canFire?: boolean;                              // absent on a known spec: it cannot fire anything
  connectActions?: Array<{ kind: string; label: string }>;
  connect?: 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';
  triggerExpectation?: string;
  schemaShape?: 'static' | 'introspected';
  description?: string;                           // the adapter's own words for itself (its manifest's `description`); shown, never checked
  resendWindowSeconds?: number;                   // how long the provider may re-send an arrival it already sent (its manifest's); a default lf.yaml overrides per connection
  listenSettingsBecome?: SettingsBecome;          // what a 0.12 settings listen on it becomes as a traversal (its manifest's); `listen-fire upgrade` rewrites by it
}

interface SettingsBecome {
  path: string[];                                 // the edges from the connection's root to the listened edge
  aliases: string[];                              // one per edge: the alias its rewritten WHERE reads the hop's record by
  paramFrom?: string;                             // the 0.12 event position a fired parameter was typed as; one naming it is retyped by the landing
  keys: Record<string, KeyBecomes>;               // each settings key, by name
  byEvent?: Record<string, SettingsBecome>;       // the mapping a listen naming one of these events becomes instead (its events arrive on another edge); one level deep
  fieldChange?: FieldChange;                      // how `field` and `becomes` compare the row a hop's records hold before and after
  changed?: string;                               // where the traversal hears otherwise than the settings listen did: told as a note, and the fix is never safe (gmail's `label_added`)
  alsoArrivesOn?: string[][];                     // the other paths these events arrive on (Slack's thread replies on `Replies`): no rewrite, one listen per edge
}

interface FieldChange {
  hop: number;                                    // the index into `path` of the hop whose records hold the rows
  field: string;                                  // the settings key naming the field: alone, F changed (each row tested present first; adapter-protocol.md)
  becomes: string;                                // the settings key naming the value it came to hold: `exists(c.Current) AND c.Current.F == v AND (NOT exists(c.Previous) OR c.Previous.F != v)`; alone, nothing
  current: string;                                // the record's field holding the row as the change left it
  previous: string;                               // the record's field holding the row as it was before
}

interface KeyBecomes {
  hop: number;                                    // the index into `path` of the hop it narrows
  field?: string;                                 // the field it compares; absent for `type`
  op: 'eq' | 'neq' | 'in' | 'contains' | 'type';  // `field == value`, `field != value`, `field IN [values]`, `field CONTAINS value` (several: an OR of them), or the landing's declared type (`payload: <T>`)
  values?: Record<string, string | boolean | null>; // a settings value's spelling as a field value (`"record.created"` → `"created"`; `true` and `false` by theirs); null: the value narrowed nothing, so the key compares nothing
  absent?: string | string[];                     // what a listen that left the key out meant (`""`: the box itself); its rewrite compares it
  absentField?: string;                           // the field `absent` is compared on, when not the key's own (gmail's `labels` left out of a label listen: `Label Type == "user"`)
  lowercase?: boolean;                            // 0.12 compared the key's values lowercased: the rewrite writes them so
}

interface ConstructionArg {
  name: string;
  kind: 'credential' | 'position';
  required: boolean;
  optionsFromType?: string;
  label?: string;
}

interface PluginSpec {
  args: string[];
  priced: boolean;
  argTypes?: Record<string, SchemaFieldType>;   // each argument's declared input type, by name; absent for one nobody typed
  requiredArgs?: string[];
  effects?: { reads?: string[]; writes?: string[]; ai?: boolean; now?: boolean; suspend?: boolean };
  fedByExtraction?: boolean;
  fedArgs?: Array<{ name: string; required?: true }>;
  output?: PluginOutput;
  package?: string;   // the package tag it is a member of (`@lf/web`); absent when it is in none
  name?: string;      // the name a program spells it (`render`), when the key is not that; absent: the key
  description?: string;   // what it does, in its author's words (its signature's `description`); shown, never checked
}
```

**A plugin's arguments by position.** A call passes the plugin's required inputs by position, then its other inputs in one settings record (`fetchUrl(u)`, `research(n, { context: s })`). The positions are the spec's required `fedArgs`, then its `requiredArgs` in `args` order; a `through [ … ]` stage, which is never fed by its author, takes only the `requiredArgs`. The spec keeps a plugin's fed inputs apart from its author's, so it does not say how the two interleave in the manifest; every plugin declares its fed input first, so fed-then-author is the manifest's declared order. A settings key is an input's name exactly as `args` (or, on a plain call, `fedArgs`) spells it. The call is bound to the named config before the plugin is invoked, so the wire is unchanged: the plugin is handed `{ url: … }` as before. One binding does this in each language (Rust `PluginSpec::bind_args`, TypeScript `bindPluginArgs`); both checkers and both engines use it.

**A plugin's output that is one file.** A `value` output of type `file` is the file the host put at the answer's `data.value`, not the fetched text (a PDF: `pdf.render(text)`).

**A plugin package.** A spec's `package` is a tag (`@lf/web`), compared exactly and never parsed. An import from `plugins` whose name equals some spec's `package` imports that package: ``import { `@lf/web` as web } from plugins``. Its members are the specs that declare that tag, each called by its key in camelCase after the package's local name (`fetch_url` → `web.fetchUrl(u)`, `through [web.linkedinEnrichment]`). A member call is an ordinary plugin call: it binds by position as above, and the plugin is invoked by its catalog key with the named config. The platform's catalog lists two: `@lf/web` and `@lf/pdf` (`pdf.render(text)`). A package's plugin is keyed by module and name (`@lf/pdf/render`, `@lf/web/render`), so two modules can each serve a `render`; the spec's `name` is what a program writes. A bare import (`import { fetch_url } from plugins`, as the older language wrote it) finds the one plugin of that name, and is refused, naming the packages, when several have it. The key is compared, never parsed. `name` is optional and additive, so the version stays 1. The member is optional and additive, both readers carry it, so the version stays 1.

```ts
type PluginOutput =
  | { kind: 'value'; type: SchemaFieldType }
  | { kind: 'record'; fields: Record<string, SchemaFieldType> }
  | { kind: 'records'; fields: Record<string, SchemaFieldType> };

type SchemaFieldType =
  | 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'file' | 'json' | 'absent'
  | { kind: 'list'; of: SchemaFieldType; unordered?: true }
  | { kind: 'tuple'; of: Array<SchemaFieldType | null> }
  | { kind: 'dict'; of: SchemaFieldType }
  | { kind: 'enum'; options: string[]; open?: { allowPattern?: string } }
  | { kind: 'owned'; name: string; owner: string; allowPattern?: string; format?: 'cron' | 'timeZone' }   // a named scalar its owner (the adapter) parses: a cron schedule; `format`, a format the checker validates a literal by, whatever the name
  | { kind: 'maybeAbsent'; of: SchemaFieldType }
  | { kind: 'record'; position: { kind: 'position'; position: string } | { kind: 'union'; union: string } };   // a record held as the value, of a position of this instance: read on with `.`, never fetched

interface InstanceSchema {
  positions: Record<string, PositionSchema>;
  collections: Record<string, CollectionSchema>;   // the instance's own edges, one per entry point that is readable, writable or listenable
  unions?: Record<string, string[]>;
  unionDisplayNames?: Record<string, string>;
  writableRoots: Record<string, WritableRootSchema>;
  createShapes?: Record<string, WritableRootSchema>;
  supportsInPlaceUpdate?: boolean;
  edgesCarryProperties?: boolean;
  refinements?: Record<string, string>;
  selectedMembers?: Record<string, string>;
  narrowBy?: Record<string, string[]>;
  unselected?: Record<string, string[]>;
  genericLandings?: Record<string, string>;
}

interface PositionSchema {
  properties: Record<string, SchemaFieldType>;
  edges: Record<string, EdgeSchema>;
  displayName?: string;
  propertyCapabilities?: Record<string, FieldCapability>;
  openProperties?: boolean;
  undescribed?: boolean;
  pending?: boolean;
  writeOnlyProperties?: string[];
  ambiguousProperties?: string[];
  pinnedProperties?: string[];                    // fields a read's WHERE must pin with == (arguments of the read); a read without them is MOV_HOP_PIN_REQUIRED
  deletable?: boolean;                            // the system removes a record of this type; a `delete` of a type without it is refused
  description?: string;                           // the adapter's words for the type (its describe's, else its entry point's, `description`); shown, never checked
  fieldDocs?: Record<string, string>;             // the adapter's words for each field it described, readable or write-only, by name
  fieldIds?: Record<string, string>;              // the id its module keys each readable field by, by name, only where the two differ: a host reads an arrival's fields by name before judging it
  changedFields?: Record<string, { release: string; note: string }>; // the fields whose meaning their module changed in a release: a check for an upgrade from before it warns (MOV_FIELD_MEANING_CHANGED) where a program reads one
}

interface WritableRootSchema {
  fields: Record<string, SchemaFieldType>;
  resultShape: Record<string, SchemaFieldType>;
  discriminated?: { discriminant: string; variants: Record<string, WritableRootSchema> };
  writeUnion?: { variants: Array<{ name: string; fields: string[] }> };
  position?: string;
  nativeUniqueness?: string[][];
  requiredEdges?: Array<{ edge: string; from: string }>;
  edges?: Record<string, EdgeSchema>;
  requiredFields?: string[];
  fieldDocs?: Record<string, string>;             // the writable fields' words only; the position's `fieldDocs` holds every field's
  fuzzyResolution?: true | string[];
  uniquenessAuthorable?: boolean;
}

interface CollectionSchema extends EdgeListening {
  target: string;
  capability?: EdgeCapability;
  readable?: false;                               // absent: it can be listed; `false`: it is only written to or listened to
  listenable?: true;                              // as on an edge: a listen can start here (`cron-[t:Ticks WHERE …]->`)
  cursor?: boolean;
  identity?: string;
  version?: string;
}

interface EdgeListening {                         // what an edge or a root collection says about being listened to; every number is a default lf.yaml overrides
  bounded?: boolean;                              // absent: bounded; `false`: it spans more than a listen should range over, narrowed only by `boundedBy`
  boundedBy?: string[];                           // the landing's fields whose `==` or `IN [literals]` bound an unbounded edge
  delivery?: 'connection' | 'scope' | 'polled';   // how arrivals reach the host: pushed to the connection, pushed per scope (a table), or polled
  pollEverySeconds?: number;                      // a polled edge's interval; lf.yaml's `pollEvery` overrides it per connection
  carries?: string[];                             // the earlier hops' edges whose records an arrival carries, outermost first
  scopedBy?: string;                              // with `delivery: scope`: the earlier hop whose records it is subscribed per, not the record it hangs off (Airtable's `Changes`: `Bases`)
  attributes?: boolean;                           // an arrival names the record it is about
  addressed?: boolean;                            // each arrival is sent to an address its sender chose (an inbox's plus-suffix): one no listen takes is said at the default log level
  membersChange?: 'pushed' | { relistEverySeconds: number }; // how a listen learns its members changed, so a filter on it as an earlier hop is re-resolved: 'pushed', the module reports each creation, rename and removal (re-resolved on the report, never on a clock); else re-listed every so many seconds (lf.yaml's `resolveEvery` overrides it)
}

interface EdgeSchema extends EdgeListening {
  target: string;
  polymorphic?: boolean;
  required?: boolean;
  capability?: EdgeCapability;
  sequenced?: 'chronological' | 'document' | 'arrival';
  ephemeral?: boolean;
  readable?: boolean;
  writable?: boolean;
  linkable?: boolean;
  requiresLiveRecord?: boolean;
  subject?: boolean;
  listenable?: boolean;                           // the module announces arrivals on the edge: it can be listened to and awaited
  cursor?: boolean;                               // the module can list the arrivals since a mark it hands out
  identity?: string;                              // the landing's field that names an arrival
  version?: string;                               // the landing's field that changes when an arrival changes
  genericOver?: { field: string; onNonLiteral?: 'error' | 'warn' };
  literalsFrom?: { at: string[]; from: string }[]; // fields of the landing (`at`, by edge names then the field) typed by the text literals the write wrote at `from` (`Buttons[].Value`)
  answerShapeFrom?: string;                       // the write's field naming a node declared in the program (`Fields: Refund`): the landing has that node's fields too
  resources?: true;                               // the system's resources edge (the describe's reserved `_resources` reference): walked by its name, sent to the adapter by the reserved field id
  description?: string;                           // the adapter's words for the edge (its reference's `description`); shown, never checked
}

interface EdgeCapability {
  filter?: 'bounded' | 'native';
  order?: 'bounded' | 'native';
  supportsLimit: boolean;
  naturalOrder?: NaturalOrder;
}

interface NaturalOrder {
  field: string;
  direction: 'asc' | 'desc';
}

interface FieldCapability {
  filterOperators?: Array<'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'in' | 'within' | 'containsAny'>;
  orderable?: boolean;
}
```

`EdgeSchema` is the catalog's (`packages/movement-lang/catalog/types.ts`); `EdgeCapability`, `NaturalOrder` and `FieldCapability` are shared with the expression layer (`packages/movement-lang/expression/types.ts`). A test holds the member names and optional marks of every interface on this page to those sources. A schema's field types are `SchemaFieldType` only: the Rust reader refuses a field typed with what only the checker's typing builds (a record, a union).

**The `file` type is the envelope that makes a value a file.** Both engines read a position's property types (`PositionSchema.properties`, the read wrapper's natural type) and a plugin output's field types (`PluginOutput`), and make a file of each value at a `file` position — `file` itself, a list's or a dict's members of that type, a tuple's slots, a maybe-absent one — where the value spells a file's descriptor (`engine-contracts` `fileDescriptorOf`). A value at any other type is data, whatever keys it carries; a value at a `file` type that spells no descriptor stays data too. No reader classifies a value by its keys.

## Changes

- **Version 3, with 0.13's listen:** the settings listen (`listen to x { … }`) is retired, and with it what said what it could hear.
  - An `AdapterSpec` loses `triggerConfig?`, `triggerConfigOptions?`, `defaultEvents?`, `triggerConfigRequired?`, `triggerConfigRequiredWhy?` and `triggerConfigFormats?`.
  - An `InstanceSchema` loses `eventPosition?`, `eventPositions?`, `eventNarrowingKeys?` and `eventNarrowingValues?`.
  - Every listen is a traversal now, onto an edge or a root collection that declares `listenable`.
  - A position gains `fieldIds?` (the id its module keys each readable field by, where it differs from the name: a host reads an arrival's records by name before judging them) and `changedFields?` (a field whose meaning its module changed in a release, with the note a check for an upgrade from before it warns with, `MOV_FIELD_MEANING_CHANGED`). An `owned` field type gains `format?` (`cron` or `timeZone`), which alone chooses the checker's validation of its literals.
  - `EdgeListening`'s `membersChange?` (`"pushed"` or `{ relistEverySeconds }`) takes the place of `cheapToList?`, `parentChanges?` and `relistEverySeconds?`, which no release carried.
  - A `listenSettingsBecome` mapping gains `changed?` (where its rewrite hears otherwise than the settings listen did: the note, and the rewrite applied only under `--all`) and `alsoArrivesOn?` (other paths its events arrive on: no rewrite); a key's `values` entry may be a boolean, or `null` for a value that narrowed nothing.
  - All are optional, and both readers carry them. A host that caches a catalog keys it by the release that built it: a version 3 catalog built before `fieldIds` maps no field, and a listen reading a field its module keys by another id never fires until it is rebuilt.
  - Members were removed, so the version moves to 3. Versions 1 and 2 are refused by name, since read as 3 they would lose those members without a word. The Rust reader refuses a snapshot that still carries one, as it refuses any member the TypeScript does not declare.
- **Version 2, with the 0.13 line:** an `EdgeSchema` loses `awaitable?` and `watchable?` and gains `listenable?`, `cursor?`, `identity?` and `version?`.
  - An edge says whether it can be listed (`readable`) and, separately, whether the module announces arrivals on it (`listenable`).
  - `listenable` takes the place of both retired members, which every declarant set together.
  - A member was removed, so the version moves to 2. Version 1 is still read, and deprecated: a version 1 snapshot that carries neither retired member means what it meant.
  - A snapshot of either version that still carries `awaitable` or `watchable` is refused by both readers, rather than read as an edge nothing can listen to.
  - `listen-fire` refuses a module that declares either on a reference, naming `listenable`.
  - An `AdapterSpec` gains `listenSettingsBecome?`: how a module's 0.12 settings listens (`listen to x { … }`) become traversals. It is optional and additive, and both readers carry it. The checker reads it to write the rewrite `MOV_LISTEN_SETTINGS_RETIRED` carries. Each of its keys may say `absent?`, what a listen that left the key out meant (compared on `absentField?` when that is another field than the key's own), and `lowercase?`, that 0.12 compared the key's values lowercased. A mapping may say `byEvent?`: the mapping a listen naming one of those events becomes instead, when a module's events arrive on more than one edge; a listen naming events of two such mappings has no rewrite. A key's `op` may be `neq`. A mapping may say `fieldChange?`: two settings keys (Airtable's `field` and `becomes`) that compare the row a hop's records hold before and after the change.
  - An `EdgeSchema` also gains `literalsFrom?`: fields of the landing typed by the text literals the write wrote at a path. It is optional and additive, and both readers carry it.
  - An `EdgeSchema` also gains `answerShapeFrom?`: the write's field that names a node declared in the program, whose fields the landing then has. It is optional and additive, and both readers carry it.
  - An `EdgeSchema` and a `CollectionSchema` gain what a module declares about listening (`EdgeListening`): `bounded?`, `boundedBy?`, `delivery?`, `pollEverySeconds?`, `carries?`, `scopedBy?`, `attributes?`, `addressed?` and `membersChange?`. A `CollectionSchema` also gains `readable?`, `listenable?`, `cursor?`, `identity?` and `version?`, and an entry point declaring `listenable` publishes a collection whether or not it can be listed: a listen can start at the instance. A collection that cannot be listed now says `readable: false`, where it said nothing. A `SchemaFieldType` gains `owned`, a named scalar its adapter parses, and an `AdapterSpec` gains `resendWindowSeconds?`. All are optional and additive and both readers carry them, so the version stays 2; a Rust reader built before them refuses a snapshot that carries them. The checker reads `bounded`, `boundedBy`, a collection's `readable` and `owned` fields: it refuses a traversal over an unbounded edge without a filter the module takes on a bounding field, a read along a collection that cannot be listed, and a literal its owned scalar's module would refuse. An owned field's `allowPattern` is spelled so on the wire, in both readers. An owned field's `format?` (`cron` or `timeZone`) chooses the checker's validation of a literal; a scalar's name never does.
- **Version 1, with the language versioned by its release** (0.12): a `PluginSpec` loses `earlierOutputs`, the older shapes of a plugin's output under the earlier integer-pinned languages. Its one entry served the earliest of them, which no pin this release reads can reach, and a pin is now a release's version, which an integer `before` cannot name. Neither writer sends it; the Rust reader refuses a snapshot that still carries it. The version stays 1, as the release line it ships in is still a pre-release.
- **Version 1** (the first version on the wire). (This page first omitted five optional `InstanceSchema` members, `genericLandings` and the four `event…` members, and inlined no capability types; they were on the wire all along and are documented now. No version change: the shapes did not change.) The snapshot gains `contractVersion`, which both builders set and both readers check. Everything else is the snapshot as it was before it was versioned, when compatibility rested on optional members alone (`files`, `models`, `schemaNotes`, `constructionArgOptions` and the positioned instance keys were each added that way). A plugin's `argTypes` (each argument's declared input type) was added the same way after versioning, so the version stays 1. Since an earlier release (main's bcd8f67407) a write handle's `resultShape` no longer lists `created` and `committed`: the host leaves them out, and the checker adds them back for a program pinned to the language before that release. A reader that took them from the snapshot reads them from the checker instead; the version stays 1. Since PLAN-07A Task 4d the `file` field type is what makes a field's value a file (above): a descriptor at an untyped or `json` field, read as a file before, is data. No member changed, so the version stays 1. With the 0.12 line a `PositionSchema` gains `deletable?` (the describe's per-type promise that `deleteRecord` removes one) and an `EdgeSchema` gains `resources?` (the system's resources edge, sent to the adapter by its reserved field id). Both are optional and additive, both readers carry them (the Rust reader declares both, so a snapshot carrying them still loads there), and nothing strips them, so the version stays 1. The adapter's own words then ride the snapshot for an editor to show: `description?` on an `AdapterSpec` (the manifest's), a `PositionSchema` (the type's), an `EdgeSchema` (the reference's) and a `PluginSpec` (the signature's), and a `PositionSchema`'s `fieldDocs?` (every described field's, where a `WritableRootSchema`'s holds only the writable ones). No checker reads them except for the words a write-only field's diagnostic quotes; all are optional and additive and both readers declare them, so the version stays 1. A Rust reader built before them refuses a snapshot that carries them. With 0.13 a `PositionSchema` gains `fieldIds?` (each readable field's id in its module's records, by name, where the two differ): a host reads each record an arrival carries by those names before its listens' judge reads it, as a run reads a field through its module. No checker reads it; it is optional and additive and both readers declare it, so the version stays 1. A Rust reader built before it refuses a snapshot that carries it.
