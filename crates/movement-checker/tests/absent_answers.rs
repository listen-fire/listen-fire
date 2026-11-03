//! A built-in whose run can answer nothing types its answer `T | absent`
//! exactly when it can: given a value that may be absent, given text it may
//! read no date out of, or (a pattern, a money figure) whatever it is given.
//! Otherwise its answer is `T`. The reader of a maybe-absent answer is told,
//! as with any other value that may be absent (from 0.15).

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text","At":"datetime","Day":{"kind":"maybeAbsent","of":"date"},"Note":{"kind":"maybeAbsent","of":"text"}},"edges":{}}},"collections":{"Invocations":{"target":"Invocation","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(body: &str) -> Vec<Diagnostic> {
    let source = format!("function go(i: <manual-[:Invocations]->>) {{\n{body}\n}}\nlisten to manual-[:Invocations]-> fire go\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

/// Each answer ordered against a value of its kind: refused when it may be absent.
fn ordered(call: &str, against: &str) -> Vec<String> {
    codes(&check(&format!("  x = {call}\n  return x < {against}"))).into_iter().map(String::from).collect()
}

const MAY_BE_ABSENT: &[(&str, &str)] = &[
    ("Text.trim(i.Note)", "\"m\""),
    ("Text.lower(i.Note)", "\"m\""),
    ("Text.upper(i.Note)", "\"m\""),
    ("Text.from(i.Day)", "\"m\""),
    ("Text.slug(i.Note)", "\"m\""),
    ("Text.regexExtract(i.Text, \"(\\\\d+)\")", "\"m\""),
    ("Currency.codeFromFigure(i.Text)", "\"m\""),
    ("Currency.numberFromFigure(i.Text)", "5"),
    ("Date.from(i.Text)", "Date.today(\"UTC\")"),
    ("Date.from(i.Day)", "Date.today(\"UTC\")"),
    ("DateTime.from(i.Text)", "i.At"),
    ("DateTime.toIso(i.Text)", "Date.today(\"UTC\")"),
    ("Date.addDays(i.Day, 1)", "Date.today(\"UTC\")"),
    ("Date.addDays(i.Text, 1)", "Date.today(\"UTC\")"),
    ("Date.format(i.Day, \"YYYY\")", "\"m\""),
    ("Date.format(i.Text, \"YYYY\")", "\"m\""),
    ("Date.daysBetween(i.Day, i.At)", "14"),
    ("DateTime.at(i.Day, \"07:00\", \"UTC\")", "i.At"),
];

const ALWAYS_THERE: &[(&str, &str)] = &[
    ("Text.trim(i.Text)", "\"m\""),
    ("Text.upper(i.Text)", "\"m\""),
    ("Text.from(i.At)", "\"m\""),
    ("Text.slug(i.Text)", "\"m\""),
    ("Date.from(i.At)", "Date.today(\"UTC\")"),
    ("DateTime.from(Date.today(\"UTC\"))", "i.At"),
    ("Date.addDays(Date.today(\"UTC\"), 1)", "Date.today(\"UTC\")"),
    ("Date.format(i.At, \"YYYY\")", "\"m\""),
    ("Date.daysBetween(Date.today(\"UTC\"), i.At)", "14"),
    ("DateTime.at(Date.today(\"UTC\"), \"07:00\", \"UTC\")", "i.At"),
    ("Date.today(\"UTC\")", "i.At"),
];

#[test]
fn an_answer_the_run_can_leave_empty_may_be_absent() {
    for (call, against) in MAY_BE_ABSENT {
        assert_eq!(ordered(call, against), ["MOV_ABSENT_REQUIRED"], "{call}");
    }
}

#[test]
fn an_answer_the_run_always_gives_is_there() {
    for (call, against) in ALWAYS_THERE {
        assert_eq!(ordered(call, against), Vec::<String>::new(), "{call}");
    }
}

#[test]
fn a_tested_value_gives_an_answer_that_is_there() {
    let found = check("  if (i.Day == null) { fail(\"no day\") }\n  return Date.addDays(i.Day, 1) < Date.today(\"UTC\")");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:?}");
    let found = check("  d = Date.parse(i.Text)\n  if (d == null) { fail(\"no day\") }\n  return Date.format(d, \"YYYY\") < \"m\"");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:?}");
}
