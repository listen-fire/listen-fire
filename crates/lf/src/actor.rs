//! `Actor`: who acted, as `lf` offers it on what lands
//! (docs/contracts/actor-field.md). A host's own addition: the language names
//! none of this, and to a filter or a run it is an ordinary record field that
//! may be absent. A module knows nothing of it either: it reports an identity.

use indexmap::{IndexMap, IndexSet};

use crate::json::Js;
use crate::obj;
use crate::schema::reference_target_type_ids;

pub const ACTOR: &str = "Actor";

/// The field a landing type gains.
pub fn record_field() -> Js {
    Js::Obj(obj! {
        "fieldId" => Js::str(ACTOR),
        "displayName" => Js::str(ACTOR),
        "kind" => Js::str("record"),
        "record" => Js::Obj(obj! { "typeId" => Js::str(ACTOR) }),
        "mayBeAbsent" => Js::Bool(true),
    })
}

/// The record it holds, read on with `.` and never fetched.
pub fn descriptor() -> Js {
    let text = |name: &str| Js::Obj(obj! { "fieldId" => Js::str(name), "displayName" => Js::str(name), "kind" => Js::str("string"), "writable" => Js::Bool(false), "required" => Js::Bool(false), "mayBeAbsent" => Js::Bool(true) });
    let id = Js::Obj(obj! { "fieldId" => Js::str("Id"), "displayName" => Js::str("Id"), "kind" => Js::str("string"), "writable" => Js::Bool(false), "required" => Js::Bool(true) });
    let proven = Js::Obj(obj! { "fieldId" => Js::str("Proven"), "displayName" => Js::str("Proven"), "kind" => Js::str("boolean"), "writable" => Js::Bool(false), "required" => Js::Bool(true) });
    Js::Obj(obj! {
        "typeId" => Js::str(ACTOR),
        "displayName" => Js::str(ACTOR),
        "description" => Js::str("Who acted, as listen-fire offers it on what lands."),
        "fields" => Js::Arr(vec![id, text("Email"), text("Domain"), text("Phone"), text("Name"), proven]),
        "references" => Js::Arr(Vec::new()),
    })
}

/// `Actor` as the projection is handed it: `reached`, so it has a position and
/// no root collection a program could walk.
pub fn reached_entry() -> Js {
    Js::Obj(obj! { "typeId" => Js::str(ACTOR), "displayName" => Js::str(ACTOR), "readable" => Js::Bool(true), "writable" => Js::Bool(false) })
}

/// Whether a module listing `methods` reports who acted.
fn reports_who_acted(methods: &[String]) -> bool {
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

/// What the projection is handed for a module's own introspection: the `reached`
/// entries, and `descriptors` with `Actor` on each listenable edge's landing
/// type. Nothing changes for a module that reports nobody.
///
/// A name the module already gives `Actor` is refused rather than overwritten:
/// the door would write over the module's value, and a filter would read
/// something other than what the module declared.
pub fn with_actor_descriptors(entries: &[Js], descriptors: &IndexMap<String, Js>, methods: &[String]) -> Result<(Vec<Js>, IndexMap<String, Js>), String> {
    let mut offered = descriptors.clone();
    if !reports_who_acted(methods) {
        return Ok((Vec::new(), offered));
    }
    if entries.iter().any(answers_to_actor) || descriptors.contains_key(ACTOR) {
        return Err(format!("a type named '{ACTOR}', a name listen-fire keeps for who acted on what lands: rename it in the source system"));
    }
    for type_id in landing_types(entries, descriptors) {
        let Some(Js::Obj(landing)) = offered.get_mut(&type_id) else { continue };
        let own = |list: &str| landing.get(list).and_then(Js::as_array).is_some_and(|items| items.iter().any(answers_to_actor));
        if own("fields") || own("references") {
            let name = landing.get("displayName").and_then(Js::as_str).unwrap_or(&type_id);
            return Err(format!("'{name}': its own '{ACTOR}', a name listen-fire keeps for who acted on what lands: rename it in the source system"));
        }
        match landing.entry("fields".to_string()).or_insert_with(|| Js::Arr(Vec::new())) {
            Js::Arr(fields) => fields.push(record_field()),
            other => *other = Js::Arr(vec![record_field()]),
        }
    }
    offered.insert(ACTOR.to_string(), descriptor());
    Ok((vec![reached_entry()], offered))
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
            let (reached, offered) = with_actor_descriptors(&entries, &descriptors, &methods(listed)).unwrap();
            assert_eq!(reached, vec![reached_entry()]);
            assert_eq!(own_fields(&offered["m"]), ["Text", "Actor"]);
            assert_eq!(own_fields(&offered["r"]), ["Actor"]);
            assert_eq!(own_fields(&offered["o"]), Vec::<String>::new());
            assert_eq!(offered.get(ACTOR), Some(&descriptor()));
        }
    }

    #[test]
    fn a_module_reporting_nobody_is_left_as_it_described_itself() {
        let (entries, descriptors) = world();
        let (reached, offered) = with_actor_descriptors(&entries, &descriptors, &methods(&["getFieldValue"])).unwrap();
        assert_eq!((reached, offered), (Vec::new(), descriptors));
    }

    #[test]
    fn a_landing_type_with_its_own_actor_is_refused_naming_the_type() {
        let (entries, mut descriptors) = world();
        descriptors.insert("r".into(), js(r#"{"typeId":"r","displayName":"Reply","fields":[{"fieldId":"a","displayName":"Actor","kind":"string"}],"references":[]}"#));
        let refused = with_actor_descriptors(&entries, &descriptors, &methods(&["extractActor"])).unwrap_err();
        assert!(refused.starts_with("'Reply': its own 'Actor'"), "{refused}");
        // A module that reports nobody keeps the name: nothing is added to clash with it.
        assert!(with_actor_descriptors(&entries, &descriptors, &methods(&[])).is_ok());
    }

    #[test]
    fn a_type_named_actor_is_refused_a_field_of_that_name_off_the_landings_is_not() {
        let (mut entries, mut descriptors) = world();
        descriptors.insert("o".into(), js(r#"{"typeId":"o","displayName":"Other","fields":[{"fieldId":"Actor","displayName":"Actor","kind":"string"}],"references":[]}"#));
        assert!(with_actor_descriptors(&entries, &descriptors, &methods(&["extractActor"])).is_ok(), "nothing lands on Other");
        entries.push(js(r#"{"typeId":"x","displayName":"Actor","readable":true,"writable":false}"#));
        let refused = with_actor_descriptors(&entries, &descriptors, &methods(&["extractActor"])).unwrap_err();
        assert!(refused.starts_with("a type named 'Actor'"), "{refused}");
    }
}
