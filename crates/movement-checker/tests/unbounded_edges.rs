//! No traversal ranges over an unbounded edge, and a hop's WHERE splits
//! into what its module takes and what the host checks. Three shapes:
//!
//! - `cron`: `Ticks` is unbounded, narrowed only by `Schedule` (a `Cron`);
//!   `Zone` is a `Zone`. Both are scalars only the module evaluates.
//! - `inbox`: `Emails` is unbounded, narrowed only by `Key` (an `InboxKey`
//!   with an allow pattern).
//! - `gmail`: `Messages` is bounded; `Query` (a `GmailQuery`) is taken with
//!   `==` only, and `Subject` is taken with nothing. `Tags` takes several
//!   `CONTAINS` together (`containsAny`), `Topics` one at a time, and
//!   `Regions` (a list of an owned `Region`) one at a time. `Drafts` is
//!   written to and never read.
//! - `mail`: an unbounded edge off a record. An `Account` has `Boxes`; a
//!   `Box`, and a `Box2` reached from the root, each have `Emails`, narrowed
//!   only by `Key`.
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
        "Schedule":{"kind":"owned","name":"Cron","owner":"cron","format":"cron"},
        "Zone":{"kind":"owned","name":"Zone","owner":"cron","format":"timeZone"},
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
        "Subject":"text",
        "Tags":{"kind":"list","of":"text"},
        "Topics":{"kind":"list","of":"text"},
        "Regions":{"kind":"list","of":{"kind":"owned","name":"Region","owner":"gmail"}}},
      "edges":{},
      "propertyCapabilities":{"Query":{"filterOperators":["eq"]},"Subject":{},
        "Tags":{"filterOperators":["contains","containsAny"]},"Topics":{"filterOperators":["contains"]},"Regions":{"filterOperators":["contains"]}}},
    "Draft":{"properties":{"Body":"text","SendIn":{"kind":"owned","name":"Zone","owner":"gmail","format":"timeZone"}},"edges":{}}},
    "collections":{
      "Messages":{"target":"Message","capability":{"filter":"native","supportsLimit":false}},
      "Drafts":{"target":"Draft","readable":false}},
    "writableRoots":{"Draft":{"fields":{"Body":"text","SendIn":{"kind":"owned","name":"Zone","owner":"gmail","format":"timeZone"}},"resultShape":{"externalId":"text"}}}}}},
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Name":"text"},"edges":{}},
    "Org":{"properties":{"Name":"text"},"edges":{}}},
    "collections":{
      "People":{"target":"Person","capability":{"filter":"bounded","supportsLimit":true}},
      "Orgs":{"target":"Org","capability":{"supportsLimit":false}}},
    "writableRoots":{}}}},
  "mail":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Account":{"properties":{"Name":"text"},
      "edges":{"Boxes":{"target":"Box","capability":{"filter":"native","supportsLimit":false}}},
      "propertyCapabilities":{"Name":{"filterOperators":["eq"]}}},
    "Box":{"properties":{"Key":{"kind":"owned","name":"InboxKey","owner":"mail"},"Label":"text"},
      "edges":{"Emails":{"target":"Email","listenable":true,"readable":true,"sequenced":"arrival","bounded":false,"boundedBy":["Key"],"capability":{"filter":"native","supportsLimit":false}}},
      "propertyCapabilities":{"Key":{"filterOperators":["eq","in"]},"Label":{"filterOperators":["eq"]}}},
    "Box2":{"properties":{"Key":{"kind":"owned","name":"InboxKey","owner":"mail"},"Other":"text"},
      "edges":{"Emails":{"target":"Email","listenable":true,"readable":true,"sequenced":"arrival","bounded":false,"boundedBy":["Key"],"capability":{"filter":"native","supportsLimit":false}}},
      "propertyCapabilities":{"Key":{"filterOperators":["eq","in"]}}},
    "Email":{"properties":{"Key":{"kind":"owned","name":"InboxKey","owner":"mail"},"Subject":"text","At":"datetime"},"edges":{},
      "propertyCapabilities":{"Key":{"filterOperators":["eq","in"]},"Subject":{"filterOperators":["eq"]}}}},
    "collections":{"Accounts":{"target":"Account","capability":{"filter":"native","supportsLimit":false}},
                   "Box2s":{"target":"Box2","capability":{"filter":"native","supportsLimit":false}}},
    "writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

/// `body` as the body of a function taking two texts, `pick` and `q`, its
/// first line line 2, with the five systems connected under their modules'
/// names.
fn diagnostics(body: &str) -> Vec<Diagnostic> {
    let source = format!(
        "import {{ cron as cron_module, inbox as inbox_module, gmail as gmail_module, crm as crm_module, mail as mail_module }} from adapters; cron = connect cron_module; inbox = connect inbox_module; gmail = connect gmail_module; crm = connect crm_module; mail = connect mail_module; function reads(pick: <text>, q: <text>) {{\n{body}}}\n"
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
        ["MOV_OWNED_VALUE_INVALID 2:13-2:72 \"Support Desk\" is not an InboxKey: it does not match ^[a-z0-9]+(-[a-z0-9]+)*$"]
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
        ["MOV_UNBOUNDED_EDGE 2:8-2:26 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `e.Key == \"…\"`"]
    );
    assert_eq!(
        check("  xs = inbox-[e:Emails WHERE e.Subject == \"x\"]->\n"),
        ["MOV_UNBOUNDED_EDGE 2:8-2:49 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter. Narrow it: `e.Key == \"…\"`"]
    );
    assert_eq!(check("  xs = inbox-[e:Emails WHERE e.Key == \"sales\"]->\n"), Vec::<String>::new());
    assert_eq!(
        check_listen("cron-[:Ticks]->"),
        ["MOV_UNBOUNDED_EDGE 2:13-2:28 '-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `-[t:Ticks WHERE t.Schedule == \"…\"]->`"]
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
        check("  xs = gmail-[m:Messages WHERE exists(crm-[:Orgs]->)]->\n"),
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

/// The WHERE `filter` on `mail-[a:Accounts]->-[b:Boxes]->-[e:Emails WHERE …]->`,
/// split: `Subject` is taken with `==`.
fn split_of_emails(filter: &str) -> Split {
    let walk = movement_checker::slots::expression_of_text(&format!("mail-[a:Accounts]->-[b:Boxes]->-[e:Emails WHERE {filter}]->")).unwrap();
    let Expression::Traverse { steps, .. } = walk else { panic!("a walk") };
    let TraversalStep::Edge(step) = &steps[2] else { panic!("an edge step") };
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let schema = &catalog.adapters["mail"].schemas[""];
    let emails = &schema.positions["Box"].edges["Emails"];
    let edge = EdgeView::of_edge("Emails", "mail", emails);
    split_where(step.expression_filter.as_deref().unwrap(), Some("e"), &edge, &schema.positions["Email"]).unwrap_or_else(|u| panic!("{filter}: {u:?}"))
}

fn spelled_e(conjuncts: &[Expression]) -> Vec<String> {
    conjuncts.iter().map(|c| spell(c, Some("e"))).collect()
}

#[test]
fn a_hop_off_a_record_that_may_be_absent_is_split() {
    // The wait off it is refused as the read is, and split all the same.
    let half_guarded = |hop: &str| format!("  a = only(mail-[:Accounts]->)\n  if (a != null) {{\n  b = only(a-[:Boxes]->)\n  {hop}\n  }}\n");
    assert_eq!(check(&half_guarded("x = await new b-[e:Emails]->")), vec![r#"MOV_ABSENT_REQUIRED 5:17-5:31 'b' may be absent, and a wait off a record that is not there fails the run rather than waiting. Guard the wait: 'if (b != null) { … }'. (see handbook: front#maybe-absent)"#, r#"MOV_UNBOUNDED_EDGE 5:17-5:31 '-[:Emails]->' is unbounded: mail can narrow it only by Key written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `e.Key == "…"`"#]);
    assert_eq!(check(&half_guarded("xs = b-[e:Emails]->")), vec![r#"MOV_ABSENT_REQUIRED 5:8-5:22 'b' may be absent, and a walk inside an expression off a record that is not there fails the run. Guard the walk: 'if (b != null) { … }'. (see handbook: front#maybe-absent)"#, r#"MOV_UNBOUNDED_EDGE 5:8-5:22 '-[:Emails]->' is unbounded: mail can narrow it only by Key written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `e.Key == "…"`"#]);
    assert_eq!(check(&half_guarded("if (b != null) { x = await new b-[e:Emails WHERE e.Key == \"sales\"]-> }")), Vec::<String>::new());
}

#[test]
fn a_hop_off_one_of_several_records_is_split_for_each() {
    let either = |hops: &str| {
        format!("  b1 = only(mail-[:Box2s]->)\n  a = only(mail-[:Accounts]->)\n  if (a != null && b1 != null) {{\n  b0 = only(a-[:Boxes]->)\n  if (b0 != null) {{\n  r = pick == \"x\" ? b0 : b1\n{hops}  }}\n  }}\n")
    };
    assert_eq!(check(&either("  xs = r-[e:Emails]->\n  y = await new r-[e:Emails]->\n")), vec![r#"MOV_UNBOUNDED_EDGE 8:8-8:22 '-[:Emails]->' is unbounded: mail can narrow it only by Key written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `e.Key == "…"`"#, r#"MOV_UNBOUNDED_EDGE 9:17-9:31 '-[:Emails]->' is unbounded: mail can narrow it only by Key written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `e.Key == "…"`"#]);
    assert_eq!(check(&either("  xs = r-[e:Emails WHERE e.Key == \"sales\"]->\n  y = await new r-[e:Emails WHERE e.Key == \"sales\"]->\n")), Vec::<String>::new());
}

#[test]
fn only_a_comparison_with_literals_is_taken() {
    // A value read off another alias, or a name the run holds, varies by
    // run; what the module takes does not, so the host checks it.
    for filter in ["e.Key == \"sales\" AND e.Subject == a.Name", "e.Key == \"sales\" AND e.Subject == y"] {
        let split = split_of_emails(filter);
        assert_eq!((spelled_e(&split.taken), spelled_e(&split.checked)), (vec!["e.Key == \"sales\"".to_string()], vec![filter["e.Key == \"sales\" AND ".len()..].to_string()]), "{filter}");
    }
    let split = split_of_emails("e.Key == \"sales\" AND e.Subject == \"hi\"");
    assert_eq!((spelled_e(&split.taken), spelled_e(&split.checked)), (vec!["e.Key == \"sales\"".to_string(), "e.Subject == \"hi\"".to_string()], vec![]));
    assert_eq!(check("  mail-[a:Accounts]-> {\n    xs = a-[b:Boxes WHERE b.Key == \"k\"]->-[e:Emails WHERE e.Key == \"sales\" AND e.Subject == a.Name]->\n  }\n"), Vec::<String>::new());
}

#[test]
fn an_owned_field_compared_with_what_is_not_a_literal_is_refused() {
    assert_eq!(check("  xs = gmail-[m:Messages WHERE m.Query == q]->\n"), vec![r#"MOV_FILTER_NOT_TAKEN 2:8-2:47 `m.Query == q` reads 'Query', a GmailQuery only gmail can evaluate, and gmail takes it only compared with a literal — write the value as one: `m.Query == "…"`"#]);
    // Not a contradiction: `q` may be "b".
    assert_eq!(check("  xs = gmail-[m:Messages WHERE m.Query == q AND m.Query == \"b\"]->\n"), vec![r#"MOV_FILTER_NOT_TAKEN 2:8-2:66 `m.Query == q` reads 'Query', a GmailQuery only gmail can evaluate, and gmail takes it only compared with a literal — write the value as one: `m.Query == "…"`"#]);
    assert_eq!(check_listen("cron-[t:Ticks WHERE t.Schedule == \"0 9 * * 1\" AND t.Zone == q]->"), vec![r#"MOV_FILTER_NOT_TAKEN 2:13-2:77 `t.Zone == q` reads 'Zone', a Zone only cron can evaluate, and cron takes it only compared with a literal — write the value as one: `t.Zone == "…"`"#]);
    assert_eq!(
        check("  a = only(mail-[:Accounts]->)\n  if (a != null) {\n  xs = mail-[:Box2s]->-[e:Emails WHERE e.Key == \"sales\" AND e.Key == a.Name]->\n  }\n"),
        vec![r#"MOV_FILTER_NOT_TAKEN 4:8-4:79 `e.Key == a.Name` reads 'Key', an InboxKey only mail can evaluate, and mail takes it only compared with a literal — write the value as one: `e.Key == "…"`"#]
    );
}

#[test]
fn a_bounding_field_compared_with_what_is_not_a_literal_does_not_bound() {
    assert_eq!(check_listen("cron-[t:Ticks WHERE t.Schedule == q]->"), vec![r#"MOV_UNBOUNDED_EDGE 2:13-2:51 '-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `t.Schedule == q` does not compare it with a literal. Narrow it: `t.Schedule == "…"`"#]);
    assert_eq!(check_listen("inbox-[e:Emails WHERE e.Key IN [q, \"sales\"]]->"), vec![r#"MOV_UNBOUNDED_EDGE 2:13-2:59 '-[:Emails]->' is unbounded: inbox can narrow it only by Key written `==` or `IN [ … ]` with literals, and this WHERE has no such filter: `e.Key IN [q, "sales"]` does not compare it with a literal. Narrow it: `e.Key == "…"`"#]);
}

#[test]
fn an_owned_type_starting_with_a_vowel_takes_an() {
    assert_eq!(check_listen("inbox-[e:Emails WHERE e.Key == \"sales\" AND e.Key CONTAINS \"x\"]->"), vec![r#"MOV_FILTER_NOT_TAKEN 2:13-2:77 `e.Key CONTAINS "x"` reads 'Key', an InboxKey only inbox can evaluate, and it can't take it here — write it as `e.Key == "…"` joined to the rest with AND"#]);
}

#[test]
fn an_or_of_contains_on_one_field_is_taken_when_the_field_takes_any_of_them() {
    let split = split_of(r#"m.Tags CONTAINS "a" OR m.Tags CONTAINS "b""#);
    assert_eq!((spelled(&split.taken), spelled(&split.checked)), (vec![r#"m.Tags CONTAINS "a" OR m.Tags CONTAINS "b""#.to_string()], vec![]));
    // One value at a time only: the host checks the OR.
    let split = split_of(r#"m.Topics CONTAINS "a" OR m.Topics CONTAINS "b""#);
    assert_eq!((spelled(&split.taken), spelled(&split.checked)), (vec![], vec![r#"m.Topics CONTAINS "a" OR m.Topics CONTAINS "b""#.to_string()]));
    // Across two fields, or two operators, it is no one field's comparison.
    for filter in [r#"m.Tags CONTAINS "a" OR m.Topics CONTAINS "b""#, r#"m.Tags CONTAINS "a" OR m.Tags == ["b"]"#] {
        let split = split_of(filter);
        assert_eq!((split.taken.len(), split.checked.len()), (0, 1), "{filter}");
    }
    // An owned field's OR the module does not take is refused where it is written.
    let found = check("  xs = gmail-[m:Messages WHERE m.Regions CONTAINS \"eu\" OR m.Regions CONTAINS \"us\"]->\n");
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].starts_with("MOV_FILTER_NOT_TAKEN"), "{found:?}");
}
