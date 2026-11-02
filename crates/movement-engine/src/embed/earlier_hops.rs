//! A later hop's WHERE and ORDER BY read an earlier hop's alias, each path
//! through the walk naming its own record: a Table's History is filtered by
//! that Table's own Name. Two Tables, `A` and `B`, each with the changes `A`,
//! `B` and `C`, so a walk that bound every path to one Table (the first, or a
//! shared one) lands on `A:A` and `B:A` rather than `A:A` and `B:B`.

use serde_json::json;

use super::test_time::block_on;
use super::*;

const CATALOG: &str = r#"{
  "adapters": { "store": { "constructionArgs": [], "canFire": true, "schemas": { "": {
    "positions": {
      "Ping": { "properties": { "Name": "text" }, "edges": {} },
      "Table": { "properties": { "Name": "text" }, "edges": { "History": { "target": "Change" } } },
      "Change": { "properties": { "Id": "text", "Kind": "text" }, "edges": {} },
      "Log": { "properties": { "Text": "text" }, "edges": { "History": { "target": "Change" } } }
    },
    "collections": {
      "Tables": { "target": "Table" },
      "Logs": { "target": "Log" },
      "Ping": { "target": "Ping", "readable": false, "listenable": true, "delivery": "connection" }
    },
    "supportsInPlaceUpdate": true,
    "writableRoots": { "Log": { "fields": { "Text": "text" }, "resultShape": { "externalId": "text", "Text": "text" } } }
  } } } },
  "credentials": {},
  "plugins": {},
  "models": ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"]
}"#;

fn movement(body: &str) -> String {
    format!("import {{ store }} from adapters\ns = connect store\nfunction m(p: <s-[:Ping]->>) {{\n{body}}}\nlisten to s-[:Ping]-> fire m\n")
}

fn position(record_type: &str, id: &str, data: Data) -> Data {
    Data::map([(
        "position",
        Data::map([
            ("recordType", Data::text(record_type)),
            ("identity", Data::map([("kind", Data::text("stable")), ("recordId", Data::text(id)), ("data", data)])),
        ]),
    )])
}

/// Tables `A` and `B`; off any record, its History: changes `A`, `B` and
/// `C`, each `Kind` naming the record it hangs off and its own id.
#[derive(Default)]
struct Store {
    calls: Vec<(String, Data)>,
    logs: Vec<String>,
}

impl Store {
    /// The `where` each History fetch was asked, as the module received it.
    fn history_wheres(&self) -> Vec<Json> {
        self.calls
            .iter()
            .filter(|(method, args)| method == "getRelated" && args.get("fieldId").and_then(Data::as_text) == Some("History"))
            .map(|(_, args)| args.get("where").map(|w| w.to_json()).unwrap_or(Json::Null))
            .collect()
    }
}

impl Adapters for Store {
    fn resolve(&mut self, request: AdapterRequest) -> HostFuture<AdapterInstance> {
        assert_eq!(request.adapter_type, "store");
        ready(Ok(AdapterInstance { id: "store".into(), methods: ["createRecord", "updateRecord", "resolveEntity", "getFieldValue", "getRelated", "describe"].map(String::from).to_vec() }))
    }

    fn call(&mut self, call: AdapterCall) -> HostFuture<AdapterReply> {
        self.calls.push((call.method.clone(), call.args.clone()));
        let from = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("recordId")).and_then(Data::as_text).unwrap_or_default().to_string();
        ready(Ok(match call.method.as_str() {
            "getRelated" => match call.args.get("fieldId").and_then(Data::as_text) {
                Some("Tables") => AdapterReply::ok(Data::List(["A", "B"].map(|name| position("Table", name, Data::map([("Name", Data::text(name))]))).to_vec())),
                Some("History") => AdapterReply::ok(Data::List(
                    ["A", "B", "C"]
                        .map(|id| position("Change", &format!("{from}-{id}"), Data::map([("Id", Data::text(id)), ("Kind", Data::text(format!("{from}:{id}")))])))
                        .to_vec(),
                )),
                other => AdapterReply::error("adapter_error", format!("the store has no edge {other:?}")),
            },
            "getFieldValue" => {
                let field = call.args.get("fieldId").and_then(Data::as_text).unwrap_or_default().to_string();
                let data = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                AdapterReply::ok(data.and_then(|d| d.get(&field).cloned()).unwrap_or(Data::Null))
            }
            "describe" => AdapterReply::ok(Data::Null),
            "resolveEntity" => AdapterReply::ok(Data::map([("candidates", Data::List(Vec::new()))])),
            "createRecord" | "updateRecord" => {
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                let text = fields.get("Text").and_then(Data::as_text).unwrap_or_default().to_string();
                let id = match call.method.as_str() {
                    "createRecord" => format!("log-{}", self.logs.len()),
                    _ => call.args.get("externalId").and_then(Data::as_text).unwrap_or_default().to_string(),
                };
                self.logs.push(text);
                AdapterReply::ok(Data::map([
                    ("adapterType", Data::text("store")),
                    ("externalId", Data::text(id)),
                    ("recordType", Data::text("Log")),
                    ("data", fields),
                ]))
            }
            other => AdapterReply::error("adapter_error", format!("the store does not answer {other}")),
        }))
    }
}

/// The run of `body`, checked clean first; the store it ran against.
fn ran(body: &str) -> Store {
    let source = movement(body);
    let catalog = Catalog::from_json(CATALOG).unwrap();
    let problems: Vec<Problem> = check(&source, &catalog, LANGUAGE_VERSION).into_iter().filter(|p| p.severity == Severity::Error).collect();
    assert_eq!(problems, vec![], "{source}");
    let event = Event::new("store", Data::map([("Name", Data::text("ping"))])).of_type("ping").about("Ping", "p1");
    let input = RunInput::new(source.clone(), event, "2026-11-02T12:00:00.000Z").function("m").catalog(catalog);
    let mut store = Store::default();
    match block_on(run(&mut Hosts::new().adapters(&mut store), &input)) {
        Ok(Outcome::Finished(_)) => {}
        other => panic!("{source}\nnot finished: {other:?}\n{:?}", store.calls),
    }
    store
}

const MATCHED: &str = "s-[t:Tables]->-[c:History WHERE c.Id == t.Name]->";

#[test]
fn a_block_head_filters_each_table_s_history_by_that_table_s_name() {
    let store = ran(&format!("  {MATCHED} {{\n    write s-[:Logs]-> {{ Text: c.Kind }}\n  }}\n"));
    assert_eq!(store.logs, vec!["A:A", "B:B"]);
    // The module is asked each Table's own name.
    let static_of = |name: &str| json!({ "type": "compare", "operator": "==", "left": { "type": "property", "propertyTypeId": "Id" }, "right": { "type": "static", "value": name } });
    let wheres = store.history_wheres();
    assert_eq!(wheres.len(), 2, "{wheres:?}");
    for (asked, name) in wheres.iter().zip(["A", "B"]) {
        assert_eq!(asked["right"], static_of(name)["right"], "{asked}");
    }
}

#[test]
fn an_expression_walk_and_a_bound_walk_read_each_path_s_own_table() {
    let store = ran(&format!(
        "  n = count({MATCHED})\n  write s-[:Logs]-> {{ Text: \"${{n}}\" }}\n  map({MATCHED}, (r) => {{ write s-[:Logs]-> {{ Text: r.Kind }} }})\n  l = {MATCHED}\n  map(l, (r) => {{ write s-[:Logs]-> {{ Text: r.Kind }} }})\n"
    ));
    assert_eq!(store.logs, vec!["2", "A:A", "B:B", "A:A", "B:B"]);
}

#[test]
fn exists_reads_each_path_s_own_table() {
    let store = ran(
        "  yes = exists(s-[t:Tables]->-[c:History WHERE c.Id == t.Name AND c.Kind == \"B:B\"]->)\n  no = exists(s-[t:Tables]->-[c:History WHERE c.Id == t.Name AND c.Kind == \"B:A\"]->)\n  write s-[:Logs]-> { Text: \"${yes} ${no}\" }\n",
    );
    assert_eq!(store.logs, vec!["true false"]);
}

#[test]
fn an_order_by_reads_each_path_s_own_table() {
    let ordered = "s-[t:Tables]->-[c:History ORDER BY (c.Id == t.Name ? \"0\" : \"1\") LIMIT 1]->";
    let store = ran(&format!("  {ordered} {{\n    write s-[:Logs]-> {{ Text: c.Kind }}\n  }}\n  map({ordered}, (r) => {{ write s-[:Logs]-> {{ Text: r.Kind }} }})\n"));
    assert_eq!(store.logs, vec!["A:A", "B:B", "A:A", "B:B"]);
}

/// A node's edge crossed before the walk reaches the source: its landings
/// held (the walk goes on through the source from each), or kept as a walk
/// run at the read (the hop's alias naming each record it lands on), in a
/// block head (the node's plane) and in an expression (the meta walk).
#[test]
fn a_node_s_edge_names_each_landing_to_the_hops_past_it() {
    for entry in ["graph { tables: s-[:Tables]-> }", "node { tables: lazy s-[:Tables]-> }"] {
        let walk = "g-[x:tables]->-[c:History WHERE c.Id == x.Name]->";
        let store = ran(&format!(
            "  g = {entry}\n  {walk} {{\n    write s-[:Logs]-> {{ Text: c.Kind }}\n  }}\n  map({walk}, (r) => {{ write s-[:Logs]-> {{ Text: r.Kind }} }})\n"
        ));
        assert_eq!(store.logs, vec!["A:A", "B:B", "A:A", "B:B"], "{entry}");
    }
}

/// Hops past a kept walk read the hops crossed before it: each group's label
/// filters the History of every Table its kept walk lands on.
#[test]
fn hops_past_a_kept_walk_read_the_hops_crossed_before_it() {
    let walk = "g-[y:groups]->-[:tables]->-[c:History WHERE c.Id == y.label]->";
    let store = ran(&format!(
        "  g = node {{ groups: [node {{ label: \"B\", tables: lazy s-[:Tables]-> }}, node {{ label: \"A\", tables: lazy s-[:Tables]-> }}] }}\n  {walk} {{\n    write s-[:Logs]-> {{ Text: c.Kind }}\n  }}\n  map({walk}, (r) => {{ write s-[:Logs]-> {{ Text: r.Kind }} }})\n"
    ));
    assert_eq!(store.logs, vec!["A:B", "B:B", "A:A", "B:A", "A:B", "B:B", "A:A", "B:A"]);
}

/// `-[o:@old]->` is the record before a write: the hops past it read it.
#[test]
fn the_hops_past_old_read_the_record_before_the_write() {
    let store = ran(
        "  s-[t:Tables]-> {\n    h = write s-[:Logs]-> { Text: t.Name }\n    h2 = write h { Text: \"later\" }\n    h2-[o:@old]->-[c:History WHERE c.Id == o.Text]-> {\n      write s-[:Logs]-> { Text: c.Kind }\n    }\n    map(h2-[o:@old]->-[c:History WHERE c.Id == o.Text]->, (r) => { write s-[:Logs]-> { Text: r.Kind } })\n  }\n",
    );
    let found: Vec<&str> = store.logs.iter().map(String::as_str).filter(|l| l.contains(':')).collect();
    assert_eq!(found, vec!["log-0:A", "log-0:A", "log-4:B", "log-4:B"], "{:?}", store.logs);
}

/// Hops over records in hand (a graph's child nodes, as an extraction
/// answers them): each group keeps only the item its own label names.
#[test]
fn a_walk_over_records_in_hand_reads_each_path_s_own_node() {
    let walk = "g-[y:groups]->-[i:items WHERE i.v == y.label]->";
    let store = ran(&format!(
        "  g = graph {{ groups: [{{ label: \"B\", items: [{{ v: \"A\" }}, {{ v: \"B\" }}] }}, {{ label: \"A\", items: [{{ v: \"A\" }}, {{ v: \"B\" }}] }}] }}\n  {walk} {{\n    write s-[:Logs]-> {{ Text: \"${{y.label}}${{i.v}}\" }}\n  }}\n  map({walk}, (r) => {{ write s-[:Logs]-> {{ Text: r.v }} }})\n  found = exists(g-[y:groups]->-[i:items WHERE i.v == y.label AND i.v == \"A\"]->)\n  write s-[:Logs]-> {{ Text: \"${{found}}\" }}\n"
    ));
    assert_eq!(store.logs, vec!["BB", "AA", "B", "A", "true"]);
}
