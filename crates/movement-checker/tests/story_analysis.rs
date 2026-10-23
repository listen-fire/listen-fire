//! The story analysis (`movement_checker::story`): the check's recording as
//! data, over the fixture programs in `fixtures/story/`. Each recorded kind
//! appears with what the checker resolved about it and the scope it sits
//! in; names resolve through the scope table to the symbol the checker's own
//! query resolves; and a movement's effects are closed over its calls.

use serde_json::{Value as Json, json};

use movement_checker::CheckOptions;
use movement_checker::query::analyze;
use movement_checker::story::{STORY_ANALYSIS_VERSION, refused_story_analysis, story_analysis_json};
use movement_parser::ast::Loc;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = include_str!("fixtures/story/catalog.json");

const FIXTURES: &[(&str, &str)] = &[
    ("writes", include_str!("fixtures/story/writes.mvt")),
    ("calls", include_str!("fixtures/story/calls.mvt")),
    ("reviews", include_str!("fixtures/story/reviews.mvt")),
    ("until", include_str!("fixtures/story/until.mvt")),
    ("callback", include_str!("fixtures/story/callback.mvt")),
    ("extract", include_str!("fixtures/story/extract.mvt")),
    ("traversal", include_str!("fixtures/story/traversal.mvt")),
    ("exists_where", include_str!("fixtures/story/exists_where.mvt")),
    ("file_read", include_str!("fixtures/story/file_read.mvt")),
    ("clock", include_str!("fixtures/story/clock.mvt")),
];

fn options() -> CheckOptions<'static> {
    CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones }
}

fn source(name: &str) -> &'static str {
    FIXTURES.iter().find(|(n, _)| *n == name).map(|(_, s)| *s).expect("a fixture")
}

fn analysis(name: &str) -> Json {
    let answer = story_analysis_json(source(name), CATALOG, options());
    assert!(answer.get("error").is_none(), "{name}: {answer}");
    answer
}

fn nodes<'a>(analysis: &'a Json, kind: &str) -> Vec<&'a Json> {
    analysis["nodes"].as_array().unwrap().iter().filter(|n| n["kind"] == kind).collect()
}

/// The node of `kind` whose span starts on `line` (1-based).
fn on_line<'a>(analysis: &'a Json, kind: &str, line: u64) -> &'a Json {
    nodes(analysis, kind).into_iter().find(|n| n["span"]["start"]["line"] == line).unwrap_or_else(|| panic!("no {kind} on line {line}"))
}

fn write_on_line(analysis: &Json, line: u64) -> &Json {
    analysis["writes"].as_array().unwrap().iter().find(|w| w["span"]["start"]["line"] == line).unwrap_or_else(|| panic!("no write on line {line}"))
}

/// The scope a body's text opened, by the line its span starts on.
fn scope_of(analysis: &Json, line: u64) -> Json {
    let at = analysis["scopes"].as_array().unwrap().iter().position(|s| s["span"]["start"]["line"] == line);
    json!(at.unwrap_or_else(|| panic!("no scope opens on line {line}")))
}

fn symbol<'a>(analysis: &'a Json, name: &str) -> &'a Json {
    analysis["symbols"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no symbol {name}"))
}

/// `name` resolved from scope `scope` through the table: the last binding of
/// the name in the nearest scope that binds it.
fn resolve_in_table<'a>(analysis: &'a Json, scope: u64, name: &str) -> Option<&'a Json> {
    let scopes = analysis["scopes"].as_array().unwrap();
    let mut at = Some(scope);
    while let Some(index) = at {
        let scope = &scopes[usize::try_from(index).unwrap()];
        if let Some(id) = scope["symbols"].get(name) {
            return analysis["symbols"].get(usize::try_from(id.as_u64().unwrap()).unwrap());
        }
        at = scope["parent"].as_u64();
    }
    None
}

#[test]
fn the_analysis_is_versioned_and_its_diagnostics_are_the_check_s() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    for (name, text) in FIXTURES {
        let answer = analysis(name);
        assert_eq!(answer["storyAnalysisVersion"], json!(STORY_ANALYSIS_VERSION));
        let program = movement_parser::stmt::parse_program(text, false).unwrap();
        let checked = movement_checker::check_program(&program, &catalog, options());
        assert_eq!(answer["diagnostics"], json!(checked), "{name}");
        // The fixtures are clean programs: what is recorded is what a valid story draws.
        assert!(checked.iter().all(|d| !d.is_error()), "{name}: {checked:?}");
    }
}

#[test]
fn every_recorded_kind_appears_in_the_fixtures() {
    let mut seen: Vec<String> = Vec::new();
    for (name, _) in FIXTURES {
        for node in analysis(name)["nodes"].as_array().unwrap() {
            let kind = node["kind"].as_str().unwrap().to_string();
            assert!(node["scope"].is_u64() && node["span"]["start"]["line"].is_u64(), "{name}: {node}");
            if !seen.contains(&kind) {
                seen.push(kind);
            }
        }
    }
    seen.sort();
    let kinds = [
        "await", "branch", "call", "callReading", "combinator", "delete", "extract", "instance", "link", "listen", "refresh", "traversal", "unlink", "valuePath",
    ];
    assert_eq!(seen, kinds);
}

#[test]
fn writes_record_their_target_action_parents_fields_and_binding() {
    let a = analysis("writes");
    let created = write_on_line(&a, 9);
    assert_eq!(created["action"], "create");
    assert_eq!(created["binding"], "person");
    assert_eq!(created["target"], json!({ "instance": "crm", "recordType": "People" }));
    assert_eq!(created["parents"], json!([{ "edge": "People" }]));
    assert_eq!(created["hasUniqueBy"], true);
    assert_eq!(created["fields"][0]["name"], "Name");
    assert_eq!(created["fields"][0]["value"]["raw"].as_str().unwrap().trim(), "m.From");
    assert_eq!(created["scope"], scope_of(&a, 8));

    let found = write_on_line(&a, 10);
    assert_eq!(found["action"], "find");
    assert_eq!(found["binding"], "employer");
    assert_eq!(found["target"], json!({ "instance": "crm", "recordType": "Companies" }));

    let off_a_handle = write_on_line(&a, 13);
    assert_eq!(off_a_handle["parents"], json!([{ "edge": "Notes", "type": "Companies" }]));
    assert_eq!(off_a_handle["scope"], scope_of(&a, 11), "a write in an arm sits in the arm's scope");
    assert!(off_a_handle.get("binding").is_none());

    let updated = write_on_line(&a, 29);
    assert_eq!(updated["action"], "update");
    assert_eq!(updated["target"], json!({ "instance": "crm", "recordType": "Companies" }));
}

#[test]
fn link_unlink_delete_and_refresh_record_their_subjects() {
    let a = analysis("writes");
    let link = on_line(&a, "link", 12);
    assert_eq!((link["from"].as_str(), link["edge"].as_str()), (Some("person"), Some("Company")));
    assert_eq!(link["to"], json!({ "kind": "handle", "name": "employer" }));
    assert_eq!(link["scope"], scope_of(&a, 11));
    let unlink = on_line(&a, "unlink", 22);
    assert_eq!((unlink["from"].as_str(), unlink["edge"].as_str()), (Some("a"), Some("employs")));
    assert_eq!(unlink["to"], json!({ "kind": "handle", "name": "b" }));
    assert_eq!(on_line(&a, "delete", 24)["subject"], "stale");
    let until = analysis("until");
    let refresh = on_line(&until, "refresh", 15);
    assert_eq!(refresh["subject"], "co");
    assert_eq!(refresh["scope"], scope_of(&until, 14), "inside the until condition's own scope");
}

#[test]
fn instances_and_listens_record_what_the_config_resolved() {
    let a = analysis("writes");
    let crm = on_line(&a, "instance", 5);
    assert_eq!((crm["name"].as_str(), crm["adapterType"].as_str()), (Some("crm"), Some("attio")));
    assert_eq!(crm["scope"], 0);
    let listen = on_line(&a, "listen", 33);
    assert_eq!(listen["instance"], "inbox");
    assert_eq!(listen["adapterType"], "email");
    assert_eq!((listen["fires"].as_str(), listen["firesMovement"].as_bool()), (Some("Intake"), Some(true)));
    assert_eq!(listen["narrowing"], json!({ "key": "intake" }));
    assert_eq!(listen["eventTypes"], json!([{ "key": "Email" }]));
    assert_eq!(on_line(&a, "listen", 35)["narrowing"], json!({}));
}

#[test]
fn walks_record_their_root_steps_and_positional_landings() {
    let a = analysis("traversal");
    let head = on_line(&a, "traversal", 8);
    assert_eq!((head["root"].as_str(), head["from"].as_str()), (Some("crm"), Some("graph")));
    assert_eq!(head["steps"][0]["edgeTypeId"], "Companies");
    assert_eq!(head["landings"], json!([{ "instance": "crm", "position": "Companies" }]));
    // A head the walk never typed (a write's target) claims no landing.
    let target = on_line(&a, "traversal", 9);
    assert_eq!(target["landings"], json!([]));

    let r = analysis("reviews");
    let awaited = on_line(&r, "traversal", 22);
    assert_eq!((awaited["root"].as_str(), awaited["from"].as_str()), (Some("q"), Some("result")));
    assert_eq!(awaited["landings"], json!([{ "instance": "asks", "position": "Check Response" }]));
    let path = on_line(&r, "valuePath", 16);
    assert_eq!(path["root"], "team");
    assert_eq!(path["landings"], json!([{ "instance": "team", "position": "Channel" }]));
    assert!(path["key"].as_str().unwrap().starts_with("[\"team\","));
    assert_eq!(path["span"], on_line(&r, "callReading", 16)["span"], "a value path carries its slot's span");
}

#[test]
fn calls_record_the_parameter_each_argument_binds() {
    let a = analysis("calls");
    let note = on_line(&a, "call", 20);
    assert_eq!((note["callee"].as_str(), note["isMovement"].as_bool()), (Some("note"), Some(true)));
    assert_eq!(note["argParams"], json!(["title"]));
    let left = on_line(&a, "call", 18);
    assert_eq!(left["binding"], "left");
    assert_eq!(left["argParams"], json!(["n"]));
    let plugin = on_line(&a, "call", 19);
    assert_eq!((plugin["callee"].as_str(), plugin["isMovement"].as_bool()), (Some("fetchUrl"), Some(false)));
    assert_eq!(plugin["binding"], "page");
    // A built-in's call is read as the value it computes, not as a call.
    let shout = on_line(&a, "callReading", 21);
    assert_eq!(shout["reading"]["kind"], "value");
    assert_eq!(shout["reading"]["expr"]["raw"].as_str().unwrap().trim(), "Text.upper(m.Subject)");
    let argument = on_line(&a, "callReading", 20);
    assert_eq!(argument["reading"]["kind"], "value", "a built-in written as an argument");
    assert!(nodes(&a, "call").iter().all(|c| c["callee"] != "Text.upper"));
}

#[test]
fn awaits_and_combinators_record_their_sources_and_arm_scopes() {
    let a = analysis("reviews");
    let race = on_line(&a, "combinator", 20);
    assert_eq!((race["combinator"].as_str(), race["binding"].as_str()), (Some("race"), Some("r")));
    let arms = race["arms"].as_array().unwrap();
    assert_eq!(arms.len(), 2);
    assert_eq!(arms[0]["scope"], scope_of(&a, 21));
    assert_eq!(arms[1]["scope"], scope_of(&a, 25));
    let response = on_line(&a, "await", 22);
    assert_eq!(response["binding"], "a");
    assert_eq!(response["scope"], arms[0]["scope"]);
    assert_eq!(response["source"], json!({ "kind": "traversal", "root": "q", "edge": "Response", "awaitable": true, "resolvesEmpty": true }));
    assert_eq!(on_line(&a, "await", 25)["source"], json!({ "kind": "sleep", "duration": "2d" }));
    let until = analysis("until");
    assert_eq!(on_line(&until, "await", 14)["source"], json!({ "kind": "until", "every": "1h" }));
}

#[test]
fn branches_record_each_arm_s_scope_and_condition() {
    let a = analysis("writes");
    let branch = on_line(&a, "branch", 11);
    let arm = &branch["arms"][0];
    assert_eq!(arm["scope"], scope_of(&a, 11));
    assert_eq!(arm["conditionSpan"]["start"], json!({ "line": 11, "col": 7 }));
    assert_eq!(branch["otherwise"]["scope"], scope_of(&a, 14));
    assert_eq!(branch["scope"], scope_of(&a, 8));
}

#[test]
fn bodies_say_whether_they_leave_by_the_checker_s_rule() {
    let a = analysis("writes");
    let bodies = a["bodies"].as_array().unwrap();
    let body = |kind: &str, line: u64| bodies.iter().find(|b| b["kind"] == kind && b["span"]["start"]["line"] == line).unwrap()["terminates"].clone();
    assert_eq!(body("arm", 11), json!(false));
    assert_eq!(body("else", 14), json!(true), "a fail() leaves");
    assert_eq!(body("movement", 8), json!(false));
    let c = analysis("calls");
    let bodies = c["bodies"].as_array().unwrap();
    let guard = bodies.iter().find(|b| b["kind"] == "arm" && b["span"]["start"]["line"] == 9).unwrap();
    assert_eq!(guard["terminates"], true, "a return leaves an if arm");
    let r = analysis("reviews");
    let arms: Vec<&Json> = r["bodies"].as_array().unwrap().iter().filter(|b| b["kind"] == "combinatorArm").collect();
    assert_eq!(arms.len(), 2);
    assert!(arms.iter().all(|b| b["terminates"] == false), "a return in an arm is its value");
}

#[test]
fn extractions_record_the_graph_they_resolved() {
    let a = analysis("extract");
    let companies = on_line(&a, "extract", 19);
    assert_eq!(companies["binding"], "companies");
    assert_eq!(companies["node"]["name"], "Company");
    let fields: Vec<&str> = companies["node"]["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(fields, ["name", "employees"]);
    assert_eq!(companies["node"]["fields"][1]["type"], "number");
    let details = on_line(&a, "extract", 22);
    assert_eq!(details["binding"], "details");
    assert_ne!(details["scope"], companies["scope"], "inside the map's closure");
}

#[test]
fn shapes_hold_each_node_declaration_with_its_base_folded_in() {
    let a = analysis("extract");
    let shapes = a["shapes"].as_array().unwrap();
    let names: Vec<&str> = shapes.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Company", "CompanyDetail"]);
    assert_eq!(shapes[0]["root"]["fields"][0]["name"], "name");

    let source = "node Base: \"a base\" {\n  name: <text> \"its name\"\n}\n\nnode Wide extends Base: \"wider\" {\n  size: <number> \"how big\"\n}\n";
    let answer = story_analysis_json(source, CATALOG, options());
    let wide = answer["shapes"].as_array().unwrap().iter().find(|s| s["name"] == "Wide").unwrap();
    let fields: Vec<&str> = wide["root"]["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(fields, ["name", "size"], "{answer}");
}

#[test]
fn a_movement_s_effects_are_closed_over_the_movements_it_calls() {
    let a = analysis("calls");
    // A movement calling itself is a cycle the row closes over, not a callee nobody could see.
    assert_eq!(symbol(&a, "countdown")["effects"], json!({ "reads": [], "writes": [], "ai": false, "now": false, "suspend": false, "partial": false }));
    assert_eq!(symbol(&a, "note")["effects"]["writes"], json!(["crm"]));
    let intake = &symbol(&a, "Intake")["effects"];
    assert_eq!(intake["writes"], json!(["crm"]), "the write is the callee's, folded in");
    assert_eq!(intake["reads"], json!(["the web"]), "what a plugin declares it reads");
    assert_eq!(intake["partial"], true, "a plugin that declares nothing is a callee nobody could see");

    let r = analysis("reviews");
    let triage = &symbol(&r, "Triage Inbound")["effects"];
    assert_eq!(triage["ai"], true);
    assert_eq!(triage["suspend"], true);
    assert_eq!(triage["partial"], false);
    assert_eq!(triage["reads"], json!(["team", "asks"]));
    assert_eq!(triage["writes"], json!(["asks", "team", "crm"]));

    let w = analysis("writes");
    assert_eq!(symbol(&w, "Rewire")["effects"], json!({ "reads": [], "writes": ["crm"], "ai": false, "now": false, "suspend": false, "partial": false }));
    assert_eq!(symbol(&w, "Intake")["effects"]["reads"], json!(["crm"]), "a match finds, so it reads");
    let e = analysis("extract");
    assert_eq!(symbol(&e, "Enrich")["effects"]["ai"], true);
}

#[test]
fn a_walk_inside_exists_reads_its_start_and_landings() {
    let a = analysis("exists_where");
    let intake = &symbol(&a, "Intake")["effects"];
    assert_eq!(intake["reads"], json!(["inbox"]), "the hop under the WHERE is a fetch from the inbox");
    assert_eq!(intake["writes"], json!(["crm"]));
    assert_eq!(intake["partial"], false);
}

#[test]
fn a_built_in_that_reads_a_file_reads_the_files() {
    let a = analysis("file_read");
    let cut = &symbol(&a, "Cut A Document")["effects"];
    // The order a row lists its reads in is not the source's (the expression sites come first).
    let mut reads: Vec<&str> = cut["reads"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
    reads.sort_unstable();
    assert_eq!(reads, ["files", "runs"], "File.read reads what the standard library declares it reads");
    assert_eq!(cut["ai"], true);
    assert_eq!(cut["partial"], false);
    let intake = &symbol(&a, "Intake Documents")["effects"];
    assert!(intake["reads"].as_array().unwrap().contains(&json!("files")), "a File.read nested in an argument: {intake}");
}

#[test]
fn only_a_built_in_that_reads_the_clock_marks_now() {
    let a = analysis("clock");
    assert_eq!(symbol(&a, "Intake")["effects"]["now"], true, "Date.today(zone) reads the run's instant");
    assert_eq!(symbol(&a, "Anchor Only")["effects"]["now"], false, "DateTime.at and Date.addDays read only their arguments");
}

#[test]
fn names_resolve_through_the_scope_table_as_the_checker_resolves_them() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let mut compared = 0;
    for (name, text) in FIXTURES {
        let a = analysis(name);
        let program = movement_parser::stmt::parse_program(text, false).unwrap();
        let checked = analyze(&program, &catalog, options());
        let mut names: Vec<(u64, &Json, String)> = Vec::new();
        for node in a["nodes"].as_array().unwrap() {
            let scope = node["scope"].as_u64().unwrap();
            let said = |key: &str| node[key].as_str().map(str::to_string);
            let mut here: Vec<String> = Vec::new();
            match node["kind"].as_str().unwrap() {
                "instance" => here.extend(said("name")),
                "listen" => here.extend(said("instance").into_iter().chain(said("fires"))),
                "link" | "unlink" => here.extend(said("from").into_iter().chain(node["to"]["name"].as_str().map(str::to_string))),
                "delete" | "refresh" => here.extend(said("subject")),
                "call" => here.extend(said("callee")),
                "traversal" | "valuePath" => here.extend(said("root")),
                "await" => here.extend(node["source"]["root"].as_str().map(str::to_string)),
                _ => {}
            }
            names.extend(here.into_iter().map(|n| (scope, &node["span"], n)));
        }
        for write in a["writes"].as_array().unwrap() {
            if let Some(binding) = write["binding"].as_str() {
                names.push((write["scope"].as_u64().unwrap(), &write["span"], binding.to_string()));
            }
        }
        for (scope, span, written) in names {
            let at = Loc { line: usize::try_from(span["start"]["line"].as_u64().unwrap()).unwrap(), col: usize::try_from(span["start"]["col"].as_u64().unwrap()).unwrap() };
            let theirs = checked.resolve(at, &written).map(|id| checked.symbol(id));
            let ours = resolve_in_table(&a, scope, &written);
            match (theirs, ours) {
                (Some(theirs), Some(ours)) => {
                    assert_eq!(ours["name"], json!(theirs.name), "{name}: '{written}' at {at:?}");
                    assert_eq!(ours["span"], json!(theirs.span), "{name}: '{written}' at {at:?}");
                }
                (None, None) => {}
                (theirs, ours) => panic!("{name}: '{written}' at {at:?}: the checker resolves {:?}, the table {ours:?}", theirs.map(|s| s.span)),
            }
            compared += 1;
        }
    }
    assert!(compared > 50, "{compared} names compared");
}

#[test]
fn a_source_that_does_not_parse_is_an_error() {
    let answer = story_analysis_json("function (", CATALOG, options());
    assert!(answer["error"]["message"].as_str().unwrap().contains("line 1"), "{answer}");
    let answer = story_analysis_json("x = 1\n", "{", options());
    assert!(answer["error"]["message"].is_string(), "a catalog that does not load: {answer}");
}

#[test]
fn a_refused_pin_is_the_version_diagnostic_alone() {
    let refused = refused_story_analysis("0.11.0").expect("0.11.0 is not this release's key");
    let diagnostics = refused["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["code"], "MOV_LANGUAGE_VERSION_UNSUPPORTED");
    assert_eq!(diagnostics[0], json!(movement_checker::language_version_diagnostic("0.11.0").unwrap()));
    for empty in ["scopes", "symbols", "writes", "nodes", "bodies", "shapes"] {
        assert_eq!(refused[empty], json!([]), "{empty}");
    }
    assert_eq!(refused["storyAnalysisVersion"], json!(STORY_ANALYSIS_VERSION));
    assert!(refused_story_analysis(movement_parser::version::LANGUAGE_VERSION).is_none());
}
