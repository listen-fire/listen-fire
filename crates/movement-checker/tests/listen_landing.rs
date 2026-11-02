//! `listen to hooks-[:Requests]-><Payment> fire f`: a listen states the
//! type of a landing its module leaves untyped, and the fired function's
//! parameter must be assignable to it, as a parameter is to its argument.
//! Two untyped shapes, and one typed:
//!
//! - `hooks`: a root `Requests` whose `Request` its module never describes
//!   (a webhook's body).
//! - `forms`: a root `Submissions` whose `Submission` lists some fields and
//!   leaves the rest open.
//! - `crm`: a root `Companies`, listenable, whose `Company` is described.

use movement_checker::CheckOptions;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::listen_plan::ListenPlan;

const CATALOG: &str = r#"{"adapters":{
  "hooks":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Request":{"properties":{},"edges":{},"undescribed":true}},
    "collections":{"Requests":{"target":"Request","readable":false,"listenable":true,"delivery":"connection"}},
    "writableRoots":{}}}},
  "forms":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Submission":{"properties":{"Form":"text"},"edges":{},"openProperties":true}},
    "collections":{"Submissions":{"target":"Submission","readable":false,"listenable":true,"delivery":"connection"}},
    "writableRoots":{}}}},
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Company":{"properties":{"Name":"text"},"edges":{}}},
    "collections":{"Companies":{"target":"Company","listenable":true,"delivery":"connection"}},
    "writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

/// The connections and the nodes: `Payment`, `Refund` (another shape),
/// `Paid` (a Payment with fewer fields), and functions taking each. Seventeen
/// lines, so the source after it starts on line 18.
const PRELUDE: &str = "import { hooks as hooks_module, forms as forms_module, crm as crm_module } from adapters
hooks = connect hooks_module
forms = connect forms_module
crm = connect crm_module
node Payment {\n  id: <text>\n  amount: <number>\n}
node Refund {\n  reason: <text>\n}
node Paid {\n  id: <text>\n}
function paid(e: <Payment>) { return e.amount }
function partly(e: <Paid>) { return e.id }
function refunded(e: <Refund>) { return e.reason }
";

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

fn plans_of(source: &str) -> Vec<ListenPlan> {
    let source = format!("{PRELUDE}{source}");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let program = movement_parser::stmt::parse_program(&source, false).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let answer = movement_checker::answer::check_answer(&program, &catalog, options());
    assert_eq!(answer.diagnostics.iter().map(|d| d.code.clone()).collect::<Vec<_>>(), Vec::<String>::new(), "{source}");
    answer.listens
}

#[test]
fn a_stated_landing_types_what_an_untyped_edge_lands_and_the_plan_names_it() {
    for listen in ["listen to hooks-[:Requests]-><Payment> fire paid\n", "listen to forms-[:Submissions]-><Payment> fire paid\n"] {
        assert_eq!(check(listen), Vec::<String>::new(), "{listen}");
    }
    let plans = plans_of("listen to hooks-[:Requests]-><Payment> fire paid\n");
    assert_eq!(plans[0].landing.as_deref(), Some("Payment"));
    // Two listens stating different types are two listens.
    let two = plans_of("listen to hooks-[:Requests]-><Payment> fire paid\nlisten to hooks-[:Requests]-><Refund> fire refunded\n");
    assert_ne!(two[0].identity(), two[1].identity());
    assert_eq!(plans_of("listen to forms-[:Submissions]-><Payment> fire paid\n")[0].landing.as_deref(), Some("Payment"));
}

#[test]
fn a_parameter_must_be_assignable_from_the_stated_landing() {
    // A Paid reads fewer fields than a Payment carries: assignable.
    assert_eq!(check("listen to hooks-[:Requests]-><Payment> fire partly\n"), Vec::<String>::new());
    // A Refund reads a field a Payment does not carry.
    let refused = check("listen to hooks-[:Requests]-><Payment> fire refunded\n");
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert!(refused[0].starts_with("MOV_LISTEN_SHAPE_MISMATCH 18:1-18:53 "), "{refused:?}");
    assert!(refused[0].contains("reason"), "{refused:?}");
    let refused = check("listen to forms-[:Submissions]-><Paid> fire paid\n");
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert!(refused[0].starts_with("MOV_LISTEN_SHAPE_MISMATCH 18:1-18:49 "), "{refused:?}");
    assert!(refused[0].contains("amount"), "{refused:?}");
}

#[test]
fn an_untyped_landing_must_be_stated_before_a_typed_parameter_takes_it() {
    assert_eq!(
        check("listen to hooks-[:Requests]-> fire paid\n"),
        ["MOV_LISTEN_PARAM_MISMATCH 18:1-18:40 'paid' takes 'e: <Payment>', but what lands on '-[:Requests]->' is untyped — state its type after the traversal: `listen to hooks-[:Requests]-><Payment> fire paid`"]
    );
    assert_eq!(
        check("listen to forms-[:Submissions]-> fire refunded\n"),
        ["MOV_LISTEN_PARAM_MISMATCH 18:1-18:47 'refunded' takes 'e: <Refund>', but what lands on '-[:Submissions]->' is untyped — state its type after the traversal: `listen to forms-[:Submissions]-><Refund> fire refunded`"]
    );
}

#[test]
fn a_landing_its_module_types_takes_no_stated_type() {
    assert_eq!(
        check("listen to crm-[:Companies]-><Payment> fire paid\n"),
        ["MOV_LISTEN_SHAPE_MISMATCH 18:29-18:38 '-[:Companies]->' lands what crm describes, so its type is the module's — `<Payment>` types only a landing its module leaves untyped (a webhook's body); drop it"]
    );
}

#[test]
fn a_stated_landing_names_a_node_the_program_declares() {
    assert_eq!(
        check("listen to hooks-[:Requests]-><Invoice> fire paid\n"),
        ["MOV_UNKNOWN_TYPE_NAME 18:30-18:39 no node 'Invoice' is declared — declare the fields what lands carries: `node Invoice { amount: <number> }`"]
    );
    assert_eq!(
        check("listen to forms-[:Submissions]-><text> fire paid\n"),
        ["MOV_UNKNOWN_TYPE_NAME 18:33-18:39 what lands is a record, not the value type '<text>' — declare the fields it carries: `node Payment { amount: <number> }`, then `-[:…]-><Payment>`"]
    );
}

/// A function over one of several nodes (`<Payment | Refund>`) is fired by a
/// listen stating any node one member takes, as TypeScript's `Payment |
/// Refund` takes a Payment. Each member is a node: the run holds the payload
/// as a value, and a record member could never be seeded from it. Before,
/// such a listen was refused as naming another connection, and an imported
/// function of that type checked clean and failed every run.
#[test]
fn a_parameter_of_one_of_several_nodes_takes_a_stated_node_one_member_takes() {
    let union = "function settled(e: <Payment | Refund>) { return 1 }\n";
    assert_eq!(check(&format!("{union}listen to hooks-[:Requests]-><Payment> fire settled\nlisten to forms-[:Submissions]-><Refund> fire settled\n")), Vec::<String>::new());
    let narrower = check(&format!("{union}listen to hooks-[:Requests]-><Paid> fire settled\n"));
    assert_eq!(narrower.len(), 1, "{narrower:#?}");
    assert!(narrower[0].contains("'settled' takes 'e: <Payment | Refund>', but this listener fires with its declared payload 'Paid', and no member of the union takes it"), "a Paid lacks a Payment's amount and a Refund's reason: {narrower:#?}");
    assert_eq!(check("function settled(e: <Refund | Paid>) { return 1 }\nlisten to hooks-[:Requests]-><Payment> fire settled\n"), Vec::<String>::new(), "a Payment fits a Paid");
    let record = check("function settled(e: <Payment | crm-[:Company]->>) { return 1 }\nlisten to hooks-[:Requests]-><Payment> fire settled\n");
    assert_eq!(record, ["MOV_LISTEN_PARAM_MISMATCH 19:1-19:52 'settled' takes 'e: <Payment | crm-[:Company]->>', but this listener fires with its declared payload 'Payment', a value, and '<crm-[:Company]->>' is a record type — every member of the union is a declared node"]);
}
