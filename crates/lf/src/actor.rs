//! `Actor`: who acted, as `lf` offers it on what lands
//! (docs/contracts/actor-field.md). A host's own addition: the language names
//! none of this, and to a filter or a run it is an ordinary record field that
//! may be absent. A module knows nothing of it either: it reports an identity.

use std::collections::BTreeSet;
use std::sync::Mutex;

use indexmap::{IndexMap, IndexSet};

use crate::arrivals::ArrivalIn;
use crate::doors::Reader;
use crate::json::{Js, Obj};
use crate::obj;
use crate::schema::reference_target_type_ids;
use crate::secrets::Credential;
use crate::sources::MovementFile;

/// The field a landing gains.
pub const ACTOR: &str = "Actor";

/// The record type that field holds. Not `Actor`, so a module's own type of that
/// name (an Attio object) keeps it: types share one namespace, and a field's
/// name is the module's to take but a type's position name is not.
pub const ACTOR_TYPE: &str = "ListenFireActor";

/// The field a landing type gains.
pub fn record_field() -> Js {
    Js::Obj(obj! {
        "fieldId" => Js::str(ACTOR),
        "displayName" => Js::str(ACTOR),
        "kind" => Js::str("record"),
        "record" => Js::Obj(obj! { "typeId" => Js::str(ACTOR_TYPE) }),
        "mayBeAbsent" => Js::Bool(true),
    })
}

/// The record it holds, read on with `.` and never fetched.
pub fn descriptor() -> Js {
    let text = |name: &str| Js::Obj(obj! { "fieldId" => Js::str(name), "displayName" => Js::str(name), "kind" => Js::str("string"), "writable" => Js::Bool(false), "required" => Js::Bool(false), "mayBeAbsent" => Js::Bool(true) });
    let id = Js::Obj(obj! { "fieldId" => Js::str("Id"), "displayName" => Js::str("Id"), "kind" => Js::str("string"), "writable" => Js::Bool(false), "required" => Js::Bool(true) });
    let proven = Js::Obj(obj! { "fieldId" => Js::str("Proven"), "displayName" => Js::str("Proven"), "kind" => Js::str("boolean"), "writable" => Js::Bool(false), "required" => Js::Bool(true) });
    Js::Obj(obj! {
        "typeId" => Js::str(ACTOR_TYPE),
        "displayName" => Js::str(ACTOR_TYPE),
        "description" => Js::str("Who acted, as listen-fire offers it on what lands."),
        "fields" => Js::Arr(vec![id, text("Email"), text("Domain"), text("Phone"), text("Name"), proven]),
        "references" => Js::Arr(Vec::new()),
    })
}

/// `Actor` as the projection is handed it: `reached`, so it has a position and
/// no root collection a program could walk.
pub fn reached_entry() -> Js {
    Js::Obj(obj! { "typeId" => Js::str(ACTOR_TYPE), "displayName" => Js::str(ACTOR_TYPE), "readable" => Js::Bool(true), "writable" => Js::Bool(false) })
}

/// Whether a module listing `methods` reports who acted.
pub fn reports_who_acted(methods: &[String]) -> bool {
    methods.iter().any(|m| m == "getActorCandidates" || m == "extractActor")
}

/// The type ids a listenable edge lands on: a listenable entry point's own, and
/// each listenable reference's targets.
fn landing_types(entries: &[Js], descriptors: &IndexMap<String, Js>) -> IndexSet<String> {
    let of_entries = entries.iter().filter(|e| Js::is_true(e.get("listenable"))).filter_map(|e| e.get("typeId").and_then(Js::as_str)).map(str::to_string);
    let references = descriptors.values().flat_map(|d| d.get("references").and_then(Js::as_array).unwrap_or(&[]));
    let of_references = references.filter(|r| Js::is_true(r.get("listenable"))).flat_map(reference_target_type_ids);
    of_entries.chain(of_references).collect()
}

/// Whether a declared field or reference answers to `Actor`.
fn answers_to_actor(declared: &Js) -> bool {
    ["fieldId", "displayName", "name"].iter().any(|key| declared.get(key).and_then(Js::as_str) == Some(ACTOR))
}

/// The landing types whose module declared an `Actor` of its own, by module.
/// The door writes `Actor` into an arrival's fields and holds no descriptors, so
/// it learns here what introspection decided; a landing listed is the module's.
static KEPT_BY_MODULE: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());

/// Whether `adapter`'s landing type `type_id` declares `Actor` itself, so nothing
/// is written there.
pub fn kept_by_module(adapter: &str, type_id: &str) -> bool {
    KEPT_BY_MODULE.lock().is_ok_and(|kept| kept.contains(&(adapter.to_string(), type_id.to_string())))
}

/// Remember that `adapter` keeps its own `Actor` on `type_id`, and say so the
/// first time: introspection runs again for every walked position.
fn keep_module_actor(adapter: &str, type_id: &str, name: &str) {
    let first = KEPT_BY_MODULE.lock().is_ok_and(|mut kept| kept.insert((adapter.to_string(), type_id.to_string())));
    if first {
        eprintln!("listen-fire: {adapter}: '{name}' has its own '{ACTOR}', so listen-fire offers no {ACTOR} on it. What a filter reads is the source system's.");
    }
}

/// What a module's introspection answered, for `with_actor_descriptors`.
pub struct Introspection<'a> {
    pub adapter: &'a str,
    pub entries: &'a [Js],
    pub descriptors: &'a IndexMap<String, Js>,
    pub methods: &'a [String],
}

/// What the projection is handed for a module's own introspection: the `reached`
/// entries, and `descriptors` with `Actor` on each listenable edge's landing
/// type. Nothing changes for a module that reports nobody.
///
/// A landing that already has an `Actor` of its own is left as the module
/// described it: the name is the source system's (an Airtable column), and
/// refusing it would stop a saved project under the same language key.
pub fn with_actor_descriptors(introspection: &Introspection<'_>) -> (Vec<Js>, IndexMap<String, Js>) {
    let Introspection { adapter, entries, descriptors, methods } = introspection;
    let mut offered = (*descriptors).clone();
    if !reports_who_acted(methods) {
        return (Vec::new(), offered);
    }
    for type_id in landing_types(entries, descriptors) {
        let Some(Js::Obj(landing)) = offered.get_mut(&type_id) else { continue };
        let own = |list: &str| landing.get(list).and_then(Js::as_array).is_some_and(|items| items.iter().any(answers_to_actor));
        if own("fields") || own("references") {
            let name = landing.get("displayName").and_then(Js::as_str).unwrap_or(&type_id).to_string();
            keep_module_actor(adapter, &type_id, &name);
            continue;
        }
        match landing.entry("fields".to_string()).or_insert_with(|| Js::Arr(Vec::new())) {
            Js::Arr(fields) => fields.push(record_field()),
            other => *other = Js::Arr(vec![record_field()]),
        }
    }
    offered.insert(ACTOR_TYPE.to_string(), descriptor());
    (vec![reached_entry()], offered)
}

/// `normalisedActor`: an identity as the fields of `Actor`, held to the table in
/// docs/contracts/actor-field.md, as `packages/engine-contracts/actor.ts` is.
/// None when the identity names nobody: a field that may be absent is better
/// than an empty one a filter could match.
pub fn normalised(identity: &Js) -> Option<Js> {
    let text = |key: &str| identity.get(key).and_then(Js::as_str);
    let identifier = text("identifier").filter(|id| !id.trim().is_empty())?;
    let scheme = text("scheme");
    let mut fields = obj! { "Id" => Js::str(identifier) };
    let address = text("email").or((scheme == Some("email")).then_some(identifier)).map(|address| address.trim().to_lowercase()).filter(|address| !address.is_empty());
    if let Some(address) = address {
        fields.insert("Email".into(), Js::str(&address));
        // The last `@`, so `a@x.com.evil.com` can never read as `x.com`.
        if let Some((_, domain)) = address.rsplit_once('@').filter(|(_, domain)| !domain.is_empty()) {
            fields.insert("Domain".into(), Js::str(domain));
        }
    }
    if scheme == Some("phone") {
        let digits: String = identifier.chars().filter(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            fields.insert("Phone".into(), Js::Str(digits));
        }
    }
    if let Some(name) = text("name").or_else(|| text("label")).filter(|name| !name.is_empty()) {
        fields.insert("Name".into(), Js::str(name));
    }
    fields.insert("Proven".into(), Js::Bool(Js::is_true(identity.get("proven"))));
    Some(Js::Obj(fields))
}

/// Whether anything in `files` could read `Actor`. It only decides whether to
/// spend a call: matching too much costs one lookup, and no read is missed.
/// Nothing in the checker says what a fired function reads.
pub fn needs_lookup(files: &[MovementFile]) -> bool {
    files.iter().any(|file| file.source.contains(ACTOR))
}

/// The connection arrivals came through, as a module is asked about them.
pub struct ActorSource<'a> {
    pub external: &'a str,
    pub install: Option<&'a Credential>,
}

/// An identity the module named no address for: only a lookup can say more.
fn is_opaque(identity: &Js) -> bool {
    identity.get("email").and_then(Js::as_str).is_none() && !matches!(identity.get("scheme").and_then(Js::as_str), Some("email" | "phone"))
}

/// `identity` with the address the module's first originator candidate has for
/// them. The identity stays as the door named it: `Id` and `Proven` say who the
/// source system vouched for, whatever a later lookup answers.
fn with_candidate_address(identity: &Js, candidates: &Js) -> Js {
    let originator = candidates.as_array().unwrap_or(&[]).iter().find(|candidate| candidate.get("source").and_then(Js::as_str) == Some("originator"));
    let found = originator.and_then(|candidate| normalised(candidate.get("identity")?));
    let address = found.as_ref().and_then(|fields| fields.get("Email")).cloned();
    match (identity, address) {
        (Js::Obj(named), Some(address)) => {
            let mut named: Obj = named.clone();
            named.insert("email".into(), address);
            Js::Obj(named)
        }
        _ => identity.clone(),
    }
}

/// `arrival` with `Actor` written into its landing's fields. One whose lookup
/// failed writes what it has and names `Actor` unread, so a filter reading it
/// lands as `Arrival Not Judged` rather than as a non match, and a listen with
/// no such filter still fires.
async fn with_actor<R: Reader>(reader: &R, source: &ActorSource<'_>, mut arrival: ArrivalIn, needs_lookup: bool) -> ArrivalIn {
    let Some(named) = arrival.actor.clone().filter(|_| arrival.landing.is_some()) else { return arrival };
    let record_type = arrival.landing.as_ref().and_then(|landing| landing.get("recordType")).and_then(Js::as_str).unwrap_or_default();
    if kept_by_module(source.external, record_type) {
        return arrival;
    }
    let mut identity = named.clone();
    let mut unread = false;
    if needs_lookup && is_opaque(&named) {
        let event = crate::routing::arrival_trigger_of("", source.external, &arrival, &crate::store::iso(0));
        match reader.actor_candidates(source.external, source.install, &event).await {
            Ok(Some(candidates)) => identity = with_candidate_address(&named, &candidates),
            Ok(None) => {}
            Err(why) => {
                eprintln!("{}: who acted on {} could not be looked up: {why}", source.external, arrival.edge);
                unread = true;
            }
        }
    }
    let Some(fields) = normalised(&identity) else { return arrival };
    let Some(Js::Obj(landing)) = arrival.landing.as_mut() else { return arrival };
    if let Some(Js::Obj(held)) = landing.get_mut("fields") {
        held.insert(ACTOR.to_string(), fields);
    }
    if unread {
        match landing.entry("unknown".to_string()).or_insert_with(|| Js::Arr(Vec::new())) {
            Js::Arr(names) => names.push(Js::str(ACTOR)),
            other => *other = Js::Arr(vec![Js::str(ACTOR)]),
        }
    }
    arrival
}

/// Each arrival with `Actor` written, before it is judged or logged: the one
/// function every path an arrival comes in by calls, so a filter, a run and a
/// wait read one answer.
pub async fn with_actors<R: Reader>(reader: &R, source: &ActorSource<'_>, arrivals: Vec<ArrivalIn>, needs_lookup: bool) -> Vec<ArrivalIn> {
    let mut written = Vec::with_capacity(arrivals.len());
    for arrival in arrivals {
        written.push(with_actor(reader, source, arrival, needs_lookup).await);
    }
    written
}

/// `Actor` on a position's data, for a read of it: the host's to answer, since
/// the module never described it. None when `described` (what the module says of
/// the record's type) declares a field of that name itself, which is the
/// module's: a type nothing lands on may.
pub fn held_on_position(position: &Js, described: &Js) -> Option<Js> {
    let declares = described.get("fields").and_then(Js::as_array).is_some_and(|fields| fields.iter().any(answers_to_actor));
    (!declares).then(|| position.get("identity").and_then(|identity| identity.get("data")).and_then(|data| data.get(ACTOR)).cloned().unwrap_or(Js::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    fn methods(names: &[&str]) -> Vec<String> {
        names.iter().map(|m| m.to_string()).collect()
    }

    fn own_fields(descriptor: &Js) -> Vec<String> {
        descriptor.get("fields").and_then(Js::as_array).unwrap().iter().filter_map(|f| f.get("displayName").and_then(Js::as_str)).map(str::to_string).collect()
    }

    /// `Message`, a listenable root; `Reply`, reached by a listenable edge off
    /// it; `Other`, a type nothing lands on.
    fn world() -> (Vec<Js>, IndexMap<String, Js>) {
        let entries = vec![
            js(r#"{"typeId":"m","displayName":"Message","readable":false,"writable":false,"listenable":true}"#),
            js(r#"{"typeId":"r","displayName":"Reply","readable":false,"writable":false}"#),
            js(r#"{"typeId":"o","displayName":"Other","readable":true,"writable":false}"#),
        ];
        let descriptors = [
            ("m", r#"{"typeId":"m","displayName":"Message","fields":[{"fieldId":"t","displayName":"Text","kind":"string"}],"references":[{"fieldId":"r","name":"Replies","targetTypeId":"r","listenable":true}]}"#),
            ("r", r#"{"typeId":"r","displayName":"Reply","fields":[],"references":[]}"#),
            ("o", r#"{"typeId":"o","displayName":"Other","fields":[],"references":[]}"#),
        ];
        (entries, descriptors.into_iter().map(|(id, text)| (id.to_string(), js(text))).collect())
    }

    #[test]
    fn a_module_reporting_who_acted_offers_actor_on_each_landing_type_and_nowhere_else() {
        let (entries, descriptors) = world();
        for listed in [&["getActorCandidates"][..], &["extractActor"][..]] {
            let (reached, offered) = offered_to("offers", &entries, &descriptors, listed);
            assert_eq!(reached, vec![reached_entry()]);
            assert_eq!(own_fields(&offered["m"]), ["Text", "Actor"]);
            assert_eq!(own_fields(&offered["r"]), ["Actor"]);
            assert_eq!(own_fields(&offered["o"]), Vec::<String>::new());
            assert_eq!(offered.get(ACTOR_TYPE), Some(&descriptor()));
        }
    }

    #[test]
    fn a_module_reporting_nobody_is_left_as_it_described_itself() {
        let (entries, descriptors) = world();
        let (reached, offered) = offered_to("reports-nobody", &entries, &descriptors, &["getFieldValue"]);
        assert_eq!((reached, offered), (Vec::new(), descriptors));
    }

    fn offered_to(adapter: &str, entries: &[Js], descriptors: &IndexMap<String, Js>, listed: &[&str]) -> (Vec<Js>, IndexMap<String, Js>) {
        with_actor_descriptors(&Introspection { adapter, entries, descriptors, methods: &methods(listed) })
    }

    #[test]
    fn a_landing_type_with_its_own_actor_keeps_it_and_is_offered_nothing() {
        let (entries, mut descriptors) = world();
        descriptors.insert("r".into(), js(r#"{"typeId":"r","displayName":"Reply","fields":[{"fieldId":"a","displayName":"Actor","kind":"string"}],"references":[]}"#));
        let (_, offered) = offered_to("own-landing", &entries, &descriptors, &["extractActor"]);
        assert_eq!(own_fields(&offered["r"]), ["Actor"], "only the module's own");
        assert_eq!(offered["r"], descriptors["r"]);
        assert_eq!(own_fields(&offered["m"]), ["Text", "Actor"], "a type that did not declare one is still offered it");
        assert!(kept_by_module("own-landing", "r") && !kept_by_module("own-landing", "m"));
    }

    #[test]
    fn a_field_named_actor_on_a_type_nothing_lands_on_does_not_stop_the_offer_elsewhere() {
        let (entries, mut descriptors) = world();
        descriptors.insert("o".into(), js(r#"{"typeId":"o","displayName":"Other","fields":[{"fieldId":"Actor","displayName":"Actor","kind":"string"}],"references":[]}"#));
        let (_, offered) = offered_to("own-elsewhere", &entries, &descriptors, &["extractActor"]);
        assert_eq!(own_fields(&offered["m"]), ["Text", "Actor"]);
        assert!(!kept_by_module("own-elsewhere", "o"));
    }

    #[test]
    fn a_module_type_named_actor_and_the_record_listen_fire_offers_are_two_types() {
        let (mut entries, mut descriptors) = world();
        entries.push(js(r#"{"typeId":"Actor","displayName":"Actor","readable":true,"writable":false}"#));
        descriptors.insert("Actor".into(), js(r#"{"typeId":"Actor","displayName":"Actor","fields":[],"references":[]}"#));
        let (reached, offered) = offered_to("own-type", &entries, &descriptors, &["extractActor"]);
        assert_eq!(offered["Actor"], descriptors["Actor"], "the module's type is as it described it");
        assert_eq!(offered.get(ACTOR_TYPE), Some(&descriptor()));
        assert_ne!(ACTOR_TYPE, ACTOR);
        assert_eq!(reached, vec![reached_entry()]);
    }

    /// The table in docs/contracts/actor-field.md, identity in and fields out.
    #[test]
    fn normalised_is_held_to_the_table_in_the_contract() {
        let doc = include_str!("../../../docs/contracts/actor-field.md");
        let rows: Vec<(&str, &str)> = doc.lines().filter_map(|line| line.strip_prefix("| `{")?.strip_suffix("}` |")?.split_once("}` | `{")).collect();
        assert!(rows.len() >= 8, "{rows:?}");
        for (identity, fields) in rows {
            assert_eq!(normalised(&js(&format!("{{{identity}}}"))), Some(js(&format!("{{{fields}}}"))), "{identity}");
        }
    }

    #[test]
    fn an_identity_naming_nobody_has_no_actor() {
        assert_eq!(normalised(&js(r#"{"identifier":"  ","scheme":"opaque"}"#)), None);
        assert_eq!(normalised(&js(r#"{"scheme":"opaque"}"#)), None);
    }

    #[test]
    fn the_first_originator_gives_an_address_and_the_identity_stays_as_named() {
        let named = js(r#"{"identifier":"U1","scheme":"opaque","proven":true}"#);
        let found = with_candidate_address(&named, &js(r#"[{"identity":{"identifier":"relay","scheme":"email","email":"r@x.com"},"source":"relay"},{"identity":{"identifier":"other","scheme":"email","email":"Ann@X.com"},"source":"originator"}]"#));
        assert_eq!(normalised(&found), Some(js(r#"{"Id":"U1","Email":"ann@x.com","Domain":"x.com","Proven":true}"#)));
        assert_eq!(with_candidate_address(&named, &js("[]")), named, "no candidate: nothing more is known");
    }

    #[test]
    fn a_read_of_actor_is_the_hosts_unless_the_module_declared_the_field_itself() {
        let position = js(r#"{"identity":{"kind":"stable","recordId":"m1","data":{"Actor":{"Id":"U1"}}}}"#);
        let undeclared = js(r#"{"fields":[{"fieldId":"t","displayName":"Text"}]}"#);
        assert_eq!(held_on_position(&position, &undeclared), Some(js(r#"{"Id":"U1"}"#)));
        assert_eq!(held_on_position(&js(r#"{"identity":{"kind":"stable","recordId":"m1"}}"#), &undeclared), Some(Js::Null), "a record reached by reading has none");
        assert_eq!(held_on_position(&position, &js(r#"{"fields":[{"fieldId":"a","displayName":"Actor"}]}"#)), None);
    }
}
