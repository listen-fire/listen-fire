//! A hop whose WHERE pins a list (`` `listName` == "Master Deals List" ``)
//! lands only that list's entries: an entry of another list the source hands
//! back is dropped before the WHERE's other conjuncts or the body read a
//! field off it. The member is the one the checker typed the hop by — the
//! write shape's `discriminated` variant for the literal — when the host
//! registered no narrowing of its own.

use super::test_time::block_on;
use super::*;

const DEALS: &str = "List Entry — Master Deals List";
const PORTFOLIO: &str = "List Entry — Portfolio";

fn catalog() -> Catalog {
    let schema = serde_json::json!({
        "positions": {
            "Organization": {
                "properties": { "Name": "text", "Deal Created": "date" },
                "edges": { "List Entries": { "target": "Organization List Entry", "writable": true, "linkable": false } }
            },
            "Organization List Entry": { "properties": { "listName": { "kind": "enum", "options": ["Master Deals List", "Portfolio"] } }, "edges": {} },
            DEALS: {
                "properties": { "listName": { "kind": "enum", "options": ["Master Deals List"] }, "Deal Created": "date", "Status": "text" },
                "edges": {}
            },
            PORTFOLIO: {
                "properties": { "listName": { "kind": "enum", "options": ["Portfolio"] }, "Ownership %": "number" },
                "edges": {}
            }
        },
        "collections": { "Organizations": { "target": "Organization" } },
        "eventPosition": "Organization",
        "supportsInPlaceUpdate": true,
        "writableRoots": {
            "Organization": { "fields": { "Name": "text", "Deal Created": "date" }, "resultShape": { "externalId": "text", "Name": "text", "Deal Created": "date" } }
        },
        "createShapes": {
            "Organization List Entry": {
                "fields": { "listName": "text" },
                "resultShape": { "externalId": "text" },
                "discriminated": {
                    "discriminant": "listName",
                    "variants": {
                        "Master Deals List": { "fields": { "listName": "text", "Status": "text" }, "resultShape": { "externalId": "text" }, "position": DEALS },
                        "Portfolio": { "fields": { "listName": "text", "Ownership %": "number" }, "resultShape": { "externalId": "text" }, "position": PORTFOLIO }
                    }
                }
            }
        }
    });
    let json = serde_json::json!({
        "adapters": { "affinity": {
            "constructionArgs": [{ "kind": "credential", "name": "credentials", "required": true }],
            "canFire": true, "triggerConfig": ["events"],
            "schemas": { "Affinity": schema }
        } },
        "credentials": { "Affinity": { "adapters": ["affinity"] } },
        "plugins": {}
    });
    Catalog::from_json(&json.to_string()).unwrap()
}

fn program(hop_where: &str) -> String {
    format!(
        "import {{ affinity }} from adapters\nimport {{ Affinity }} from credentials\ncrm = connect affinity using Affinity\nfunction m(o: <crm-[:Organization]->>) {{\n  created = o-[le:`List Entries` WHERE {hop_where}]-> {{\n    return le.`Deal Created`\n  }}\n  write crm-[:Organizations]-> {{ Name: \"Veltha\", `Deal Created` ?: only(created) }}\n}}\nlisten to crm {{ events: [\"organization\"] }} fire m\n"
    )
}

/// An organisation on two lists. The Portfolio entry carries none of the
/// Deals list's fields, and asking for one of its fields fails the call: a
/// read off it is a read the gate should have prevented.
#[derive(Default)]
struct Affinity {
    calls: Vec<(String, Data)>,
}

fn entry(record_type: &str, id: &str, data: Data) -> Data {
    Data::map([(
        "position",
        Data::map([
            ("recordType", Data::text(record_type)),
            ("identity", Data::map([("kind", Data::text("stable")), ("recordId", Data::text(id)), ("data", data)])),
        ]),
    )])
}

impl Adapters for Affinity {
    fn resolve(&mut self, request: AdapterRequest) -> HostFuture<AdapterInstance> {
        assert_eq!(request.adapter_type, "affinity");
        ready(Ok(AdapterInstance {
            id: "affinity".into(),
            methods: ["createRecord", "updateRecord", "resolveEntity", "getRelated", "getFieldValue", "describe"].map(String::from).to_vec(),
        }))
    }

    fn call(&mut self, call: AdapterCall) -> HostFuture<AdapterReply> {
        self.calls.push((call.method.clone(), call.args.clone()));
        let record_id = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("recordId")).and_then(Data::as_text).map(str::to_string);
        ready(Ok(match call.method.as_str() {
            "getRelated" => AdapterReply::ok(Data::List(vec![
                entry(PORTFOLIO, "portfolio-1", Data::map([("listName", Data::text("Portfolio")), ("Ownership %", Data::Number(12.0))])),
                entry(
                    DEALS,
                    "deals-1",
                    Data::map([("listName", Data::text("Master Deals List")), ("Deal Created", Data::text("2026-05-01")), ("Status", Data::text("Open"))]),
                ),
            ])),
            "getFieldValue" if record_id.as_deref() == Some("portfolio-1") => {
                AdapterReply::error("adapter_error", "a field was read off the Portfolio entry")
            }
            "getFieldValue" => {
                let field = call.args.get("fieldId").and_then(Data::as_text).unwrap_or_default().to_string();
                let data = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                AdapterReply::ok(data.and_then(|d| d.get(&field).cloned()).unwrap_or(Data::Null))
            }
            "describe" => AdapterReply::ok(Data::Null),
            "resolveEntity" => AdapterReply::ok(Data::map([("candidates", Data::List(Vec::new()))])),
            "createRecord" | "updateRecord" => {
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                AdapterReply::ok(Data::map([
                    ("adapterType", Data::text("affinity")),
                    ("externalId", Data::text("o1")),
                    ("recordType", Data::text("Organization")),
                    ("data", fields),
                ]))
            }
            other => AdapterReply::error("adapter_error", format!("affinity does not answer {other}")),
        }))
    }
}

fn run_program(hop_where: &str) -> (Result<Outcome, EmbedError>, Affinity) {
    let source = program(hop_where);
    let catalog = catalog();
    let problems: Vec<Problem> = check(&source, &catalog, LANGUAGE_VERSION).into_iter().filter(|p| p.severity == Severity::Error).collect();
    assert_eq!(problems, vec![], "{source}");
    let event = Event::new("affinity", Data::map([("Name", Data::text("Veltha"))])).of_type("organization").about("Organization", "o1");
    let input = RunInput::new(source, event, "2026-10-26T12:00:00.000Z").function("m").catalog(catalog);
    let mut affinity = Affinity::default();
    let outcome = block_on(run(&mut Hosts::new().adapters(&mut affinity), &input));
    (outcome, affinity)
}

/// The `Deal Created` the run wrote back, from the Deals entry.
fn written_deal_created(outcome: Result<Outcome, EmbedError>, affinity: &Affinity) -> Option<Data> {
    match outcome.unwrap() {
        Outcome::Finished(_) => {}
        other => panic!("not finished: {other:?}\n{:?}", affinity.calls),
    }
    let (_, args) = affinity.calls.iter().find(|(method, _)| method == "createRecord")?;
    args.get("fields")?.get("Deal Created").cloned()
}

#[test]
fn the_body_reads_the_pinned_lists_entry_and_never_the_others() {
    let (outcome, affinity) = run_program("le.`listName` == \"Master Deals List\"");
    assert!(written_deal_created(outcome, &affinity).is_some_and(|d| d != Data::Null), "{:?}", affinity.calls);
}

#[test]
fn another_lists_entry_is_dropped_before_the_wheres_other_conjuncts_read_it() {
    for hop_where in ["le.`Status` == \"Open\" AND le.`listName` == \"Master Deals List\"", "le.`listName` == \"Master Deals List\" AND le.`Status` == \"Open\""] {
        let (outcome, affinity) = run_program(hop_where);
        assert!(written_deal_created(outcome, &affinity).is_some_and(|d| d != Data::Null), "{hop_where}: {:?}", affinity.calls);
    }
}
