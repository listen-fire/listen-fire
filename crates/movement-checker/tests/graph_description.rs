//! The foundation of describing the graph one way everywhere
//! (plans/graph-description-2026-11-06/DESIGN.md): typing a walk's text from a
//! place in a checked file, a description following any edge, the value that
//! says what is at a landing, and one spelling of a type. A program's check of
//! the same walks is held beside it, unchanged.

use std::rc::Rc;

use movement_checker::description::{Description, DescribedEdge, DescribedField, EdgeCan, Known, Mark, Showing, connection_root, describe_landing};
use movement_checker::host::native::NativeZones;
use movement_checker::query::{Analysis, WalkQuery, WalkTyped, analyze};
use movement_checker::types::field::{HeldRecord, Ty, spell_type};
use movement_checker::types::position::{Position, describe_position, position_ref_in};
use movement_checker::{CheckOptions, check_source};
use movement_parser::ast::Loc;
use movement_parser::catalog::types::{CatalogSnapshot, FieldType, InstanceSchema};
use movement_parser::catalog::written_type::spell_field_type;
use serde_json::{Value, json};

/// The three kinds of write only edge, and their neighbours. `Archive` lands on
/// a type with readable fields; `approve` and `notify` on types known only by
/// what is written to them, one with edges and one with none.
fn schema() -> Value {
    json!({
        "positions": {
            "Channel": {
                "description": "A place people talk.",
                "properties": { "Name": "text", "Topic": { "kind": "maybeAbsent", "of": "text" }, "Id": "text", "Secret Name": "text" },
                "fieldDocs": { "Name": "What it is called.", "Secret": "Never read back." },
                "writeOnlyProperties": ["Secret"],
                "pinnedProperties": [],
                "edges": {
                    "Posts": { "target": "Post", "readable": false, "writable": true, "description": "Post into it." },
                    "Messages": { "target": "Post", "listenable": true },
                    "Pings": { "target": "Ping", "readable": false, "listenable": true },
                    "Owner": { "target": "Person" }
                }
            },
            "Post": {
                "properties": { "Text": "text" },
                "edges": { "Presses": { "target": "Press", "readable": false, "listenable": true } }
            },
            "Ping": { "properties": { "At": "date" }, "edges": {} },
            "Press": { "properties": { "Label": "text" }, "edges": {} },
            "Person": { "properties": { "Tags": { "kind": "list", "of": "text" } }, "edges": {} },
            "Archived": { "properties": { "Kept": "boolean" }, "edges": {} },
            "Vague": { "undescribed": true, "properties": {}, "edges": {} }
        },
        "collections": {
            "Channels": { "target": "Channel" },
            "Archive": { "target": "Archived", "readable": false },
            "approve": { "target": "Approval", "readable": false, "description": "Ask a person to approve." },
            "notify": { "target": "Notice", "readable": false },
            "Vagueness": { "target": "Vague" },
            "nothing": { "target": "Nowhere", "readable": false }
        },
        "writableRoots": {
            "Channel": {
                "fields": { "Name": "text", "Topic": "text", "Secret": "text" },
                "requiredFields": ["Name"],
                "nativeUniqueness": [["Id"], ["Name"]],
                "fieldDocs": { "Name": "What it is called." },
                "resultShape": { "externalId": "text" }
            },
            "Approval": {
                "fields": { "Customer": "text", "Amount": { "kind": "enum", "options": ["low", "medium", "high"] } },
                "requiredFields": ["Amount"],
                "fieldDocs": { "Customer": "Who it is for: the template's first placeholder." },
                "resultShape": { "externalId": "text", "Customer": "text" },
                "edges": { "Presses": { "target": "Press", "readable": false, "listenable": true } }
            },
            "Notice": { "fields": { "Text": "text" }, "resultShape": { "externalId": "text" } }
        },
        "createShapes": {
            "Post": { "fields": { "Text": "text", "Pin": "boolean" }, "requiredFields": ["Text"], "resultShape": { "externalId": "text", "Text": "text" } }
        }
    })
}

fn catalog_of(schema: Value) -> CatalogSnapshot {
    let catalog = json!({ "adapters": { "wa": { "canFire": true, "constructionArgs": [], "schemas": { "": schema } } }, "credentials": {}, "plugins": {} });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

fn options() -> CheckOptions<'static> {
    CheckOptions { upgrading_from: None, zones: &NativeZones }
}

fn analysis_of(source: &str, catalog: &CatalogSnapshot) -> Analysis {
    let program = movement_parser::stmt::parse_program(source, false).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    analyze(&program, catalog, options())
}

const CONNECTED: &str = "c = connect #wa\n";
/// Below the connect line.
const AFTER: Loc = Loc { line: 2, col: 1 };

struct Walks(Analysis);

impl Walks {
    fn connected() -> Walks {
        Walks(analysis_of(CONNECTED, &catalog_of(schema())))
    }

    fn typed(&self, text: &str, describing: bool) -> WalkTyped {
        self.0.type_walk(WalkQuery { at: AFTER, text, describing, zones: &NativeZones }).unwrap_or_else(|e| panic!("{text}: {e:?}"))
    }

    fn described(&self, text: &str) -> WalkTyped {
        self.typed(text, true)
    }
}

fn lands(typed: &WalkTyped) -> Option<String> {
    typed.landing.as_ref().map(describe_position)
}

fn codes(typed: &WalkTyped) -> Vec<String> {
    typed.diagnostics.iter().map(|d| d.code.clone()).collect()
}

fn describe(typed: &WalkTyped) -> Description {
    describe_landing(typed.landing.as_ref().expect("it lands"), Showing::default())
}

fn field<'d>(description: &'d Description, name: &str) -> &'d DescribedField {
    description.fields.shown.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no field {name}: {description:?}"))
}

fn edge<'d>(description: &'d Description, name: &str) -> &'d DescribedEdge {
    description.edges.iter().find(|e| e.name == name).unwrap_or_else(|| panic!("no edge {name}: {description:?}"))
}

// ── What a walk does at a write only edge, described ──

#[test]
fn describing_follows_a_write_only_edge_off_a_record() {
    let walks = Walks::connected();
    let typed = walks.described("c-[:Channels]->-[:Posts]->");
    assert_eq!(codes(&typed), Vec::<String>::new());
    assert_eq!(lands(&typed).as_deref(), Some("Post"));
    assert_eq!(codes(&walks.described("c-[:Channels]->-[:Posts]->-[:Presses]->")), Vec::<String>::new());
    assert_eq!(lands(&walks.described("c-[:Channels]->-[:Posts]->-[:Presses]->")).as_deref(), Some("Press"));
}

#[test]
fn describing_follows_a_write_only_edge_off_a_connection_to_a_readable_type() {
    let typed = Walks::connected().described("c-[:Archive]->");
    assert_eq!(codes(&typed), Vec::<String>::new());
    assert_eq!(lands(&typed).as_deref(), Some("Archived"));
}

#[test]
fn a_type_known_only_by_what_is_written_to_it_lands_where_a_write_lands() {
    let walks = Walks::connected();
    let typed = walks.described("c-[:approve]->");
    assert_eq!(codes(&typed), Vec::<String>::new());
    assert!(matches!(typed.landing, Some(Position::Handle(_))), "{:?}", lands(&typed));
    assert_eq!(lands(&walks.described("c-[:approve]->-[:Presses]->")).as_deref(), Some("Press"));
}

#[test]
fn describing_follows_a_listen_only_edge() {
    let typed = Walks::connected().described("c-[:Channels]->-[:Pings]->");
    assert_eq!(codes(&typed), Vec::<String>::new());
    assert_eq!(lands(&typed).as_deref(), Some("Ping"));
}

#[test]
fn a_misspelt_further_hop_is_reported_in_all_three_cases_listing_the_edges_there_are() {
    let walks = Walks::connected();
    for (text, edges) in [
        ("c-[:Channels]->-[:Posts]->-[:Nope]->", "Presses"),
        ("c-[:Archive]->-[:Nope]->", ""),
        ("c-[:approve]->-[:Nope]->", "Presses"),
    ] {
        let typed = walks.described(text);
        assert_eq!(codes(&typed), ["MOV_TRAVERSE_UNKNOWN_EDGE"], "{text}");
        assert!(typed.diagnostics[0].message.contains("'Nope'") && typed.diagnostics[0].message.contains(edges), "{text}: {}", typed.diagnostics[0].message);
    }
}

#[test]
fn a_misspelt_hop_off_a_type_with_no_edges_at_all_is_reported() {
    let typed = Walks::connected().described("c-[:notify]->-[:Nope]->");
    assert_eq!(codes(&typed), ["MOV_TRAVERSE_UNKNOWN_EDGE"]);
    assert_eq!(typed.landing.map(|l| describe_position(&l)), None);
}

#[test]
fn a_misspelt_edge_off_the_connection_lists_its_edges() {
    let typed = Walks::connected().described("c-[:Nope]->");
    assert_eq!(codes(&typed), ["MOV_TRAVERSE_UNKNOWN_EDGE"]);
    assert!(typed.diagnostics[0].message.contains("it has: Archive, Channels"), "{}", typed.diagnostics[0].message);
}

#[test]
fn a_type_nothing_describes_lands_nowhere() {
    assert_eq!(lands(&Walks::connected().described("c-[:nothing]->")), None);
}

/// With the option off the query types as a program does: the walk is refused.
#[test]
fn without_describing_the_query_refuses_as_a_program_does() {
    let walks = Walks::connected();
    assert_eq!(codes(&walks.typed("c-[:approve]->", false)), ["MOV_COLLECTION_NOT_READABLE"]);
    assert_eq!(codes(&walks.typed("c-[:Channels]->-[:Posts]->", false)), ["MOV_WRITE_ONLY_EDGE"]);
    assert_eq!(codes(&walks.typed("c-[:Channels]->-[:Pings]->", false)), ["MOV_AWAIT_REQUIRED"]);
    assert_eq!(lands(&walks.typed("c-[:approve]->", false)), None);
}

// ── A program's check of the same walks ──

fn program_errors(walk: &str) -> Vec<String> {
    let source = format!("{CONNECTED}x = {walk}\n");
    check_source(&source, &catalog_of(schema()), options()).unwrap_or_else(|e| panic!("{e:?}")).into_iter().filter(|d| d.severity.is_none()).map(|d| format!("{} {}", d.code, d.message)).collect()
}

/// The table in the design's "What a walk does at a write only edge", pinned.
#[test]
fn a_programs_check_of_a_write_only_walk_is_what_it_was() {
    const OFF_RECORD: &str = "MOV_WRITE_ONLY_EDGE '-[:Posts]->' on Channel is write-only — it writes (write …-[:Posts]-> { … }); the system offers nothing to read back along it";
    assert_eq!(program_errors("c-[:Channels]->-[:Posts]->"), [OFF_RECORD]);
    // Off a record, a further hop gets no diagnostic of its own.
    assert_eq!(program_errors("c-[:Channels]->-[:Posts]->-[:Nope]->"), [OFF_RECORD]);

    const READABLE_TYPE: &str = "MOV_COLLECTION_NOT_READABLE '-[:Archive]->' off c can't be read: the wa module lists nothing along it";
    assert_eq!(program_errors("c-[:Archive]->"), [READABLE_TYPE]);
    // The walk goes on, so a misspelt further hop is reported.
    assert_eq!(program_errors("c-[:Archive]->-[:Nope]->"), [READABLE_TYPE.to_string(), "MOV_TRAVERSE_UNKNOWN_EDGE Archived has no edge 'Nope'".to_string()]);

    const WRITTEN_TYPE: &str = "MOV_COLLECTION_NOT_READABLE '-[:approve]->' off c can be written to but not read: the wa module lists nothing along it";
    assert_eq!(program_errors("c-[:approve]->"), [WRITTEN_TYPE]);
    // The type is not among the readable ones, so the step lands nowhere.
    assert_eq!(program_errors("c-[:approve]->-[:Nope]->"), [WRITTEN_TYPE]);
}

// ── The query ──

#[test]
fn a_bare_name_lands_on_what_it_holds() {
    let typed = Walks::connected().described("c");
    assert_eq!(codes(&typed), Vec::<String>::new());
    assert!(matches!(typed.landing, Some(Position::Meta { .. })), "{:?}", lands(&typed));
}

#[test]
fn the_type_of_a_field_read_comes_back_beside_the_landing() {
    let typed = Walks::connected().described("c-[:Channels]->.Topic");
    assert_eq!(typed.ty.as_ref().map(spell_type).as_deref(), Some("text | null"));
    assert_eq!(lands(&typed).as_deref(), Some("Channel"));
}

#[test]
fn text_that_is_no_expression_is_refused_by_the_grammar() {
    let walks = Walks::connected();
    assert!(walks.0.type_walk(WalkQuery { at: AFTER, text: "c-[:Channels WHERE Name == ]->", describing: true, zones: &NativeZones }).is_err());
}

#[test]
fn a_name_bound_below_the_place_is_not_seen() {
    let source = "x = connect #wa\ny = connect #wa\n";
    let analysis = analysis_of(source, &catalog_of(schema()));
    let at = |line, text| analysis.type_walk(WalkQuery { at: Loc { line, col: 1 }, text, describing: true, zones: &NativeZones }).unwrap();

    let below = at(1, "y-[:Channels]->");
    assert_eq!(lands(&below), None);
    assert_eq!(codes(&below), ["MOV_USE_BEFORE_BIND"]);

    let below_then_above = at(3, "y-[:Channels]->");
    assert_eq!(codes(&below_then_above), Vec::<String>::new());
    assert_eq!(lands(&below_then_above).as_deref(), Some("Channel"));
}

#[test]
fn a_name_nothing_binds_is_refused_like_any_unresolved_name() {
    let typed = Walks::connected().described("nope-[:Channels]->");
    assert_eq!(lands(&typed), None);
    assert_eq!(codes(&typed), ["MOV_NAME_UNRESOLVED"]);
}

#[test]
fn a_where_on_a_field_there_is_not_is_refused_as_in_a_program() {
    let walks = Walks::connected();
    for (walk, code) in [("c-[:Channels WHERE Nope == \"x\"]->", "MOV_NAME_UNRESOLVED"), ("c-[e:Channels WHERE e.Nope == \"x\"]->", "MOV_UNKNOWN_PROPERTY")] {
        let typed = walks.described(walk);
        assert_eq!(codes(&typed), [code], "{:?}", typed.diagnostics);
        assert!(typed.diagnostics[0].message.contains("'Nope'"), "{}", typed.diagnostics[0].message);
        assert_eq!(program_errors(walk), [format!("{code} {}", typed.diagnostics[0].message)]);
    }
    assert_eq!(codes(&walks.described("c-[:Channels WHERE Name == \"x\"]->")), Vec::<String>::new());
}

/// What a read must do to be sent is no question of a description's: a type
/// that must be pinned, an edge with no bound, a limit with no order.
#[test]
fn describing_asks_nothing_a_read_must_do() {
    let mut schema = schema();
    schema["positions"]["Tool"] = json!({ "properties": { "Query": "text" }, "pinnedProperties": ["Query"], "edges": {} });
    schema["positions"]["Tick"] = json!({ "properties": { "Zone": "text" }, "edges": {} });
    schema["collections"]["Tool"] = json!({ "target": "Tool" });
    schema["collections"]["Ticks"] = json!({ "target": "Tick", "bounded": false, "boundedBy": ["Zone"] });
    let catalog = catalog_of(schema);
    let walks = Walks(analysis_of(CONNECTED, &catalog));
    for text in ["c-[:Tool]->", "c-[:Ticks]->", "c-[:Channels LIMIT 3]->"] {
        assert_eq!(codes(&walks.described(text)), Vec::<String>::new(), "{text}");
        assert!(!walks.typed(text, false).diagnostics.is_empty(), "{text} is no refusal in a program, so this proves nothing");
    }
}

// ── A hop's WHERE narrows the landing (the Affinity fixture) ──

const DEALS: &str = "List Entry — Master Deals List";
const PORTFOLIO: &str = "List Entry — Portfolio";

fn lists_schema() -> Value {
    let lists = json!({ "kind": "enum", "options": ["Master Deals List", "Portfolio"] });
    let variant = |position: &str, fields: Value| json!({ "fields": fields, "resultShape": { "externalId": "text" }, "position": position, "requiredFields": ["listName"] });
    json!({
        "positions": {
            "Organization": { "properties": { "Name": "text" }, "edges": { "List Entries": { "target": "Organization List Entry", "writable": true, "linkable": false } } },
            "Organization List Entry": { "properties": { "listName": lists }, "edges": {} },
            DEALS: { "properties": { "listName": { "kind": "enum", "options": ["Master Deals List"] }, "Deal Created": "date", "Status": "text" }, "edges": {} },
            PORTFOLIO: { "properties": { "listName": { "kind": "enum", "options": ["Portfolio"] }, "Ownership %": "number", "Added On": "date" }, "edges": {} }
        },
        "collections": { "Organization": { "target": "Organization" } },
        "writableRoots": {},
        "createShapes": { "Organization List Entry": { "fields": { "listName": lists }, "resultShape": { "externalId": "text" },
            "discriminated": { "discriminant": "listName", "variants": {
                "Master Deals List": variant(DEALS, json!({ "listName": "text", "Deal Created": "date", "Status": "text" })),
                "Portfolio": variant(PORTFOLIO, json!({ "listName": "text", "Ownership %": "number" })) } } } }
    })
}

#[test]
fn a_where_that_pins_a_member_lands_on_that_member() {
    let catalog = catalog_of(lists_schema());
    let walks = Walks(analysis_of(CONNECTED, &catalog));
    let typed = walks.described("c-[:Organization]->-[e:`List Entries` WHERE listName == \"Portfolio\"]->");
    assert_eq!(codes(&typed), Vec::<String>::new());
    let description = describe(&typed);
    let names: Vec<&str> = description.fields.shown.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["listName", "Added On", "Ownership %"]);
    // Its marks come from its member's shape: it is written through the type it narrows.
    assert_eq!(field(&description, "listName").marks, [Mark::Required]);
    assert_eq!(field(&description, "Added On").marks, [Mark::ReadOnly]);

    let unpinned = walks.described("c-[:Organization]->-[:`List Entries`]->");
    assert_eq!(describe(&unpinned).fields.shown.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["listName"]);
}

// ── The description value, at each kind of landing ──

#[test]
fn at_a_connections_root_are_its_edges_and_what_each_can_do() {
    let description = describe(&Walks::connected().described("c"));
    assert_eq!(description.fields.shown, []);
    assert_eq!(edge(&description, "Channels").can, EdgeCan { read: true, write: true, fires: false });
    assert_eq!(edge(&description, "Archive").can, EdgeCan { read: false, write: false, fires: false });
    assert_eq!(edge(&description, "approve").can, EdgeCan { read: false, write: true, fires: false });
    assert_eq!(edge(&description, "approve").description.as_deref(), Some("Ask a person to approve."));
    assert_eq!(edge(&description, "approve").target.as_deref(), Some("Approval"));
    let write_fields = edge(&description, "approve").write_fields.as_ref().expect("it writes");
    assert_eq!(write_fields.shown.iter().map(|f| (f.name.as_str(), f.marks.clone())).collect::<Vec<_>>(), [("Amount", vec![Mark::Required]), ("Customer", vec![])]);
    assert!(edge(&description, "Archive").write_fields.is_none());
    assert!(edge(&description, "nothing").landing.is_none());
}

#[test]
fn at_a_record_are_its_fields_with_their_marks_and_its_edges() {
    let description = describe(&Walks::connected().described("c-[:Channels]->"));
    assert_eq!(description.description.as_deref(), Some("A place people talk."));
    assert_eq!(description.known, Known::Whole);
    let name = field(&description, "Name");
    assert_eq!((name.type_.as_str(), name.marks.as_slice(), name.description.as_deref()), ("text", &[Mark::Required, Mark::Identifying][..], Some("What it is called.")));
    assert_eq!(field(&description, "Id").marks, [Mark::Identifying, Mark::ReadOnly]);
    assert_eq!(field(&description, "Topic").type_, "text | null");
    assert_eq!(field(&description, "Topic").marks, []);
    let secret = field(&description, "Secret");
    assert!(secret.write_only);
    assert_eq!(secret.description.as_deref(), Some("Never read back."));

    let posts = edge(&description, "Posts");
    assert_eq!(posts.can, EdgeCan { read: false, write: true, fires: false });
    assert_eq!(posts.description.as_deref(), Some("Post into it."));
    let posting = posts.write_fields.as_ref().expect("it writes");
    assert_eq!(posting.shown[0].name, "Text");
    assert_eq!(posting.shown[0].marks, [Mark::Required]);
    assert_eq!(edge(&description, "Messages").can, EdgeCan { read: true, write: false, fires: true });
    assert_eq!(edge(&description, "Pings").can, EdgeCan { read: false, write: false, fires: true });
    assert_eq!(edge(&description, "Owner").can, EdgeCan { read: true, write: false, fires: false });
    // Each edge says where it lands, to describe in turn.
    let owner = describe_landing(edge(&description, "Owner").landing.as_ref().expect("it lands"), Showing::default());
    assert_eq!(field(&owner, "Tags").type_, "text[]");
}

#[test]
fn a_type_known_only_by_what_is_written_to_it_has_its_write_fields_and_its_root_edges_words() {
    let description = describe(&Walks::connected().described("c-[:approve]->"));
    assert_eq!(description.description.as_deref(), Some("Ask a person to approve."));
    let names: Vec<&str> = description.fields.shown.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["Amount", "Customer"]);
    assert_eq!(field(&description, "Amount").type_, r#""low" | "medium" | "high""#);
    assert_eq!(field(&description, "Amount").marks, [Mark::Required]);
    assert_eq!(field(&description, "Customer").description.as_deref(), Some("Who it is for: the template's first placeholder."));
    assert!(!field(&description, "Customer").write_only);
    assert_eq!(edge(&description, "Presses").can, EdgeCan { read: false, write: false, fires: true });
    assert!(edge(&description, "Presses").landing.is_some());
    assert_eq!(describe(&Walks::connected().described("c-[:notify]->")).edges.len(), 0);
}

#[test]
fn an_undescribed_type_says_so_rather_than_seeming_empty() {
    assert_eq!(describe(&Walks::connected().described("c-[:Vagueness]->")).known, Known::Undescribed);
}

#[test]
fn how_much_shows_is_the_callers() {
    let description = describe_landing(Walks::connected().described("c-[:Channels]->").landing.as_ref().expect("it lands"), Showing { fields: Some(2), enum_options: None });
    assert_eq!(description.fields.shown.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Name", "Id"]);
    assert_eq!(description.fields.cut, 3);

    let enums = describe_landing(Walks::connected().described("c-[:approve]->").landing.as_ref().expect("it lands"), Showing { fields: None, enum_options: Some(1) });
    assert_eq!(field(&enums, "Amount").type_, r#""low" | …+2"#);
}

#[test]
fn at_a_union_is_what_every_member_has() {
    let schema = json!({
        "positions": {
            "Holder": { "properties": {}, "edges": { "Subject": { "target": "Subject Union" } } },
            "Person": { "properties": { "Name": "text", "Age": "number" }, "edges": { "Notes": { "target": "Note" }, "Pets": { "target": "Note" } } },
            "Company": { "properties": { "Name": "text" }, "edges": { "Notes": { "target": "Note" } } },
            "Note": { "properties": { "Body": "text" }, "edges": {} }
        },
        "collections": { "Holders": { "target": "Holder" } },
        "unions": { "Subject Union": ["Person", "Company"] },
        "unionDisplayNames": { "Subject Union": "Person | Company" },
        "writableRoots": {}
    });
    let catalog = catalog_of(schema);
    let walks = Walks(analysis_of(CONNECTED, &catalog));
    let description = describe(&walks.described("c-[:Holders]->-[:Subject]->"));
    assert_eq!(description.members, ["Person", "Company"]);
    assert_eq!(description.fields.shown.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Name"]);
    assert_eq!(description.edges.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Notes"]);
    let holder = describe(&walks.described("c-[:Holders]->"));
    assert_eq!(edge(&holder, "Subject").target.as_deref(), Some("Person | Company"));
}

#[test]
fn at_a_node_a_run_builds_are_its_fields() {
    let source = "node Note {\n  Body: <text>\n  Tag: <text | null>\n}\nfunction f() {\n  n = graph<Note> { Body: \"a\" }\n  return n\n}\n";
    let analysis = analysis_of(source, &catalog_of(schema()));
    let typed = analysis.type_walk(WalkQuery { at: Loc { line: 7, col: 3 }, text: "n", describing: true, zones: &NativeZones }).unwrap();
    assert_eq!(codes(&typed), Vec::<String>::new());
    let description = describe(&typed);
    assert_eq!(field(&description, "Tag").type_, "text | null");
}

#[test]
fn at_each_other_kind_of_landing_is_what_it_offers() {
    let source = concat!(
        "c = connect #wa\n",
        "node Found: \"what is found\" {\n  title: <text> \"the title\"\n  node item: \"each item\" {\n    label: <text> \"its label\"\n  }\n}\n",
        "function f(t: <text>, a: <c-[:Channels]->>, b: <c-[:Vagueness]->>, p: <c-[:Archive]-> | c-[:Channels]->>) {\n",
        "  sent = write c-[:approve]-> { Amount: \"low\" }\n",
        "  some = only(c-[:Channels]->)\n",
        "  found = extractOne([t], Found)\n",
        "  helper = (n) => n\n",
        "  return 1\n",
        "}\n",
    );
    let analysis = analysis_of(source, &catalog_of(schema()));
    let inside = Loc { line: 13, col: 3 };
    let at = |text| {
        let typed = analysis.type_walk(WalkQuery { at: inside, text, describing: true, zones: &NativeZones }).unwrap();
        assert_eq!(codes(&typed), Vec::<String>::new(), "{text}");
        assert!(typed.landing.is_some(), "{text} lands nowhere: {:?}", typed.ty.as_ref().map(spell_type));
        describe(&typed)
    };

    // A write's own handle reads back what the write hands back.
    let sent = at("sent");
    assert_eq!(field(&sent, "Customer").type_, "text");
    assert_eq!(field(&sent, "externalId").marks, [Mark::ReadOnly]);
    assert!(edge(&sent, "Presses").landing.is_some());

    // A landing that may be empty reads every field as maybe absent.
    assert_eq!(field(&at("some"), "Name").type_, "text | null");
    assert_eq!(field(&at("some"), "Name").marks, [Mark::Required, Mark::Identifying]);

    let found = at("found");
    assert_eq!(field(&found, "title").type_, "text");
    assert_eq!(edge(&found, "item").can, EdgeCan { read: true, write: false, fires: false });
    assert_eq!(field(&describe_landing(edge(&found, "item").landing.as_ref().expect("it lands"), Showing::default()), "label").type_, "text");

    // One of several records: what every one of them has.
    let either = at("p");
    assert_eq!(either.members, ["Archived", "Channel"]);
    assert_eq!(either.fields.shown, []);

    // A closure offers nothing to walk or read.
    let helper = at("helper");
    assert_eq!((helper.fields.shown.len(), helper.edges.len()), (0, 0));
}

/// `modules show` and `catalog` describe with no program at all.
#[test]
fn a_description_needs_no_program() {
    let instance: InstanceSchema = serde_json::from_value(schema()).unwrap();
    let root = connection_root("wa", Rc::new(instance));
    let description = describe_landing(&root, Showing::default());
    assert_eq!(description.edges.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Archive", "Channels", "Vagueness", "approve", "nothing", "notify"]);

    let channel = describe_landing(edge(&description, "Channels").landing.as_ref().expect("it lands"), Showing::default());
    assert_eq!(channel.description.as_deref(), Some("A place people talk."));
    let posts = edge(&channel, "Posts").landing.as_ref().expect("a description follows any edge");
    assert_eq!(edge(&describe_landing(posts, Showing::default()), "Presses").target.as_deref(), Some("Press"));

    let approve = describe_landing(edge(&description, "approve").landing.as_ref().expect("it lands"), Showing::default());
    assert_eq!(approve.description.as_deref(), Some("Ask a person to approve."));
    assert_eq!(field(&approve, "Customer").description.as_deref(), Some("Who it is for: the template's first placeholder."));
}

// ── One spelling ──

/// A record field is typed by its position in an instance, so `from_schema`,
/// which has none, cannot say which (`from_schema_in` can): its spelling is
/// held to the parser's by the instance below.
#[test]
fn a_types_spelling_is_the_parsers_whichever_holds_it() {
    let every_schema_type = [
        json!("text"),
        json!("number"),
        json!("boolean"),
        json!("date"),
        json!("datetime"),
        json!("file"),
        json!("json"),
        json!("absent"),
        json!("never"),
        json!({ "kind": "list", "of": "text" }),
        json!({ "kind": "list", "of": "text", "unordered": true }),
        json!({ "kind": "list", "of": { "kind": "list", "of": "date" } }),
        json!({ "kind": "maybeAbsent", "of": "text" }),
        json!({ "kind": "maybeAbsent", "of": { "kind": "list", "of": "text" } }),
        json!({ "kind": "list", "of": { "kind": "maybeAbsent", "of": "text" } }),
        json!({ "kind": "tuple", "of": ["text", "number"] }),
        json!({ "kind": "tuple", "of": ["text", null] }),
        json!({ "kind": "dict", "of": "text" }),
        json!({ "kind": "dict", "of": { "kind": "list", "of": "json" } }),
        json!({ "kind": "enum", "options": ["open", "paid"] }),
        json!({ "kind": "enum", "options": [] }),
        json!({ "kind": "enum", "options": ["open"], "open": {} }),
        json!({ "kind": "enum", "options": ["open"], "open": { "allowPattern": "^o" } }),
        json!({ "kind": "owned", "name": "Cron", "owner": "cron" }),
        json!({ "kind": "owned", "name": "Mail Key", "owner": "mail", "format": "cron" }),
        json!({ "kind": "record" }),
        // What only typing builds. Typing puts a union's members in its own
        // order (`value_union`), so `null` beside one member is what compares.
        json!({ "kind": "union", "of": ["absent", "text"] }),
        json!({ "kind": "dict", "of": "json", "shape": { "a": "text", "b": { "kind": "maybeAbsent", "of": "number" }, "c d": null } }),
        json!({ "kind": "tuple", "of": ["text"], "rest": { "at": 1, "of": "number" } }),
    ];
    for type_ in every_schema_type {
        let schema_type: FieldType = serde_json::from_value(type_.clone()).unwrap();
        assert_eq!(spell_type(&Ty::from_schema(&schema_type)), spell_field_type(&schema_type), "{type_}");
    }

    let held: FieldType = serde_json::from_value(json!({ "kind": "maybeAbsent", "of": { "kind": "record", "position": { "kind": "position", "position": "Deal Row" } } })).unwrap();
    let instance: InstanceSchema = serde_json::from_value(json!({ "positions": { "Deal Row": { "properties": {}, "edges": {} } }, "collections": {}, "writableRoots": {} })).unwrap();
    let Position::Meta { instance } = connection_root("wa", Rc::new(instance)) else { panic!("a connection's root") };
    let typed = Ty::from_schema_in(&held, &|name| Some(HeldRecord { position: position_ref_in(&instance, name)?, live_edge: None }));
    assert_eq!(spell_type(&typed), spell_field_type(&held));
    assert_eq!(spell_type(&typed), "`Deal Row` | null");

    let union = serde_json::from_value::<FieldType>(json!({ "kind": "list", "of": { "kind": "union", "of": ["text", "number"] } })).unwrap();
    assert_eq!(spell_type(&Ty::from_schema(&union)), "(number | text)[]");
}
