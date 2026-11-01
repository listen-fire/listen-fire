//! Routing read from source: every `listen to <traversal> fire …` across
//! the project's files is the routing table, each as the checker plans it,
//! and the arrival a run it fires is handed.

use std::collections::HashMap;

use std::rc::Rc;

use movement_engine::listen_judge::{ArrivedRecord, PlanArrival, Verdict, judge_arrival, named_fields};
use movement_engine::listen_landing::{DeclaredPayload, FileScope};
use movement_parser::ast::{RValue, Statement};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::listen_plan::{HopJudged, ListenPlan};
use serde_json::Value as Json;

use crate::arrivals::ArrivalIn;
use crate::json::{Js, Obj};

/// One `listen` statement, with its instance's construction resolved (`FileListener`).
#[derive(Debug, Clone)]
pub struct Listen {
    /// The file it is in, by name.
    pub file: String,
    /// The adapter slug (the construction's callee, import alias resolved).
    pub adapter: String,
    pub movement_name: String,
    /// The credential its construction names (`connect … using X`), by its
    /// name in the secrets (an import alias resolved); None when the
    /// construction names none, and for a host unit.
    pub credential: Option<String>,
    /// The node it states its untyped landing is (`-[:Requests]-><Payment>`):
    /// an arrival whose landing does not fit it never reaches the listen.
    pub payload: Option<DeclaredPayload>,
    /// Its construction's other arguments (`{ base: "CRM" }`), by name, as
    /// their source text: those the module declares as position args say
    /// which position the connection is in (RunningExternal::position_settings).
    pub args: Vec<(String, String)>,
    /// How it is watched, as the checker planned its traversal
    /// (`listen to crm-[c:Company WHERE …]->`): arrivals on its last edge
    /// fire it.
    pub plan: ListenPlan,
    /// The edges its fired function waits on off the records a delivery
    /// hands its run: a delivery that fires it opens its run's waits on them
    /// as it is kept, so what lands while the run sits in the queue still
    /// counts.
    pub trigger_awaits: TriggerAwaits,
    /// Each record type its connection's module keys some fields of by ids
    /// other than their names, as the catalog says (`fieldIds`): an
    /// arrival's records are read by name before they are judged.
    pub field_ids: FieldIds,
}

/// Each record type's `fieldIds` in a connection's schema (name → id), by
/// the record type's name; only types that have any.
pub type FieldIds = HashMap<String, serde_json::Map<String, Json>>;

/// The edges a fired function waits on off the records its run is handed at
/// delivery, as the checker stamps them on its parameter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TriggerAwaits {
    /// Off the trigger itself (`opensWaits`).
    pub own: Vec<String>,
    /// Off each record the arrival carries, aligned to its `parents` (the
    /// plan's `carries`): the edges awaited off the record type its carried
    /// hop lands on (`carriedAwaits`).
    pub carried: Vec<Vec<String>>,
}

impl Listen {
    /// The listen's pipeline: what its receipts, its runs, its polls and
    /// its resolved heads name it by: `listen:<file>:<movement>:` and the
    /// first 8 hex digits of the sha256 of its plan's identity and of its
    /// connection's construction, so two in one file that fire one function
    /// are two listens, and so is one whose connection is constructed with
    /// another credential or other arguments: each has its own receipts, and
    /// its own heads, listed afresh.
    pub fn pipeline(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut args = self.args.clone();
        args.sort();
        let construction = serde_json::json!({ "credential": self.credential, "args": args });
        let named = format!("{}\n{construction}", self.plan.identity());
        let digest: String = Sha256::digest(named.as_bytes()).iter().take(4).map(|byte| format!("{byte:02x}")).collect();
        format!("listen:{}:{}:{digest}", self.file, self.movement_name)
    }

    /// Whether a delivery for `credential` reaches this listen (the
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
        self.adapter == adapter && self.plan.hops.last().is_some_and(|hop| hop.edge == edge)
    }

    /// Whether an arrival on `edge` of `adapter` is this listen's: it fires on
    /// it (`is_on`), or `edge` is one of the earlier hops the host resolves,
    /// whose arrivals (a module reporting its parents' changes) list its
    /// heads again (crate::resolve).
    pub fn hears_of(&self, adapter: &str, edge: &str) -> bool {
        self.is_on(adapter, edge)
            || (self.adapter == adapter && self.plan.hops.iter().any(|hop| hop.judged == HopJudged::Resolved && hop.edge == edge))
    }

    /// Whether `arrival`, delivered for `credential`, fires this listen at
    /// `now_ms`, as the judge finds its filters. None when the arrival is not
    /// this listen's to judge: the arrival came for another connection, or it is marked for this listen's own sake
    /// (`notFor` its pipeline); nothing is said of those. An arrival with no
    /// landing skips at the last hop.
    pub fn fires(&self, arrival: &ArrivalIn, credential: Option<&str>, now_ms: f64) -> Option<Verdict> {
        let plan = &self.plan;
        if !self.hears(credential) || arrival.not_for.as_deref().is_some_and(|not_for| not_for == self.pipeline()) {
            return None;
        }
        let arrived = |record: &Js| {
            let fields = self.named(record)?;
            let unknown = record.get("unknown").and_then(Js::as_array).map(|names| names.iter().filter_map(Js::as_str).map(str::to_string).collect()).unwrap_or_default();
            Some(ArrivedRecord { record_type: record.get("recordType").and_then(Js::as_str).map(str::to_string), fields, unknown })
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
        declared.misfits(&arrival.landing.as_ref().and_then(|landing| self.named(landing)).unwrap_or(Json::Null))
    }

    /// A record's fields as the listen's program reads them, by name
    /// (`named_fields`): its module may key them by its own ids, which the
    /// catalog maps for the record type it states. None when it has none.
    fn named(&self, record: &Js) -> Option<Json> {
        let fields = json_of(record.get("fields")?);
        let ids = record.get("recordType").and_then(Js::as_str).and_then(|record_type| self.field_ids.get(record_type));
        Some(ids.map_or_else(|| fields.clone(), |ids| named_fields(&fields, ids)))
    }

}

/// A webhook subscription's scope, as a listen in the settings form
/// registered it before 0.13: its value of each of the module's
/// `subscriptionScopeKeys`, in their order. Empty for a module that declared
/// none.
pub type Scope = Vec<(String, String)>;

/// The construction argument `connect … using X` writes the credential to.
const CREDENTIAL_ARG: &str = "credentials";

/// The listens of a set of files, and a line for each one written there
/// that would never fire.
#[derive(Debug, Default)]
pub struct Listens {
    pub listens: Vec<Listen>,
    /// Each listen that would never fire, named where it is written: a
    /// listen the checker plans nothing for (it does not check, the catalog
    /// does not load, or it is in the settings form 0.13 retired), or a
    /// listen on a connection the file does not make. A session that routes refuses the set for them;
    /// one that only runs a function reads the listens it has.
    pub unwatched: Vec<String>,
}

/// `collectListens`: the listens of every file that parses. A payload node
/// the listen's file imports from another file is read from that file, the
/// way the checker links it, so the listens of a set depend on the whole set
/// and not on one file's text. Each is read from the checker's plan of it
/// against `catalog`; a file with one the checker plans none for still has
/// its other listens read.
pub fn listens_across(parsed: &[Rc<crate::sources::Parsed>], catalog: &Js) -> Listens {
    let programs: Vec<(&crate::sources::Parsed, &movement_parser::ast::Program)> = parsed.iter().filter_map(|p| p.program.as_ref().ok().map(|program| (&**p, program))).collect();
    let scopes: HashMap<String, FileScope<'_>> = programs.iter().map(|(file, program)| (file.name.clone(), FileScope::of(program))).collect();
    let mut snapshot = None;
    let mut read = Listens::default();
    for (file, program) in &programs {
        let (plans, unplanned) = match program.statements.iter().any(|s| matches!(s, Statement::Listen(_))) {
            true => plans_of(file, program, snapshot.get_or_insert_with(|| catalog_snapshot(catalog)).as_ref()),
            false => (Vec::new(), Vec::new()),
        };
        read.unwatched.extend(unplanned);
        listens_of(file, program, &scopes, plans, &mut read);
    }
    if let Some(Ok(catalog)) = &snapshot {
        for listen in &mut read.listens {
            listen.field_ids = field_ids_of(catalog, listen);
        }
    }
    read
}

/// The `fieldIds` of each record type in the schema of `listen`'s
/// connection, as the checker instantiates it from its construction.
fn field_ids_of(catalog: &CatalogSnapshot, listen: &Listen) -> FieldIds {
    let credential_arg = catalog.adapter(&listen.adapter).and_then(movement_parser::catalog::helpers::credential_arg_of).map_or_else(|| CREDENTIAL_ARG.to_string(), |arg| arg.name.clone());
    let credential = listen.credential.clone().map(|credential| (credential_arg, credential));
    let args: movement_parser::catalog::snapshot::Args = listen.args.iter().cloned().chain(credential).collect();
    let Some(schema) = catalog.instantiate(&listen.adapter, &args) else { return FieldIds::default() };
    schema
        .positions
        .iter()
        .filter_map(|(name, position)| {
            let ids = position.field_ids.as_ref().filter(|ids| !ids.is_empty())?;
            Some((name.clone(), ids.iter().map(|(field, id)| (field.clone(), Json::String(id.clone()))).collect()))
        })
        .collect()
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
/// order, and a line for each listen it plans none for, naming where it is
/// written: one in the settings form is never planned.
fn plans_of(file: &crate::sources::Parsed, program: &movement_parser::ast::Program, catalog: Result<&CatalogSnapshot, &String>) -> (Vec<(ListenPlan, TriggerAwaits)>, Vec<String>) {
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
    let settings = program.statements.iter().filter_map(|s| match s {
        Statement::Listen(listen) if listen.path.is_none() => Some(format!(
            "{} the listen that fires {} is in the settings form (`listen to {} {{ … }}`), retired in 0.13, so nothing would fire it",
            listen_at(file, listen.span.start),
            listen.movement,
            listen.instance
        )),
        _ => None,
    });
    let settings: Vec<String> = settings.collect();
    let catalog = match catalog {
        Ok(catalog) => catalog,
        Err(why) => {
            let lines = traversals().map(|listen| unwatched(listen.span, &format!("is not planned, as the catalog does not load ({why})")));
            return (Vec::new(), lines.chain(settings).collect());
        }
    };
    // The file's own parse is checked: lf parses with every slot marked for
    // the eager export (`ExprSlot::eager`), which the checker never reads.
    let options = movement_checker::CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let answer = movement_checker::answer::check_answer(program, catalog, options);
    let planned = answer.listens.into_iter().map(|plan| {
        let awaits = trigger_awaits_of(program, &answer.stamps, &plan);
        (plan, awaits)
    });
    (planned.collect(), answer.unwatched.iter().map(|at| unwatched(*at, "does not check")).chain(settings).collect())
}

/// The edges the check stamps on the parameter of the function `plan` fires,
/// declared in `program`, where a run of it enters its trigger
/// (`/statements/<index>/params/0`): those awaited off the trigger, and off
/// each record type its arrival carries, aligned to the plan's `carries` by
/// the type each carried hop lands on.
fn trigger_awaits_of(program: &movement_parser::ast::Program, stamps: &[serde_json::Value], plan: &ListenPlan) -> TriggerAwaits {
    let Some(index) = program.statements.iter().position(|s| matches!(s, Statement::Movement(declared) if declared.name == plan.movement)) else { return TriggerAwaits::default() };
    let path = format!("/statements/{index}/params/0");
    let on_param = || stamps.iter().filter(|stamp| stamp.get("file").is_none() && stamp.get("path").and_then(serde_json::Value::as_str) == Some(path.as_str()));
    let edges = |edges: &serde_json::Value| edges.as_array().map(|edges| edges.iter().filter_map(|e| e.as_str().map(str::to_string)).collect::<Vec<_>>());
    let own = on_param().find_map(|stamp| edges(stamp.get("opensWaits")?)).unwrap_or_default();
    let by_type = on_param().find_map(|stamp| stamp.get("carriedAwaits"));
    let carried = plan
        .carries
        .iter()
        .map(|carried| {
            let landed = plan.hops.iter().find(|hop| &hop.edge == carried).map(|hop| hop.to.as_str());
            landed.and_then(|to| by_type?.get(to)).and_then(edges).unwrap_or_default()
        })
        .collect();
    TriggerAwaits { own, carried }
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

/// The listens of one file into `read`, one for each of `plans`. One whose
/// instance is neither a connection the file makes nor a host unit is named
/// in `read.unwatched` instead.
fn listens_of(file: &crate::sources::Parsed, program: &movement_parser::ast::Program, scopes: &HashMap<String, FileScope<'_>>, plans: Vec<(ListenPlan, TriggerAwaits)>, read: &mut Listens) {
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
            movement_name: plan.movement.clone(),
            credential,
            payload,
            args,
            plan,
            trigger_awaits,
            field_ids: FieldIds::default(),
        });
    }
}

/// A record's fields as the judge reads them.
fn json_of(value: &Js) -> Json {
    serde_json::from_str(&value.to_json()).unwrap_or(Json::Null)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{MovementFile, Parsed};
    use std::path::PathBuf;

    /// A module `inbox` whose `Notes` its connection pushes, made with a
    /// credential or none: a schema for each.
    const NOTES_CATALOG: &str = r#"{"adapters":{"inbox":{"constructionArgs":[{"kind":"credential","name":"credentials","required":false}],"canFire":true,"schemas":{"":{"positions":{"Note":{"properties":{},"edges":{}}},"collections":{"Notes":{"target":"Note","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}},"inbox_main":{"positions":{"Note":{"properties":{},"edges":{}}},"collections":{"Notes":{"target":"Note","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}},"Inbox B":{"positions":{"Note":{"properties":{},"edges":{}}},"collections":{"Notes":{"target":"Note","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}}}}},"credentials":{"inbox_main":{"adapters":["inbox"]},"Inbox B":{"adapters":["inbox"]}},"plugins":{}}"#;

    /// Every listen across the files, against `NOTES_CATALOG`.
    fn collect_listens(files: &[MovementFile]) -> Vec<Listen> {
        let read = listens_across(&Parsed::each(files, &[]), &js(NOTES_CATALOG));
        assert!(read.unwatched.is_empty(), "{:?}", read.unwatched);
        read.listens
    }

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    /// A CRM whose companies are a listenable root, delivered to the
    /// connection; a company's comments a listenable edge.
    const CRM_CATALOG: &str = r#"{"adapters":{"acme_crm":{"canFire":true,"constructionArgs":[],"schemas":{"":{"positions":{
      "Company":{"properties":{"id":"text","Name":"text"},"edges":{"Comments":{"target":"Comment","listenable":true,"identity":"Id","delivery":"connection"}}},
      "Comment":{"properties":{"Id":"text","Text":"text"},"edges":{}}},
      "collections":{"Company":{"target":"Company","listenable":true,"identity":"id","delivery":"connection"}},
      "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

    /// Two listens on the CRM's companies and one on its comments, in a file `crm`.
    const CRM_LISTENS: &str = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n\nfunction welcome(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nfunction note(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nfunction answer(k: <crm-[:Comment]->>) {\n  return k.Text\n}\n\nlisten to crm-[c:Company WHERE c.Name != \"Ignored\"]-> fire welcome\nlisten to crm-[:Company]-> fire note\nlisten to crm-[:Company]->-[:Comments]-> fire answer\n";

    /// A listen in the settings form, retired in 0.13, written after `CRM_LISTENS`.
    const SETTINGS_LISTEN: &str = "listen to crm { events: [\"company.created\"] } fire welcome\n";

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
    fn a_listen_is_read_from_its_plan_and_one_in_the_settings_form_is_named_as_never_firing() {
        let listens = crm_listens();
        let read: Vec<(&str, Option<&str>, Option<&str>)> = listens.iter().map(|l| (l.movement_name.as_str(), l.credential.as_deref(), l.plan.hops.last().map(|h| h.edge.as_str()))).collect();
        assert_eq!(read, [("welcome", Some("acme"), Some("Company")), ("note", Some("acme"), Some("Company")), ("answer", Some("acme"), Some("Comments"))]);
        assert_eq!(listens[0].adapter, "acme_crm");
        assert!(listens[0].is_on("acme_crm", "Company") && !listens[0].is_on("acme_crm", "Comments"));
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: format!("{CRM_LISTENS}{SETTINGS_LISTEN}"), version: None }];
        let read = listens_across(&Parsed::each(&files, &[]), &js(CRM_CATALOG));
        assert_eq!(read.listens.len(), 3, "the file's other listens are read");
        assert_eq!(read.unwatched, ["crm.mvt:21:1 the listen that fires welcome is in the settings form (`listen to crm { … }`), retired in 0.13, so nothing would fire it"]);
    }

    #[test]
    fn a_listen_on_a_traversal_is_named_by_its_file_its_function_its_plan_and_its_connection() {
        let listens = crm_listens();
        let identity = listens[0].plan.identity();
        use sha2::{Digest, Sha256};
        let named = format!("{identity}\n{}", r#"{"args":[],"credential":"acme"}"#);
        let digest: String = Sha256::digest(named.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect();
        assert_eq!(listens[0].pipeline(), format!("listen:crm:welcome:{digest}"));
        // A connection constructed otherwise is another listen.
        let elsewhere = Listen { credential: Some("acme_b".into()), ..listens[0].clone() };
        assert_ne!(elsewhere.pipeline(), listens[0].pipeline(), "another credential");
        let based = |args: &[(&str, &str)]| Listen { args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), ..listens[0].clone() };
        assert_ne!(based(&[("base", "\"one\"")]).pipeline(), listens[0].pipeline(), "other arguments");
        assert_eq!(based(&[("base", "\"one\""), ("space", "\"s\"")]).pipeline(), based(&[("space", "\"s\""), ("base", "\"one\"")]).pipeline(), "in any order");
        // Two listens in one file firing one function on two paths are two listens.
        let twice = CRM_LISTENS.replace("listen to crm-[:Company]-> fire note", "listen to crm-[c:Company WHERE c.Name != \"Other\"]-> fire welcome");
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: twice, version: None }];
        let listens = listens_across(&Parsed::each(&files, &[]), &js(CRM_CATALOG)).listens;
        let welcomes: Vec<String> = listens.iter().filter(|l| l.movement_name == "welcome").map(Listen::pipeline).collect();
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
        assert!(read.listens.is_empty());
        // One the check refuses: its WHERE reads a field companies do not have.
        let bogus = CRM_LISTENS.replace("listen to crm-[:Company]-> fire note", "listen to crm-[c:Company WHERE c.Bogus == \"x\"]-> fire note");
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: bogus, version: None }];
        let read = listens_across(&Parsed::each(&files, &[]), &js(CRM_CATALOG));
        assert_eq!(read.unwatched[0], "crm.mvt:19:1 the listen that fires note does not check, so nothing would fire it");
        let kept: Vec<&str> = read.listens.iter().map(|l| l.movement_name.as_str()).collect();
        assert_eq!(kept, ["welcome", "answer"], "the file's other listens are read");
    }

    #[test]
    fn a_listen_on_a_connection_imported_from_another_file_is_named_as_never_firing() {
        // The checker refuses it (a file exports no connection: MOV_IMPORT_NOT_EXPORTED, MOV_LISTEN_NOT_INSTANCE), so it plans nothing for it.
        let connections = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n";
        let traversal = "import { crm } from \"connections\"\n\nfunction welcome(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nlisten to crm-[:Company]-> fire welcome\n";
        let file = |name: &str, source: &str| MovementFile { name: name.into(), path: PathBuf::from(format!("{name}.mvt")), source: source.into(), version: None };
        let mut catalog = js(CRM_CATALOG);
        if let Js::Obj(top) = &mut catalog {
            top.insert("files".into(), js(&format!(r#"{{"connections":{{"source":{}}}}}"#, Js::str(connections).to_json())));
        }
        let read = listens_across(&Parsed::each(&[file("connections", connections), file("welcome", traversal)], &[]), &catalog);
        assert_eq!(read.unwatched, ["welcome.mvt:7:1 the listen that fires welcome does not check, so nothing would fire it"]);
    }

    #[test]
    fn a_listen_on_a_traversal_fires_on_an_arrival_its_where_takes_and_skips_one_it_does_not() {
        let welcome = &crm_listens()[0];
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","Name":"Osprey"}"#), Some("acme"), 0.0), Some(Verdict::Fires));
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","Name":"Ignored"}"#), Some("acme"), 0.0), Some(Verdict::Skips { hop: 0, reason: None }));
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","Name":"Osprey"}"#), Some("another"), 0.0), None, "another connection's");
    }

    #[test]
    fn an_arrival_on_the_listened_edge_name_fires_only_when_it_landed_on_the_record_type_the_listen_lands_on() {
        let welcome = &crm_listens()[0];
        let osprey = r#"{"id":"company-1","Name":"Osprey"}"#;
        assert_eq!(welcome.fires(&landed_as("Comment", osprey), Some("acme"), 0.0), Some(Verdict::Skips { hop: 0, reason: Some("it has record type Comment, not Company, which this listen's Company lands on".into()) }), "another record type's edge of the same name");
        let untyped = crate::arrivals::arrivals_of(&js(&format!(r#"{{"arrivals":[{{"edge":"Company","identity":"company-1","landing":{{"fields":{osprey}}}}}]}}"#))).unwrap().remove(0);
        assert_eq!(
            welcome.fires(&untyped, Some("acme"), 0.0),
            Some(Verdict::Undecided { reason: "the arrival acme_crm reported on Company does not say its record type, so it cannot be told from another record type's Company (this listen's lands on Company)".into() })
        );
    }

    /// The CRM, its module keying a company's `Name` as `name` (`fieldIds`).
    fn crm_keyed_by_ids() -> Vec<Listen> {
        let catalog = CRM_CATALOG.replace(r#""properties":{"id":"text","Name":"text"},"#, r#""properties":{"id":"text","Name":"text"},"fieldIds":{"Name":"name"},"#);
        let source = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n\nfunction welcome(c: <crm-[:Company]->>) {\n  return c.Name\n}\n\nlisten to crm-[c:Company WHERE c.Name == \"Acme\"]-> fire welcome\n";
        let files = vec![MovementFile { name: "crm".into(), path: PathBuf::from("crm.mvt"), source: source.into(), version: None }];
        let read = listens_across(&Parsed::each(&files, &[]), &js(&catalog));
        assert_eq!(read.unwatched, Vec::<String>::new());
        read.listens
    }

    #[test]
    fn an_arrival_keyed_by_its_modules_field_ids_is_judged_by_the_names_the_listen_reads() {
        let welcome = &crm_keyed_by_ids()[0];
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","name":"Acme"}"#), Some("acme"), 0.0), Some(Verdict::Fires));
        assert_eq!(welcome.fires(&company(r#"{"id":"company-1","name":"Osprey"}"#), Some("acme"), 0.0), Some(Verdict::Skips { hop: 0, reason: None }));
    }

    #[test]
    fn a_field_its_module_could_not_read_leaves_a_listen_reading_it_undecided_and_the_rest_judged() {
        let listens = crm_listens();
        let unread = |unknown: &str| {
            crate::arrivals::arrivals_of(&js(&format!(r#"{{"arrivals":[{{"edge":"Company","identity":"company-1","landing":{{"recordType":"Company","fields":{{"id":"company-1","Name":null}},"unknown":["{unknown}"]}}}}]}}"#))).unwrap().remove(0)
        };
        assert_eq!(
            listens[0].fires(&unread("Name"), Some("acme"), 0.0),
            Some(Verdict::Undecided { reason: "acme_crm could not read Name of the arrival on Company, which this listen's filter reads".into() }),
            "never read as absent, which would skip it"
        );
        assert_eq!(listens[1].fires(&unread("Name"), Some("acme"), 0.0), Some(Verdict::Fires), "a listen reading no unknown field is judged as usual");
    }

    #[test]
    fn an_arrival_marked_not_for_a_listen_runs_every_other_listen_on_its_edge_and_not_that_one() {
        let listens = crm_listens();
        let mut arrival = company(r#"{"id":"company-1","Name":"Osprey"}"#);
        arrival.not_for = Some(listens[1].pipeline());
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
                movement_name: plan.movement.clone(),
                credential: case["credential"].as_str().map(str::to_string),
                payload: None,
                args,
                plan,
                trigger_awaits: TriggerAwaits::default(),
                field_ids: FieldIds::default(),
            };
            assert_eq!(listen.pipeline(), case["pipeline"].as_str().unwrap(), "{}", case["case"]);
        }
    }

    /// The table of cases the engine's TypeScript is held to as well
    /// (`listenHearsCredential`).
    #[test]
    fn hears_matches_the_shared_table_of_cases() {
        let table: Json = serde_json::from_str(include_str!("../../../packages/engine-contracts/conformance/listen-hears.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let listen = Listen {
                file: "f".into(),
                adapter: "notes".into(),
                movement_name: "m".into(),
                credential: case["listen"].as_str().map(str::to_string),
                payload: None,
                args: Vec::new(),
                plan: serde_json::from_str(r#"{"movement":"m","connection":"n","adapter":"notes","hops":[]}"#).unwrap(),
                trigger_awaits: TriggerAwaits::default(),
                field_ids: FieldIds::default(),
            };
            assert_eq!(listen.hears(case["delivery"].as_str()), case["hears"].as_bool().unwrap(), "{}", case["case"]);
        }
    }

    #[test]
    fn a_listen_names_its_constructions_credential_and_hears_only_its_deliveries() {
        let source = "import { inbox } from adapters\nimport { inbox_main as a_cred, `Inbox B` } from credentials\n\na = connect inbox using a_cred\nb = connect inbox using `Inbox B`\nc = connect inbox\n\nfunction noted_a(n: <a-[:Notes]->>) {\n}\n\nfunction noted_b(n: <b-[:Notes]->>) {\n}\n\nfunction noted_c(n: <c-[:Notes]->>) {\n}\n\nlisten to a-[:Notes]-> fire noted_a\nlisten to b-[:Notes]-> fire noted_b\nlisten to c-[:Notes]-> fire noted_c\n";
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
            source: format!("import {{ inbox }} from adapters\nb = connect inbox\n\nfunction {movement}(n: <b-[:Notes]->>) {{\n}}\n\nlisten to b-[:Notes]-> fire {movement}\n"),
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

}
