//! `listen to <traversal> fire f`: checked as a wait is, and planned for the
//! host. Two shapes:
//!
//! - `chat`: Channels → Messages (listable and announced, pushed to the
//!   connection, each arrival carrying its Channel) → Interactions (only
//!   announced, carrying its Channel and Message) → Actions. A Message's
//!   Reactions are announced and carry nothing.
//! - `at`: Bases → Tables (both cheap to list) → Changes (only announced,
//!   pushed per table); a Table's Edits (the same, each carrying its Table);
//!   a Table's Records (not cheap) → Comments (announced, polled), and Notes
//!   (only announced, pushed per record). A Change's Replies are announced.

use movement_checker::CheckOptions;
use movement_checker::families::filter_split::spell;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::listen_plan::ListenPlan;
use serde_json::json;

const CATALOG: &str = r#"{"adapters":{
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Channel":{"properties":{"Name":"text"},
      "edges":{"Messages":{"target":"Message","listenable":true,"identity":"Id","delivery":"connection","carries":["Channels"],
        "capability":{"filter":"native","supportsLimit":false}}},
      "propertyCapabilities":{"Name":{"filterOperators":["eq"]}}},
    "Message":{"properties":{"Id":"text","Topic":"text","Text":"text","Posted At":"datetime"},
      "edges":{
        "Interactions":{"target":"Interaction","readable":false,"listenable":true,"identity":"Id","delivery":"connection","carries":["Channels","Messages"]},
        "Reactions":{"target":"Reaction","readable":false,"listenable":true,"delivery":"connection"}},
      "propertyCapabilities":{"Topic":{"filterOperators":["eq"]}}},
    "Interaction":{"properties":{"Id":"text"},
      "edges":{"Actions":{"target":"Action","listenable":true,"delivery":"connection"},"By":{"target":"Person"}}},
    "Action":{"properties":{"Value":"text"},"edges":{}},
    "Person":{"properties":{"Name":"text"},"edges":{}},
    "Reaction":{"properties":{"Emoji":"text"},"edges":{}}},
    "collections":{"Channels":{"target":"Channel","capability":{"filter":"native","supportsLimit":false}}},
    "writableRoots":{}}}},
  "at":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Base":{"properties":{"Name":"text"},
      "edges":{"Tables":{"target":"Table","membersChange":"pushed","capability":{"filter":"native","supportsLimit":false}},
        "Views":{"target":"Table","membersChange":"pushed","listenable":true,"delivery":"scope","capability":{"filter":"native","supportsLimit":false}}},
      "propertyCapabilities":{"Name":{"filterOperators":["eq"]}}},
    "Table":{"properties":{"Name":"text","Created":"datetime"},
      "edges":{
        "Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope"},
        "Edits":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope","carries":["Tables"]},
        "Records":{"target":"Record","capability":{"filter":"native","supportsLimit":false}}},
      "propertyCapabilities":{"Name":{"filterOperators":["eq"]},"Created":{"filterOperators":["within"]}}},
    "Change":{"properties":{"Id":"text","Kind":"text"},
      "edges":{"Replies":{"target":"Reply","readable":false,"listenable":true,"delivery":"scope"}}},
    "Reply":{"properties":{"Text":"text"},"edges":{}},
    "Record":{"properties":{"Stage":"text"},
      "edges":{"Comments":{"target":"Comment","listenable":true,"delivery":"polled","pollEverySeconds":60},
        "Notes":{"target":"Comment","readable":false,"listenable":true,"delivery":"scope"}},
      "propertyCapabilities":{"Stage":{"filterOperators":["eq"]}}},
    "Comment":{"properties":{"Text":"text"},"edges":{}}},
    "collections":{"Bases":{"target":"Base","membersChange":{"relistEverySeconds":300},"capability":{"filter":"native","supportsLimit":false}}},
    "writableRoots":{}}}},
  "crm":{"canFire":true,"constructionArgs":[],"schemas":{"":{"positions":{
    "Company":{"properties":{"Name":"text"},"edges":{}}},
    "collections":{"Companies":{"target":"Company"}},
    "writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

/// The connections, and one function per landing a listen here fires with:
/// `f` takes a press, `c` a change, `r` a reaction, `k` a comment, `n` a
/// company. Five lines, so the source after it starts on line 6.
const PRELUDE: &str = "import { chat as chat_module, at as at_module, crm as crm_module } from adapters; chat = connect chat_module; at = connect at_module; crm = connect crm_module; function f(i: <chat-[:Interaction]->>) { return i.Id }\nfunction c(x: <at-[:Change]->>) { return x.Kind }\nfunction r(x: <chat-[:Reaction]->>) { return x.Emoji }\nfunction k(x: <at-[:Comment]->>) { return x.Text }\nfunction n(x: <crm-[:Company]->>) { return x.Name }\n";

fn options() -> CheckOptions<'static> {
    CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones }
}

fn check(source: &str) -> Vec<String> {
    let source = format!("{PRELUDE}{source}");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    movement_checker::check_source(&source, &catalog, options())
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

/// The plans the check answers, and its diagnostics' codes.
fn answer_of(source: &str) -> (Vec<ListenPlan>, Vec<String>) {
    let source = format!("{PRELUDE}{source}");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let program = movement_parser::stmt::parse_program(&source, false).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let answer = movement_checker::answer::check_answer(&program, &catalog, options());
    (answer.listens, answer.diagnostics.into_iter().map(|d| d.code).collect())
}

fn plans_of(source: &str) -> Vec<ListenPlan> {
    let (plans, codes) = answer_of(source);
    assert_eq!(codes, Vec::<String>::new(), "{source}");
    plans
}

fn judged(plan: &ListenPlan) -> serde_json::Value {
    serde_json::to_value(plan.hops.iter().map(|h| h.judged).collect::<Vec<_>>()).unwrap()
}

#[test]
fn a_listen_on_a_listenable_edge_fires_a_function_typed_by_its_landing() {
    assert_eq!(check("listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"lunch-poll\"]->-[:Interactions]-> fire f\n"), Vec::<String>::new());
    assert_eq!(check("listen to at-[:Bases]->-[:Tables]->-[x:Changes WHERE x.Kind == \"created\"]-> fire c\n"), Vec::<String>::new());
    // The plan names the connection, its module, and each hop's types.
    let plans = plans_of("listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"lunch-poll\"]->-[:Interactions]-> fire f\n");
    assert_eq!(
        serde_json::to_value(&plans).unwrap(),
        json!([{
            "movement": "f", "connection": "chat", "adapter": "chat", "carries": ["Channels", "Messages"],
            "hops": [
                { "edge": "Channels", "from": "", "to": "Channel", "judged": "none" },
                { "edge": "Messages", "from": "Channel", "to": "Message", "alias": "m",
                  "taken": { "type": "compare", "op": "eq", "left": { "type": "edge_property", "propertyTypeId": "Topic", "fieldOnly": true }, "right": { "type": "static", "value": "lunch-poll" } },
                  "judged": "arrival" },
                { "edge": "Interactions", "from": "Message", "to": "Interaction", "judged": "arrival" }
            ]
        }])
    );
}

#[test]
fn the_plan_judges_carried_hops_on_arrival_and_lists_cheap_ones() {
    let plans = plans_of("listen to at-[b:Bases WHERE b.Name == \"Finance\"]->-[t:Tables WHERE t.Name == \"Expenses\"]->-[x:Changes WHERE x.Kind == \"created\"]-> fire c\n");
    assert_eq!(judged(&plans[0]), json!(["resolved", "resolved", "arrival"]));
    assert_eq!(spell(plans[0].hops[2].checked.as_ref().unwrap(), Some("x")), "x.Kind == \"created\"");
    assert_eq!(spell(plans[0].hops[1].taken.as_ref().unwrap(), Some("t")), "t.Name == \"Expenses\"");
    // A filter an arrival carries is judged on it, whatever listing costs.
    let plans = plans_of("listen to chat-[h:Channels WHERE h.Name == \"office\"]->-[m:Messages WHERE m.Topic == \"lunch-poll\"]->-[:Interactions]-> fire f\n");
    assert_eq!(judged(&plans[0]), json!(["arrival", "arrival", "arrival"]));
    // With no filter, a hop is listed only when the last edge is pushed per
    // scope: the heads must be listed to subscribe to each.
    assert_eq!(judged(&plans_of("listen to at-[:Bases]->-[:Tables]->-[:Changes]-> fire c\n")[0]), json!(["resolved", "resolved", "arrival"]));
    assert_eq!(judged(&plans_of("listen to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f\n")[0]), json!(["none", "none", "arrival"]));
    // Under a scope, every earlier hop is listed, filtered or not: the host
    // lists the heads to subscribe, so it judges their filters as it does.
    // A hop the arrival carries is listed too.
    let plans = plans_of("listen to at-[:Bases]->-[t:Tables WHERE t.Name == \"Deals\"]->-[:Edits]-> fire c\n");
    assert_eq!(judged(&plans[0]), json!(["resolved", "resolved", "arrival"]));
    // And one not cheap to list is listed all the same: the module's scope
    // promises its heads can be listed.
    let plans = plans_of("listen to at-[:Bases]->-[:Tables]->-[r:Records WHERE r.Stage == \"Won\"]->-[:Notes]-> fire k\n");
    assert_eq!(judged(&plans[0]), json!(["resolved", "resolved", "resolved", "arrival"]));
    assert_eq!(judged(&plans_of("listen to at-[:Bases]->-[:Tables]->-[:Records]->-[:Notes]-> fire k\n")[0]), json!(["resolved", "resolved", "resolved", "arrival"]));
    // Two conjuncts the module takes are joined back by AND; one it does not
    // take is the host's.
    let (plans, codes) = answer_of("listen to at-[b:Bases WHERE b.Name == \"Finance\"]->-[t:Tables WHERE t.Name == \"Expenses\" AND t.Name != \"Old\"]->-[:Changes]-> fire c\n");
    // The host checking it is said, as for any read.
    assert_eq!(codes, ["MOV_HOP_FILTER_RESIDUAL"]);
    assert_eq!(
        (spell(plans[0].hops[1].taken.as_ref().unwrap(), Some("t")), spell(plans[0].hops[1].checked.as_ref().unwrap(), Some("t"))),
        ("t.Name == \"Expenses\"".to_string(), "t.Name != \"Old\"".to_string())
    );
}

#[test]
fn comments_across_a_table_are_unwatchable() {
    assert_eq!(
        check("listen to at-[:Bases]->-[t:Tables WHERE t.Name == \"Deals\"]->-[r:Records WHERE r.Stage == \"Won\"]->-[:Comments]-> fire k\n"),
        ["MOV_LISTEN_UNWATCHABLE 6:11-6:112 this listen filters '-[:Records]->' with `r.Stage == \"Won\"`, but at's arrivals on '-[:Comments]->' don't carry the Record they are under, and listing every Record to re-check it isn't cheap — filter on what arrives, or wait on one record in a run: `await r-[:Comments]->`"]
    );
    assert_eq!(
        check("listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"x\"]->-[:Reactions]-> fire r\n"),
        ["MOV_LISTEN_UNWATCHABLE 6:11-6:80 this listen filters '-[:Messages]->' with `m.Topic == \"x\"`, but chat's arrivals on '-[:Reactions]->' don't carry the Message they are under, and listing every Message to re-check it isn't cheap — filter on what arrives, or wait on one record in a run: `await m-[:Reactions]->`"]
    );
    // An unwatchable listen has no plan.
    let (plans, codes) = answer_of("listen to at-[:Bases]->-[t:Tables WHERE t.Name == \"Deals\"]->-[r:Records WHERE r.Stage == \"Won\"]->-[:Comments]-> fire k\n");
    assert_eq!((plans.len(), codes), (0, vec!["MOV_LISTEN_UNWATCHABLE".to_string()]));
    // Unfiltered, the comments are listened to as they are polled.
    assert_eq!(judged(&plans_of("listen to at-[:Bases]->-[:Tables]->-[:Records]->-[:Comments]-> fire k\n")[0]), json!(["none", "none", "none", "arrival"]));
}

/// A hop the host lists whose changes its module reports per record it
/// hangs off is planned as any listed hop: listen-fire watches it once per
/// record it hangs off (Airtable's schema webhook, one per base), filtered
/// or not.
#[test]
fn a_listed_hop_whose_changes_are_reported_per_record_is_planned_as_any_listed_hop() {
    assert_eq!(check("listen to at-[:Bases]->-[v:Views WHERE v.Name == \"Deals\"]->-[:Changes]-> fire c\n"), Vec::<String>::new());
    assert_eq!(judged(&plans_of("listen to at-[:Bases]->-[v:Views WHERE v.Name == \"Deals\"]->-[:Changes]-> fire c\n")[0]), json!(["resolved", "resolved", "arrival"]));
    let (plans, codes) = answer_of("listen to at-[:Bases]->-[:Views]->-[:Changes]-> fire c\n");
    assert_eq!((plans.len(), codes), (1, Vec::<String>::new()), "listed under a scope, filtered or not");
    assert_eq!(judged(&plans_of("listen to at-[:Bases]->-[t:Tables WHERE t.Name == \"Deals\"]->-[:Changes]-> fire c\n")[0]), json!(["resolved", "resolved", "arrival"]));
}

#[test]
fn a_listen_must_end_on_a_listenable_edge() {
    assert_eq!(
        check("function h(x: <chat-[:Channel]->>) { return x.Name }\nlisten to chat-[:Channels]-> fire h\n"),
        ["MOV_LISTEN_EDGE_NOT_LISTENABLE 7:11-7:29 '-[:Channels]->' on chat announces nothing, so a listen on it would never fire — a listen ends on an edge its module announces arrivals on"]
    );
    assert_eq!(
        check("function h(x: <at-[:Record]->>) { return x.Stage }\nlisten to at-[:Bases]->-[:Tables]->-[:Records]-> fire h\n"),
        ["MOV_LISTEN_EDGE_NOT_LISTENABLE 7:11-7:49 '-[:Records]->' on at's Table announces nothing, so a listen on it would never fire — a listen ends on an edge its module announces arrivals on, such as '-[:Changes]->'"]
    );
}

#[test]
fn a_listen_cannot_pass_through_an_only_announced_edge() {
    assert_eq!(
        check("function h(x: <chat-[:Action]->>) { return x.Value }\nlisten to chat-[:Channels]->-[:Messages]->-[:Interactions]->-[:Actions]-> fire h\n"),
        ["MOV_LISTEN_HOP_NOT_ITERABLE 7:11-7:74 '-[:Interactions]->' on chat's Message can't be listed, so a listen can't pass through it — only a listen's last edge may be one that is only announced"]
    );
    assert_eq!(
        check("function h(x: <at-[:Reply]->>) { return x.Text }\nlisten to at-[:Bases]->-[:Tables]->-[:Changes]->-[:Replies]-> fire h\n"),
        ["MOV_LISTEN_HOP_NOT_ITERABLE 7:11-7:62 '-[:Changes]->' on at's Table can't be listed, so a listen can't pass through it — only a listen's last edge may be one that is only announced"]
    );
}

#[test]
fn a_listen_where_reads_only_its_hops_and_literals() {
    assert_eq!(
        check("topic = \"lunch-poll\"\nlisten to chat-[:Channels]->-[m:Messages WHERE m.Topic == topic]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_IMPURE_WHERE 7:11-7:85 a listen's WHERE reads only its hops and literals — 'topic' is neither"]
    );
    assert_eq!(
        check("base = \"Finance\"\nlisten to at-[b:Bases WHERE b.Name == base]->-[:Tables]->-[:Changes]-> fire c\n"),
        ["MOV_LISTEN_IMPURE_WHERE 7:11-7:71 a listen's WHERE reads only its hops and literals — 'base' is neither"]
    );
    // What only a run can evaluate is refused the same way, and only once.
    assert_eq!(
        check("listen to chat-[:Channels]->-[:Messages]->-[i:Interactions WHERE AI(\"is it a yes\")]-> fire f\n"),
        ["MOV_LISTEN_IMPURE_WHERE 6:11-6:86 a listen's WHERE reads only its hops and literals — 'ai' is neither"]
    );
    // A walk is only a run's to take, whatever it starts from: off a hop's
    // alias, or inside EXISTS. It is refused once, as the listen's.
    assert_eq!(
        check("listen to chat-[h:Channels WHERE EXISTS(h-[:Messages]->)]->-[m:Messages]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_IMPURE_WHERE 6:11-6:93 a listen's WHERE reads only its hops and literals — 'h-[:Messages]->' is neither"]
    );
    assert_eq!(
        check("listen to chat-[:Channels]->-[m:Messages WHERE EXISTS(m-[:Reactions]->)]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_IMPURE_WHERE 6:11-6:93 a listen's WHERE reads only its hops and literals — 'm-[:Reactions]->' is neither"]
    );
    assert_eq!(
        check("listen to chat-[h:Channels]->-[:Messages]->-[i:Interactions WHERE h-[:Messages]->.Topic == \"x\"]-> fire f\n"),
        ["MOV_LISTEN_IMPURE_WHERE 6:11-6:98 a listen's WHERE reads only its hops and literals — 'h-[:Messages]->' is neither"]
    );
    // What the rest of a WHERE says is still checked.
    assert_eq!(
        check("listen to chat-[h:Channels]->-[m:Messages WHERE EXISTS(m-[:Reactions]->) AND m.Nope == \"x\"]->-[:Interactions]-> fire f\n")
            .iter()
            .map(|d| d.split(' ').next().unwrap().to_string())
            .collect::<Vec<_>>(),
        ["MOV_UNKNOWN_PROPERTY", "MOV_LISTEN_IMPURE_WHERE"]
    );
    // An earlier hop's alias is one of its hops: the host checks it.
    let plans = plans_of("listen to at-[b:Bases WHERE b.Name == \"Finance\"]->-[t:Tables WHERE t.Name == b.Name]->-[:Changes]-> fire c\n");
    assert_eq!((spell(plans[0].hops[1].checked.as_ref().unwrap(), Some("t")), plans[0].hops[1].taken.is_none()), ("t.Name == b.Name".to_string(), true));
}

#[test]
fn a_parameter_wider_than_the_landing_is_accepted_and_a_different_one_refused() {
    // `f` takes any press; the listen narrows its messages. Assignable.
    assert_eq!(check("listen to chat-[h:Channels WHERE h.Name == \"office\"]->-[m:Messages WHERE m.Topic == \"lunch-poll\"]->-[:Interactions]-> fire f\n"), Vec::<String>::new());
    assert_eq!(check("listen to at-[b:Bases WHERE b.Name == \"Finance\"]->-[:Tables]->-[:Changes]-> fire c\n"), Vec::<String>::new());
    assert_eq!(
        check("function g(m: <chat-[:Message]->>) { return m.Topic }\nlisten to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire g\n"),
        ["MOV_LISTEN_PARAM_MISMATCH 7:1-7:68 'g' takes 'm: <chat-[:Message]->>', but this listen fires with what lands on '-[:Interactions]->' ('<chat-[:Channels]->-[:Messages]->-[:Interactions]->>') — the parameter's type must accept it"]
    );
    assert_eq!(
        check("listen to at-[:Bases]->-[:Tables]->-[:Changes]-> fire n\n"),
        ["MOV_LISTEN_PARAM_MISMATCH 6:1-6:56 'n' takes 'x: <crm-[:Company]->>', but this listen fires with what lands on '-[:Changes]->' ('<at-[:Bases]->-[:Tables]->-[:Changes]->>') — the parameter's type must accept it"]
    );
    assert_eq!(
        check("function v(x: <text>) { return x }\nlisten to at-[:Bases]->-[:Tables]->-[:Changes]-> fire v\n"),
        ["MOV_LISTEN_PARAM_MISMATCH 7:1-7:56 'v' takes 'x: <text>', but this listen fires with what lands on '-[:Changes]->' ('<at-[:Bases]->-[:Tables]->-[:Changes]->>') — the parameter's type must accept it"]
    );
}

#[test]
fn a_listen_inside_a_function_is_refused() {
    assert_eq!(
        check("function g() {\n  listen to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f\n}\n"),
        ["MOV_LISTEN_FILE_LEVEL 7:3-7:70 'listen' is a file-level statement — it declares the file's listeners, so move it out of this block"]
    );
    assert_eq!(
        check("function g() {\n  listen to at-[:Bases]->-[:Tables]->-[:Changes]-> fire c\n}\n"),
        ["MOV_LISTEN_FILE_LEVEL 7:3-7:58 'listen' is a file-level statement — it declares the file's listeners, so move it out of this block"]
    );
}

#[test]
fn the_settings_form_still_parses() {
    let source = format!("{PRELUDE}listen to crm {{ events: [\"company.created\"] }} fire n\n");
    let program = movement_parser::stmt::parse_program(&source, false).unwrap();
    let Some(movement_parser::ast::Statement::Listen(listen)) = program.statements.last() else { panic!("a listen") };
    assert_eq!((listen.path.is_none(), listen.config.len(), listen.instance.as_str()), (true, 1, "crm"));
    // It is checked as before, and is no plan.
    let (plans, _) = answer_of("listen to crm { events: [\"company.created\"] } fire n\n");
    assert!(plans.is_empty());
}

#[test]
fn listen_as_keeps_its_alias_on_the_plan() {
    let plans = plans_of("listen as \"Lunch\" to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f\nlisten to at-[:Bases]->-[:Tables]->-[:Changes]-> fire c\n");
    assert_eq!(plans.iter().map(|p| p.alias.as_deref()).collect::<Vec<_>>(), [Some("Lunch"), None]);
    assert!(!serde_json::to_value(&plans[1]).unwrap().as_object().unwrap().contains_key("alias"));
    assert_eq!(
        check("listen as \"Lunch\" to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f\nlisten as \"Lunch\" to chat-[h:Channels WHERE h.Name == \"office\"]->-[:Messages]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_ALIAS_DUPLICATE 7:1-7:105 Two lanes of 'f' are both named \"Lunch\" — give each listen a distinct alias"]
    );
}

#[test]
fn two_listens_with_one_plan_are_one_too_many() {
    assert_eq!(
        check("listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"a\"]->-[:Interactions]-> fire f\nlisten to chat-[:Channels]->-[m:Messages  WHERE  m.Topic == \"a\"]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_DUPLICATE 7:1-7:92 Duplicate listener — an identical 'listen to chat-[:Channels]->-[m:Messages  WHERE  m.Topic == \"a\"]->-[:Interactions]->' already fires 'f'"]
    );
    // A hop's alias is the listen's own name for it: spelled otherwise, it
    // is the same listen.
    assert_eq!(
        check("listen to chat-[h:Channels WHERE h.Name == \"x\"]->-[m:Messages WHERE m.Topic == h.Name]->-[:Interactions]-> fire f\nlisten to chat-[c:Channels WHERE c.Name == \"x\"]->-[n:Messages WHERE n.Topic == c.Name]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_DUPLICATE 7:1-7:114 Duplicate listener — an identical 'listen to chat-[c:Channels WHERE c.Name == \"x\"]->-[n:Messages WHERE n.Topic == c.Name]->-[:Interactions]->' already fires 'f'"]
    );
    // The plan keeps the aliases as written.
    let plans = plans_of("listen to chat-[:Channels]->-[n:Messages WHERE n.Topic == \"a\"]->-[:Interactions]-> fire f\n");
    assert_eq!(plans[0].hops[1].alias.as_deref(), Some("n"));
    // A lane's name is not what it listens to, as for the settings form: two
    // lanes of one function on one plan are one too many.
    assert_eq!(
        check("listen as \"A\" to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f\nlisten as \"B\" to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f\n"),
        ["MOV_LISTEN_DUPLICATE 7:1-7:75 Duplicate listener — an identical 'listen to chat-[:Channels]->-[:Messages]->-[:Interactions]->' already fires 'f'"]
    );
    // Another filter, or another function, is another listen.
    assert_eq!(
        check("listen to at-[:Bases]->-[:Tables]->-[x:Changes WHERE x.Kind == \"a\"]-> fire c\nlisten to at-[:Bases]->-[:Tables]->-[x:Changes WHERE x.Kind == \"b\"]-> fire c\n"),
        Vec::<String>::new()
    );
}

#[test]
fn the_story_of_a_listen_on_a_traversal_names_its_path() {
    let source = format!("{PRELUDE}listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"lunch-poll\"]->-[:Interactions]-> fire f\n");
    let story = movement_checker::story::story_analysis_json(&source, CATALOG, options());
    let listens: Vec<&serde_json::Value> = story["nodes"].as_array().unwrap().iter().filter(|n| n["kind"] == "listen").collect();
    assert_eq!(listens.len(), 1, "{story}");
    assert_eq!(
        (&listens[0]["instance"], &listens[0]["adapterType"], &listens[0]["fires"], &listens[0]["path"]),
        (&json!("chat"), &json!("chat"), &json!("f"), &json!("chat-[:Channels]->-[m:Messages WHERE m.Topic == \"lunch-poll\"]->-[:Interactions]->"))
    );
}

/// One name for two hops: the checker would read the nearest, the judge the
/// first. Refused where it is written, on a listen as on any walk.
#[test]
fn a_hop_alias_written_twice_in_one_listen_is_refused() {
    assert_eq!(
        check("listen to chat-[c:Channels WHERE c.Name == \"x\"]->-[c:Messages]->-[i:Interactions WHERE i.Id == c.Topic]-> fire f\n"),
        ["MOV_HOP_ALIAS_REPEATED 6:11-6:106 'c' names two hops of this walk, '-[c:Channels]->' and '-[c:Messages]->' — a name means one thing everywhere it is visible: give each hop its own alias"]
    );
    // And it is watched by no plan.
    let (plans, codes) = answer_of("listen to chat-[c:Channels WHERE c.Name == \"x\"]->-[c:Messages]->-[i:Interactions WHERE i.Id == c.Topic]-> fire f\n");
    assert_eq!((plans.len(), codes), (0, vec!["MOV_HOP_ALIAS_REPEATED".to_string()]));
    // Each hop its own alias: the same listen, planned.
    assert_eq!(judged(&plans_of("listen to chat-[h:Channels WHERE h.Name == \"x\"]->-[c:Messages]->-[i:Interactions WHERE i.Id == c.Topic]-> fire f\n")[0]), json!(["arrival", "none", "arrival"]));
}

/// The judge reads only the records an arrival carries, so a filter judged
/// on arrival that reads an earlier hop the arrival does not carry could
/// never be judged: every arrival would be undecided.
#[test]
fn a_filter_judged_on_arrival_reads_only_the_hops_the_arrival_carries() {
    // The earlier hop unfiltered, so not listed: a reaction carries nothing.
    assert_eq!(
        check("listen to chat-[:Channels]->-[m:Messages]->-[x:Reactions WHERE x.Emoji == m.Topic]-> fire r\n"),
        ["MOV_LISTEN_UNWATCHABLE 6:11-6:85 this listen's filter on '-[:Reactions]->' reads `m`, the Message it is under, but chat's arrivals on '-[:Reactions]->' don't carry the Message, so no arrival could be judged by it — compare with a literal, or wait in a run, where the Message is a record the run holds"]
    );
    // Listed is not carried: the host lists the Table, the judge never sees it.
    assert_eq!(
        check("listen to at-[:Bases]->-[t:Tables]->-[x:Changes WHERE x.Id == t.Name]-> fire c\n"),
        ["MOV_LISTEN_UNWATCHABLE 6:11-6:72 this listen's filter on '-[:Changes]->' reads `t`, the Table it is under, but at's arrivals on '-[:Changes]->' don't carry the Table, so no arrival could be judged by it — compare with a literal, or wait in a run, where the Table is a record the run holds"]
    );
    assert_eq!(answer_of("listen to at-[:Bases]->-[t:Tables]->-[x:Changes WHERE x.Id == t.Name]-> fire c\n").0.len(), 0);
    // What the arrival carries, it may read.
    assert_eq!(check("listen to at-[:Bases]->-[t:Tables]->-[x:Edits WHERE x.Id == t.Name]-> fire c\n"), Vec::<String>::new());
    assert_eq!(check("listen to chat-[:Channels]->-[m:Messages]->-[i:Interactions WHERE i.Id == m.Topic]-> fire f\n"), Vec::<String>::new());
    // A listed hop may read the hops listed above it: the host lists them in one walk.
    assert_eq!(check("listen to at-[b:Bases]->-[t:Tables WHERE t.Name == b.Name]->-[:Changes]-> fire c\n"), Vec::<String>::new());
}

/// A listed hop is judged again only when it is listed again; a window
/// measured from now would keep a record that has aged out of it.
#[test]
fn a_window_from_now_is_judged_on_arrival_never_on_a_listed_hop() {
    assert_eq!(
        check("listen to at-[:Bases]->-[t:Tables WHERE t.Created WITHIN 1d]->-[:Changes]-> fire c\n"),
        ["MOV_LISTEN_UNWATCHABLE 6:11-6:76 this listen filters '-[:Tables]->' by a window measured from now (`WITHIN`), but that hop is listed to find what to watch, and judged again only when it is listed again, so a record that ages out of the window would keep firing — a window is judged on what arrives: put it on '-[:Changes]->', or on a hop its arrivals carry"]
    );
    // Inside an AND, and on a hop listed because it is cheap.
    assert_eq!(
        check("listen to at-[b:Bases WHERE b.Name == \"x\"]->-[t:Tables WHERE t.Name == \"y\" AND t.Created WITHIN 1d]->-[:Records]->-[:Comments]-> fire k\n")
            .iter()
            .map(|d| d.split(' ').next().unwrap().to_string())
            .collect::<Vec<_>>(),
        ["MOV_LISTEN_UNWATCHABLE"]
    );
    // On what arrives, or on a hop the arrival carries, it is judged with now.
    assert_eq!(check("listen to chat-[:Channels]->-[m:Messages WHERE m.`Posted At` WITHIN 1d]->-[:Interactions]-> fire f\n"), Vec::<String>::new());
    // Spelled back as written: a window is a duration, not a text.
    let plans = plans_of("listen to chat-[:Channels]->-[m:Messages WHERE m.`Posted At` WITHIN 1d AND NOT exists(m.Topic)]->-[:Interactions]-> fire f\n");
    assert_eq!(spell(plans[0].hops[1].checked.as_ref().unwrap(), Some("m")), "m.`Posted At` WITHIN 1d AND NOT exists(m.Topic)");
    assert_eq!(check("listen to chat-[:Channels]->-[m:Messages WHERE m.`Posted At` WITHIN 1d]-> fire g\nfunction g(m: <chat-[:Message]->>) { return m.Topic }\n"), Vec::<String>::new());
}

const UNIONS: &str = r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Note","listenable":true,"delivery":"connection","carries":["Subjects"]}}},
    "Company":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Note","listenable":true,"delivery":"connection","carries":["Subjects"]}}},
    "Note":{"properties":{"Text":"text"},"edges":{}}},
    "unions":{"Subject":["Person","Company"]},
    "collections":{"Subjects":{"target":"Subject","membersChange":{"relistEverySeconds":300},"capability":{"filter":"native","supportsLimit":false}},
                   "Things":{"target":"Subject","listenable":true,"delivery":"connection"},
                   "People":{"target":"Person","membersChange":{"relistEverySeconds":300},"listenable":true,"delivery":"connection"}},
    "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check_unions(source: &str) -> (usize, Vec<String>) {
    let source = format!("import {{ crm as m }} from adapters; crm = connect m;\nfunction f(n: <crm-[:Note]->>) {{ return n.Text }}\nfunction g(n: <crm-[:Things]->>) {{ return n.Name }}\nfunction p(n: <crm-[:Person]->>) {{ return n.Name }}\n{source}");
    let catalog = CatalogSnapshot::load(UNIONS).unwrap();
    let program = movement_parser::stmt::parse_program(&source, false).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let answer = movement_checker::answer::check_answer(&program, &catalog, options());
    (answer.listens.len(), answer.diagnostics.into_iter().filter(|d| d.severity.is_none()).map(|d| format!("{} {}", d.code, d.message)).collect())
}

/// The judge tells an arrival's records apart by the record type each hop
/// lands on, and an arrival is only ever one member of a union: a listen
/// through or onto one would check clean and never fire.
#[test]
fn a_listen_through_or_onto_a_union_is_refused() {
    assert_eq!(
        check_unions("listen to crm-[:Subjects]->-[:Notes]-> fire f\n"),
        (0, vec!["MOV_LISTEN_UNION_HOP '-[:Subjects]->' on crm lands on Subject, which is one of Person or Company, and every hop of a listen lands on one record type: the host tells what arrives apart by it, so this listen would never fire — listen through an edge that lands on Person or Company alone, or wait in a run on one record".to_string()])
    );
    assert_eq!(
        check_unions("listen to crm-[t:Things WHERE t.Name == \"x\"]-> fire g\n"),
        (0, vec!["MOV_LISTEN_UNION_HOP '-[:Things]->' on crm lands on Subject, which is one of Person or Company, and every hop of a listen lands on one record type: the host tells what arrives apart by it, so this listen would never fire — listen through an edge that lands on Person or Company alone, or wait in a run on one record".to_string()])
    );
    // One member's edge is watched.
    assert_eq!(check_unions("listen to crm-[:People]->-[:Notes]-> fire f\n"), (1, Vec::<String>::new()));
    assert_eq!(check_unions("listen to crm-[w:People WHERE w.Name == \"x\"]-> fire p\n"), (1, Vec::<String>::new()));
}

/// A listen that checks clean is watched: one on a system the catalog does
/// not describe says so where it is written.
#[test]
fn a_listen_with_no_plan_never_checks_clean() {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{"manual":{"constructionArgs":[],"canFire":true,"schemas":{}}},"credentials":{},"plugins":{}}"#).unwrap();
    let source = "import { manual } from adapters\nruns = connect manual\nfunction recap(go: <runs-[:Invocation]->>) { return 1 }\nlisten to runs-[:Invocations]-> fire recap\n";
    let program = movement_parser::stmt::parse_program(source, false).unwrap();
    let answer = movement_checker::answer::check_answer(&program, &catalog, options());
    assert_eq!(
        (answer.listens.len(), answer.diagnostics.iter().map(|d| format!("{} {}", d.code, d.message)).collect::<Vec<_>>()),
        (0, vec!["MOV_EVENT_UNDESCRIBED 'runs' has no description in the catalog, so listen-fire can't tell what this listen watches — it would never fire. The catalog describes it from the system behind 'runs': check that its connection resolves and the system answers, then check again.".to_string()])
    );
}

/// A hop judged on each arrival is fetched by nothing: what its module can't
/// filter, the judge checks, and no fetch grows for it.
#[test]
fn what_a_module_cannot_filter_on_a_hop_judged_on_arrival_costs_no_fetch() {
    let (plans, codes) = answer_of("listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"a\" AND m.Text == \"b\"]->-[:Interactions]-> fire f\n");
    assert_eq!((codes, spell(plans[0].hops[1].checked.as_ref().unwrap(), Some("m"))), (Vec::<String>::new(), "m.Text == \"b\"".to_string()));
    assert_eq!(check("listen to chat-[:Channels]->-[m:Messages WHERE m.Text == \"b\"]->-[:Interactions]-> fire f\n"), Vec::<String>::new());
    // A listed hop is fetched: the host lists it, and filters what comes back.
    assert_eq!(answer_of("listen to at-[:Bases]->-[t:Tables WHERE t.Name == \"a\" AND t.Name != \"b\"]->-[:Changes]-> fire c\n").1, ["MOV_HOP_FILTER_RESIDUAL"]);
}

/// A file with no listen is shown one to paste for each function a listen
/// could fire: a parameter typed by a record type is reached by the walk to
/// an edge that announces it, since a listen ends on an edge.
#[test]
fn the_missing_listen_hint_ends_on_an_edge() {
    let found: Vec<String> = check("").into_iter().filter(|d| d.starts_with("MOV_LISTEN_MISSING")).collect();
    assert_eq!(
        found,
        [
            "MOV_LISTEN_MISSING 1:161-1:161 'f' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to chat-[:Channels]->-[:Messages]->-[:Interactions]-> fire f",
            "MOV_LISTEN_MISSING 2:1-2:1 'c' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to at-[:Bases]->-[:Tables]->-[:Changes]-> fire c",
            "MOV_LISTEN_MISSING 3:1-3:1 'r' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to chat-[:Channels]->-[:Messages]->-[:Reactions]-> fire r",
            "MOV_LISTEN_MISSING 4:1-4:1 'k' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to at-[:Bases]->-[:Tables]->-[:Records]->-[:Comments]-> fire k",
            "MOV_LISTEN_MISSING 5:1-5:1 'n' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to crm-[:…]-> fire n",
        ]
    );
}
