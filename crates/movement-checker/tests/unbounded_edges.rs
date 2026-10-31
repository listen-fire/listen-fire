//! No traversal ranges over an unbounded edge, and a hop's WHERE splits
//! into what its module takes and what the host checks. Three shapes:
//!
//! - `cron`: `Ticks` is unbounded, narrowed only by `Schedule` (a `Cron`);
//!   `Zone` is a `Zone`. Both are scalars only the module evaluates.
//! - `inbox`: `Emails` is unbounded, narrowed only by `Key` (an `InboxKey`
//!   with an allow pattern).
//! - `gmail`: `Messages` is bounded; `Query` (a `GmailQuery`) is taken with
//!   `==` only, and `Subject` is taken with nothing. `Drafts` is written to
//!   and never read.
//!
//! A listen is a traversal (Task 5 gives it its statement): until then a
//! wait on the path checks its hop the same way, so `check_listen` waits.

use movement_checker::families::filter_split::{EdgeView, Split, split_where, spell};
use movement_checker::{CheckOptions, Diagnostic};
use movement_parser::catalog::types::{CatalogSnapshot, PositionSchema};
use movement_parser::lowering::expression::{Expression, TraversalStep};

const CATALOG: &str = r#"{"adapters":{
  "cron":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Tick":{"properties":{
        "Schedule":{"kind":"owned","name":"Cron","owner":"cron"},
        "Zone":{"kind":"owned","name":"Zone","owner":"cron"},
        "Name":"text"},
      "edges":{},
      "propertyCapabilities":{"Schedule":{"filterOperators":["eq","in"]},"Zone":{"filterOperators":["eq"]},"Name":{"filterOperators":["eq"]}}}},
    "collections":{"Ticks":{"target":"Tick","readable":false,"listenable":true,"bounded":false,"boundedBy":["Schedule"],
      "capability":{"filter":"native","supportsLimit":false}}},
    "writableRoots":{}}}},
  "inbox":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Email":{"properties":{
        "Key":{"kind":"owned","name":"InboxKey","owner":"inbox","allowPattern":"^[a-z0-9]+(-[a-z0-9]+)*$"},
        "Subject":"text"},
      "edges":{},
      "propertyCapabilities":{"Key":{"filterOperators":["eq","in"]},"Subject":{"filterOperators":["eq"]}}}},
    "collections":{"Emails":{"target":"Email","listenable":true,"bounded":false,"boundedBy":["Key"],
      "capability":{"filter":"native","supportsLimit":false}}},
    "writableRoots":{}}}},
  "gmail":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Message":{"properties":{
        "Query":{"kind":"owned","name":"GmailQuery","owner":"gmail"},
        "Subject":"text"},
      "edges":{},
      "propertyCapabilities":{"Query":{"filterOperators":["eq"]},"Subject":{}}},
    "Draft":{"properties":{"Body":"text","SendIn":{"kind":"owned","name":"Zone","owner":"gmail"}},"edges":{}}},
    "collections":{
      "Messages":{"target":"Message","capability":{"filter":"native","supportsLimit":false}},
      "Drafts":{"target":"Draft","readable":false}},
    "writableRoots":{"Draft":{"fields":{"Body":"text","SendIn":{"kind":"owned","name":"Zone","owner":"gmail"}},"resultShape":{"externalId":"text"}}}}}},
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Name":"text"},"edges":{}},
    "Org":{"properties":{"Name":"text"},"edges":{}}},
    "collections":{
      "People":{"target":"Person","capability":{"filter":"bounded","supportsLimit":true}},
      "Orgs":{"target":"Org","capability":{"supportsLimit":false}}},
    "writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

/// `body` as the body of a function, its first line line 2, with the four
/// systems connected under their modules' names.
fn diagnostics(body: &str) -> Vec<Diagnostic> {
    let source = format!(
        "import {{ cron as cron_module, inbox as inbox_module, gmail as gmail_module, crm as crm_module }} from adapters; cron = connect cron_module; inbox = connect inbox_module; gmail = connect gmail_module; crm = connect crm_module; function reads() {{\n{body}}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    movement_checker::check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn check(body: &str) -> Vec<String> {
    diagnostics(body)
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

/// `path` as the traversal a listen is over, waited on.
fn check_listen(path: &str) -> Vec<String> {
    check(&format!("  x = await {path}\n"))
}

/// The WHERE `filter` on `gmail-[m:Messages WHERE …]->`, split.
fn split_of(filter: &str) -> Split {
    let walk = movement_checker::slots::expression_of_text(&format!("gmail-[m:Messages WHERE {filter}]->")).unwrap();
    let Expression::Traverse { steps, .. } = walk else { panic!("a walk") };
    let TraversalStep::Edge(step) = &steps[0] else { panic!("an edge step") };
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let schema = &catalog.adapters["gmail"].schemas[""];
    let collection = &schema.collections["Messages"];
    let target: &PositionSchema = &schema.positions["Message"];
    let edge = EdgeView { name: "Messages", module: "gmail", capability: collection.capability.as_ref(), bounded: true, bounded_by: &[] };
    split_where(step.expression_filter.as_deref().unwrap(), step.alias.as_deref(), &edge, target).unwrap_or_else(|u| panic!("{filter}: {u:?}"))
}

fn spelled(conjuncts: &[Expression]) -> Vec<String> {
    conjuncts.iter().map(|c| spell(c, Some("m"))).collect()
}

#[test]
fn one_schedule_or_a_finite_union_is_taken() {
    for filter in [r#"t.Schedule == "0 9 * * 1""#, r#"t.Schedule IN ["0 9 * * 1", "0 17 * * 5"]"#, r#"t.Schedule == "0 9 * * 1" OR t.Schedule == "0 17 * * 5""#] {
        assert_eq!(check_listen(&format!("cron-[t:Ticks WHERE {filter}]->")), Vec::<String>::new(), "{filter}");
    }
    for filter in [r#"e.Key == "sales""#, r#"e.Key IN ["sales", "customer-support"]"#, r#"e.Key == "sales" OR e.Key == "support""#] {
        assert_eq!(check_listen(&format!("inbox-[e:Emails WHERE {filter}]->")), Vec::<String>::new(), "{filter}");
    }
    // Each is one conjunct the module takes, and nothing is left to check.
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let schema = &catalog.adapters["cron"].schemas[""];
    let collection = &schema.collections["Ticks"];
    let bounded_by = collection.bounded_by.clone().unwrap();
    let edge = EdgeView { name: "Ticks", module: "cron", capability: collection.capability.as_ref(), bounded: false, bounded_by: &bounded_by };
    for filter in [r#"t.Schedule == "0 9 * * 1""#, r#"t.Schedule IN ["0 9 * * 1", "0 17 * * 5"]"#, r#"t.Schedule == "0 9 * * 1" OR t.Schedule == "0 17 * * 5""#] {
        let walk = movement_checker::slots::expression_of_text(&format!("cron-[t:Ticks WHERE {filter}]->")).unwrap();
        let Expression::Traverse { steps, .. } = walk else { panic!("a walk") };
        let TraversalStep::Edge(step) = &steps[0] else { panic!("an edge step") };
        let split = split_where(step.expression_filter.as_deref().unwrap(), Some("t"), &edge, &schema.positions["Tick"]).unwrap();
        assert_eq!((split.taken.iter().map(|c| spell(c, Some("t"))).collect::<Vec<_>>(), split.checked.len()), (vec![filter.to_string()], 0));
    }
}

#[test]
fn a_negated_schedule_is_refused() {
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Schedule != \"0 9 * * 1\"]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:61 '-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `t.Schedule != \"0 9 * * 1\"` is neither. Narrow it: `t.Schedule == \"…\"`"]
    );
    assert_eq!(
        check_listen("inbox-[e:Emails WHERE NOT (e.Key == \"sales\")]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:60 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `NOT (e.Key == \"sales\")` is neither. Narrow it: `e.Key == \"…\"`"]
    );
}

#[test]
fn a_range_of_inbox_keys_is_refused() {
    assert_eq!(
        check_listen("inbox-[e:Emails WHERE e.Key > \"d\"]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:49 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `e.Key > \"d\"` is neither. Narrow it: `e.Key == \"…\"`"]
    );
    // A filter on another field leaves the edge as wide as it was.
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Name == \"standup\"]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:55 '-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this WHERE has no such filter. Narrow it: `t.Schedule == \"…\"`"]
    );
}

#[test]
fn an_or_across_a_bounding_and_a_plain_field_is_refused() {
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\" OR t.Name == \"x\"]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:78 '-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `t.Schedule == \"0 9 * * 1\" OR t.Name == \"x\"` is neither. Narrow it: `t.Schedule == \"…\"`"]
    );
    assert_eq!(
        check_listen("inbox-[e:Emails WHERE e.Key == \"sales\" OR e.Subject == \"x\"]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:74 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `e.Key == \"sales\" OR e.Subject == \"x\"` is neither. Narrow it: `e.Key == \"…\"`"]
    );
}

#[test]
fn a_partly_taken_filter_is_split_and_the_rest_checked_on_the_host() {
    let split = split_of("m.Query == \"from:acme\" AND m.Subject CONTAINS \"invoice\"");
    assert_eq!((spelled(&split.taken), spelled(&split.checked)), (vec!["m.Query == \"from:acme\"".to_string()], vec!["m.Subject CONTAINS \"invoice\"".to_string()]));
    // On an unbounded edge the bounding conjunct is taken and the rest is
    // the host's, as on a bounded one.
    assert_eq!(
        check_listen("inbox-[e:Emails WHERE e.Key == \"sales\" AND e.Subject CONTAINS \"invoice\"]->"),
        ["MOV_HOP_FILTER_RESIDUAL 2:13-2:87 `Subject` (contains) on 'Emails' can't be filtered by the source, so those run here on what comes back — the rest of the WHERE narrows it first. The records you get are the same either way; the fetch is bigger."]
    );
}

#[test]
fn two_queries_are_a_contradiction() {
    assert_eq!(
        check("  xs = gmail-[m:Messages WHERE m.Query == \"a\" AND m.Query == \"b\"]->\n"),
        ["MOV_FILTER_NOT_TAKEN 2:8-2:68 `m.Query == \"a\"` and `m.Query == \"b\"` give 'Query' two values, so nothing matches both — write one GmailQuery"]
    );
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\" AND t.Zone == \"UTC\" AND t.Zone == \"Europe/London\"]->"),
        ["MOV_FILTER_NOT_TAKEN 2:13-2:111 `t.Zone == \"UTC\"` and `t.Zone == \"Europe/London\"` give 'Zone' two values, so nothing matches both — write one Zone"]
    );
}

#[test]
fn an_owned_field_the_module_cannot_take_is_refused() {
    assert_eq!(
        check("  xs = gmail-[m:Messages WHERE m.Query CONTAINS \"acme\"]->\n"),
        ["MOV_FILTER_NOT_TAKEN 2:8-2:58 `m.Query CONTAINS \"acme\"` reads 'Query', a GmailQuery only gmail can evaluate, and it can't take it here — write it as `m.Query == \"…\"` joined to the rest with AND"]
    );
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\" AND (t.Zone == \"UTC\" OR t.Name == \"x\")]->"),
        ["MOV_FILTER_NOT_TAKEN 2:13-2:100 `t.Zone == \"UTC\" OR t.Name == \"x\"` reads 'Zone', a Zone only cron can evaluate, and it can't take it here — write it as `t.Zone == \"…\"` joined to the rest with AND"]
    );
}

#[test]
fn a_bad_cron_literal_is_refused_by_its_owner() {
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * *\"]->"),
        ["MOV_OWNED_VALUE_INVALID 2:13-2:59 \"0 9 * *\" is not a Cron: a schedule has five fields (minute hour day-of-month month day-of-week), got 4"]
    );
    assert_eq!(
        check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\" AND t.Zone == \"Mars/Olympus\"]->"),
        ["MOV_OWNED_VALUE_INVALID 2:13-2:90 \"Mars/Olympus\" is not a Zone: 'Mars/Olympus' is not a recognised IANA time zone (e.g. \"Europe/London\", \"America/New_York\", \"UTC\")"]
    );
    assert_eq!(
        check_listen("inbox-[e:Emails WHERE e.Key IN [\"sales\", \"Support Desk\"]]->"),
        ["MOV_OWNED_VALUE_INVALID 2:13-2:72 \"Support Desk\" is not a InboxKey: it does not match ^[a-z0-9]+(-[a-z0-9]+)*$"]
    );
    // Written, as compared.
    assert_eq!(
        check("  d = write gmail-[:Drafts]-> { Body: \"hi\", SendIn: \"Mars/Olympus\" }\n"),
        ["MOV_OWNED_VALUE_INVALID 2:53-2:67 \"Mars/Olympus\" is not a Zone: 'Mars/Olympus' is not a recognised IANA time zone (e.g. \"Europe/London\", \"America/New_York\", \"UTC\")"]
    );
    assert_eq!(check("  d = write gmail-[:Drafts]-> { Body: \"hi\", SendIn: \"Europe/London\" }\n"), Vec::<String>::new());
}

#[test]
fn a_read_over_an_unbounded_edge_is_refused_like_a_listen() {
    assert_eq!(
        check("  xs = inbox-[e:Emails]->\n"),
        ["MOV_UNBOUNDED_EDGE 2:8-2:26 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter. Narrow it: `e.Key == \"…\"`"]
    );
    assert_eq!(
        check("  xs = inbox-[e:Emails WHERE e.Subject == \"x\"]->\n"),
        ["MOV_UNBOUNDED_EDGE 2:8-2:49 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter. Narrow it: `e.Key == \"…\"`"]
    );
    assert_eq!(check("  xs = inbox-[e:Emails WHERE e.Key == \"sales\"]->\n"), Vec::<String>::new());
    assert_eq!(
        check_listen("cron-[:Ticks]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:28 '-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this WHERE has no such filter. Narrow it: `Schedule == \"…\"`"]
    );
}

#[test]
fn a_root_that_can_only_be_written_or_listened_to_is_not_read() {
    assert_eq!(
        check("  xs = gmail-[:Drafts]->\n"),
        ["MOV_COLLECTION_NOT_READABLE 2:8-2:25 '-[:Drafts]->' off gmail can be written to but not read: the gmail module lists nothing along it"]
    );
    assert_eq!(
        check("  xs = cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\"]->\n"),
        ["MOV_COLLECTION_NOT_READABLE 2:8-2:56 '-[:Ticks]->' off cron can be listened to but not read: the cron module only announces what arrives on it"]
    );
    // An address types what lands on a declared edge; nothing is read.
    assert_eq!(check("  digest = node {\n    Title: \"t\"\n    drafts: <gmail-[:Drafts]->>\n    ticks: <cron-[:Ticks]->>\n    mail: <inbox-[:Emails]->>\n  }\n"), Vec::<String>::new());
    // Written, or waited on, it is what it says.
    assert_eq!(check("  d = write gmail-[:Drafts]-> { Body: \"hi\" }\n"), Vec::<String>::new());
    assert_eq!(check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\"]->"), Vec::<String>::new());
}

#[test]
fn reads_on_bounded_edges_keep_todays_filter_messages() {
    assert_eq!(
        check("  xs = gmail-[m:Messages WHERE m.Subject CONTAINS \"invoice\"]->\n"),
        ["MOV_HOP_FILTER_UNSUPPORTED 2:8-2:63 This source can't filter 'Messages' by `Subject` (contains) — reading it would mean fetching every record and filtering here. Narrow it by something the source can filter first."]
    );
    assert_eq!(
        check("  xs = gmail-[m:Messages WHERE m.Query == \"from:acme\" AND m.Subject CONTAINS \"invoice\"]->\n"),
        ["MOV_HOP_FILTER_RESIDUAL 2:8-2:90 `Subject` (contains) on 'Messages' can't be filtered by the source, so those run here on what comes back — the rest of the WHERE narrows it first. The records you get are the same either way; the fetch is bigger."]
    );
    assert_eq!(
        check("  xs = gmail-[m:Messages WHERE EXISTS(crm-[:Orgs]->)]->\n"),
        ["MOV_HOP_FILTER_UNSUPPORTED 2:8-2:56 This filter has to run in the app (it uses ai() or exists), which isn't possible over 'Messages' — an unbounded source. Narrow to a bounded relationship first, then filter."]
    );
    assert_eq!(
        check("  xs = crm-[p:People WHERE p.Name == \"Ada\"]->\n"),
        ["MOV_HOP_FILTER_ENGINE 2:8-2:46 WHERE on 'People' runs here, not at the source — the whole collection is fetched first and filtered afterwards. The records you get are the same either way; the fetch is bigger."]
    );
    assert_eq!(
        check("  xs = crm-[o:Orgs WHERE o.Name == \"Acme\"]->\n"),
        ["MOV_HOP_FILTER_UNSUPPORTED 2:8-2:45 'Orgs' can't be filtered here — this source doesn't support a WHERE across that relationship."]
    );
}
