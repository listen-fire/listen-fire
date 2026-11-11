//! `Date.daysBetween(from, to)`: the whole calendar days from one date to
//! another. It takes what `Date.addDays` takes. A count from a date that may
//! be missing, or from text that may read as no date, may be missing too, so
//! ordering on it is refused until it is tested or given a fallback.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text","At":"datetime"},"edges":{}}},"collections":{"Invocations":{"target":"Invocation","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(body: &str) -> Vec<Diagnostic> {
    let source = format!("function go(i: <manual-[:Invocations]->>) {{\n{body}\n}}\nlisten to manual-[:Invocations]-> fire go\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn a_day_count_between_dates_and_datetimes_is_a_number() {
    for (from, to) in [
        ("Date.today(\"Europe/London\")", "Date.addDays(Date.today(\"Europe/London\"), 30)"),
        ("Date.today(\"UTC\")", "i.At"),
    ] {
        let found = check(&format!("  days = Date.daysBetween({from}, {to})\n  return days < 14 ? \"Urgent\" : \"Normal\""));
        assert_eq!(codes(&found), Vec::<&str>::new(), "{from}, {to}: {found:?}");
    }
}

#[test]
fn only_a_date_a_datetime_or_text_is_a_day() {
    for arg in ["14", "true", "[\"2026-03-12\"]"] {
        let found = check(&format!("  return Date.daysBetween({arg}, Date.today(\"UTC\")) + 1"));
        assert_eq!(codes(&found), ["MOV_BUILTIN_ARG_TYPE"], "{arg}: {found:?}");
        assert!(found[0].message.contains("a date, a datetime, or text that reads as one"), "{}", found[0].message);
    }
}

#[test]
fn a_day_count_from_a_missing_date_or_from_text_may_be_missing() {
    let found = check("  event = Date.parse(i.Text)\n  days = Date.daysBetween(Date.today(\"UTC\"), event)\n  return days < 14");
    assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED"], "{found:?}");
    assert!(found[0].message.contains("number | null"), "{}", found[0].message);
    for arg in ["null", "i.Text", "\"2026-03-12\""] {
        let found = check(&format!("  return Date.daysBetween({arg}, i.At) + 1"));
        assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED"], "{arg}: {found:?}");
    }
}

#[test]
fn a_tested_date_gives_a_present_count() {
    let found = check(
        "  event = Date.parse(i.Text)\n  if (event == null) { fail(\"no date\") }\n  days = Date.daysBetween(Date.today(\"UTC\"), event)\n  return days < 14",
    );
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:?}");
    let found = check("  days = coalesce(Date.daysBetween(Date.today(\"UTC\"), Date.parse(i.Text)), 999)\n  return days < 14");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:?}");
}

#[test]
fn subtracting_dates_points_at_the_day_count() {
    let found = check("  return Date.today(\"UTC\") - i.At");
    assert_eq!(codes(&found), ["MOV_ARITH_NON_NUMERIC"], "{found:?}");
    assert!(found[0].message.contains("Date.daysBetween(from, to)"), "{}", found[0].message);
    let found = check("  return Date.today(\"UTC\") + 7");
    assert!(!found[0].message.contains("daysBetween"), "{}", found[0].message);
}
