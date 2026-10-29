//! Routing read from source: every `listen … fire …` across the project's
//! files is the routing table (as movement-engine's
//! `movement/file_listeners.ts` reads it), plus the scope gate an inbound event must
//! clear to reach a listen (`triggers/listen_config.ts`) and the trigger
//! event a run is handed (`triggers/trigger_event.ts`, with
//! `engine/inbound/discriminate.ts`).

use std::collections::{BTreeMap, HashMap};

use std::rc::Rc;

use movement_parser::ast::{ImportSource, NamedArg, RValue, ShapeDeclaration, ShapeNode, Statement};
use movement_parser::util::form::external_text;
use serde_json::Value as Json;

use crate::json::{Js, Obj};
use crate::wire::js_of_json;

/// One `listen` statement, with its instance's construction resolved (`FileListener`).
#[derive(Debug, Clone)]
pub struct Listen {
    /// The file it is in, by name.
    pub file: String,
    /// The adapter slug (the construction's callee, import alias resolved).
    pub adapter: String,
    /// The listen's config block, statically evaluated.
    pub config: Obj,
    pub movement_name: String,
    /// The credential its construction names (`connect … using X`), by its
    /// name in the secrets (an import alias resolved); None when the
    /// construction names none, and for a host unit.
    pub credential: Option<String>,
    /// The node its config declares its events are (`payload: <Payment>`):
    /// an event whose payload does not fit it never reaches the listen.
    pub payload: Option<DeclaredPayload>,
    /// Its construction's other arguments (`{ base: "CRM" }`), by name, as
    /// their source text: those the module declares as position args say
    /// which position the connection is in (RunningExternal::position_settings).
    pub args: Vec<(String, String)>,
    /// The values its connection's position gives the module's address hops
    /// the listen does not name, resolved to ids (the platform's
    /// `resolved_address`; `listen_narrowing::resolve_listen_addresses`), or
    /// why they could not be. Empty until resolved.
    pub address: Result<BTreeMap<String, String>, String>,
}

impl Listen {
    /// Its webhook scope under the module's `scope_keys`: each key's value
    /// in its config, else in its resolved address; the keys neither gives
    /// when it misses any.
    pub fn scope(&self, scope_keys: &[String]) -> Result<Scope, Vec<String>> {
        let resolved = self.address.as_ref().ok();
        let mut config = self.config.clone();
        for key in scope_keys {
            let named = config.get(key).and_then(Js::as_str).is_some_and(|v| !v.is_empty());
            if let Some(value) = resolved.and_then(|a| a.get(key)).filter(|_| !named) {
                config.insert(key.clone(), Js::str(value));
            }
        }
        scope_of(&config, scope_keys)
    }

    /// The listen's pipeline, `listen:<file>:<movement>`: what its receipts,
    /// its runs and its polls name it by.
    pub fn pipeline(&self) -> String {
        format!("listen:{}:{}", self.file, self.movement_name)
    }

    /// Whether an event delivered for `credential` reaches this listen (the
    /// platform's per-trigger credential narrowing): a listen whose
    /// construction names a credential hears only that credential's
    /// deliveries. A listen that names none hears every delivery, and a
    /// delivery that names none (addressed to the module's install, which
    /// serves every connection) reaches every listen.
    pub fn hears(&self, credential: Option<&str>) -> bool {
        match (self.credential.as_deref(), credential) {
            (Some(own), Some(delivered)) => own == delivered,
            _ => true,
        }
    }

    /// Whether an event's payload fits the node the listen declares; a
    /// listen that declares none takes any.
    pub fn takes(&self, event: &Js) -> bool {
        self.payload.as_ref().is_none_or(|declared| declared.misfits(event.get("payload").unwrap_or(&Js::Null)).is_empty())
    }

    /// Whether an event delivered for `credential` through the webhook
    /// subscription `subscription` (a scope's key, `subscription_key`)
    /// reaches this listen: it hears the credential, and its own scope under
    /// the module's `scope_keys` is that subscription's. A delivery through
    /// no subscription (a credential's own door, or a row queued before
    /// rows named one) is narrowed by the credential alone.
    pub fn hears_through(&self, credential: Option<&str>, subscription: Option<&str>, scope_keys: &[String]) -> bool {
        self.hears(credential)
            && subscription.is_none_or(|key| self.scope(scope_keys).is_ok_and(|scope| subscription_key(&scope) == key))
    }
}

/// A webhook subscription's scope: the listen config's value of each of the
/// module's `subscriptionScopeKeys`, in their order (the platform's channel
/// scope, Airtable's base and table). Empty for a module that declares none.
pub type Scope = Vec<(String, String)>;

/// The scope `config` names under `keys`; the keys it gives no non-empty
/// text when it misses any (the platform refuses such a listen's channel).
pub fn scope_of(config: &Obj, keys: &[String]) -> Result<Scope, Vec<String>> {
    let mut scope = Scope::new();
    let mut missing = Vec::new();
    for key in keys {
        match config.get(key).and_then(Js::as_str).filter(|v| !v.is_empty()) {
            Some(value) => scope.push((key.clone(), value.to_string())),
            None => missing.push(key.clone()),
        }
    }
    if missing.is_empty() { Ok(scope) } else { Err(missing) }
}

/// The scope's key: its values in order, joined by `.`, each byte outside
/// `[A-Za-z0-9_-]` written `~` and two hex digits. A URL path segment that
/// no sender rewrites (`~` is unreserved), and one per scope.
pub fn subscription_key(scope: &Scope) -> String {
    let escaped = |value: &str| -> String {
        value
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' => (b as char).to_string(),
                other => format!("~{other:02x}"),
            })
            .collect()
    };
    scope.iter().map(|(_, value)| escaped(value)).collect::<Vec<_>>().join(".")
}

/// A listen's declared payload: the node, as listen-fire checks a body against it
/// before any run. The checker has typed the movement against the same node,
/// so a payload that fits is what the movement reads.
#[derive(Debug, Clone)]
pub struct DeclaredPayload {
    pub name: String,
    node: PayloadNode,
}

#[derive(Debug, Clone)]
struct PayloadNode {
    fields: Vec<PayloadField>,
    /// A nested node: the key holds an object, or a list of them.
    children: Vec<(String, PayloadNode)>,
}

#[derive(Debug, Clone)]
struct PayloadField {
    name: String,
    kind: ValueKind,
    nullable: bool,
}

/// What JSON a declared field's type takes.
#[derive(Debug, Clone)]
enum ValueKind {
    Text,
    Number,
    Boolean,
    /// One of a declared `type`'s values.
    OneOf(Vec<String>),
    /// `json`, a file, or a type listen-fire does not read the JSON of: any value.
    Any,
}

impl ValueKind {
    fn of(written: &str, enums: &HashMap<String, Vec<String>>) -> ValueKind {
        match written.trim() {
            "text" | "date" | "datetime" => ValueKind::Text,
            "number" => ValueKind::Number,
            "boolean" => ValueKind::Boolean,
            other => enums.get(other.trim_matches('`')).map_or(ValueKind::Any, |options| ValueKind::OneOf(options.clone())),
        }
    }

    fn describe(&self) -> String {
        match self {
            ValueKind::Text => "text".into(),
            ValueKind::Number => "a number".into(),
            ValueKind::Boolean => "a boolean".into(),
            ValueKind::OneOf(options) => format!("one of {}", options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join(", ")),
            ValueKind::Any => "any value".into(),
        }
    }

    fn fits(&self, value: &Js) -> bool {
        match (self, value) {
            (ValueKind::Any, _) => true,
            (ValueKind::Text, Js::Str(_)) | (ValueKind::Number, Js::Num(_)) | (ValueKind::Boolean, Js::Bool(_)) => true,
            (ValueKind::OneOf(options), Js::Str(s)) => options.contains(s),
            _ => false,
        }
    }
}

/// What a JSON value is, as a misfit names it.
fn json_kind(value: &Js) -> &'static str {
    match value {
        Js::Str(_) => "text",
        Js::Num(_) => "a number",
        Js::Bool(_) => "a boolean",
        Js::Arr(_) => "a list",
        Js::Obj(_) => "an object",
        _ => "null",
    }
}

impl PayloadNode {
    fn of(node: &ShapeNode, base: Option<PayloadNode>, enums: &HashMap<String, Vec<String>>) -> PayloadNode {
        let mut out = base.unwrap_or(PayloadNode { fields: Vec::new(), children: Vec::new() });
        for field in &node.fields {
            out.fields.retain(|f| f.name != field.name);
            out.fields.push(PayloadField { name: field.name.clone(), kind: ValueKind::of(&field.type_, enums), nullable: field.nullable == Some(true) });
        }
        for child in &node.children {
            out.children.retain(|(name, _)| *name != child.name);
            out.children.push((child.name.clone(), PayloadNode::of(child, None, enums)));
        }
        out
    }

    fn misfits(&self, value: &Js, path: &str, out: &mut Vec<String>) {
        let Js::Obj(object) = value else {
            out.push(format!("{} is {}, not an object", if path.is_empty() { "the body" } else { path }, json_kind(value)));
            return;
        };
        let at = |name: &str| if path.is_empty() { format!("`{name}`") } else { format!("`{path}.{name}`") };
        for field in &self.fields {
            match object.get(&field.name) {
                None | Some(Js::Null) if field.nullable => {}
                None | Some(Js::Null) => out.push(format!("{} is missing ({})", at(&field.name), field.kind.describe())),
                Some(found) if !field.kind.fits(found) => out.push(format!("{} is {}, not {}", at(&field.name), json_kind(found), field.kind.describe())),
                Some(_) => {}
            }
        }
        for (name, child) in &self.children {
            let inner = if path.is_empty() { name.clone() } else { format!("{path}.{name}") };
            match object.get(name) {
                None | Some(Js::Null) => {}
                Some(Js::Arr(items)) => items.iter().for_each(|item| child.misfits(item, &inner, out)),
                Some(found) => child.misfits(found, &inner, out),
            }
        }
    }
}

/// What one file declares for reading a payload node: its nodes, its enums,
/// and the names it imports from other files (local name to file and exported
/// name), as the checker's linker resolves them.
struct FileScope<'a> {
    shapes: HashMap<String, &'a ShapeDeclaration>,
    enums: HashMap<String, Vec<String>>,
    imports: HashMap<String, (String, String)>,
}

impl<'a> FileScope<'a> {
    fn of(program: &'a movement_parser::ast::Program) -> FileScope<'a> {
        let mut scope = FileScope { shapes: HashMap::new(), enums: HashMap::new(), imports: HashMap::new() };
        for statement in &program.statements {
            match statement {
                Statement::Shape(shape) => {
                    scope.shapes.insert(shape.name.clone(), shape);
                }
                Statement::Type(declaration) => {
                    scope.enums.insert(declaration.name.clone(), declaration.options.clone());
                }
                Statement::Import(import) => {
                    if let ImportSource::File { path } = &import.source {
                        for name in &import.names {
                            scope.imports.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()), (path.clone(), name.name.clone()));
                        }
                    }
                }
                _ => {}
            }
        }
        scope
    }

    /// The node `name` as this file means it, and the file that declares it:
    /// its own, or the one it imports it from (through any chain of imports).
    fn shape<'s>(&'s self, name: &str, scopes: &'s HashMap<String, FileScope<'a>>, hops: usize) -> Option<(&'a ShapeDeclaration, &'s FileScope<'a>)> {
        if let Some(shape) = self.shapes.get(name) {
            return Some((shape, self));
        }
        let (path, exported) = self.imports.get(name).filter(|_| hops < 16)?;
        scopes.get(path)?.shape(exported, scopes, hops + 1)
    }
}

impl DeclaredPayload {
    /// The node `name` as `scope` means it, a base it extends folded in. None
    /// when no such node is declared or imported (the checker refuses that
    /// listen).
    fn of(name: &str, scope: &FileScope<'_>, scopes: &HashMap<String, FileScope<'_>>) -> Option<DeclaredPayload> {
        fn node(name: &str, scope: &FileScope<'_>, scopes: &HashMap<String, FileScope<'_>>, depth: usize) -> Option<PayloadNode> {
            let (shape, owner) = scope.shape(name, scopes, 0)?;
            let base = shape.extends.as_ref().filter(|_| depth < 16).and_then(|b| node(&b.name, owner, scopes, depth + 1));
            Some(PayloadNode::of(&shape.root, base, &owner.enums))
        }
        let name = name.trim().trim_matches('`');
        Some(DeclaredPayload { name: name.to_string(), node: node(name, scope, scopes, 0)? })
    }

    /// What of `payload` does not fit the node, one line each; empty when it fits.
    pub fn misfits(&self, payload: &Js) -> Vec<String> {
        let mut out = Vec::new();
        self.node.misfits(payload, "", &mut out);
        out
    }
}

/// `configValueOf`: a listen config value, statically evaluated; anything
/// that does not reduce to a static value keeps its raw text.
fn config_value_of(arg: &NamedArg) -> Js {
    let raw = external_text(&arg.value.raw).into_owned();
    if arg.is_type == Some(true) {
        return Js::Str(raw.trim().to_string());
    }
    let lowered = movement_parser::parse_expression(&arg.value.raw)
        .ok()
        .and_then(|tree| movement_parser::lowering::lower_expression_json(&tree, &arg.value.raw).ok());
    let Some(lowered) = lowered else { return Js::Str(raw.trim().to_string()) };
    let static_value = |e: &Json| -> Option<Js> {
        match e.get("type").and_then(Json::as_str) {
            Some("static") => Some(external_js(e.get("value").unwrap_or(&Json::Null))),
            _ => None,
        }
    };
    if let Some(value) = static_value(&lowered) {
        return value;
    }
    if lowered.get("type").and_then(Json::as_str) == Some("list")
        && let Some(elements) = lowered.get("elements").and_then(Json::as_array)
    {
        let read: Option<Vec<Js>> = elements
            .iter()
            .map(|e| match e.get("type").and_then(Json::as_str) {
                Some("static") => static_value(e),
                // `fields: [domains]` — bare names read as root-less property nodes.
                Some("property") => e.get("propertyTypeId").and_then(Json::as_str).map(|s| Js::Str(external_text(s).into_owned())),
                _ => None,
            })
            .collect();
        if let Some(read) = read {
            return Js::Arr(read);
        }
    }
    Js::Str(raw.trim().to_string())
}

/// A lowered static's value, its texts out of the engine's form.
fn external_js(value: &Json) -> Js {
    match value {
        Json::String(s) => Js::Str(external_text(s).into_owned()),
        other => js_of_json(other),
    }
}

/// The construction argument `connect … using X` writes the credential to.
const CREDENTIAL_ARG: &str = "credentials";

/// `collectListens`: the listens of every file that parses. A payload node
/// the listen's file imports from another file is read from that file, the
/// way the checker links it, so the listens of a set depend on the whole set
/// and not on one file's text.
pub fn listens_across(parsed: &[Rc<crate::sources::Parsed>]) -> Vec<Listen> {
    let programs: Vec<(&str, &movement_parser::ast::Program)> = parsed.iter().filter_map(|p| p.program.as_ref().ok().map(|program| (p.name.as_str(), program))).collect();
    let scopes: HashMap<String, FileScope<'_>> = programs.iter().map(|(name, program)| (name.to_string(), FileScope::of(program))).collect();
    programs.iter().flat_map(|(name, program)| listens_of(name, program, &scopes)).collect()
}

fn listens_of(file: &str, program: &movement_parser::ast::Program, scopes: &HashMap<String, FileScope<'_>>) -> Vec<Listen> {
    let mut listens = Vec::new();
    let mut originals: HashMap<String, String> = HashMap::new();
    // Each instance's adapter, credential and other arguments, by the instance's name.
    let mut constructions: HashMap<String, (String, Option<String>, Vec<(String, String)>)> = HashMap::new();
    let mut declared = Vec::new();
    let scope = &scopes[file];
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => {
                for name in &import.names {
                    if let Some(alias) = &name.alias {
                        originals.insert(alias.clone(), name.name.clone());
                    }
                }
            }
            Statement::Assign(assign) => {
                if let RValue::Construct { construct } = &assign.value {
                    let adapter = originals.get(&construct.callee).cloned().unwrap_or_else(|| construct.callee.clone());
                    let credential = construct
                        .args
                        .iter()
                        .find(|a| a.name == CREDENTIAL_ARG)
                        .and_then(|a| movement_parser::catalog::helpers::unwrap_credential_arg(&a.value.raw));
                    let mut args: Vec<(String, String)> =
                        construct.args.iter().filter(|a| a.name != CREDENTIAL_ARG).map(|a| (a.name.clone(), a.value.raw.clone())).collect();
                    args.sort();
                    constructions.insert(assign.name.clone(), (adapter, credential, args));
                }
            }
            Statement::Listen(listen) => declared.push(listen),
            _ => {}
        }
    }
    for listen in declared {
        // A unit the file does not bind itself is the host's own.
        let unit = movement_parser::version::RUN_HOST_UNITS.iter().find(|u| **u == listen.instance).map(|u| u.to_string());
        let Some((adapter, credential, args)) = constructions.get(&listen.instance).cloned().or(unit.map(|u| (u, None, Vec::new()))) else { continue };
        let credential = credential.map(|local| originals.get(&local).cloned().unwrap_or(local));
        let mut config = Obj::new();
        for arg in &listen.config {
            config.insert(arg.name.clone(), config_value_of(arg));
        }
        // The checker takes a type only for a key of the `type` format: a
        // node the program declares.
        let payload = listen.config.iter().filter(|a| a.is_type == Some(true)).find_map(|a| DeclaredPayload::of(&a.value.raw, scope, scopes));
        listens.push(Listen {
            file: file.to_string(),
            adapter,
            config,
            movement_name: listen.movement.clone(),
            credential,
            payload,
            args,
            address: Ok(BTreeMap::new()),
        });
    }
    listens
}

/// `eventConfigList`.
fn event_config_list(events: Option<&Js>) -> Vec<String> {
    match events {
        Some(Js::Arr(items)) => items.iter().filter_map(Js::as_str).map(str::to_string).collect(),
        Some(Js::Str(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// How an event reached listen-fire: pushed (a webhook, `emit`, a unit's tick), or
/// returned by a poll of one listen's source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arrival {
    Pushed,
    Polled,
}

/// `eventMatchesTriggerScope`: the listen's chosen events, an
/// Airtable-style table scope, and a changed field (`field`) with the value
/// it became (`becomes`). A source labels each event with its kind
/// (`eventType`), pushed or polled, and the chosen events narrow by it. A
/// polled event with no label (a module older than adapter protocol 2.3)
/// still reaches its listen: the poll was made for that listen with its
/// config (the caller says so, crate::runs).
pub fn event_matches_trigger_scope(event: &Js, config: &Obj, arrival: Arrival) -> bool {
    let events = event_config_list(config.get("events"));
    if !events.is_empty() {
        match (event.get("eventType").and_then(Js::as_str), arrival) {
            (Some(t), _) if events.iter().any(|e| e == t) => {}
            (None, Arrival::Polled) => {}
            (Some(_), _) | (None, Arrival::Pushed) => return false,
        }
    }
    if let Some(Js::Str(table)) = config.get("table")
        && !table.is_empty()
        && let Some(record_type) = event.get("recordType")
        && record_type.as_str() != Some(table.as_str())
    {
        return false;
    }
    if let Some(Js::Str(field)) = config.get("field")
        && !field.is_empty()
    {
        let changed = event.get("changedFields").and_then(Js::as_array).unwrap_or(&[]);
        if !changed.iter().any(|f| f.as_str() == Some(field.as_str())) {
            return false;
        }
        if let Some(value) = config.get("becomes")
            && !became_value(event.get("payload"), field, value)
        {
            return false;
        }
    }
    true
}

/// `becameValue`: the field's new value (`payload.fields`) is the value and
/// its previous one (`payload.previous`, `FieldChangePayload`) was not; a
/// field missing from `previous` had no value before.
fn became_value(payload: Option<&Js>, field: &str, value: &Js) -> bool {
    let cell = |key: &str| payload.and_then(|p| p.get(key)).and_then(|cells| cells.get(field));
    same_value(cell("fields"), value) && !same_value(cell("previous"), value)
}

/// `sameValue`: equal as data, a list or an object by its contents.
fn same_value(held: Option<&Js>, value: &Js) -> bool {
    match (held, value) {
        (None, _) => false,
        (Some(Js::Num(a)), Js::Num(b)) => a.as_f64() == b.as_f64(),
        (Some(held), value) => held.to_json() == value.to_json(),
    }
}

/// The listen config key that routes inbound mail: a module that declares
/// it (`@lf/email`) has each message reach the listen whose `key` is the
/// plus-suffix of the address it was sent to.
pub const ROUTING_KEY: &str = "key";

/// Whether a module's listen vocabulary declares the routing key.
pub fn routes_by_key(listen_vocabulary: &Obj) -> bool {
    let entries = listen_vocabulary.get("listenConfig").and_then(Js::as_array).unwrap_or(&[]);
    entries.iter().any(|entry| entry.get("key").and_then(Js::as_str) == Some(ROUTING_KEY))
}

/// The plus-suffix of the address a message was delivered to (its
/// `recipient`, `<box>+<key>@<domain>`), lowercased: a mail server hands the
/// address back in whatever case the sender typed. None for the box itself.
pub fn plus_suffix_of(event: &Js) -> Option<String> {
    let recipient = event.get("payload").and_then(|p| p.get("recipient")).and_then(Js::as_str)?;
    recipient.split(',').find_map(|address| {
        let address = address.trim();
        let address = address.rsplit_once('<').map_or(address, |(_, bracketed)| bracketed.trim_end_matches('>'));
        let (local, _domain) = address.rsplit_once('@')?;
        let (_box, key) = local.split_once('+')?;
        (!key.is_empty()).then(|| key.to_lowercase())
    })
}

/// The routing gate (the platform's `findTriggerByInboundKey`): a message
/// reaches a listen when its address's plus-suffix is the listen's `key`, and
/// a listen with no key hears only the mail sent to the box itself. A suffix
/// no listen has reaches none: mail is never fanned out to every listen.
pub fn address_matches_key(event: &Js, config: &Obj) -> bool {
    let key = config.get(ROUTING_KEY).and_then(Js::as_str).map(str::to_lowercase);
    plus_suffix_of(event) == key
}

/// The line a message no listen is keyed for is refused with.
pub fn unrouted_line(external: &str, event: &Js) -> String {
    match plus_suffix_of(event) {
        Some(key) => format!("no listen on {external} has the key \"{key}\" (the plus-suffix of the address the message was sent to): it runs nothing"),
        None => format!("no listen on {external} is without a key, and the message was sent to the box itself, with no plus-suffix: it runs nothing"),
    }
}

/// `readPath`.
fn read_path<'a>(value: &'a Js, path: &str) -> Option<&'a Js> {
    path.split('.').try_fold(value, |at, key| at.get(key))
}

/// `discriminateEvent`'s choice: the event type the event is.
fn select_event_type<'a>(event: &Js, event_types: &'a [Js]) -> Option<&'a Js> {
    if let Some(tag) = event.get("tag") {
        return event_types.iter().find(|t| t.get("tag") == Some(tag));
    }
    let payload = event.get("payload").unwrap_or(&Js::Null);
    event_types.iter().find(|t| {
        let Some(matcher) = t.get("match") else { return false };
        let path = matcher.get("path").and_then(Js::as_str).unwrap_or_default();
        let Some(Js::Str(value)) = read_path(payload, path) else { return false };
        match matcher.get("equals") {
            Some(Js::Arr(options)) => options.iter().any(|o| o.as_str() == Some(value)),
            Some(Js::Str(equals)) => equals == value,
            _ => false,
        }
    })
}

/// Why an event names no record when it matches none of its module's event
/// types: the run is handed no record type for it, so a write to the
/// event's record cannot update it. `None` when it matches one, or the
/// module declares none.
pub fn untyped_event_line(external: &str, event: &Js, event_types: &[Js]) -> Option<String> {
    if event_types.is_empty() || select_event_type(event, event_types).is_some() {
        return None;
    }
    let tags: Vec<&str> = event_types.iter().filter_map(|t| t.get("tag").and_then(Js::as_str)).collect();
    Some(format!(
        "the event matched none of {external}'s event types (it carries no `tag`, and no type's `match` fits its payload), so it names no record of its own; its types' tags: {}",
        tags.join(", ")
    ))
}

/// `triggerEventOf`: the event as a run is handed it.
pub fn trigger_event_of(pipeline_input_id: &str, adapter_type: &str, event: &Js, event_types: &[Js], now: &str) -> Js {
    let root_record_type =
        if event_types.is_empty() { None } else { select_event_type(event, event_types).and_then(|t| t.get("positionType")).cloned() };
    let external_type = event.get("recordType").cloned().or_else(|| root_record_type.clone());
    let truthy = |v: &Js| !matches!(v, Js::Null | Js::Bool(false)) && v.as_str() != Some("");
    let mut out = Obj::new();
    out.insert("pipelineInputId".into(), Js::str(pipeline_input_id));
    out.insert("adapterType".into(), Js::str(adapter_type));
    out.insert("triggerType".into(), Js::str("webhook"));
    if let Some(payload) = event.get("payload") {
        out.insert("payload".into(), payload.clone());
    }
    if let Some(change) = event.get("changeType").filter(|v| truthy(v)) {
        out.insert("changeType".into(), change.clone());
    }
    if let Some(root) = root_record_type.filter(truthy) {
        out.insert("rootRecordType".into(), root);
    }
    if let Some(external_id) = event.get("externalId") {
        let mut reference = Obj::new();
        reference.insert("adapterType".into(), Js::str(adapter_type));
        reference.insert("externalId".into(), external_id.clone());
        if let Some(record_type) = external_type.filter(truthy) {
            reference.insert("recordType".into(), record_type);
        }
        out.insert("externalRecordRef".into(), Js::Obj(reference));
    }
    for key in ["actor", "changedFields", "idempotencyKey"] {
        if let Some(value) = event.get(key).filter(|v| truthy(v)) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("occurredAt".into(), event.get("occurredAt").filter(|v| !matches!(v, Js::Null)).cloned().unwrap_or_else(|| Js::str(now)));
    Js::Obj(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{MovementFile, Parsed};
    use std::path::PathBuf;

    /// Every listen across the files.
    fn collect_listens(files: &[MovementFile]) -> Vec<Listen> {
        listens_across(&Parsed::each(files, &[]))
    }

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_listen_is_read_with_its_construction_and_static_config() {
        let source = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n\nfunction welcome(company: <crm-[:Company]->>) {\n  write crm-[:Company]-> { Name: \"x\" }\n}\n\nlisten to crm { events: [\"company.created\"] } fire welcome\n";
        let files = vec![MovementFile { name: "companies".into(), path: PathBuf::from("companies.mvt"), source: source.into(), version: None }];
        let listens = collect_listens(&files);
        assert_eq!(listens.len(), 1);
        let listen = &listens[0];
        assert_eq!((listen.adapter.as_str(), listen.movement_name.as_str()), ("acme_crm", "welcome"));
        assert_eq!(Js::Obj(listen.config.clone()).to_json(), r#"{"events":["company.created"]}"#);
    }

    /// The table of cases the engine's TypeScript is held to as well
    /// (`listenHearsCredential`, `listenerHearsDelivery`).
    #[test]
    fn hears_matches_the_shared_table_of_cases() {
        let table: Json = serde_json::from_str(include_str!("../../../packages/engine-contracts/conformance/listen-hears.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let listen = Listen {
                file: "f".into(),
                adapter: "notes".into(),
                config: Obj::new(),
                movement_name: "m".into(),
                credential: case["listen"].as_str().map(str::to_string),
                payload: None,
                args: Vec::new(),
                address: Ok(BTreeMap::new()),
            };
            assert_eq!(listen.hears(case["delivery"].as_str()), case["hears"].as_bool().unwrap(), "{}", case["case"]);
        }
    }

    #[test]
    fn a_listens_scope_is_its_configs_values_of_the_scope_keys_in_order() {
        let config = match js(r#"{"table":"tblC","base":"appH","events":["record.updated"]}"#) {
            Js::Obj(config) => config,
            _ => unreachable!(),
        };
        let keys = ["base".to_string(), "table".to_string()];
        let scope = scope_of(&config, &keys).unwrap();
        assert_eq!(scope, [("base".to_string(), "appH".to_string()), ("table".to_string(), "tblC".to_string())]);
        assert_eq!(subscription_key(&scope), "appH.tblC");
        assert_eq!(scope_of(&config, &["base".to_string(), "shelf".to_string()]), Err(vec!["shelf".to_string()]));
        assert_eq!(scope_of(&config, &[]), Ok(vec![]), "a module that declares no scope keys has the empty scope");
        assert_eq!(subscription_key(&vec![("a".into(), "x.y/z ü".into())]), "x~2ey~2fz~20~c3~bc", "a key is one path segment, its separator unambiguous");
    }

    #[test]
    fn a_delivery_through_a_subscription_reaches_only_the_listens_of_its_scope() {
        let mut listen = Listen { file: "f".into(), adapter: "airtable".into(), config: Obj::new(), movement_name: "m".into(), credential: Some("acme".into()), args: vec![], payload: None, address: Ok(BTreeMap::new()) };
        listen.config.insert("base".into(), Js::str("appH"));
        listen.config.insert("table".into(), Js::str("tblC"));
        let keys = ["base".to_string(), "table".to_string()];
        assert!(listen.hears_through(Some("acme"), Some("appH.tblC"), &keys));
        assert!(!listen.hears_through(Some("acme"), Some("appH.tblI"), &keys), "another table's subscription");
        assert!(!listen.hears_through(Some("other"), Some("appH.tblC"), &keys), "another credential's");
        assert!(listen.hears_through(Some("acme"), None, &keys), "a delivery through no subscription is the credential's");
    }

    #[test]
    fn a_listen_names_its_constructions_credential_and_hears_only_its_deliveries() {
        let source = "import { inbox } from adapters\nimport { inbox_main as a_cred, `Inbox B` } from credentials\n\na = connect inbox using a_cred\nb = connect inbox using `Inbox B`\nc = connect inbox\n\nfunction noted() {\n}\n\nlisten to a fire noted\nlisten to b fire noted\nlisten to c fire noted\nlisten to manual fire noted\n";
        let files = vec![MovementFile { name: "noted".into(), path: PathBuf::from("noted.mvt"), source: source.into(), version: None }];
        let listens = collect_listens(&files);
        let credentials: Vec<Option<&str>> = listens.iter().map(|l| l.credential.as_deref()).collect();
        assert_eq!(credentials, [Some("inbox_main"), Some("Inbox B"), None, None], "an alias is resolved to the secrets' name");
        let (a, c) = (&listens[0], &listens[2]);
        assert!(a.hears(Some("inbox_main")) && !a.hears(Some("Inbox B")), "a listen hears only its own connection's deliveries");
        assert!(a.hears(None), "a delivery that names no credential reaches every listen");
        assert!(c.hears(Some("inbox_main")) && c.hears(None), "a listen whose construction names none hears every delivery");
    }

    #[test]
    fn a_listen_names_its_file_not_its_place() {
        let file = |name: &str, movement: &str| MovementFile {
            name: name.into(),
            path: PathBuf::from(format!("{name}.mvt")),
            source: format!("function {movement}() {{\n}}\n\nlisten to manual fire {movement}\n"),
            version: None,
        };
        let pairs = |files: &[MovementFile]| {
            let mut pairs: Vec<(String, String)> = collect_listens(files).into_iter().map(|l| (l.file, l.movement_name)).collect();
            pairs.sort();
            pairs
        };
        let (orders, alerts) = (file("orders/sync", "sync"), file("alerts", "alert"));
        let forward = pairs(&[orders.clone(), alerts.clone()]);
        assert_eq!(forward, vec![("alerts".to_string(), "alert".to_string()), ("orders/sync".to_string(), "sync".to_string())]);
        assert_eq!(pairs(&[alerts, orders]), forward);
    }

    #[test]
    fn the_scope_gate_reads_the_chosen_events_and_the_table() {
        let config = match js(r#"{"events":["company.created"]}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(event_matches_trigger_scope(&js(r#"{"eventType":"company.created"}"#), &config, Arrival::Pushed));
        assert!(!event_matches_trigger_scope(&js(r#"{"eventType":"company.updated"}"#), &config, Arrival::Pushed));
        assert!(!event_matches_trigger_scope(&js(r#"{}"#), &config, Arrival::Pushed));
        assert!(event_matches_trigger_scope(&js(r#"{}"#), &Obj::new(), Arrival::Pushed));
    }

    /// The table of cases the engine's TypeScript is held to as well
    /// (`eventMatchesTriggerScope`).
    #[test]
    fn the_field_and_becomes_gates_match_the_shared_table_of_cases() {
        let table = js(include_str!("../../../packages/engine-contracts/conformance/listen-field-change.json"));
        let cases = table.get("cases").and_then(Js::as_array).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let Some(Js::Obj(config)) = case.get("config") else { panic!("a case has a config") };
            let event = case.get("event").unwrap();
            let expected = Js::is_true(case.get("matches"));
            for arrival in [Arrival::Pushed, Arrival::Polled] {
                assert_eq!(event_matches_trigger_scope(event, config, arrival), expected, "{:?}", case.get("case"));
            }
        }
    }

    #[test]
    fn a_becomes_gate_compares_numbers_as_numbers() {
        let config = match js(r#"{"field":"Score","becomes":3}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        let event = js(r#"{"changedFields":["Score"],"payload":{"fields":{"Score":3.0},"previous":{"Score":2}}}"#);
        assert!(event_matches_trigger_scope(&event, &config, Arrival::Pushed));
        let unchanged = js(r#"{"changedFields":["Score"],"payload":{"fields":{"Score":3.0},"previous":{"Score":3}}}"#);
        assert!(!event_matches_trigger_scope(&unchanged, &config, Arrival::Pushed));
    }

    #[test]
    fn a_polled_event_with_no_event_type_is_not_narrowed_by_the_chosen_events() {
        let config = match js(r#"{"events":["company.created"],"table":"Company"}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(event_matches_trigger_scope(&js(r#"{}"#), &config, Arrival::Polled));
        assert!(event_matches_trigger_scope(&js(r#"{"eventType":"company.created"}"#), &config, Arrival::Polled));
        assert!(!event_matches_trigger_scope(&js(r#"{"eventType":"company.updated"}"#), &config, Arrival::Polled));
        assert!(!event_matches_trigger_scope(&js(r#"{"recordType":"Person"}"#), &config, Arrival::Polled));
    }

    #[test]
    fn a_declared_payload_takes_only_a_body_that_fits_it_and_names_what_does_not() {
        let source = "import { webhook } from adapters\nimport { StripeHook } from credentials\nstripe = connect webhook using StripeHook\ntype Currency = <\"usd\" | \"eur\">\nnode Charge {\n  id: <text>\n}\nnode Payment extends Charge {\n  amount: <number>\n  currency: <Currency>\n  note: <text | null>\n  meta: <json>\n  node card {\n    last4: <text>\n  }\n}\nfunction paid(e: <Payment>) {\n}\nfunction any(e: <Payment>) {\n}\nlisten to stripe { payload: <Payment> } fire paid\nlisten to stripe {} fire any\n";
        let files = vec![MovementFile { name: "payments".into(), path: PathBuf::from("payments.mvt"), source: source.into(), version: None }];
        let listens = collect_listens(&files);
        let (paid, any) = (&listens[0], &listens[1]);
        assert_eq!(paid.payload.as_ref().map(|p| p.name.as_str()), Some("Payment"));
        assert!(any.payload.is_none(), "a listen that declares no payload takes any body");
        let event = |payload: &str| js(&format!(r#"{{"payload":{payload}}}"#));
        let fits = event(r#"{"id":"pay_1","amount":12,"currency":"usd","meta":{"x":[1]},"card":{"last4":"4242"},"extra":true}"#);
        assert!(paid.takes(&fits) && any.takes(&fits));
        let misfits = |payload: &str| paid.payload.as_ref().unwrap().misfits(&js(payload));
        assert_eq!(
            misfits(r#"{"amount":"12","currency":"gbp","card":{"last4":4242}}"#),
            [
                "`id` is missing (text)",
                "`amount` is text, not a number",
                "`currency` is text, not one of \"usd\", \"eur\"",
                "`meta` is missing (any value)",
                "`card.last4` is a number, not text",
            ]
        );
        assert_eq!(misfits(r#"[1]"#), ["the body is a list, not an object"]);
        assert!(!paid.takes(&event(r#"{"id":"pay_1"}"#)) && any.takes(&event(r#"{"id":"pay_1"}"#)));
    }

    #[test]
    fn a_payload_node_imported_from_another_file_gates_like_one_declared_in_the_file() {
        let types = "type Currency = <\"usd\" | \"eur\">\nexport node Charge {\n  id: <text>\n}\nexport node Payment extends Charge {\n  amount: <number>\n  currency: <Currency>\n}\n";
        let hooks = "import { webhook } from adapters\nimport { StripeHook } from credentials\nimport { Payment as Paid } from \"types\"\nstripe = connect webhook using StripeHook\nfunction paid(e: <Paid>) {\n}\nlisten to stripe { payload: <Paid> } fire paid\n";
        let file = |name: &str, source: &str| MovementFile { name: name.into(), path: PathBuf::from(format!("{name}.mvt")), source: source.into(), version: None };
        let listens = collect_listens(&[file("hooks", hooks), file("types", types)]);
        let paid = &listens[0];
        assert_eq!(paid.payload.as_ref().map(|p| p.name.as_str()), Some("Paid"));
        let event = |payload: &str| js(&format!(r#"{{"payload":{payload}}}"#));
        assert!(paid.takes(&event(r#"{"id":"p","amount":1,"currency":"usd"}"#)));
        assert_eq!(
            paid.payload.as_ref().unwrap().misfits(&js(r#"{"amount":"1","currency":"gbp"}"#)),
            ["`id` is missing (text)", "`amount` is text, not a number", "`currency` is text, not one of \"usd\", \"eur\""],
            "the imported node's base and enum come from its own file"
        );
        assert!(!paid.takes(&event(r#"{"id":"p"}"#)));
    }

    #[test]
    fn mail_reaches_the_listen_keyed_by_its_plus_suffix_and_no_other() {
        let keyed = |key: &str| match js(&format!(r#"{{"key":"{key}"}}"#)) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        let listens = [("deals", keyed("deals")), ("intros", keyed("Intros")), ("box", Obj::new())];
        let reached = |recipient: &str| -> Vec<&str> {
            let event = js(&format!(r#"{{"payload":{{"recipient":"{recipient}"}}}}"#));
            listens.iter().filter(|(_, config)| address_matches_key(&event, config)).map(|(name, _)| *name).collect()
        };
        assert_eq!(reached("inbox+deals@acme.test"), ["deals"]);
        assert_eq!(reached("Inbox <inbox+INTROS@acme.test>"), ["intros"]);
        assert_eq!(reached("inbox@acme.test"), ["box"]);
        assert!(reached("inbox+hiring@acme.test").is_empty());
        let stray = js(r#"{"payload":{"recipient":"inbox+hiring@acme.test"}}"#);
        assert!(unrouted_line("email", &stray).contains(r#"no listen on email has the key "hiring""#));
        let vocabulary = match js(r#"{"listenConfig":[{"key":"key","required":false}]}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(routes_by_key(&vocabulary));
        assert!(!routes_by_key(&Obj::new()));
    }

    #[test]
    fn the_trigger_event_is_built_in_the_typescript_order() {
        let event = js(r#"{"payload":{"id":"c-1"},"externalId":"c-1","eventType":"company.created","changeType":"create","recordType":"Company"}"#);
        let types = vec![js(r#"{"tag":"company.created","positionType":"Company"}"#)];
        assert_eq!(
            trigger_event_of("listen:companies:welcome", "acme_crm", &event, &types, "2026-10-17T00:00:00.000Z").to_json(),
            r#"{"pipelineInputId":"listen:companies:welcome","adapterType":"acme_crm","triggerType":"webhook","payload":{"id":"c-1"},"changeType":"create","externalRecordRef":{"adapterType":"acme_crm","externalId":"c-1","recordType":"Company"},"occurredAt":"2026-10-17T00:00:00.000Z"}"#
        );
        let tagged = js(r#"{"payload":{},"tag":"company.created"}"#);
        assert_eq!(trigger_event_of("p", "a", &tagged, &types, "t").get("rootRecordType").and_then(Js::as_str), Some("Company"));
    }

    #[test]
    fn an_event_matching_no_event_type_is_said_to_name_no_record() {
        let types = vec![js(r#"{"tag":"company.created","positionType":"Company"}"#), js(r#"{"tag":"company.updated","positionType":"Company"}"#)];
        let labelled_only = js(r#"{"payload":{},"eventType":"company.created"}"#);
        let line = untyped_event_line("acme_crm", &labelled_only, &types).expect("an eventType is not a tag");
        assert!(line.contains("matched none of acme_crm's event types"), "{line}");
        assert!(line.ends_with("company.created, company.updated"), "{line}");
        assert_eq!(untyped_event_line("acme_crm", &js(r#"{"payload":{},"tag":"company.created"}"#), &types), None);
        assert_eq!(untyped_event_line("acme_crm", &labelled_only, &[]), None);
    }
}
