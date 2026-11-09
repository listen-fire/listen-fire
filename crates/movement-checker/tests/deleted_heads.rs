//! A record a run waits on can be deleted while it waits. From 0.13 the
//! wait then never ends: what follows the `await` never runs, and a `race`
//! with a `sleep` is the way out. So what a function that awaits hands back
//! is typed as what it returns, never maybe absent for the deletion; and a
//! check for an upgrade from an older pin warns on every `await` no `sleep`
//! races (`MOV_AWAIT_MAY_HANG`), since under the old pin the code after it
//! was skipped instead. A wait in a function is raced when every call of the
//! function is; each way it hangs a run is warned once, at the unraced call
//! in the run's way in, spelling the calls down to the wait.
//!
//! Two catalog shapes: a chat's message and its button presses, and a CRM's
//! deal and its notes.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Message":{"properties":{"Text":"text","Ts":"text"},"edges":{
      "Interactions":{"target":"Interaction","listenable":true,"sequenced":"chronological","identity":"Id"}}},
    "Interaction":{"properties":{"Id":"text","Value":"text"},"edges":{}}},
    "collections":{"Messages":{"target":"Message"}},
    "writableRoots":{"Message":{"fields":{"Text":"text"},"resultShape":{"externalId":"text"}}}}}},
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Deal":{"properties":{"Name":"text"},"edges":{
      "Notes":{"target":"Note","listenable":true,"sequenced":"chronological","identity":"Id"}}},
    "Note":{"properties":{"Id":"text","Title":"text"},"edges":{}}},
    "collections":{"Deals":{"target":"Deal"}},
    "writableRoots":{"Deal":{"fields":{"Name":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

/// The program's first line: the connections, and the function whose body
/// `body` is (from line 2), handed a message `msg` and a deal `d`.
const HEADER: &str = "import { chat as chat_module, crm as crm_module } from adapters; chat = connect chat_module; crm = connect crm_module; function go(msg: <chat-[:Message]->>, d: <crm-[:Deal]->>) {";

/// Every diagnostic on `body` (with `functions` declared after it), checked
/// as an upgrade from `pin` when one is given.
fn found_with(body: &str, functions: &str, pin: Option<&str>) -> Vec<String> {
    let source = format!("{HEADER}\n{body}}}\n{functions}");
    let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.code != "MOV_LISTEN_MISSING")
        .map(|d| {
            let severity = match d.severity {
                Some(movement_checker::Severity::Warning) => "warning",
                _ => "error",
            };
            format!("{} {severity} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message)
        })
        .collect()
}

fn found(body: &str, pin: Option<&str>) -> Vec<String> {
    found_with(body, "", pin)
}

fn check(body: &str) -> Vec<String> {
    found(body, None)
}

#[test]
fn an_all_slot_whose_arm_awaits_is_typed_as_the_arm() {
    assert_eq!(check("  r = all(() => { return await msg-[:Interactions]-> })\n  t = r[0].Id\n"), Vec::<String>::new());
    // Written where a value is needed: the slot is there.
    assert_eq!(check("  r = all(() => {\n    i = await msg-[:Interactions]->\n    return i.Value\n  }, () => \"b\")\n  write chat-[:Messages]-> { Text: r[0] }\n"), Vec::<String>::new());
    assert_eq!(check("  r = all(() => {\n    n = await d-[:Notes]->\n    return n.Title\n  }, () => \"b\")\n  write crm-[:Deals]-> { Name: r[0] }\n"), Vec::<String>::new());
}

#[test]
fn a_map_member_whose_function_awaits_is_present() {
    let notes = "  ds = List.from(crm-[:Deals]->)\n  xs = map(ds, (deal) => { return await deal-[:Notes]-> })\n  ys = map(xs, (n) => Text.upper(n.Title))\n";
    assert_eq!(check(notes), Vec::<String>::new());
    let titles = "  ds = List.from(crm-[:Deals]->)\n  xs = map(ds, (deal) => {\n    n = await deal-[:Notes]->\n    return n.Title\n  })\n  ys = map(xs, (x: <text>) => Text.upper(x))\n";
    assert_eq!(check(titles), Vec::<String>::new());
    let values = "  ms = List.from(chat-[:Messages]->)\n  xs = map(ms, (m) => {\n    i = await m-[:Interactions]->\n    return i.Value\n  })\n  ys = map(xs, (x: <text>) => Text.upper(x))\n";
    assert_eq!(check(values), Vec::<String>::new());
}

#[test]
fn a_call_whose_body_awaits_answers_present() {
    let closure = "  f = () => { return await d-[:Notes]-> }\n  x = f()\n  t = Text.upper(x.Title)\n";
    assert_eq!(check(closure), Vec::<String>::new());
    // A declared return type says what the body hands back, and it does.
    let declared = "function pressed(m: <chat-[:Message]->>): <text> {\n  i = await m-[:Interactions]->\n  return i.Value\n}\n";
    assert_eq!(found_with("  r = all(() => pressed(msg))\n  t = Text.upper(r[0])\n", declared, None), Vec::<String>::new());
    let inferred = "function noted(deal: <crm-[:Deal]->>) {\n  return await deal-[:Notes]->\n}\n";
    assert_eq!(found_with("  x = noted(d)\n  write crm-[:Deals]-> { Name: x.Title }\n", inferred, None), Vec::<String>::new());
    assert_eq!(found_with("  r = all(() => noted(d))\n  write crm-[:Deals]-> { Name: r[0].Title }\n", inferred, None), Vec::<String>::new());
}

#[test]
fn a_race_slot_keeps_its_record_type() {
    let race = "  r = race(() => { return await msg-[:Interactions]-> }, () => { await sleep(1d) })\n  if (r[0] != null) { t = r[0].Nope }\n";
    assert_eq!(
        check(race),
        ["MOV_UNKNOWN_PROPERTY error 3:27-3:36 Interaction has no field 'Nope' — it has: Id, Value".to_string()]
    );
    let notes = "  r = race(() => { return await d-[:Notes]-> }, () => { await sleep(1d) })\n  if (r[0] != null) { t = r[0].Nope }\n";
    assert_eq!(check(notes), ["MOV_UNKNOWN_PROPERTY error 3:27-3:36 Note has no field 'Nope' — it has: Id, Title".to_string()]);
}

#[test]
fn an_unraced_await_is_warned_on_upgrade_only() {
    let src = "  i = await msg-[:Interactions]->\n";
    assert_eq!(found(src, Some("0.12.13")), ["MOV_AWAIT_MAY_HANG warning 2:7-2:34 'await msg-[:Interactions]->' is not in a `race` with a `sleep`: from 0.13 a wait whose record is deleted never ends (under 0.12.13 the code after it was skipped), so this run can wait forever. Race it: `race(() => { return await msg-[:Interactions]-> }, () => { await sleep(1d) })` — reviews#deleted-records"]);
    assert_eq!(found(src, None), Vec::<String>::new());
    // Under this release's own key there is nothing to say.
    assert_eq!(found(src, Some(movement_parser::version::LANGUAGE_VERSION)), Vec::<String>::new());
    // `await new`, as written; and an `all` is no race.
    let all = "  r = all(() => { return await new d-[:Notes]-> }, () => { await sleep(1d) })\n";
    let hang = found(all, Some("0.12.13"));
    assert_eq!(hang.len(), 1, "{hang:?}");
    assert!(hang[0].starts_with("MOV_AWAIT_MAY_HANG warning 2:26-2:48 'await new d-[:Notes]->' is not in a `race` with a `sleep`"), "{}", hang[0]);
}

#[test]
fn a_raced_await_is_not_warned() {
    assert_eq!(found("  r = race(() => { return await new d-[:Notes]-> }, () => { await sleep(2d) })\n", Some("0.12.13")), Vec::<String>::new());
    // The sleep through a function the sibling arm calls, or names.
    let a_day = "function a_day() {\n  await sleep(1d)\n}\n";
    let called = "  r = race(() => { return await msg-[:Interactions]-> }, () => { a_day() })\n";
    assert_eq!(found_with(called, a_day, Some("0.12.13")), Vec::<String>::new());
    let named = "  r = race(() => { return await msg-[:Interactions]-> }, a_day)\n";
    assert_eq!(found_with(named, a_day, Some("0.12.13")), Vec::<String>::new());
    // Inside a race nested in a raced arm.
    let nested = "  r = race(() => {\n    q = race(() => { return await d-[:Notes]-> }, () => { return await msg-[:Interactions]-> })\n    return q[0]\n  }, () => { await sleep(1d) })\n";
    assert_eq!(found(nested, Some("0.12.13")), Vec::<String>::new());
}

#[test]
fn a_race_with_no_sleep_beside_the_await_is_warned() {
    // Its sibling waits on a record too: both can wait forever.
    let both = "  r = race(() => { return await d-[:Notes]-> }, () => { return await msg-[:Interactions]-> })\n";
    let hang = found(both, Some("0.12.13"));
    assert_eq!(hang.len(), 2, "{hang:?}");
    assert!(hang[0].starts_with("MOV_AWAIT_MAY_HANG warning 2:27-2:45 'await d-[:Notes]->'"), "{}", hang[0]);
    assert!(hang[1].starts_with("MOV_AWAIT_MAY_HANG warning 2:64-2:91 'await msg-[:Interactions]->'"), "{}", hang[1]);
    // The sleep in the await's own arm races nothing.
    let own = "  r = race(() => {\n    await sleep(1d)\n    return await d-[:Notes]->\n  })\n";
    let hang = found(own, Some("0.12.13"));
    assert_eq!(hang.len(), 1, "{hang:?}");
    assert!(hang[0].starts_with("MOV_AWAIT_MAY_HANG warning 4:12-4:30 'await d-[:Notes]->'"), "{}", hang[0]);
}

/// The `MOV_AWAIT_MAY_HANG` warnings on `body` with `functions`, checked as
/// an upgrade from 0.12.13: where each is, and its text up to the advice.
fn hangs(body: &str, functions: &str) -> Vec<String> {
    found_with(body, functions, Some("0.12.13"))
        .into_iter()
        .filter(|d| d.starts_with("MOV_AWAIT_MAY_HANG"))
        .map(|d| d.split(": from 0.13").next().unwrap_or_default().to_string())
        .collect()
}

const PRESSED: &str = "function pressed(m: <chat-[:Message]->>) {\n  return await m-[:Interactions]->\n}\n";
const NOTED: &str = "function noted(deal: <crm-[:Deal]->>) {\n  return await deal-[:Notes]->\n}\n";

#[test]
fn a_wait_in_a_function_every_call_of_which_is_raced_is_not_warned() {
    // Called inside the raced arm.
    assert_eq!(hangs("  r = race(() => { return pressed(msg) }, () => { await sleep(1d) })\n", PRESSED), Vec::<String>::new());
    assert_eq!(hangs("  r = race(() => { return noted(d) }, () => { await sleep(1d) })\n", NOTED), Vec::<String>::new());
    // Named as the raced arm: a closure bound to a name, and a function.
    let named = "  pressed_fn = () => { return await msg-[:Interactions]-> }\n  r = race(pressed_fn, () => { await sleep(1d) })\n";
    assert_eq!(hangs(named, ""), Vec::<String>::new());
    let a_deal = "function first_note() {\n  return await new crm-[:Deals]->\n}\n";
    assert_eq!(hangs("  r = race(first_note, () => { await sleep(1d) })\n", a_deal), Vec::<String>::new());
    // Through a function that calls it: every way in is raced.
    let asked = format!("{PRESSED}function asked(m: <chat-[:Message]->>) {{\n  return pressed(m)\n}}\n");
    assert_eq!(hangs("  r = race(() => { return asked(msg) }, () => { await sleep(1d) })\n", &asked), Vec::<String>::new());
}

#[test]
fn an_unraced_call_to_a_function_that_waits_is_warned_once_at_the_call() {
    // Told at the call, spelling the way down to the wait; the wait itself,
    // in a function something calls, is not told again.
    assert_eq!(
        found_with("  x = noted(d)\n", NOTED, Some("0.12.13")),
        ["MOV_AWAIT_MAY_HANG warning 2:7-2:15 'noted(d) → await deal-[:Notes]->' is not in a `race` with a `sleep`: from 0.13 a wait whose record is deleted never ends (under 0.12.13 the code after it was skipped), so this run can wait forever. Race the call: `race(() => { return noted(d) }, () => { await sleep(1d) })` — reviews#deleted-records"]
    );
    assert_eq!(hangs("  p = pressed(msg)\n", PRESSED), ["MOV_AWAIT_MAY_HANG warning 2:7-2:19 'pressed(msg) → await m-[:Interactions]->' is not in a `race` with a `sleep`"]);
    // A closure bound to a name, called unraced.
    assert_eq!(
        hangs("  f = () => { return await d-[:Notes]-> }\n  x = f()\n", ""),
        ["MOV_AWAIT_MAY_HANG warning 3:7-3:10 'f() → await d-[:Notes]->' is not in a `race` with a `sleep`"]
    );
}

#[test]
fn a_chain_of_unraced_calls_is_warned_once_at_its_outermost_call() {
    // Three levels: the run's way in calls `asked`, which calls `pressed`,
    // which waits.
    let asked = format!("{PRESSED}function asked(m: <chat-[:Message]->>) {{\n  return pressed(m)\n}}\n");
    assert_eq!(
        hangs("  p = asked(msg)\n", &asked),
        ["MOV_AWAIT_MAY_HANG warning 2:7-2:17 'asked(msg) → pressed(m) → await m-[:Interactions]->' is not in a `race` with a `sleep`"]
    );
    let dealt = format!("{NOTED}function dealt(deal: <crm-[:Deal]->>) {{\n  return noted(deal)\n}}\n");
    assert_eq!(
        hangs("  n = dealt(d)\n", &dealt),
        ["MOV_AWAIT_MAY_HANG warning 2:7-2:15 'dealt(d) → noted(deal) → await deal-[:Notes]->' is not in a `race` with a `sleep`"]
    );
    // A race inside the middle function covers the rest of the way down.
    let raced = format!("{NOTED}function dealt(deal: <crm-[:Deal]->>) {{\n  return race(() => {{ return noted(deal) }}, () => {{ await sleep(1d) }})\n}}\n");
    assert_eq!(hangs("  n = dealt(d)\n", &raced), Vec::<String>::new());
}

#[test]
fn a_function_reached_raced_and_unraced_is_warned_once_at_the_unraced_call() {
    let both = "  r = race(() => { return pressed(msg) }, () => { await sleep(1d) })\n  p = pressed(msg)\n";
    assert_eq!(hangs(both, PRESSED), ["MOV_AWAIT_MAY_HANG warning 3:7-3:19 'pressed(msg) → await m-[:Interactions]->' is not in a `race` with a `sleep`"]);
    let notes = "  n = noted(d)\n  r = race(() => { return noted(d) }, () => { await sleep(1d) })\n";
    assert_eq!(hangs(notes, NOTED), ["MOV_AWAIT_MAY_HANG warning 2:7-2:15 'noted(d) → await deal-[:Notes]->' is not in a `race` with a `sleep`"]);
}

#[test]
fn a_sibling_that_can_hang_is_no_way_out() {
    // It waits on a record before its sleep.
    let first = "  r = race(() => { return await msg-[:Interactions]-> }, () => {\n    n = await d-[:Notes]->\n    await sleep(1d)\n  })\n";
    assert_eq!(
        hangs(first, ""),
        [
            "MOV_AWAIT_MAY_HANG warning 2:27-2:54 'await msg-[:Interactions]->' is not in a `race` with a `sleep`",
            "MOV_AWAIT_MAY_HANG warning 3:9-3:27 'await d-[:Notes]->' is not in a `race` with a `sleep`",
        ]
    );
    // Through a function it calls.
    let slow = "function slow(deal: <crm-[:Deal]->>) {\n  n = await deal-[:Notes]->\n  await sleep(1d)\n}\n";
    let called = "  r = race(() => { return await msg-[:Interactions]-> }, () => { slow(d) })\n";
    assert_eq!(
        hangs(called, slow),
        [
            "MOV_AWAIT_MAY_HANG warning 2:27-2:54 'await msg-[:Interactions]->' is not in a `race` with a `sleep`",
            "MOV_AWAIT_MAY_HANG warning 2:66-2:73 'slow(d) → await deal-[:Notes]->' is not in a `race` with a `sleep`",
        ]
    );
    // After its sleep: it ends only if the record is not deleted.
    let after = "  r = race(() => { return await d-[:Notes]-> }, () => {\n    await sleep(1d)\n    i = await msg-[:Interactions]->\n  })\n";
    assert_eq!(hangs(after, "").len(), 2, "{:?}", hangs(after, ""));
    // Its own wait raced with a sleep: it ends, so it is a way out.
    let raced = "  r = race(() => { return await msg-[:Interactions]-> }, () => {\n    q = race(() => { return await d-[:Notes]-> }, () => { await sleep(1h) })\n    await sleep(1d)\n  })\n";
    assert_eq!(hangs(raced, ""), Vec::<String>::new());
}

#[test]
fn a_function_a_listen_fires_is_a_way_in_however_it_is_called() {
    let fired = format!("{PRESSED}listen to chat fire pressed\n");
    assert_eq!(
        hangs("  r = race(() => { return pressed(msg) }, () => { await sleep(1d) })\n", &fired),
        ["MOV_AWAIT_MAY_HANG warning 5:10-5:35 'await m-[:Interactions]->' is not in a `race` with a `sleep`"]
    );
}
