//! Routing read from source: every `listen … fire …` across the project's
//! files is the routing table (as movement-engine's
//! `movement/file_listeners.ts` reads it), plus the scope gate an inbound event must
//! clear to reach a listen (`triggers/listen_config.ts`) and the trigger
//! event a run is handed (`triggers/trigger_event.ts`, with
//! `engine/inbound/discriminate.ts`).

use std::collections::{BTreeMap, HashMap};

use std::rc::Rc;

use movement_engine::listen_judge::{ArrivedRecord, PlanArrival, Verdict, judge_arrival};
use movement_engine::listen_landing::{DeclaredPayload, FileScope};
use movement_parser::ast::{NamedArg, RValue, Statement};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::listen_plan::ListenPlan;
use movement_parser::util::form::external_text;
use serde_json::Value as Json;

use crate::arrivals::ArrivalIn;
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
    /// How a listen on a traversal (`listen to crm-[c:Company WHERE …]->`)
    /// is watched, as the checker planned it: arrivals on its last edge fire
    /// it, never events. None for a listen in the settings form, which
    /// events fire and arrivals never do.
    pub plan: Option<ListenPlan>,
    /// The edges its fired function waits on off its parameter, as the
    /// checker stamps them (`opensWaits` on the parameter): a delivery that
    /// fires it opens its run's waits on them as it is kept, so what lands
    /// while the run sits in the queue still counts. Empty for a listen in
    /// the settings form.
    pub trigger_awaits: Vec<String>,
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

    /// The listen's pipeline: what its receipts, its runs, its polls and
    /// its resolved heads name it by. `listen:<file>:<movement>` for one in
    /// the settings form; one on a traversal adds the first 8 hex digits of
    /// the sha256 of its plan's identity and of its connection's
    /// construction, so two in one file that fire one function are two
    /// listens, and so is one whose connection is constructed with another
    /// credential or other arguments: each has its own receipts, and its own
    /// heads, listed afresh.
    pub fn pipeline(&self) -> String {
        match &self.plan {
            None => format!("listen:{}:{}", self.file, self.movement_name),
            Some(plan) => {
                use sha2::{Digest, Sha256};
                let mut args = self.args.clone();
                args.sort();
                let construction = serde_json::json!({ "credential": self.credential, "args": args });
                let named = format!("{}\n{construction}", plan.identity());
                let digest: String = Sha256::digest(named.as_bytes()).iter().take(4).map(|byte| format!("{byte:02x}")).collect();
                format!("listen:{}:{}:{digest}", self.file, self.movement_name)
            }
        }
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

    /// Whether it is a listen on a traversal of `adapter` whose last edge is `edge`.
    pub fn is_on(&self, adapter: &str, edge: &str) -> bool {
        self.adapter == adapter && self.plan.as_ref().and_then(|plan| plan.hops.last()).is_some_and(|hop| hop.edge == edge)
    }

    /// Whether `arrival`, delivered for `credential`, fires this listen at
    /// `now_ms`, as the judge finds its filters. None when the arrival is not
    /// this listen's to judge: it is in the settings form, the arrival came
    /// for another connection, or it is marked for this listen's own sake
    /// (`notFor` its pipeline); nothing is said of those. An arrival with no
    /// landing skips at the last hop.
    pub fn fires(&self, arrival: &ArrivalIn, credential: Option<&str>, now_ms: f64) -> Option<Verdict> {
        let plan = self.plan.as_ref()?;
        if !self.hears(credential) || arrival.not_for.as_deref().is_some_and(|not_for| not_for == self.pipeline()) {
            return None;
        }
        let arrived = |record: &Js| {
            let fields = record.get("fields")?;
            Some(ArrivedRecord { record_type: record.get("recordType").and_then(Js::as_str).map(str::to_string), fields: json_of(fields) })
        };
        let Some(landing) = arrival.landing.as_ref().and_then(arrived) else {
            return Some(Verdict::Skips { hop: plan.hops.len().saturating_sub(1), reason: None });
        };
        let planned = PlanArrival {
            edge: arrival.edge.clone(),
            key: arrival.key.clone(),
            landing,
            parents: arrival.parents.iter().map(arrived).collect(),
            taken_applied: arrival.taken_applied,
        };
        Some(judge_arrival(plan, &planned, now_ms))
    }

    /// What of an arrival's landing does not fit the node the listen states
    /// it is (`-[:Requests]-><Payment>`), one line each; empty when it fits,
    /// or the listen states none.
    pub fn misfits(&self, arrival: &ArrivalIn) -> Vec<String> {
        let Some(declared) = &self.payload else { return Vec::new() };
        declared.misfits(&arrival.landing.as_ref().and_then(|landing| landing.get("fields")).map_or(Json::Null, json_of))
    }

    /// Whether an event's payload fits the node the listen declares; a
    /// listen that declares none takes any.
    pub fn takes(&self, event: &Js) -> bool {
        self.payload.as_ref().is_none_or(|declared| declared.misfits(&event.get("payload").map_or(Json::Null, json_of)).is_empty())
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

/// The listens of a set of files, and a line for each one written there
/// that would never fire.
#[derive(Debug, Default)]
pub struct Listens {
    pub listens: Vec<Listen>,
    /// Each listen that would never fire, named where it is written: a
    /// listen on a traversal the checker plans nothing for (it does not
    /// check, or the catalog does not load), or a listen on a connection the
    /// file does not make. A session that routes refuses the set for them;
    /// one that only runs a function reads the listens it has.
    pub unwatched: Vec<String>,
}

/// `collectListens`: the listens of every file that parses. A payload node
/// the listen's file imports from another file is read from that file, the
/// way the checker links it, so the listens of a set depend on the whole set
/// and not on one file's text. A listen on a traversal is read from the
/// checker's plan of it against `catalog`; a file with one the checker plans
/// none for still has its other listens read.
pub fn listens_across(parsed: &[Rc<crate::sources::Parsed>], catalog: &Js) -> Listens {
    let programs: Vec<(&crate::sources::Parsed, &movement_parser::ast::Program)> = parsed.iter().filter_map(|p| p.program.as_ref().ok().map(|program| (&**p, program))).collect();
    let scopes: HashMap<String, FileScope<'_>> = programs.iter().map(|(file, program)| (file.name.clone(), FileScope::of(program))).collect();
    let mut snapshot = None;
    let mut read = Listens::default();
    for (file, program) in &programs {
        let (plans, unplanned) = match program.statements.iter().any(|s| matches!(s, Statement::Listen(listen) if listen.path.is_some())) {
            true => plans_of(file, program, snapshot.get_or_insert_with(|| catalog_snapshot(catalog)).as_ref()),
            false => (Vec::new(), Vec::new()),
        };
        read.unwatched.extend(unplanned);
        listens_of(file, program, &scopes, plans, &mut read);
    }
    read
}

/// The catalog as the checker reads it, or why it does not load.
fn catalog_snapshot(catalog: &Js) -> Result<CatalogSnapshot, String> {
    CatalogSnapshot::load(&movement_parser::util::form::read_json_text(&catalog.to_json())).map_err(|e| e.to_string())
}

/// Where a listen is written, as a line about it begins.
fn listen_at(file: &crate::sources::Parsed, at: movement_parser::ast::Loc) -> String {
    format!("{}:{}:{}", file.path.display(), at.line, at.col)
}

/// How the checker plans each `listen to <traversal>` of `file`, in source
/// order, and a line for each it plans none for, naming where it is written.
fn plans_of(file: &crate::sources::Parsed, program: &movement_parser::ast::Program, catalog: Result<&CatalogSnapshot, &String>) -> (Vec<(ListenPlan, Vec<String>)>, Vec<String>) {
    let traversals = || {
        program.statements.iter().filter_map(|s| match s {
            Statement::Listen(listen) if listen.path.is_some() => Some(listen),
            _ => None,
        })
    };
    let unwatched = |at: movement_parser::ast::Span, why: &str| {
        let fires = traversals().find(|listen| listen.span == at).map_or_else(|| "a listen".to_string(), |listen| format!("the listen that fires {}", listen.movement));
        format!("{} {fires} {why}, so nothing would fire it", listen_at(file, at.start))
    };
    let catalog = match catalog {
        Ok(catalog) => catalog,
        Err(why) => return (Vec::new(), traversals().map(|listen| unwatched(listen.span, &format!("is not planned, as the catalog does not load ({why})"))).collect()),
    };
    // The file's own parse is checked: lf parses with every slot marked for
    // the eager export (`ExprSlot::eager`), which the checker never reads.
    let options = movement_checker::CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let answer = movement_checker::answer::check_answer(program, catalog, options);
    let planned = answer.listens.into_iter().map(|plan| {
        let awaits = trigger_awaits_of(program, &answer.stamps, &plan.movement);
        (plan, awaits)
    });
    (planned.collect(), answer.unwatched.iter().map(|at| unwatched(*at, "does not check")).collect())
}

/// The edges the check stamps as opening waits on the parameter of the
/// function `movement` declared in `program`, where a run of it enters its
/// trigger (`/statements/<index>/params/0`).
fn trigger_awaits_of(program: &movement_parser::ast::Program, stamps: &[serde_json::Value], movement: &str) -> Vec<String> {
    let Some(index) = program.statements.iter().position(|s| matches!(s, Statement::Movement(declared) if declared.name == movement)) else { return Vec::new() };
    let path = format!("/statements/{index}/params/0");
    stamps
        .iter()
        .filter(|stamp| stamp.get("file").is_none() && stamp.get("path").and_then(serde_json::Value::as_str) == Some(path.as_str()))
        .find_map(|stamp| stamp.get("opensWaits")?.as_array().map(|edges| edges.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()))
        .unwrap_or_default()
}

/// Each instance's adapter, credential and other arguments, by the
/// instance's name: the connections `program` makes itself. A file cannot
/// export a connection, so a listen's instance is one of these or a host unit.
fn constructions_of(program: &movement_parser::ast::Program) -> HashMap<String, (String, Option<String>, Vec<(String, String)>)> {
    let originals = import_originals(program);
    let mut constructions = HashMap::new();
    for statement in &program.statements {
        if let Statement::Assign(assign) = statement
            && let RValue::Construct { construct } = &assign.value
        {
            let adapter = originals.get(&construct.callee).cloned().unwrap_or_else(|| construct.callee.clone());
            let credential = construct
                .args
                .iter()
                .find(|a| a.name == CREDENTIAL_ARG)
                .and_then(|a| movement_parser::catalog::helpers::unwrap_credential_arg(&a.value.raw))
                .map(|local| originals.get(&local).cloned().unwrap_or(local));
            let mut args: Vec<(String, String)> = construct.args.iter().filter(|a| a.name != CREDENTIAL_ARG).map(|a| (a.name.clone(), a.value.raw.clone())).collect();
            args.sort();
            constructions.insert(assign.name.clone(), (adapter, credential, args));
        }
    }
    constructions
}

/// Each name `program` imports under an alias, to the name it imports.
fn import_originals(program: &movement_parser::ast::Program) -> HashMap<String, String> {
    let mut originals = HashMap::new();
    for statement in &program.statements {
        if let Statement::Import(import) = statement {
            for name in &import.names {
                if let Some(alias) = &name.alias {
                    originals.insert(alias.clone(), name.name.clone());
                }
            }
        }
    }
    originals
}

/// The listens of one file into `read`: each in the settings form, then each
/// of `plans`. One whose instance is neither a connection the file makes nor
/// a host unit is named in `read.unwatched` instead.
fn listens_of(file: &crate::sources::Parsed, program: &movement_parser::ast::Program, scopes: &HashMap<String, FileScope<'_>>, plans: Vec<(ListenPlan, Vec<String>)>, read: &mut Listens) {
    let constructions = constructions_of(program);
    let scope = &scopes[&file.name];
    let connection = |instance: &str, at: movement_parser::ast::Loc, fires: &str| {
        // A unit the file does not bind itself is the host's own.
        let unit = movement_parser::version::RUN_HOST_UNITS.iter().find(|u| **u == instance).map(|u| (u.to_string(), None, Vec::new()));
        constructions.get(instance).cloned().or(unit).ok_or_else(|| {
            let why = match scope.imports(instance) {
                true => "is imported from another file, which cannot make a connection",
                false => "is no connection this file makes",
            };
            format!("{} the listen that fires {fires} is on `{instance}`, which {why}, so nothing would fire it", listen_at(file, at))
        })
    };
    let declared = program.statements.iter().filter_map(|s| match s {
        Statement::Listen(listen) if listen.path.is_none() => Some(listen),
        _ => None,
    });
    for listen in declared {
        let (adapter, credential, args) = match connection(&listen.instance, listen.span.start, &listen.movement) {
            Ok(made) => made,
            Err(line) => {
                read.unwatched.push(line);
                continue;
            }
        };
        let mut config = Obj::new();
        for arg in &listen.config {
            config.insert(arg.name.clone(), config_value_of(arg));
        }
        // The checker takes a type only for a key of the `type` format: a
        // node the program declares.
        let payload = listen.config.iter().filter(|a| a.is_type == Some(true)).find_map(|a| DeclaredPayload::of(&a.value.raw, scope, scopes));
        read.listens.push(Listen {
            file: file.name.clone(),
            adapter,
            config,
            movement_name: listen.movement.clone(),
            credential,
            payload,
            args,
            address: Ok(BTreeMap::new()),
            plan: None,
            trigger_awaits: Vec::new(),
        });
    }
    for (plan, trigger_awaits) in plans {
        let written = program.statements.iter().find_map(|s| match s {
            Statement::Listen(listen) if listen.path.is_some() && listen.instance == plan.connection && listen.movement == plan.movement => Some(listen.span.start),
            _ => None,
        });
        let (adapter, credential, args) = match connection(&plan.connection, written.unwrap_or(movement_parser::ast::Loc { line: 1, col: 1 }), &plan.movement) {
            Ok(made) => made,
            Err(line) => {
                read.unwatched.push(line);
                continue;
            }
        };
        // The node the listen states its untyped landing is: what lands
        // reaches it only when it fits.
        let payload = plan.landing.as_deref().and_then(|name| DeclaredPayload::of(name, scope, scopes));
        read.listens.push(Listen {
            file: file.name.clone(),
            adapter,
            config: Obj::new(),
            movement_name: plan.movement.clone(),
            credential,
            payload,
            args,
            address: Ok(BTreeMap::new()),
            plan: Some(plan),
            trigger_awaits,
        });
    }
}

/// A record's fields as the judge reads them.
fn json_of(value: &Js) -> Json {
    serde_json::from_str(&value.to_json()).unwrap_or(Json::Null)
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

/// The arrival a listen on a traversal fires on, as its run is handed it:
/// the engine binds the fired function's parameter to `arrival.landing`, as
/// a wait binds what lands on its edge.
pub fn arrival_trigger_of(pipeline_input_id: &str, adapter_type: &str, arrival: &ArrivalIn, now: &str) -> Js {
    let mut landed = Obj::new();
    landed.insert("adapterType".into(), Js::str(adapter_type));
    landed.insert("edge".into(), Js::str(&arrival.edge));
    landed.insert("landing".into(), arrival.landing.clone().unwrap_or(Js::Null));
    if !arrival.parents.is_empty() {
        landed.insert("parents".into(), Js::Arr(arrival.parents.clone()));
    }
    let mut out = Obj::new();
    out.insert("pipelineInputId".into(), Js::str(pipeline_input_id));
    out.insert("adapterType".into(), Js::str(adapter_type));
    out.insert("triggerType".into(), Js::str("arrival"));
    out.insert("arrival".into(), Js::Obj(landed));
    out.insert("occurredAt".into(), Js::str(now));
    Js::Obj(out)
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
        listens_across(&Parsed::each(files, &[]), &Js::Null).listens
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

    /// A CRM whose companies are a listenable root, delivered to the
    /// connection; a company's comments a listenable edge.
    const CRM_CATALOG: &str = r#"{"adapters":{"acme_crm":{"canFire":true,"constructionArgs":[],"schemas":{"":{"positions":{
      "Company":{"properties":{"id":"text","Name":"text"},"edges":{"Comments":{"target":"Comment","listenable":true,"identity":"Id","delivery":"connection"}}},
      "Comment":{"properties":{"Id":"text","Text":"text"},"edges":{}}},
      "collections":{"Company":{"target":"Company","listenable":true,"identity":"id","delivery":"connection"}},
      "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

    /// Two listens on the CRM's companies, one on its comments, and one in
    /// the settings form, in a file `crm`.
    const CRM_LISTENS: &str = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n\nfunction welcome(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nfunction note(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nfunction answer(k: <crm-[:Comment]->>) {\n  return k.Text\n}\n\nlisten to crm-[c:Company WHERE c.Name != \"Ignored\"]-> fire welcome\nlisten to crm-[:Company]-> fire note\nlisten to crm-[:Company]->-[:Comments]-> fire answer\nlisten to crm { events: [\"company.created\"] } fire welcome\n";

    fn crm_listens() -> Vec<Listen> {
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: CRM_LISTENS.into(), version: None }];
        let read = listens_across(&Parsed::each(&files, &[]), &js(CRM_CATALOG));
        assert_eq!(read.unwatched, Vec::<String>::new());
        read.listens
    }

    /// An arrival of a company on the CRM's root edge, its fields as given.
    fn company(fields: &str) -> ArrivalIn {
        landed_as("Company", fields)
    }

    /// An arrival on the CRM's root edge whose landing says it is a `record_type`.
    fn landed_as(record_type: &str, fields: &str) -> ArrivalIn {
        let text = format!(r#"{{"arrivals":[{{"edge":"Company","identity":"company-1","landing":{{"recordId":"company-1","recordType":"{record_type}","fields":{fields}}}}}]}}"#);
        crate::arrivals::arrivals_of(&js(&text)).unwrap().remove(0)
    }

    #[test]
    fn a_listen_on_a_traversal_is_read_from_its_plan_beside_the_settings_listens() {
        let listens = crm_listens();
        let read: Vec<(&str, Option<&str>, Option<&str>, bool)> =
            listens.iter().map(|l| (l.movement_name.as_str(), l.credential.as_deref(), l.plan.as_ref().and_then(|p| p.hops.last()).map(|h| h.edge.as_str()), l.config.is_empty())).collect();
        assert_eq!(
            read,
            [("welcome", Some("acme"), None, false), ("welcome", Some("acme"), Some("Company"), true), ("note", Some("acme"), Some("Company"), true), ("answer", Some("acme"), Some("Comments"), true)]
        );
        assert_eq!(listens[1].adapter, "acme_crm");
        assert!(listens[1].is_on("acme_crm", "Company") && !listens[1].is_on("acme_crm", "Comments") && !listens[0].is_on("acme_crm", "Company"));
    }

    #[test]
    fn a_listen_on_a_traversal_is_named_by_its_file_its_function_its_plan_and_its_connection() {
        let listens = crm_listens();
        assert_eq!(listens[0].pipeline(), "listen:crm:welcome", "the settings form keeps its name");
        let identity = listens[1].plan.as_ref().unwrap().identity();
        use sha2::{Digest, Sha256};
        let named = format!("{identity}\n{}", r#"{"args":[],"credential":"acme"}"#);
        let digest: String = Sha256::digest(named.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect();
        assert_eq!(listens[1].pipeline(), format!("listen:crm:welcome:{digest}"));
        // A connection constructed otherwise is another listen.
        let elsewhere = Listen { credential: Some("acme_b".into()), ..listens[1].clone() };
        assert_ne!(elsewhere.pipeline(), listens[1].pipeline(), "another credential");
        let based = |args: &[(&str, &str)]| Listen { args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), ..listens[1].clone() };
        assert_ne!(based(&[("base", "\"one\"")]).pipeline(), listens[1].pipeline(), "other arguments");
        assert_eq!(based(&[("base", "\"one\""), ("space", "\"s\"")]).pipeline(), based(&[("space", "\"s\""), ("base", "\"one\"")]).pipeline(), "in any order");
        // Two listens in one file firing one function on two paths are two listens.
        let twice = CRM_LISTENS.replace("listen to crm-[:Company]-> fire note", "listen to crm-[c:Company WHERE c.Name != \"Other\"]-> fire welcome");
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: twice, version: None }];
        let listens = listens_across(&Parsed::each(&files, &[]), &js(CRM_CATALOG)).listens;
        let welcomes: Vec<String> = listens.iter().filter(|l| l.plan.is_some() && l.movement_name == "welcome").map(Listen::pipeline).collect();
        assert_eq!(welcomes.len(), 2);
        assert_ne!(welcomes[0], welcomes[1]);
    }

    #[test]
    fn a_listen_on_a_traversal_the_check_plans_nothing_for_is_named_where_it_is_written_and_the_files_other_listens_read() {
        // Without a catalog the checker plans nothing.
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: CRM_LISTENS.into(), version: None }];
        let read = listens_across(&Parsed::each(&files, &[]), &Js::Null);
        assert_eq!(read.unwatched.len(), 3, "{:?}", read.unwatched);
        assert!(read.unwatched[0].starts_with("crm.mvt:18:1 the listen that fires welcome is not planned, as the catalog does not load ("), "{:?}", read.unwatched);
        assert!(read.unwatched[0].ends_with(", so nothing would fire it"), "{:?}", read.unwatched);
        let settings: Vec<(&str, bool)> = read.listens.iter().map(|l| (l.movement_name.as_str(), l.plan.is_some())).collect();
        assert_eq!(settings, [("welcome", false)], "the listen in the settings form is still read");
        // One the check refuses: its WHERE reads a field companies do not have.
        let bogus = CRM_LISTENS.replace("listen to crm-[:Company]-> fire note", "listen to crm-[c:Company WHERE c.Bogus == \"x\"]-> fire note");
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: bogus, version: None }];
        let read = listens_across(&Parsed::each(&files, &[]), &js(CRM_CATALOG));
        assert_eq!(read.unwatched, ["crm.mvt:19:1 the listen that fires note does not check, so nothing would fire it"]);
        let kept: Vec<(&str, bool)> = read.listens.iter().map(|l| (l.movement_name.as_str(), l.plan.is_some())).collect();
        assert_eq!(kept, [("welcome", false), ("welcome", true), ("answer", true)], "the file's other listens are read");
    }

    #[test]
    fn a_listen_on_a_connection_imported_from_another_file_is_named_in_either_form() {
        // The checker refuses both (a file exports no connection: MOV_IMPORT_NOT_EXPORTED, MOV_LISTEN_NOT_INSTANCE).
        let connections = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n";
        let listening = "import { crm } from \"connections\"; import { bell } from adapters; own = connect bell\n\nfunction welcome(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nlisten to crm { events: [\"company.created\"] } fire welcome\nlisten to own fire welcome\n";
        let file = |name: &str, source: &str| MovementFile { name: name.into(), path: PathBuf::from(format!("{name}.mvt")), source: source.into(), version: None };
        let read = listens_across(&Parsed::each(&[file("connections", connections), file("welcome", listening)], &[]), &Js::Null);
        assert_eq!(read.unwatched, ["welcome.mvt:7:1 the listen that fires welcome is on `crm`, which is imported from another file, which cannot make a connection, so nothing would fire it"]);
        assert_eq!(read.listens.iter().map(|l| l.adapter.as_str()).collect::<Vec<_>>(), ["bell"], "the file's listen on its own connection is read");
        // On a traversal, the checker plans nothing for it.
        let traversal = listening.replace("listen to crm { events: [\"company.created\"] } fire welcome", "listen to crm-[:Company]-> fire welcome");
        let mut catalog = js(CRM_CATALOG);
        if let Js::Obj(top) = &mut catalog {
            top.insert("files".into(), js(&format!(r#"{{"connections":{{"source":{}}}}}"#, Js::str(connections).to_json())));
        }
        let read = listens_across(&Parsed::each(&[file("connections", connections), file("welcome", &traversal)], &[]), &catalog);
        assert_eq!(read.unwatched, ["welcome.mvt:7:1 the listen that fires welcome does not check, so nothing would fire it"]);
    }

    #[test]
    fn a_listen_on_a_traversal_fires_on_an_arrival_its_where_takes_and_skips_one_it_does_not() {
        let listens = crm_listens();
        let welcome = &listens[1];
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","Name":"Osprey"}"#), Some("acme"), 0.0), Some(Verdict::Fires));
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","Name":"Ignored"}"#), Some("acme"), 0.0), Some(Verdict::Skips { hop: 0, reason: None }));
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","Name":"Osprey"}"#), Some("another"), 0.0), None, "another connection's");
        assert_eq!(listens[0].fires(&company(r#"{"Name":"Osprey"}"#), Some("acme"), 0.0), None, "a settings listen takes events, never arrivals");
    }

    #[test]
    fn an_arrival_on_the_listened_edge_name_fires_only_when_it_landed_on_the_record_type_the_listen_lands_on() {
        let welcome = &crm_listens()[1];
        let osprey = r#"{"id":"company-1","Name":"Osprey"}"#;
        assert_eq!(welcome.fires(&landed_as("Comment", osprey), Some("acme"), 0.0), Some(Verdict::Skips { hop: 0, reason: Some("it has record type Comment, not Company, which this listen's Company lands on".into()) }), "another record type's edge of the same name");
        let untyped = crate::arrivals::arrivals_of(&js(&format!(r#"{{"arrivals":[{{"edge":"Company","identity":"company-1","landing":{{"fields":{osprey}}}}}]}}"#))).unwrap().remove(0);
        assert_eq!(
            welcome.fires(&untyped, Some("acme"), 0.0),
            Some(Verdict::Undecided { reason: "the arrival acme_crm reported on Company does not say its record type, so it cannot be told from another record type's Company (this listen's lands on Company)".into() })
        );
    }

    #[test]
    fn an_arrival_marked_not_for_a_listen_runs_every_other_listen_on_its_edge_and_not_that_one() {
        let listens = crm_listens();
        let mut arrival = company(r#"{"id":"company-1","Name":"Osprey"}"#);
        arrival.not_for = Some(listens[2].pipeline());
        let on_edge: Vec<(&str, Option<Verdict>)> =
            listens.iter().filter(|l| l.is_on("acme_crm", "Company")).map(|l| (l.movement_name.as_str(), l.fires(&arrival, Some("acme"), 0.0))).collect();
        assert_eq!(on_edge, [("welcome", Some(Verdict::Fires)), ("note", None)], "the listen it is not for is not judged, so nothing is said of it");
    }

    #[test]
    fn an_arrival_is_handed_to_its_run_as_the_landing_it_carries() {
        let arrival = company(r#"{"id":"company-1","Name":"Osprey"}"#);
        assert_eq!(
            arrival_trigger_of("listen:crm:welcome", "acme_crm", &arrival, "2026-10-31T00:00:00.000Z").to_json(),
            r#"{"pipelineInputId":"listen:crm:welcome","adapterType":"acme_crm","triggerType":"arrival","arrival":{"adapterType":"acme_crm","edge":"Company","landing":{"recordId":"company-1","recordType":"Company","fields":{"id":"company-1","Name":"Osprey"}}},"occurredAt":"2026-10-31T00:00:00.000Z"}"#
        );
    }

    /// The pipelines the TypeScript host names the same listens by
    /// (movement-engine `listenPipeline`): one table, read by both.
    #[test]
    fn a_listen_on_a_traversal_is_named_as_the_shared_table_of_pipelines_names_it() {
        let table: Json = serde_json::from_str(include_str!("../../../packages/engine-contracts/conformance/listen-pipelines.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let plan: ListenPlan = serde_json::from_value(case["plan"].clone()).unwrap();
            // Pairs, in the order the construction writes them: a JSON object would reach here sorted.
            let args = case["args"].as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_string(), pair[1].as_str().unwrap().to_string())).collect();
            let listen = Listen {
                file: case["file"].as_str().unwrap().into(),
                adapter: plan.adapter.clone(),
                config: Obj::new(),
                movement_name: plan.movement.clone(),
                credential: case["credential"].as_str().map(str::to_string),
                payload: None,
                args,
                address: Ok(BTreeMap::new()),
                plan: Some(plan),
                trigger_awaits: Vec::new(),
            };
            assert_eq!(listen.pipeline(), case["pipeline"].as_str().unwrap(), "{}", case["case"]);
        }
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
                plan: None, trigger_awaits: Vec::new(),
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
        let mut listen = Listen {
            file: "f".into(),
            adapter: "airtable".into(),
            config: Obj::new(),
            movement_name: "m".into(),
            credential: Some("acme".into()),
            args: vec![],
            payload: None,
            address: Ok(BTreeMap::new()),
            plan: None,
            trigger_awaits: Vec::new(),
        };
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
        let source = "import { inbox } from adapters\nimport { inbox_main as a_cred, `Inbox B` } from credentials\n\na = connect inbox using a_cred\nb = connect inbox using `Inbox B`\nc = connect inbox\n\nfunction noted() {\n}\n\nlisten to a fire noted\nlisten to b fire noted\nlisten to c fire noted\n";
        let files = vec![MovementFile { name: "noted".into(), path: PathBuf::from("noted.mvt"), source: source.into(), version: None }];
        let listens = collect_listens(&files);
        let credentials: Vec<Option<&str>> = listens.iter().map(|l| l.credential.as_deref()).collect();
        assert_eq!(credentials, [Some("inbox_main"), Some("Inbox B"), None], "an alias is resolved to the secrets' name");
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
            source: format!("import {{ bell }} from adapters\nb = connect bell\n\nfunction {movement}() {{\n}}\n\nlisten to b fire {movement}\n"),
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
        // The lines themselves are the engine's (movement_engine::listen_landing,
        // held to conformance/listen-landings.json).
        assert!(!paid.takes(&event(r#"[1]"#)));
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
        assert!(!paid.takes(&event(r#"{"id":"p","amount":1,"currency":"gbp"}"#)), "the imported node's enum comes from its own file");
        assert!(!paid.takes(&event(r#"{"amount":1,"currency":"usd"}"#)), "the imported node's base comes from its own file");
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
