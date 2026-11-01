// The catalog and schema types the contracts and the modules name: what a
// system declares (adapters, credentials, plugins) and what its instances look
// like (schemas, positions, edges). Plain data and the small lookups over it;
// nothing here reads a program or checks one.
//
// `SchemaFieldType` spells the bare field names out. The TypeScript checker's
// own `FieldType` (checker/catalog.ts on the platform) is the same union plus
// the record that carries a checker position; every `SchemaFieldType` is a
// `FieldType`, and the platform's checker asserts it at compile time.

import type { EdgeCapability, EdgeSequencing, Expression, FieldCapability } from '../expression/types';



/**
 * One argument in an adapter's construction signature. The list is the full
 * signature: the credential (when the adapter needs one) is just an entry with
 * `kind: 'credential'`, alongside any entry-position args (`kind: 'position'`).
 * There is no separate credential field — `credentialArgOf` derives it.
 */
export interface ConstructionArg {
  /** The construction-arg name, e.g. `credentials`, `spreadsheet`. */
  name: string;
  /**
   * `credential` = names an imported credential whose `adapter` is this adapter
   * (required unless the adapter works without one: listen-fire's email). `position` = an entry-position arg (e.g. Sheets'
   * `spreadsheet`) that pins where the instance starts.
   */
  kind: 'credential' | 'position';
  /** Whether construction MUST supply it. A credential arg is required unless every credential the
   *  adapter declares is optional (an absent one then instantiates the credential-free schema);
   *  position args are optional today. */
  required: boolean;
  /**
   * Position args only: the collection/type whose members are the value enum
   * (Sheets: `Spreadsheet`). The author enumerates it via describeConnection.
   */
  optionsFromType?: string;
  /** Author-facing label (defaults to `name`). */
  label?: string;
}


export interface AdapterSpec {
  /**
   * The adapter's full construction signature — the credential (if any) folded
   * in as a `kind: 'credential'` entry, plus every entry-position arg.
   */
  constructionArgs: ConstructionArg[];
  /**
   * The credentials a module declares it needs, by name (its manifest's
   * `credentials`). A connection's credential that fills one of a module's
   * declared credentials must fill one of THESE: a credential made for a
   * declaration the module does not have would be sent where it means
   * nothing. Absent ⇒ the adapter declares none by name (a built-in), and
   * only the credential's adapter is checked.
   */
  declaredCredentials?: string[];
  /**
   * Whether this adapter declares ANY trigger surface at all — projected from
   * the manifest's `supportedTriggers`, which is a construction-free fact: it
   * needs no credential, no introspection, and no describe() call.
   *
   * EXPLICIT, like `writable` (layer 13): only `true` projects, and its absence
   * on a spec the catalog KNOWS is the positive fact "this system cannot fire
   * anything". That distinction is the whole point — an absent SPEC (unknown
   * adapter) stays leniently unchecked, while a present spec without this flag
   * is a definite no. Collapsing the two is what let a Google Sheets listener
   * provision valid and stay silent forever.
   */
  canFire?: boolean;
  /**
   * Interactive "connect" actions the adapter offers when authoring against
   * one of its instances. The checker never reads these — they're carried
   * for the editor/chat suggestion engine, which appends a "+ <label>"
   * entry per action wherever a slot resolves against this adapter's
   * instance, dispatching to an app-shipped handler by `kind`. Projected
   * by the host from the `action` blocks in the adapter manifest's
   * `construction` block list (config-blocks).
   */
  connectActions?: ConnectAction[];
  /**
   * How this adapter is connected, when it needs a credential at all:
   *   - 'oauth'     — a browser sign-in (connectCredential mints a link).
   *   - 'key-entry' — a short form where the user pastes an API key
   *                   (connectCredential mints a link to it).
   *   - 'intrinsic' — part of Listen-Fire itself (e.g. Listen-Fire Valuations);
   *                   connectCredential mints a one-click link — no external
   *                   sign-in and no key to paste, the server provisions it.
   *   - 'handshake' — the link hands the user into the system's own linking
   *                   flow (e.g. Telegram's bot Start step); connectCredential
   *                   mints a link to it.
   *   - 'app-only'  — connected inside the Listen-Fire app; connectCredential
   *                   CANNOT mint a link for it, so don't try.
   * Absent ⇒ the adapter needs no credential (nothing to connect). Lets an
   * author pick the right connect path — or skip a doomed connectCredential —
   * without a failed call. The checker never reads this; it's catalog metadata.
   */
  connect?: 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';
  /**
   * Plain-language truth about what a listener on this adapter fires on
   * (e.g. which Telegram messages actually reach the bot). Catalog metadata
   * for the author — trigger-surface claims ground in this rather than being
   * invented. The checker never reads it.
   */
  triggerExpectation?: string;
  /**
   * 'introspected' = the instance schema comes from live workspace
   * introspection (describing costs upstream API calls — scope requests);
   * 'static' = describing is free. Catalog metadata; the checker never
   * reads it.
   */
  schemaShape?: 'static' | 'introspected';
  /** What the adapter says it is (its manifest's `description`). The checker
   *  never reads it; the language service's hover leads with it. */
  description?: string;
  /**
   * How long, by default, a provider may re-send an arrival it already sent
   * (Stripe: three days): a repeat inside it is dropped by identity. lf.yaml
   * overrides it per connection.
   */
  resendWindowSeconds?: number;
  /** What a 0.12 settings listen on this module becomes as a traversal: the
   *  upgrade's rewrite of `listen to x { … }`. */
  listenSettingsBecome?: SettingsBecome;
}

/**
 * A module's mapping from its 0.12 listen settings to the traversal a listen
 * is in 0.13: the path from the connection to the edge its events arrive on,
 * and the hop and field each settings key narrows.
 */
export interface SettingsBecome {
  /** The edges from the connection's root to the listened edge. */
  path: string[];
  /** One per hop: the alias its rewritten WHERE reads the hop's record by. */
  aliases: string[];
  /** The 0.12 event position a fired parameter was typed as: a parameter
   *  naming it is retyped by the landing. */
  paramFrom?: string;
  /** Each settings key, by name. */
  keys: Record<string, KeyBecomes>;
  /** The mapping a listen naming one of these events in `events` becomes
   *  instead, when the module's events arrive on more than one edge (gmail's
   *  `label_added` lands on `Labelings`, not `Messages`); `events` is then
   *  spent choosing it. A listen naming events of two mappings has no
   *  rewrite: one listen per edge. One level deep. */
  byEvent?: Record<string, Omit<SettingsBecome, 'byEvent'>>;
  /** How the `field` and `becomes` keys of a module whose records hold their
   *  row before and after compare those rows. */
  fieldChange?: FieldChange;
}

/** Two settings keys that compare a record's row before and after on one
 *  hop (Airtable's `{ field: "Stage", becomes: "Interview" }`): the field
 *  alone changed; with a value, it came to hold it (`exists(c.Current) AND
 *  c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR
 *  c.Previous.Stage != "Interview")`), each row tested present before a
 *  field is read through it. A value with no field compares nothing. The
 *  field is the row's own, by name. */
export interface FieldChange {
  /** The index into `path` of the hop whose records hold the rows. */
  hop: number;
  /** The settings key naming the field. */
  field: string;
  /** The settings key naming the value the field came to hold. */
  becomes: string;
  /** The record's field holding the row as the change left it. */
  current: string;
  /** The record's field holding the row as it was before. */
  previous: string;
}

/** What one settings key becomes: a comparison on a hop's field (`eq`, `neq`,
 *  `in`, `contains`: a member of a list field, several values an OR of
 *  them), or the landing's declared type (`type`, `payload: <T>`). */
export interface KeyBecomes {
  /** The index into `path` of the hop it narrows. */
  hop: number;
  /** The field it compares (absent for `type`). */
  field?: string;
  op: KeyOp;
  /** A settings value's spelling as a field value (`"record.created"` →
   *  `"created"`, or Slack's `"app_mention"` → `true` on a flag); absent, a
   *  value is the field's as written. */
  values?: Record<string, string | boolean>;
  /** What a 0.12 listen meant by leaving the key out, as a settings value
   *  (`""`: mail sent to the box itself; a list: the events it heard). The
   *  rewrite of a listen that omits the key compares it, so the traversal
   *  hears what the listen heard. Absent, omitting the key narrowed nothing. */
  absent?: string | string[];
  /** The field `absent` is compared on, when leaving the key out meant
   *  something about another field than the key's own (gmail's `labels` left
   *  out of a `label_added` listen meant its own labels: `Label Type == "user"`). */
  absentField?: string;
  /** 0.12 compared this key's values lowercased: the rewrite writes them
   *  lowercased, so `{ key: "Deals" }` still hears what it heard. */
  lowercase?: boolean;
}

export type KeyOp = 'eq' | 'neq' | 'in' | 'contains' | 'type';

/**
 * The credential arg in a construction signature, if the adapter needs one.
 * Replaces the old dedicated `credentialArg` field — the credential is just the
 * `kind: 'credential'` entry, so every consumer derives it the same way.
 */
export function credentialArgOf(
  spec: Pick<AdapterSpec, 'constructionArgs'>,
): ConstructionArg | undefined {
  return spec.constructionArgs.find((a) => a.kind === 'credential');
}


/**
 * The ENTRY POSITION a construction pins, as an opaque key.
 *
 * An instance's schema belongs to (adapter, credential, position): the
 * `kind: 'position'` args pick which node the cursor starts at, and a Sheets
 * instance started at one spreadsheet has different leaves than one started at
 * another. Anything that stores or looks up a schema needs all three.
 *
 * Only the spec's DECLARED position args count. The credential is already the
 * other half of the key, and an arg the adapter never declared a position does
 * not move the cursor — letting either in would fork one instance's schema into
 * several that describe the same node.
 *
 * The key is derived, sorted and COMPARED — never parsed. That is what keeps it
 * an identity rather than a fabricated name: two sides that derive it the same
 * way cannot disagree, and no value inside it can collide with another.
 * `''` means the meta position (the node you get when you pin nothing).
 */
export function entryPositionKeyOf(
  spec: Pick<AdapterSpec, 'constructionArgs'>,
  args: Record<string, string> | undefined,
): string {
  const values: [string, string][] = [];
  for (const arg of spec.constructionArgs) {
    if (arg.kind !== 'position') continue;
    const raw = args?.[arg.name];
    if (raw === undefined || raw.trim() === '') continue;
    values.push([arg.name, unquoteConstructionArg(raw)]);
  }
  values.sort(([a], [b]) => a.localeCompare(b));
  return values.length ? JSON.stringify(values) : '';
}


/**
 * A position arg's value as AUTHORED is raw source (`"LP Commitments"`, quotes
 * included). The key is the VALUE, not its spelling — the host resolves the
 * unquoted string against the real service, so a key built from the quoted form
 * would never match the one built from the resolved form.
 */
function unquoteConstructionArg(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}


export interface CredentialSpec {
  /** The adapters this credential can authenticate — `slack(credentials: <attio cred>)`
   *  is a type error unless 'slack' is in this set. A credential *type* may serve
   *  several adapters (e.g. a Google credential serves sheets + drive). */
  adapters: string[];
  /** The module credential this one fills (a name in its adapter's
   *  `declaredCredentials`). Absent ⇒ not a module's declared credential. */
  credential?: string;
}


/**
 * A PLUGIN is a function whose body isn't visible — it lives in the transform
 * registry, not in the program. Under the one-function-sort ruling that is the
 * ONLY thing separating it from a movement, so what it needs is the one fact
 * the checker would otherwise infer by walking a body: its effect row.
 *
 * The row is DECLARED beside the arguments, in the registry entry, because that
 * is where the plugin's surface already is — the same place its parameter names
 * are written, checked by the same lockstep test that keeps manifests and
 * implementations from drifting.
 *
 * An UNDECLARED row (`effects` absent) is not "does nothing": it is nobody
 * having said. That keeps the plugin legal exactly where it is legal today —
 * inside an extract's `through [ … ]`, where the pipeline bounds what a stage
 * can reach — and refuses it anywhere else, since a call the checker cannot
 * describe has no business being folded into a movement's row.
 *
 */
export interface PluginSpec {
  /** Named arguments the plugin accepts. */
  args: string[];
  /**
   * Whether invoking it may cost money (a paid scrape, a paid search, priced
   * work of its own). The engine refuses to start a priced plugin once the
   * run has spent its cost cap; an unpriced one runs regardless.
   */
  priced: boolean;
  /**
   * What each argument takes, by name — the plugin's declared input types. A
   * call is checked against them as a movement's arguments are against its
   * parameters: a record handed to an argument that takes text is refused
   * where it is written, and an argument declared to take structured data
   * (`json`) is handed a record's fields. Absent for an argument nobody typed.
   */
  argTypes?: Record<string, SchemaFieldType>;
  /**
   * Arguments (⊆ `args`) a call MUST supply: a call missing one is
   * MOV_THROUGH_ARG_MISSING.
   *
   * This is an AUTHORING gate, not a runtime one, and the two stay
   * deliberately different: the engine's skip-on-absent sentinel covers a
   * required argument that resolves absent at run time (a record whose
   * source field came back empty — legitimate, so the stage quietly does
   * nothing that firing). It was never meant to cover an argument the
   * author never wrote at all, which is what this catches instead — at
   * check time, once, rather than as a stage that silently never fires.
   *
   * An `auto` param (engine-injected, never in `args`) can never appear
   * here either — there is nothing for an author to omit.
   */
  requiredArgs?: string[];
  /** What running it may do. Absent ⇒ nobody declared, and it stays a
   *  through-stage-only name. */
  effects?: DeclaredEffectRow;
  /**
   * The EXTRACTION supplies what this plugin runs on — an engine-injected
   * parameter (the `from [ … ]` text), or a body that reads the fields the
   * enclosing extract has produced so far. Such a plugin has no inputs of its
   * own, so an ordinary call could only pass it nothing; it is a stage, and a
   * call anywhere else is refused with the stage to write it in.
   *
   * A fact about the plugin's own signature, derived where the signature is —
   * not a second declaration an author could get out of step with the first.
   *
   * Narrow on purpose: it means the extraction is the plugin's ONLY way in. A
   * plugin whose engine-injected parameter an ordinary call could write itself
   * is `fedArgs`, not this — that one is callable, it just has to be handed
   * what the stage would have handed it.
   */
  fedByExtraction?: boolean;
  /**
   * Arguments the EXTRACTION fills inside a `through [ … ]` stage — the engine
   * feeds them from the `from [ … ]` source, which is why a stage never writes
   * one and `args` deliberately excludes them.
   *
   * A PLAIN call has no extraction behind it, so it writes them itself: they
   * are accepted there, and a required one omitted is
   * MOV_PLUGIN_FED_BY_EXTRACTION naming the argument. The same parameter, two
   * ways of being filled — not two parameters.
   */
  fedArgs?: PluginFedArg[];
  /**
   * What a plain call HANDS BACK. Absent ⇒ nobody declared, and a plain call
   * is refused (MOV_PLUGIN_OUTPUT_UNDECLARED): a value nothing describes would
   * type as unknown everywhere it flowed, which is the silence this checker
   * exists to refuse. A `through [ … ]` stage is unaffected — a stage's output
   * goes to the extractor, not to a name.
   */
  output?: PluginOutput;
  /** The package tag it is a member of (`@lf/web`), matched exactly
   *  (`packageMembers`); absent when it is in none. */
  package?: string;
  /**
   * The name a program spells it (`fetch_url`), when the catalog's key is not
   * that: a plugin in a package is keyed by package AND name (`pluginKey`), so
   * two packages can each serve a `render`. Absent: the key is the name.
   */
  name?: string;
  /** What it does, in its author's words (its signature's `description`). */
  description?: string;
}


/** One `fedArgs` entry: the argument's name, and whether a PLAIN call must
 *  write it (a stage never does either way). */
export interface PluginFedArg {
  name: string;
  required?: true;
}


// ── A plugin's arguments by position (design §2.7) ──
//
// Its required inputs in the manifest's declared order, then one optional
// settings record `{ name: value }` for the rest. Binding turns that call into
// the named arguments the older language writes, so every check and the wire to the
// plugin read one form. The Rust twin is `PluginSpec::bind_args`
// (crates/movement-parser/src/catalog/plugin_args.rs); both checkers and both
// engines bind through these two and nothing else.

// ── A plugin package (design §2.10, §4.3) ──
//
// A tag a plugin's spec declares as its `package`, matched exactly and never
// parsed. ``import { `@lf/web` as web } from plugins`` binds each member under
// the dotted local name `web.fetchUrl`, so a call of it is an ordinary plugin
// call. The Rust twin is crates/movement-parser/src/catalog/packages.rs.

/** The catalog key of a package's plugin: module and name together, so two
 *  packages can each serve a plugin of the same name. Compared, never parsed
 *  (a spec carries its own `name`). The Rust twin is `plugin_key`. */
export function pluginKey(packageTag: string, name: string): string {
  return `${packageTag}/${name}`;
}


/** A plugin as a program writes it: its key's own name unless the spec says. */
export function pluginProgramNameOf(key: string, spec: PluginSpec): string {
  return spec.name ?? key;
}


/** What a written plugin name stands for among `plugins`: the entry keyed by
 *  exactly that (a package member's key), else the one entry whose name it is
 *  (a bare import, as the older language writes it); several such are `ambiguous`,
 *  listing the packages that serve it. The Rust twin is `find_plugin`. */
export function findPlugin(
  plugins: Readonly<Record<string, PluginSpec>>,
  name: string,
): { found: { key: string; spec: PluginSpec } } | { ambiguous: string[] } | undefined {
  const exact = Object.hasOwn(plugins, name) ? plugins[name] : undefined;
  if (exact !== undefined) return { found: { key: name, spec: exact } };
  const named = Object.entries(plugins).filter(([key, spec]) => pluginProgramNameOf(key, spec) === name);
  if (named.length === 1) return { found: { key: named[0][0], spec: named[0][1] } };
  if (named.length > 1) return { ambiguous: named.map(([, spec]) => spec.package ?? '(no package)') };
  return undefined;
}


/**
 * What a plugin's plain call evaluates to, on whichever PLANE it lives — the
 * same two planes every other bound value has, and no third type language:
 *
 *   - `value`   — one value on the dot plane, an ordinary `FieldType`. Absence
 *                 is spelled the way absence is spelled everywhere else, with
 *                 `maybeAbsent`;
 *   - `record`  — several values read by name, which is a node on the arrow
 *                 plane: the checker mints a LOCAL node whose reads are these
 *                 fields, exactly as `callback(…)` and a node literal do;
 *   - `records` — zero or more of those nodes, one per thing the plugin found.
 *                 The value is a list of records, typed exactly as a hop's
 *                 landings are, so `FIRST(pages).text` and `MAP` read it the
 *                 way they read any other list of records.
 */
export type PluginOutput =
  | { kind: 'value'; type: SchemaFieldType }
  | { kind: 'record'; fields: Record<string, SchemaFieldType> }
  | { kind: 'records'; fields: Record<string, SchemaFieldType> };


// ── Per-instance schema ──

/** How a listenable edge's arrivals reach the host: pushed to the
 *  connection (one subscription serves every listen on it), pushed per scope
 *  (one per watched parent, a table), or polled. */
export type Delivery = 'connection' | 'scope' | 'polled';

/**
 * What an edge, or a root collection, says about being listened to and about
 * being listed under a listen. Each member is present only when the module
 * declared it. Every number is a default the operator's lf.yaml overrides.
 */
export interface EdgeListening {
  /**
   * Absent means bounded: the edge holds what one record has. `false`: it
   * spans more than any listen should range over (every schedule, every
   * team's mail), and only a filter on `boundedBy` narrows it.
   */
  bounded?: boolean;
  /** The landing's fields whose `==` or `IN [literals]` make an unbounded
   *  edge bounded. */
  boundedBy?: string[];
  delivery?: Delivery;
  /** How often a polled edge is polled, by default (lf.yaml's `pollEvery`
   *  overrides it per connection). */
  pollEverySeconds?: number;
  /** The earlier hops' edges whose records an arrival carries, outermost
   *  first: a filter on one of them is judged on the arrival. */
  carries?: string[];
  /** An edge delivered per scope whose subscription is made per record an
   *  earlier hop, this edge named, landed on, not per record it hangs off
   *  (Airtable's `Changes`, one data webhook per base: `Bases`). Each arrival
   *  still names the record it is under, and a listen keeps only those under
   *  its own. */
  scopedBy?: string;
  /** An arrival names the record it is about. */
  attributes?: boolean;
  /** Each arrival is sent to an address its sender chose (mail's plus-suffix),
   *  so one that no listen's WHERE takes is a misdirected message the host
   *  says so at its default level; on any other edge that is said only under
   *  `LF_LOG=debug`. */
  addressed?: boolean;
  /** Listing it is cheap enough to re-list on a schedule (a base's tables;
   *  never every message in a workspace), so a filter on it as an earlier
   *  hop can be re-resolved. */
  cheapToList?: boolean;
  /** The module reports when one of its members is created, renamed or
   *  removed, so a listen re-resolves on the report and never on a clock. */
  parentChanges?: 'pushed';
  /** How often, in seconds, its members are re-listed by default when the
   *  module does not report their changes (lf.yaml's `resolveEvery`
   *  overrides it). */
  relistEverySeconds?: number;
}

/** A reference (edge) declared by a position type. */
export interface EdgeSchema extends EdgeListening {
  /** The position type (or union) the edge points at. */
  target: string;
  /**
   * A polymorphic edge's concrete target varies per record; a linked write
   * through it must name the type explicitly (`write x-[:related]->company`).
   */
  polymorphic?: boolean;
  /**
   * The DECLARING type cannot exist without this edge — a required
   * FK/reference field IS a required edge (the projection rule). Surfaced
   * for hover/agent display; the checker's create gate reads the written
   * type's `WritableRootSchema.requiredEdges`.
   */
  required?: boolean;
  /**
   * Whether — and how — filter / order / limit push across this edge
   * (adapter-capability-contract chunk 4). The gate (chunk 6) combines this
   * with the TARGET position's per-property `propertyCapabilities`: a `native`
   * edge offers the target's filterable fields; a `bounded` edge offers all of
   * them (the adapter runs the shared filter unit). Absent ⇒ unknown ⇒ gating
   * degrades to silent best-effort, exactly like an absent schema.
   */
  capability?: EdgeCapability;
  /**
   * What this edge's members are inherently ordered BY, when they are ordered
   * at all. Absent ⇒ unordered, the safe default.
   *
   * NOT `capability.order`, which is about PUSHDOWN — whether an authored
   * ORDER BY reaches the source. This is about what the author gets without
   * asking. An edge can be one without the other in either direction.
   *
   * Carried for the set/list split (core-calculus v2 R2/R4): a sequenced edge
   * yields a list, an unsequenced one a set. Nothing reads it yet — the split's
   * checker lands separately.
   */
  sequenced?: EdgeSequencing;
  /**
   * Writing along this edge performs an ACTION, not a record write
   * (message-write-unification §4.2 resolved: WhatsApp's typing indicator).
   * Still gated by `writable`; the one extra rule is that the write's
   * result cannot be BOUND — nothing materialises to hold a handle to.
   */
  ephemeral?: boolean;
  /**
   * Whether traversing this edge READS anything. Absent ⇒ true. `false`
   * marks a WRITE-ONLY edge — a pure create path with no read API behind it
   * (WhatsApp's `replies`; traversal would silently yield nothing) — and
   * the checker rejects read traversal (MOV_WRITE_ONLY_EDGE). Writes along
   * the edge are unaffected.
   */
  readable?: boolean;
  /**
   * THE write promise for this edge, and it is EXPLICIT.
   * **Absent ⇒ READ-ONLY** — the checker rejects `write …-[:edge]->` /
   * `link …-[:edge]->` (MOV_READ_ONLY_EDGE). `true` ⇒ a linked write may
   * create the target along this edge, or link an existing one.
   *
   * This ONE flag consumed the retired `creatable`: there is no default-true
   * link promise and no separate create fact, because an absent flag must
   * never become an affirmative claim. The two halves of the promise are
   * separable, and `linkable` is where an adapter withdraws the second.
   *
   */
  writable?: boolean;
  /**
   * Whether two records that ALREADY EXIST can be joined along this edge
   * (`link a -[:e]-> b`, and its inverse `unlink`).
   *
   * **Absent ⇒ the `writable` promise covers link too** — that is what the
   * promise says. `false` WITHDRAWS the second half: the edge creates its
   * target and cannot join one that is already there, so a `link` along it is
   * refused (MOV_LINK_UNSUPPORTED_EDGE) instead of failing at run time.
   *
   * Only the source system can say this, and it says it per EDGE: Affinity's
   * list membership is made by adding a company to a list, and there is no way
   * to point an entry that already exists at a different one.
   */
  linkable?: boolean;
  /**
   * Traversing this edge needs the record at its far end to still EXIST
   * (the adapter hydrates it by fetch). Projected from the adapter
   * descriptor's same-named reference fact. An event position whose address
   * pins `action` to the deleted kind (`RECORD_DELETED_ACTION`) drops these
   * edges — the record is gone, so the traversal would return nothing, and
   * the constraint is stated at check time instead.
   */
  requiresLiveRecord?: boolean;
  /**
   * This edge leads from an EVENT to the record the event is ABOUT. Declared by
   * the adapter (never inferred from the edge's name, which is a display name
   * an adapter may spell as it likes); only ever compared here.
   *
   * A listen's `fields:` filter names properties of the RECORD, so the checker
   * validates those names one hop along this edge. An event position with no
   * subject edge keeps the plainer reading — the names belong to the position
   * the listen lands on, which is right for an adapter whose listen fires the
   * record itself.
   *
   */
  subject?: boolean;
  /**
   * The module ANNOUNCES ARRIVALS on this edge, so it can be listened to and
   * awaited (`await …-[:edge]->` parks until an arrival wakes it). Separate
   * from whether the edge can be LISTED, which is `readable`: an edge may be
   * one, the other, or both. An email's `Replies` is both; a table's `Changes`
   * only announces. Absent ⇒ nothing is announced, and `await`-ing the edge is
   * refused.
   */
  listenable?: boolean;
  /**
   * Whether the module can list the arrivals since a mark it hands out. Without
   * one, an arrival announced while nobody was listening is lost.
   */
  cursor?: boolean;
  /** The landing's field that names an arrival, so a repeat is dropped. */
  identity?: string;
  /**
   * The landing's field that changes when an arrival changes. Without one,
   * only a new member counts as an arrival; a change that makes an existing
   * member match is not seen.
   */
  version?: string;
  /**
   * This edge's LANDING TYPE is generic over the CONSTRUCTION SITE: the literal
   * value(s) the write body gives `field` fix the landing's shape. An ask's
   * `Response` is generic over the `Options` it offered (`Choose` answers an
   * enum of exactly those) and over `Answer Type` (`Provide` answers the scalar
   * it named).
   *
   * DECLARATIVE, like `discriminated`: the adapter says WHICH body field
   * parameterizes the landing, so the checker never has to know a field by
   * name. What the literals MEAN is the host's synthesis; the checker looks the
   * result up under `genericLandingKey` and retargets. Absent ⇒ the landing is
   * the same type for every construction, which is the ordinary case.
   *
   * `onNonLiteral` says what a COMPUTED value for that field means, and the
   * three states are three different facts:
   *
   *  - `'error'` mirrors a runtime precondition the adapter already enforces (an
   *    ask's `Answer Type` must be one of a closed set, so a create cannot
   *    discover it at run time) — the `WRITE_DISCRIMINANT_NOT_LITERAL` shape;
   *  - `'warn'` is legitimate at run time but COSTS the author the type (a
   *    `Form` built from computed field names answers one opaque value instead
   *    of one property per name) — a warning, because losing a guarantee in
   *    silence is losing it twice;
   *  - absent is the ordinary "I can't see it, and nothing was promised" case
   *    (an ask's `Options`): the base type, said nothing about.
   */
  genericOver?: { field: string; onNonLiteral?: 'error' | 'warn' };
  /**
   * Fields of what lands on this edge that take the literals the write it
   * hangs off wrote at a path: `{ at: ['Actions', 'Value'], from:
   * 'Buttons[].Value' }` makes the `Value` of each action an answer carries an
   * enum of exactly the `Value`s of the buttons written. `at` walks from the
   * landing by edge names and ends at the field; `from` is the write's field,
   * `[]` going into each entry of a list and `.` into a field of an entry. A
   * value there that is not a text literal leaves the field its declared type,
   * with a warning (MOV_WRITE_GENERIC_UNTYPED).
   */
  literalsFrom?: { at: string[]; from: string }[];
  /**
   * The field of the write this edge hangs off that names a node declared in
   * the program (`Fields: Refund`): what lands here has that node's fields
   * too, typed as the node declares them. The field's value reaches the
   * module as the node's fields (`{ fields: { <name>: <field type> } }`).
   * A value there that is not a node is MOV_ANSWER_SHAPE.
   */
  answerShapeFrom?: string;
  /**
   * The edge is the one the system declared as its records' resources (the
   * describe's reserved `_resources` reference — the knowledge graph's
   * `Resources`). An ordinary edge, walked by its name like any other; what
   * the flag records is that an older `x-[f:_resources]->` on this
   * system read it, so MOV_RESOURCES_NOT_EXTRACTED can name it. Diagnostics
   * only: nothing resolves `_resources` to it.
   */
  resources?: true;
  /** What the adapter says the edge is (a reference's `description`). The
   *  checker never reads it; the language service's hover leads with it. */
  description?: string;
}


/** A readable position type: its properties and outgoing references. */
export interface PositionSchema {
  properties: Record<string, SchemaFieldType>;
  edges: Record<string, EdgeSchema>;
  /**
   * Author-facing text for a position whose KEY is not author-facing — a
   * grafted event address (`eventAddressKey`) and the table it narrows to.
   * Diagnostics render this; nothing else may read it.
   *
   * It exists so identity can be an opaque key rather than a fabricated name.
   * One string doing both jobs is the magic-naming bug: `refinements.ts` keys
   * on `Table "Deals"`, so two bases each with a `Deals` collide and the second
   * is silently discarded. A key that is only COMPARED cannot collide; a
   * display that is only SHOWN is allowed to.
   *
   * Absent ⇒ the key IS the name (every ordinary position: `Deals`, `message`).
   *
   */
  displayName?: string;
  /**
   * What the source can do with each property server-side — the operators it
   * can filter by, whether it can order by it (adapter-capability-contract
   * chunk 4). Read by the gate (chunk 6) when a hop into this position filters
   * / orders over a `native` edge. Keyed by property name (matching
   * `properties`). Absent for a property ⇒ unknown ⇒ silent best-effort.
   */
  propertyCapabilities?: Record<string, FieldCapability>;
  /**
   * The honesty valve for property-existence checking. By DEFAULT a typed
   * position is CLOSED: reading a property it does not declare is
   * MOV_UNKNOWN_PROPERTY (the projection is expected to enumerate the
   * surface fully). A projection that genuinely cannot enumerate a
   * position's properties — a raw webhook payload, an unstable event bag —
   * marks it `openProperties: true`, and unknown reads stay silent for
   * that position only. Open is a property of the POSITION, not the
   * instance: declare it where the under-description actually is.
   *
   * `openProperties` is a POSITIVE claim — "the surface is genuinely wider than
   * what's enumerated". It is NOT the same fact as `undescribed` below, and
   * conflating the two is a measured bug; see there.
   */
  openProperties?: boolean;
  /**
   * NOBODY HAS LOOKED at this position. No descriptor came back for it — a
   * demand-scoped describe that never fetched the type, an adapter that cannot
   * answer the name, an address that landed nowhere (`never`).
   *
   * DISTINCT FROM `openProperties`, and that separation is the whole point.
   * "I haven't looked" and "anything goes" are DIFFERENT FACTS, and this
   * projection used to spell both `openProperties: true`. So:
   *
   * ```
   * movement intake(e: <at-[:`Record Change`]->>) {
   *   e-[r:record]-> { … r.`Name` … }     # NO diagnostics. null at runtime.
   * }
   * ```
   *
   * `r` targets the meta type `Table` — undescribed in that demand scope, hence
   * OPEN, hence accepting ANY field name. The open-projection rule has a real
   * reason (a scoped describe must not false-positive on types it hasn't
   * fetched) but it cannot serve both facts at once: one of them means "stay
   * silent", the other means "you are guessing".
   *
   * So an undescribed position is the ABSENCE of a claim, and touching the
   * handle is `MOV_UNDESCRIBED_POSITION` rather than an open door — the
   * rule for a `never`: don't error at the narrow, error at the USE.
   *
   */
  undescribed?: boolean;
  /**
   * NOBODY HAS LOOKED **YET** — a fetch for this position is in flight, or the
   * host has not started one but will when asked. The answer is coming.
   *
   * The THIRD member of the family `openProperties` and `undescribed` already
   * split, and separated for the same reason: one value must not mean two
   * facts. "I looked and there is nothing" and "I have not looked yet" are
   * different, and only the first licenses a diagnostic.
   *
   * ```
   *  described   → here is the surface           → check against it
   *  open        → genuinely wider than listed   → stay silent
   *  undescribed → looked, nothing there         → error at the USE
   *  pending     → answer in flight              → stay silent, re-check on arrival
   * ```
   *
   * Spelling this `undescribed` — the obvious shortcut, since neither has a
   * surface to check — would make the EDITOR throw a diagnostic on every
   * keystroke until each fetch landed, errors that appear and clear as you
   * type. Spelling it `openProperties` would accept a typo against a type
   * nobody has fetched. Neither existing flag can carry it.
   *
   * Set ONLY by a host that fills positions lazily (the editor's snapshot,
   * where the checker runs synchronously per keystroke over a cache the walk
   * fills). The server-side compile path finishes its demand rounds before it
   * projects, so nothing is ever pending there and this stays absent.
   *
   * It lives HERE, beside the other two, rather than as a host-side set keyed
   * by position name — which is where it was first sketched, on the reasoning
   * that pending is a fact about the cache rather than about the graph. That
   * reasoning is true and still the wrong conclusion: the checker makes ONE
   * decision ("can I check against this position?") at ONE place, and splitting
   * that decision's inputs across two objects is how the two halves drift out
   * of agreement. Colocate the fact with the decision it feeds.
   *
   */
  pending?: boolean;
  /**
   * Fields that exist on this type's WRITE shape only (`readable: false`
   * in the adapter descriptor) — a value you set when writing, never read
   * back (WhatsApp Message's send-side `File`). Deliberately absent from
   * `properties`, listed here so a read gets the pointed
   * MOV_WRITE_ONLY_PROPERTY diagnostic instead of the generic
   * unknown-property one.
   */
  writeOnlyProperties?: string[];
  /**
   * Display names carried by MORE THAN ONE of the source's fields — an Attio
   * object with both a built-in and a custom attribute titled "Name".
   *
   * The name is still in `properties` and still resolves, to the first field
   * the adapter listed. This is the ambiguity itself, not a second type: the
   * projection cannot invent a distinct name for the shadowed field without
   * minting a nominal one (`Name (name_custom)`), which is exactly the magic
   * naming the model forbids — identity is the ADDRESS, display is separate.
   *
   * So the honest thing is to resolve deterministically and TELL the author at
   * the point of use (MOV_AMBIGUOUS_PROPERTY, warning severity — it never
   * gates a compile). Reading is legal; the author just learns their source
   * has two fields wearing one name.
   */
  ambiguousProperties?: string[];
  /**
   * Fields a read of this type must pin in its WHERE with `==` (the adapter
   * descriptor's `pinned: true`): the source takes them as the read's
   * arguments, so a read that leaves one out has nothing to ask
   * (MOV_HOP_PIN_REQUIRED).
   */
  pinnedProperties?: string[];
  /**
   * A record of this type can be DELETED — the system's own promise, declared
   * per type in its describe (`deletable: true`) where its `deleteRecord`
   * removes one. Absent ⇒ it makes no such promise, and `delete x` of this type is MOV_DELETE_NOT_DECLARED (an
   * undescribed or pending position says nothing, so nothing is refused).
   */
  deletable?: boolean;
  /** What the adapter says a record of this type is, in its own words (its
   *  describe's or entry point's `description`). The checker never reads it;
   *  the language service's hover leads with it. */
  description?: string;
  /** What the adapter says each field is, by name — every field it described,
   *  readable or write-only. */
  fieldDocs?: Record<string, string>;
}


/**
 * A DISCRIMINATED write shape — the write-side dual of read narrowing. On the
 * read side a WHERE's literal selects a variant type (`-[:Base WHERE `Name` ==
 * "Dev Base"]->`); here the LITERAL of one required discriminant FIELD selects
 * the variant of a create's body (a create NAMES its target, it doesn't filter
 * it with a WHERE). What TypeScript would model as:
 *
 * ```ts
 * type ListEntryWrite =
 *   | { listName: "Pipeline" }
 *   | { listName: "VC Deal Flow"; Stage: Stage }
 * ```
 *
 * Each variant is a COMPLETE `WritableRootSchema` — exactly the write shape
 * when the discriminant is that literal (its `fields`/`requiredFields` are that
 * variant's, and it carries the discriminant field itself). The enclosing
 * schema is the fallback shape used when no variant can be selected (the
 * discriminant is missing, typo'd, or not a compile-time literal).
 *
 */
export interface DiscriminatedWriteShape {
  /** The required field whose LITERAL value selects the variant (`listName`). */
  discriminant: string;
  /** literal value → the complete write shape when the discriminant is that literal. */
  variants: Record<string, WritableRootSchema>;
}


/**
 * An UNTAGGED union of write shapes — the other half of the write-side type,
 * and the one with NO discriminant. A Slack message is a file post or an
 * interactive post; nothing in the body names which, so the shape is inferred
 * from what the body SETS. What TypeScript would model as:
 *
 * ```ts
 * type MessageWrite = { Message?: string; File?: File } | { Message?: string; Blocks?: Json }
 * ```
 *
 * Inventing a discriminant field to tag it would be nominal typing smuggled
 * into a structural union, so the rule is assignability, exactly as in TS: the
 * fields a write MAPS must be a subset of at least one variant.
 *
 * Deliberately NOT a `Record<string, WritableRootSchema>` like the
 * discriminated shape: a variant here restricts WHICH FIELDS may be set and
 * nothing else — no per-variant types, requiredness, or narrowing. Every other
 * fact (types, `requiredFields`, edges) stays on the enclosing shape, where it
 * is true of every variant.
 *
 */
export interface WriteUnionShape {
  variants: Array<{
    /** Author-facing name of the shape ("a file post") — what the checker's
     *  error offers the author to choose between. Display only. */
    name: string;
    /** Surface field names (`WritableRootSchema.fields` keys) this shape accepts. */
    fields: string[];
  }>;
}


/** A root the instance accepts writes for, and the shape of the resulting handle. */
export interface WritableRootSchema {
  fields: Record<string, SchemaFieldType>;
  /**
   * When present, this create's body is a DISCRIMINATED UNION: the literal of
   * `discriminated.discriminant` (a required field in `fields`) selects one of
   * `discriminated.variants`, and THAT variant determines the rest of the
   * writable shape. `checkWrite` reads the discriminant literal from the body,
   * selects the variant, and validates the remaining fields against it.
   * ADDITIVE — absent ⇒ one fixed shape (the common case). See
   * `DiscriminatedWriteShape`.
   */
  discriminated?: DiscriminatedWriteShape;
  /**
   * When present, this create's writable surface is an UNTAGGED UNION: the set
   * of fields a body maps must be a subset of at least one variant. Nothing
   * selects the variant — assignability does, as in TS. ADDITIVE and disjoint
   * from `discriminated` (the host rejects declaring both): absent ⇒ every
   * field of `fields` may be set together, the common case. See
   * `WriteUnionShape`.
   */
  writeUnion?: WriteUnionShape;
  /** What a handle from `x = write instance-[:root]-> { … }` carries (`externalId`, `url`, the written fields). */
  resultShape: Record<string, SchemaFieldType>;
  /**
   * The POSITION a handle from a write of this shape stands on, when that is
   * more specific than the root the write was addressed through. Set on a
   * DISCRIMINATED VARIANT: `write org-[:List Entries]-> { listName: "Master
   * Deals List", … }` is addressed at the membership collection, but the record
   * it hands back is a row of that one list — the type that genuinely carries
   * `Owners`. So the handle stands on the variant's own position, and a chained
   * write or `link` off it resolves against that type's edges.
   *
   * Absent ⇒ the handle keeps the type the write's own edge named (the common
   * case, and the case of a variant whose type mints no position at all — its
   * `fields`/`edges` still ride the handle).
   */
  position?: string;
  /**
   * The target system's OWN identity rules for this root, declaratively:
   * an OR-of-AND of surface field names (each inner array is one
   * AND-group; any group matching means "the same record"). Projected
   * from what the adapter honestly exposes — Attio's per-attribute
   * `is_unique`, the KG ontology's uniqueness rules — and enforced by
   * the target regardless of what a write authors. `unique by` is the
   * explicit layer on top; the checker compares the two (redundant /
   * conflicting) and the editor surfaces these on hover. Absent when
   * the adapter exposes no native rules (not proof there are none).
   */
  nativeUniqueness?: string[][];
  /**
   * Edges a write of this root must satisfy, each named by its satisfying
   * authored spelling: a tuple/linked path rooted at a `from`-typed handle
   * walking `edge` (or, where the target also exposes the edge as a
   * writable field, a body field named `edge`). Projected from what the
   * target honestly declares — required FK/reference fields (the FK
   * holder requires the edge) and KG scoping edges (`scopes: true` — the
   * scoped type requires each scoping parent). Absent when the target
   * declares none.
   */
  requiredEdges?: Array<{ edge: string; from: string }>;
  /**
   * The relationships this record participates in — every outgoing edge with
   * its target type and whether it's required. The REQUIRED subset must be
   * satisfied on create (and also appears, with its satisfying spelling, in
   * `requiredEdges`); the rest are OPTIONAL relationships you may author a
   * related record along — a linked write (`write x.<edge> -> …`) or a `link`
   * statement. Surfaced on the WRITE surface so authoring a write shows the
   * full link surface, not just the required edges; mirrors the readable
   * position's `edges`. Absent when the root declares no edges. (Whether the
   * target system accepts a given link is enforced at write time — this is the
   * relationship surface, not a per-edge write guarantee.)
   */
  edges?: Record<string, EdgeSchema>;
  /**
   * Scalar fields a CREATE of this root must give a value — projected
   * from what the target honestly declares (an adapter descriptor's
   * `required` flags; KG identity properties). The checker errors when a
   * write's body never sets one; a field written from a possibly-absent
   * expression (an unguarded `DATE.PARSE`) is caught by typed-absence
   * propagation at the value site (MOV_ABSENT_REQUIRED), not here. Absent
   * when the target declares none.
   */
  requiredFields?: string[];
  /**
   * Per-field authoring guidance, verbatim from the adapter descriptor's
   * field descriptions — value conventions ("channel name or id"), live
   * workspace facts (the actual channel names), formatting hints. Not
   * used by the checker; surfaced to authors (agents read it off
   * describeInstance, the editor can show it on hover). Absent when the
   * adapter describes nothing.
   */
  fieldDocs?: Record<string, string>;
  /**
   * Which fields this target's adapter can resolve by SIMILARITY, not just
   * equality — surfacing close candidates for the engine to arbitrate. Gates
   * the `FUZZY` modifier on a `unique by` component: an author may only mark a
   * component fuzzy where the target can honour it (the KG's pg_trgm search,
   * Attio's `$contains`). `true` ⇒ every field; a list ⇒ only those fields (by
   * their names in `fields`), since a system that searches names by
   * similarity may still compare a city exactly. Absent ⇒ exact only, and
   * FUZZY is rejected at author time.
   */
  fuzzyResolution?: true | readonly string[];
  /**
   * Whether a movement may author `unique by` on this root. Default (absent) ⇒
   * yes. `false` ⇒ the target decides record identity ITSELF and doesn't accept
   * author-defined uniqueness — the adapter does its own native matching that a
   * movement can't meaningfully configure (Affinity: org by domain/name, person
   * by email, with the workspace-vs-global-data nuance the engine can't
   * express). The checker rejects a `unique by` clause on such a root rather
   * than silently ignoring it.
   */
  uniquenessAuthorable?: boolean;
}


/**
 * A collection directly off an instance's meta node (`crm-[c:Companies]->`).
 *
 * The root is a NODE and the meta edge is an EDGE, so it says what it can do
 * the same way any record edge does — `target` is where the hop lands,
 * `capability` is what the source can do across it. Absent capability is the
 * same fact as an absent `EdgeSchema.capability`: nobody declared, so the gate
 * stays silent.
 *
 */
export interface CollectionSchema extends EdgeListening {
  /** The position type name the collection's members land on. */
  target: string;
  /** Whether — and how — filter / order / limit push across this collection.
   *  Read by the hop gate exactly as `EdgeSchema.capability` is. */
  capability?: EdgeCapability;
  /** Absent: it can be listed. `false`: it is only written to or listened to. */
  readable?: false;
  /** As `EdgeSchema.listenable`, `cursor`, `identity` and `version` say. */
  listenable?: true;
  cursor?: boolean;
  identity?: string;
  version?: string;
}


/**
 * The schema of a constructed instance — produced per construction because
 * which objects and fields an adapter offers depends on the credentials.
 * The same shape also describes configuration-free graphs: the `kg`
 * ontology (the catalog's `kg` slot), declared shape graphs, and (with only
 * `positions`/`collections` populated) extract results and block meta-nodes
 * derived by the checker itself.
 */
export interface InstanceSchema {
  /** Position types by name. */
  positions: Record<string, PositionSchema>;
  /** The bare instance name's meta-position edges: collection name → what the
   *  hop lands on, and what the source can do across it. */
  collections: Record<string, CollectionSchema>;
  /** Union position types: name → variant position type names (e.g. record → [company, person]). */
  unions?: Record<string, string[]>;
  /** Author-facing text for a union whose KEY is not author-facing — a grafted
   *  event address over the event union. The `PositionSchema.displayName` rule,
   *  one level up: identity is a key, display is a separate string. */
  unionDisplayNames?: Record<string, string>;
  /** Roots `write instance.<root> { … }` accepts. */
  writableRoots: Record<string, WritableRootSchema>;
  /**
   * Write shapes for types writable ALONG AN EDGE (`EdgeSchema.writable`)
   * — the per-field-writability projection of a type that has no top-level
   * root. Disjoint lookup from `writableRoots` (which remains the registry
   * of `write instance.<root>` targets): the checker reads
   * `writableRoots[t] ?? createShapes?.[t]` for a linked write's shape.
   */
  createShapes?: Record<string, WritableRootSchema>;
  /**
   * Whether the instance's adapter can update an already-identified record
   * in place (`updateRecord` in its manifest `methods[]`). Gates the
   * position write `write a { … }`: you may only update a record the
   * adapter contract lets you update by id. Absent/false → the checker
   * rejects position writes against this instance (an append-only target
   * like Slack or Drive). Reads/creates are unaffected.
   */
  supportsInPlaceUpdate?: boolean;
  /**
   * Whether this instance's edges can carry INLINE properties — facts that
   * belong to the relationship rather than to either end (a knowledge-graph
   * edge's `role`, a Slack file's `pinned`), which the adapter attaches per
   * traversed record at run time and no describe enumerates.
   *
   * A POSITIVE claim, and the third surface a bare name in a bracket WHERE can
   * address: the walked edge's own property, an outer binding, or a field of
   * the landed type. Two of those the checker can see; this one it cannot, so
   * where it is declared an otherwise-unknown WHERE name stays silent — the
   * same honesty valve `openProperties` is for a read. Absent ⇒ the edge
   * carries nothing but its ends, and such a name is a mistake.
   */
  edgesCarryProperties?: boolean;
  /**
   * Position-aware narrowing (2026-07-05): refined position types, keyed by
   * `refinementKey`. When a hop lands on a type through a WHERE that is a
   * DECIDABLE EQUALITY (`` `Field` == "literal" ``), the checker rebinds the
   * hop target to the named entry — an anonymous subtype registered in
   * `positions` that carries that POSITION's actual surface (e.g. one
   * spreadsheet's table edges) instead of the type's whole-collection union.
   * Produced by the host by WALKING to the type the selector names; absent ⇒ no
   * static narrowing, and position knowledge stays a runtime concern.
   */
  refinements?: Record<string, string>;
  /**
   * The TYPE the member each refinement selected lands, under the SAME
   * `refinementKey` as `refinements` — the name that type is PUBLISHED under,
   * which is exactly what a landed record's `recordType` carries.
   *
   * Not the member's ADDRESSING name. A polymorphic member is addressed by the
   * label the meta walk filed it under (Affinity's `"Portfolio"`) and lands
   * records of a type of its own (`"List Entry — Portfolio"`); those are two
   * strings, and only the second one a record can ever equal.
   *
   * `refinements` is the TYPE half of a narrowing and `selectedMembers` is the
   * RUNTIME half: the checker rebinds the hop to the member's surface, the
   * engine drops any landed record of a different member before reading a
   * field off it. Two facts, one key, one host pass — so the two halves cannot
   * disagree about which member a WHERE chose. Absent ⇒ nothing narrowed, and
   * every landed record faces the whole WHERE as it always has.
   */
  selectedMembers?: Record<string, string>;
  /**
   * The fields a `WHERE` may test to narrow a type to one of its members, keyed
   * by the type — the same `narrowBy` a connection's describe shows on the
   * polymorphic edge, recorded by the host for the types this program's hops
   * land on. A type that has none is not narrowable.
   *
   * Read only to say how to fix a refusal: a field the type itself does not
   * carry may belong to one member, and narrowing is how it becomes readable.
   */
  narrowBy?: Record<string, string[]>;
  /**
   * A hop's `WHERE` the host evaluated over a type's members and found to
   * select none of them, under the same `refinementKey` as `refinements`: the
   * members there are, by name. The checker refuses the hop where it is
   * written (`MOV_UNKNOWN_POSITION`), naming them. Absent ⇒ either the WHERE
   * selected a member (`refinements`) or the members could not decide it, and
   * the hop stays on the unnarrowed type.
   */
  unselected?: Record<string, string[]>;
  /**
   * Construction-site landings (2026-07-30): positions synthesized from ONE
   * write's own literals, keyed by `genericLandingKey`. The refinements
   * mechanism one door over — there the program's WHERE selects a position the
   * host walks to; here the program's write BODY fixes a type the host derives.
   * Both are program-dependent positions the host grafts into a copy of the
   * schema and the checker only looks up, so neither side can decide anything
   * the other disagrees with.
   *
   * Absent ⇒ nobody synthesized anything, and every edge lands on its declared
   * base type.
   *
   */
  genericLandings?: Record<string, string>;
}


/**
 * Structural, key-order-independent serialization of a parsed node. Both sides
 * of a refinement derive their key from the SAME parsed expression, so the only
 * thing that could split them is object key order; sorting removes it. `undefined`
 * members are dropped so an explicitly-absent optional keys like an omitted one.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}


/**
 * Canonical key into `InstanceSchema.refinements`: the hop's target type plus
 * the WHERE that selects the position. Shared by the checker (looking
 * refinements up) and the host (registering them), so the two sides can never
 * drift on key shape.
 *
 * The key is the EXPRESSION, not a `{field, value}` selector: narrowing
 * consumes a predicate that evaluates to a Boolean, so any shape the shared
 * filter unit can evaluate keys here — conjunctions included — with nothing to
 * widen. Both sides hold the same AST, so they can key on it directly.
 *
 */
export function refinementKey(input: { type: string; filter: Expression }): string {
  return JSON.stringify([input.type, canonicalize(fieldReadsUnmarked(input.filter))]);
}


/**
 * The filter with its field reads' `fieldOnly` marks dropped. The mark says
 * how a read was SPELLED — through the hop's alias
 * (`e.action`), bare before (`action`) — and both spellings name the same
 * field, so the key must not tell them apart: a host registers its narrowing
 * once, from its own filter, and every version's program must find it.
 */
function fieldReadsUnmarked(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fieldReadsUnmarked);
  const node = value as Record<string, unknown>;
  const isFieldRead = node['type'] === 'property' || node['type'] === 'edge_property';
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => !(isFieldRead && k === 'fieldOnly'))
      .map(([k, v]) => [k, fieldReadsUnmarked(v)]),
  );
}


/**
 * THE IDENTITY of a union position type — the key it lives under in
 * `InstanceSchema.unions`, and what an `EdgeSchema` whose landing varies per
 * record puts in its `target`.
 *
 * A union IS its member set, exactly as in TypeScript: `A | B` is the same type
 * wherever it is written, so two edges landing on the same types land on ONE
 * type. Sorting makes that literally true of the key, and de-duplication means
 * a set that collapses to one member cannot masquerade as a union.
 *
 * `refinementKey`'s contract: opaque, derived identically by whoever registers
 * the union and whoever resolves it, and only ever COMPARED. Never parse it,
 * never show it to an author — `unionDisplayNames` carries the text, and it is
 * a separate string precisely so no code path can start depending on it.
 *
 * The `'union'` tag is what stops it colliding with the other opaque keys in
 * this namespace (an event address, a refinement): three key families sharing a
 * `positions`/`unions` namespace must not be able to produce one string.
 */
export function unionKey(members: readonly string[]): string {
  return JSON.stringify(['union', unionVariants(members)]);
}


/** THE DISPLAY of a union — author-facing text, and nothing else. TS's own
 *  notation, because that is what the type is. */
export function unionDisplay(members: readonly string[]): string {
  return unionVariants(members).join(' | ');
}


/** A member set in its one canonical form — a set has no order, so the key, the
 *  display and the registered `unions` entry all derive from the same sorted,
 *  de-duplicated list. */
export function unionVariants(members: readonly string[]): string[] {
  return [...new Set(members)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}


export interface Catalog {
  adapter(name: string): AdapterSpec | undefined;
  credential(name: string): CredentialSpec | undefined;
  /**
   * Every credential import name this workspace has — what a diagnostic's fix
   * draws on to name the ONE connection an adapter can be constructed with.
   * Undefined ⇒ the catalog cannot list them, and no such fix is offered.
   */
  credentialNames?(): readonly string[];
  plugin(name: string): PluginSpec | undefined;
  /**
   * Every plugin's registered name — what a package import's members are
   * found among (`packageMembers`). Undefined ⇒ the catalog cannot list them,
   * and no import names a package.
   */
  pluginNames?(): readonly string[];
  /**
   * Resolve a constructed instance's schema. An instance's full type exists
   * only under concrete construction arguments (which objects and fields an
   * Attio offers depends on the credential), which is why this is a call and
   * not a static per-adapter schema. `args` carries the construction call's
   * named arguments as raw expression text, keyed by argument name (the
   * credential argument's value is the credential's name).
   *
   * Return undefined when the schema cannot be produced — the checker then
   * leaves every schema-typed check silent for that instance.
   */
  instantiate(adapter: string, args: Record<string, string>): InstanceSchema | undefined;
  /**
   * The valid values for an ENUM-TYPED construction arg — an entry-position arg
   * (Sheets' `spreadsheet:`, whose options are the credential's visible
   * spreadsheets). The value depends on the CREDENTIAL, so it's a call, not
   * static per-adapter metadata. Returns undefined when `arg` isn't enum-typed
   * for this adapter (the checker then leaves the value unchecked); an empty
   * array means "enum-typed but no options resolved" (also left unchecked, so a
   * transient introspection miss never mis-warns). A value outside a non-empty
   * result is a WARNING with a did-you-mean, never an error (grants change).
   */
  constructionArgOptions?(input: {
    adapter: string;
    credentialName?: string;
    arg: string;
  }): readonly string[] | undefined;
  /**
   * The logical model names a movement may ask an LLM call for on THIS
   * deployment — the ones its model map sends somewhere it can call. A
   * deployment property, like the credentials: the same movement can name a
   * model one deployment reaches and another does not, so a name outside this
   * list is refused at validate and at the deploy check, not by language
   * version. Undefined ⇒ the catalog does not know (a hand-built fixture), and
   * a named model is left unchecked.
   */
  models?(): readonly string[];
}


/** A catalog's `models` member over a list, or none when the list is not
 *  known — absent and empty are different facts. */
export function modelsMember(models: readonly string[] | undefined): Pick<Catalog, 'models'> {
  return models !== undefined ? { models: () => models } : {};
}


export function mockCatalog(spec: {
  adapters?: Record<string, AdapterSpec & { schema?: InstanceSchema }>;
  credentials?: Record<string, { adapter: string } | CredentialSpec>;
  plugins?: Record<string, PluginSpec>;
  instantiate?: Catalog['instantiate'];
  constructionArgOptions?: Catalog['constructionArgOptions'];
  models?: readonly string[];
}): Catalog {
  return {
    // Fixtures declare the surface they're testing, not the whole manifest, so
    // `canFire` defaults ON here — an omission in a test means "not what this
    // test is about", whereas in the real projection it means "this system has
    // no inbound surface". A fixture opts out by setting it false explicitly.
    adapter(name) {
      const found = spec.adapters?.[name];
      if (found === undefined) return undefined;
      // The fixture's `schema` is how `instantiate` answers, not a member of
      // the adapter's spec: left on it, it would ride into a snapshot as a
      // key no snapshot declares.
      const { schema: _instantiated, ...adapter } = found;
      return { canFire: true, ...adapter };
    },
    credential(name) {
      const c = spec.credentials?.[name];
      if (!c) return undefined;
      return 'adapters' in c ? c : { adapters: [c.adapter] };
    },
    credentialNames: () => Object.keys(spec.credentials ?? {}),
    plugin: name => {
      const hit = findPlugin(spec.plugins ?? {}, name);
      return hit !== undefined && 'found' in hit ? hit.found.spec : undefined;
    },
    pluginNames: () => Object.keys(spec.plugins ?? {}),
    instantiate: spec.instantiate ?? (adapter => spec.adapters?.[adapter]?.schema),
    ...(spec.constructionArgOptions !== undefined
      ? { constructionArgOptions: spec.constructionArgOptions }
      : {}),
    ...modelsMember(spec.models),
  };
}


/**
 * A row a DECLARATION states, for a function whose body the checker cannot
 * walk — a plugin, an adapter's field function, a remote callee. The inferred
 * row's twin: same five facts, written down instead of derived, and folded into
 * a caller by exactly the same `absorb`.
 *
 * `reads`/`writes` name synthetic sources in the words an author would read
 * ("the web"). They are not instances: a declaration is written once, in the
 * registry, and cannot know which graphs the movement that calls it constructed.
 *
 * There is no `partial` here. A declaration is a CLAIM — it says what the
 * function does, completely. Not declaring one at all is the lower bound, and
 * that is the absence of this object, not a field inside it.
 */
export interface DeclaredEffectRow {
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly ai?: boolean;
  readonly now?: boolean;
  readonly suspend?: boolean;
}


// ── Edges the engine makes ──

/** The prefix that marks an edge the ENGINE makes rather than one a system
 *  declares. Reserved in every version: the host leaves an adapter edge so
 *  named out of its projection, with a note, so the two can never collide. */
export const ARTIFICIAL_EDGE_PREFIX = '@';


export function isArtificialEdge(edge: string): boolean {
  return edge.startsWith(ARTIFICIAL_EDGE_PREFIX);
}


/**
 * The EVENT NAME a key was minted from — the inverse of `eventAddressKey`'s
 * event half, and it lives HERE so the key stays opaque to everyone else. Its
 * consumers only ever compare it; the moment one of them pulled the name out
 * itself, the key would be a magic string that is PARSED rather than compared.
 *
 * This exists because the engine stamps an event position's `recordType` with
 * the key, and any name resolution scoped by type then has to ask which type
 * that is. An UNPINNED key already IS the event name, which is why adapters
 * whose events pin nothing (Granola, an unnarrowed Attio event) resolve
 * correctly by COINCIDENCE — and why Airtable, which always pins base and
 * table, never did.
 *
 * A string this module did not mint is returned unchanged: it is an ordinary
 * type name, and saying so is the honest answer.
 */
export function eventAddressEventName(key: string): string {
  if (!key.startsWith('[')) return key;
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0];
  } catch {
    // Not a key we minted — fall through to the verbatim name.
  }
  return key;
}


/**
 * What an adapter SURFACE can declare — every field type, nested collections
 * included, a record by the name of its position.
 *
 * A record field holds a record as its value (a change's row before and
 * after), read on with `.` and never fetched. It names its position as the
 * checker's `PositionTypeRef` does, less the instance: the schema declaring
 * it is the instance's own. That is what keeps a schema clear of the position
 * model — a schema crosses the wire (`InstanceSchema` is a tRPC response),
 * and a field type that carried an instance would reach back into schemas
 * again, a cycle no serialiser's type can follow.
 *
 * The collections are spelled a second time because TypeScript cannot subtract
 * a member from a RECURSIVE union — `Exclude` removes the record at the top
 * and leaves `list of record` behind, which is the same cycle. The scalars and
 * every rule about them live on `FieldType` above; this is that union with one
 * member gone, and every `SchemaFieldType` IS a `FieldType`, so nothing that
 * reads a schema needs to know which it was handed.
 */
export type SchemaFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'file'
  | 'json'
  | 'absent'
  | 'never'
  | { kind: 'list'; of: SchemaFieldType; unordered?: true }
  | { kind: 'tuple'; of: Array<SchemaFieldType | null> }
  | { kind: 'dict'; of: SchemaFieldType }
  | { kind: 'enum'; options: string[]; open?: { allowPattern?: string } }
  /** A named scalar its owner (the module that declared it) parses: a cron
   *  schedule, a mailbox key. `allowPattern` is the least an owner says of
   *  its values. */
  | { kind: 'owned'; name: string; owner: string; allowPattern?: string }
  | { kind: 'maybeAbsent'; of: SchemaFieldType }
  /** A record's fields held as the field's value (`c.Current`): typed as a
   *  plain object of that position's fields, never as the record. It has no
   *  edges and no identity, so a checker refuses a walk, a write or a record
   *  parameter on it, bound to a name or not. */
  | { kind: 'record'; position: SchemaPositionRef };

/** Which record a `record` field holds: one record type of the instance, or
 *  one of several (`unions`). */
export type SchemaPositionRef = { kind: 'position'; position: string } | { kind: 'union'; union: string };

/** `T | absent` over a surface type; a surface type in is a surface type out. */
export function maybeAbsent(type: SchemaFieldType | undefined): SchemaFieldType | undefined {
  if (type === undefined) return undefined;
  if (typeof type === 'string') return type === 'never' ? 'absent' : { kind: 'maybeAbsent', of: type };
  return type.kind === 'maybeAbsent' ? type : { kind: 'maybeAbsent', of: type };
}



/** One adapter-declared interactive connect action — the declaration half
 *  of the generalised "+" connect affordance. `kind` names an app-shipped
 *  client handler; `label` is the suggestion text. The language stays pure:
 *  it carries the declaration and never interprets `kind`. */
export interface ConnectAction {
  kind: string;
  label: string;
}
