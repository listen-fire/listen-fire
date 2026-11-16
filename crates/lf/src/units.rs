//! The run host's units (Henry 2026-10-16): `cron` and `manual`, in every
//! file's scope in this language with no import
//! (movement_parser::version::RUN_HOST_UNITS). listen-fire builds them in, as the
//! platform does (lf-platform's apps/api translation_graph/adapters/{cron,manual}): their
//! catalog entries and the in-process adapter a run reads its landing through.
//!
//! Each is one listenable root edge. `cron-[t:Ticks WHERE t.Schedule == "…"]->`
//! is polled (crate::edge_polls): one clock per schedule and zone a shared
//! poll's filter names, which the unit answers itself (`poll_ticks`).
//! `manual-[:Invocations]->` is pushed by `listen-fire run <movement>`.
//!
//! A project external of the same name replaces the unit.

use serde_json::json;

use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, LogicalOp, StaticValue};

use crate::json::{Js, Obj};
use crate::obj;
use crate::wire::{Hv, js_of_json};

pub const CRON: &str = "cron";
pub const MANUAL: &str = "manual";

/// The cron unit's one edge, and the manual unit's.
pub const TICKS: &str = "Ticks";
pub const INVOCATIONS: &str = "Invocations";

/// The zone a schedule is read in when a listen names none.
const DEFAULT_ZONE: &str = "UTC";

/// The unit `name` is, when no external of the project takes the name.
pub fn unit_named<'a>(name: &str, externals: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    let unit = movement_parser::version::RUN_HOST_UNITS.iter().copied().find(|u| *u == name)?;
    (!externals.into_iter().any(|e| e == unit)).then_some(unit)
}

/// What the unit's manifest says of its listens: how a 0.12 settings listen
/// on it is written as a traversal (`listenSettingsBecome`). A cron listen
/// always named its schedule; a manual one named nothing.
pub fn listen_vocabulary(unit: &str) -> Obj {
    js_obj(match unit {
        CRON => json!({
            "listenSettingsBecome": {
                "path": [TICKS],
                "aliases": ["t"],
                "paramFrom": "Tick",
                "keys": {
                    "schedule": { "hop": 0, "field": "Schedule", "op": "eq" },
                    "timezone": { "hop": 0, "field": "Zone", "op": "eq" },
                },
            },
        }),
        _ => json!({ "listenSettingsBecome": { "path": [INVOCATIONS], "aliases": ["i"], "paramFrom": "Invocation", "keys": {} } }),
    })
}

/// `listEntryPoints`. A cron's ticks are polled at its next tick (`poll_ticks`'s
/// `pollAgainAt`) or every `pollEverySeconds`, whichever is sooner,
/// unless lf.yaml's `pollEvery` names another interval for `cron`.
pub fn entry_points(unit: &str) -> Vec<Js> {
    let entries = match unit {
        CRON => json!([{
            "typeId": "tick",
            "displayName": "Tick",
            "collectionName": TICKS,
            "writable": false,
            "readable": false,
            "listenable": true,
            "bounded": false,
            "boundedBy": ["Schedule"],
            "delivery": "polled",
            "pollEverySeconds": 60,
            "cursor": true,
            "capability": { "filter": "native", "supportsLimit": false },
        }]),
        _ => json!([
            { "typeId": "invocation", "displayName": "Invocation", "collectionName": INVOCATIONS, "writable": false, "readable": false, "listenable": true, "delivery": "connection" },
            { "typeId": "file", "displayName": "File", "writable": false, "readable": false },
        ]),
    };
    entries.as_array().map(|a| a.iter().map(js_of_json).collect()).unwrap_or_default()
}

/// `describe`, by type id or display name; `None` for a type the unit lacks.
pub fn describe(unit: &str, type_ref: &str) -> Option<Js> {
    descriptors(unit).into_iter().find(|d| [d.get("typeId"), d.get("displayName")].iter().any(|v| v.and_then(Js::as_str) == Some(type_ref)))
}

/// Every type the unit describes, by type id (the catalog's projection input).
pub fn descriptors(unit: &str) -> Vec<Js> {
    let field = |id: &str, name: &str, kind: &str, required: bool| json!({ "fieldId": id, "displayName": name, "kind": kind, "writable": false, "required": required });
    // A scalar only the cron unit reads, compared by `==` or `IN`.
    let owned = |id: &str, name: &str, scalar: &str, format: &str| {
        json!({ "fieldId": id, "displayName": name, "kind": "owned", "owned": { "name": scalar, "format": format }, "writable": false, "required": true, "capability": { "filterOperators": ["eq", "in"] } })
    };
    let list = match unit {
        CRON => vec![json!({
            "typeId": "tick",
            "displayName": "Tick",
            "description": "One scheduled firing: when it was due, on which schedule, in which zone.",
            "fields": [field("firedAt", "Fired at", "date", true), owned("schedule", "Schedule", "Cron", "cron"), owned("zone", "Zone", "Zone", "timeZone")],
            "references": [],
        })],
        _ => vec![
            json!({
                "typeId": "invocation",
                "displayName": "Invocation",
                "description": "One Run-now press — when, by whom, and any text or files supplied.",
                "fields": [
                    field("firedAt", "Fired at", "date", true),
                    field("actorEmail", "Run by (email)", "string", false),
                    field("actorName", "Run by (name)", "string", false),
                    field("text", "Text", "string", false),
                    field("content", "Content", "string", false),
                ],
                "references": [{ "fieldId": "files", "targetTypeId": "file", "cardinality": "many", "direction": "outgoing", "name": "Files", "writable": false }],
            }),
            json!({
                "typeId": "file",
                "displayName": "File",
                "fields": [
                    field("name", "Name", "string", true),
                    field("contentType", "Content Type", "string", true),
                    field("size", "Size", "number", false),
                ],
                "references": [],
            }),
        ],
    };
    list.iter().map(js_of_json).collect()
}

/// The type a position naming none is read as: what lands on the unit's edge.
fn landing_type_id(unit: &str) -> &'static str {
    if unit == CRON { "tick" } else { "invocation" }
}

/// The methods the unit's in-process adapter answers.
pub const METHODS: &[&str] = &["listEntryPoints", "describe", "getFieldValue", "getRelated"];

/// One adapter call on the unit: `listEntryPoints`, `describe`, and a
/// landing's fields read off its position's data, by id or by name; nothing
/// is related (a file supplied to a manual run is the platform's;
/// listen-fire supplies none).
pub fn call(unit: &str, method: &str, args: &Hv) -> Result<Js, String> {
    match method {
        "listEntryPoints" => Ok(Js::Arr(entry_points(unit))),
        "describe" => Ok(describe(unit, args.get("typeId").and_then(Hv::as_str).unwrap_or_default()).unwrap_or(Js::Null)),
        "getFieldValue" => {
            let position = args.get("position").map(Hv::js).unwrap_or(Js::Null);
            let record_type = position.get("recordType").and_then(Js::as_str).unwrap_or(landing_type_id(unit));
            let written = args.get("fieldId").and_then(Hv::as_str).unwrap_or_default();
            let descriptor = describe(unit, record_type);
            let fields = descriptor.as_ref().and_then(|d| d.get("fields")).and_then(Js::as_array).unwrap_or(&[]);
            let declared = fields.iter().find(|f| [f.get("fieldId"), f.get("displayName")].iter().any(|v| v.and_then(Js::as_str) == Some(written)));
            let id = declared.and_then(|f| f.get("fieldId").and_then(Js::as_str)).unwrap_or(written);
            let name = declared.and_then(|f| f.get("displayName").and_then(Js::as_str)).unwrap_or(written);
            let data = position.get("identity").and_then(|i| i.get("data")).cloned().unwrap_or(Js::Null);
            let held = |key: &str| data.get(key).filter(|v| **v != Js::Null).cloned();
            Ok(match (unit, id) {
                // A run started with no text reads `""`, never absent: the
                // schema types both as text, which is always present.
                (MANUAL, "text" | "content") => held("Text").or_else(|| held("text")).unwrap_or(Js::str("")),
                _ => held(id).or_else(|| held(name)).unwrap_or(Js::Null),
            })
        }
        "getRelated" => Ok(Js::Arr(Vec::new())),
        other => Err(format!("the '{unit}' unit does not implement {other}")),
    }
}

/// The arrival a manual run is, on `Invocations`: when it was asked for,
/// by whom, and the text given with it. Each is its own invocation.
pub fn invocation(fired_at: &str, user: &Js, text: Option<&str>) -> Js {
    let mut fields = obj! { "Fired at" => Js::str(fired_at) };
    if let Some(email) = user.get("email").and_then(Js::as_str) {
        fields.insert("Run by (email)".into(), Js::str(email));
    }
    if let Some(name) = user.get("principal").and_then(|p| p.get("display")).and_then(Js::as_str) {
        fields.insert("Run by (name)".into(), Js::str(name));
    }
    if let Some(text) = text {
        fields.insert("Text".into(), Js::str(text));
    }
    let identity = format!("invocation:{}", uuid::Uuid::new_v4());
    Js::Obj(obj! {
        "edge" => Js::str(INVOCATIONS),
        "identity" => Js::str(&identity),
        "landing" => Js::Obj(obj! { "recordType" => Js::str("Invocation"), "fields" => Js::Obj(fields) }),
    })
}

/// When a poll of `Ticks` happens, and how often its key is polled.
#[derive(Clone, Copy)]
pub struct PollClock {
    pub now_ms: i64,
    pub every_ms: i64,
}

/// What a poll of `Ticks` answered, and a line for each schedule and zone
/// the filter names that the unit could not read (that pair fires nothing;
/// the rest of the poll still does).
pub struct Ticked {
    pub answer: Js,
    pub unread: Vec<String>,
}

/// The cron unit's answer to a poll of `Ticks` (adapter protocol 2.6's
/// `poll({ edge, filter, cursor })`): every occurrence since the cursor of
/// each schedule and zone the filter names, as one arrival each. An
/// occurrence older than one poll interval before now was missed while
/// nothing polled (a backlog): of those only the latest fires, once. One
/// instant fires once however many spellings of a schedule or zone the
/// filter names. Its identity is the occurrence, so however many workers
/// find it due, a listen runs it once. The first poll (no cursor) only sets
/// the cursor: nothing before a listen is owed. The cursor is the instant it
/// polled to. The unit applies the filter itself (`takenApplied`).
///
/// Each answer, the first included, says when the next occurrence is due
/// (`pollAgainAt`, adapter protocol 2.7), so the host polls then rather than
/// up to an interval after it. It looks no further than one interval
/// ahead: the host polls by then anyway.
pub fn poll_ticks(filter: Option<&serde_json::Value>, cursor: Option<&Js>, clock: PollClock) -> Result<Ticked, String> {
    let PollClock { now_ms, every_ms } = clock;
    let filter: Expression = match filter {
        Some(filter) => serde_json::from_value(filter.clone()).map_err(|e| format!("cron: the filter on {TICKS} is not one it reads: {e}"))?,
        None => return Err(format!("cron: a poll of {TICKS} names no schedule")),
    };
    let schedules = values_of(&filter, "Schedule").ok_or_else(|| format!("cron: a poll of {TICKS} names no schedule it can read"))?;
    let zones = values_of(&filter, "Zone").unwrap_or_else(|| vec![DEFAULT_ZONE.to_string()]);
    let mut unread = Vec::new();
    let mut clocks: Vec<(&str, &str, Schedule)> = Vec::new();
    for schedule in &schedules {
        for zone in &zones {
            match parse_schedule(schedule, Some(zone)) {
                Ok(parsed) => clocks.push((schedule, zone, parsed)),
                Err(e) => unread.push(format!("cron: schedule \"{schedule}\" in {zone} fires nothing: {e}")),
            }
        }
    }
    let next = clocks.iter().filter_map(|(_, _, parsed)| parsed.next_in(now_ms, now_ms + every_ms)).min();
    let answer = |arrivals: Vec<Js>| {
        let mut answer = obj! { "arrivals" => Js::Arr(arrivals), "cursor" => Js::str(&iso_of(now_ms)) };
        if let Some(at) = next {
            answer.insert("pollAgainAt".into(), Js::str(&iso_of(at)));
        }
        Js::Obj(answer)
    };
    let Some(after_ms) = cursor.and_then(Js::as_str).and_then(ms_of) else {
        return Ok(Ticked { answer: answer(Vec::new()), unread });
    };
    let backlog_until = now_ms - every_ms;
    // Each instant once, by the first schedule and zone the filter names that is due then.
    let mut due: std::collections::BTreeMap<i64, (&str, &str)> = std::collections::BTreeMap::new();
    for (schedule, zone, parsed) in &clocks {
        let caught_up = (after_ms < backlog_until).then(|| parsed.latest_in(after_ms, backlog_until)).flatten();
        for at in caught_up.into_iter().chain(parsed.occurrences_in(after_ms.max(backlog_until), now_ms)) {
            due.entry(at).or_insert((schedule, zone));
        }
    }
    let arrivals = due
        .into_iter()
        .map(|(at, (schedule, zone))| {
            let at = iso_of(at);
            let fields = obj! { "Fired at" => Js::str(&at), "Schedule" => Js::str(schedule), "Zone" => Js::str(zone) };
            Js::Obj(obj! {
                "edge" => Js::str(TICKS),
                "identity" => Js::Str(format!("tick:{schedule}:{zone}:{at}")),
                "landing" => Js::Obj(obj! { "recordType" => Js::str("Tick"), "fields" => Js::Obj(fields) }),
                "occurredAt" => Js::str(&at),
                "takenApplied" => Js::Bool(true),
            })
        })
        .collect();
    Ok(Ticked { answer: answer(arrivals), unread })
}

/// The literals `filter` compares `field` with, by `==` or `IN`, or an `OR`
/// of `==`; `None` when it names none (the checker refuses any other form
/// on a field only the unit reads).
fn values_of(filter: &Expression, field: &str) -> Option<Vec<String>> {
    let on_field = |left: &Expression| matches!(left, Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } if property_type_id == field);
    match filter {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().find_map(|o| values_of(o, field)),
        Expression::Logical { op: LogicalOp::Or, operands } => {
            let each: Option<Vec<Vec<String>>> = operands.iter().map(|o| values_of(o, field)).collect();
            each.map(|v| v.concat())
        }
        Expression::Compare { op: FilterOperator::Eq, left, right } if on_field(left) => match &**right {
            Expression::Static { value: StaticValue::String(value) } => Some(vec![value.clone()]),
            _ => None,
        },
        Expression::Compare { op: FilterOperator::In, left, right } if on_field(left) => match &**right {
            Expression::List { elements } => elements
                .iter()
                .map(|e| match e {
                    ListElement::Expression(Expression::Static { value: StaticValue::String(value) }) => Some(value.clone()),
                    _ => None,
                })
                .collect(),
            _ => None,
        },
        _ => None,
    }
}

fn js_obj(value: serde_json::Value) -> Obj {
    match js_of_json(&value) {
        Js::Obj(map) => map,
        _ => Obj::new(),
    }
}

/// A cron listen's schedule, read as lf-platform's packages/legacy-lang/cron reads it (five
/// fields, names for months and weekdays, 7 also Sunday; both day fields
/// restricted means either matches), in the listen's zone or UTC.
pub struct Schedule {
    minutes: Vec<bool>,
    hours: Vec<bool>,
    days_of_month: Vec<bool>,
    months: Vec<bool>,
    days_of_week: Vec<bool>,
    any_day_of_month: bool,
    any_day_of_week: bool,
    zone: jiff::tz::TimeZone,
}

const MONTHS: &[&str] = &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// One field's values, `min..=max`, and whether it is `*`.
fn field(text: &str, min: usize, max: usize, names: &[&str], first_name: usize) -> Result<(Vec<bool>, bool), String> {
    let value = |s: &str| -> Result<usize, String> {
        if let Some(i) = names.iter().position(|n| n.eq_ignore_ascii_case(s)) {
            return Ok(i + first_name);
        }
        s.parse::<usize>().ok().filter(|n| (min..=max).contains(n)).ok_or_else(|| format!("'{s}' is not a value in {min}-{max}"))
    };
    let mut set = vec![false; max + 1];
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => (range, step.parse::<usize>().ok().filter(|s| *s > 0).ok_or_else(|| format!("'{step}' is not a step"))?),
            None => (item, 1),
        };
        let (from, to) = match range {
            "*" => (min, max),
            r => match r.split_once('-') {
                Some((a, b)) => (value(a)?, value(b)?),
                None if step > 1 => (value(r)?, max),
                None => (value(r)?, value(r)?),
            },
        };
        if from > to {
            return Err(format!("range {range} runs backwards"));
        }
        for n in (from..=to).step_by(step) {
            set[n] = true;
        }
    }
    Ok((set, text == "*"))
}

pub fn parse_schedule(expression: &str, timezone: Option<&str>) -> Result<Schedule, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    let [minute, hour, dom, month, dow] = fields.as_slice() else {
        return Err(format!("a schedule has five fields, got {}", fields.len()));
    };
    let (mut days_of_week, any_day_of_week) = field(dow, 0, 7, WEEKDAYS, 0)?;
    if days_of_week[7] {
        days_of_week[0] = true;
    }
    let (days_of_month, any_day_of_month) = field(dom, 1, 31, &[], 0)?;
    let zone = match timezone {
        Some(name) => movement_checker::host::native::zone_of(name).ok_or_else(|| format!("'{name}' is not a time zone"))?,
        None => jiff::tz::TimeZone::UTC,
    };
    Ok(Schedule {
        minutes: field(minute, 0, 59, &[], 0)?.0,
        hours: field(hour, 0, 23, &[], 0)?.0,
        days_of_month,
        months: field(month, 1, 12, MONTHS, 1)?.0,
        days_of_week,
        any_day_of_month,
        any_day_of_week,
        zone,
    })
}

/// How far back a worker looks for a missed occurrence.
const LOOKBACK_MINUTES: i64 = 366 * 24 * 60;

impl Schedule {
    /// Whether the minute starting at `ms` is an occurrence.
    fn matches(&self, ms: i64) -> bool {
        let Ok(at) = jiff::Timestamp::from_millisecond(ms) else { return false };
        let local = at.to_zoned(self.zone.clone());
        let (dom, dow) = (self.days_of_month[local.day() as usize], self.days_of_week[local.weekday().to_sunday_zero_offset() as usize]);
        let day = match (self.any_day_of_month, self.any_day_of_week) {
            (false, false) => dom || dow,
            (false, true) => dom,
            (true, false) => dow,
            (true, true) => true,
        };
        day && self.minutes[local.minute() as usize] && self.hours[local.hour() as usize] && self.months[local.month() as usize]
    }

    /// The latest occurrence after `after_ms` and no later than `until_ms`
    /// (each a minute's start), when there is one.
    pub fn latest_in(&self, after_ms: i64, until_ms: i64) -> Option<i64> {
        self.minutes_back(after_ms, until_ms).find(|at| self.matches(*at))
    }

    /// Every occurrence after `after_ms` and no later than `until_ms`,
    /// earliest first.
    pub fn occurrences_in(&self, after_ms: i64, until_ms: i64) -> Vec<i64> {
        let mut all: Vec<i64> = self.minutes_back(after_ms, until_ms).filter(|at| self.matches(*at)).collect();
        all.reverse();
        all
    }

    /// The earliest occurrence after `after_ms` and no later than
    /// `until_ms`, when there is one.
    pub fn next_in(&self, after_ms: i64, until_ms: i64) -> Option<i64> {
        let first = after_ms - after_ms.rem_euclid(60_000) + 60_000;
        (0..).map(|n| first + n * 60_000).take_while(|at| *at <= until_ms).find(|at| self.matches(*at))
    }

    /// The minutes' starts in (`after_ms`, `until_ms`], latest first, no
    /// further back than a worker looks.
    fn minutes_back(&self, after_ms: i64, until_ms: i64) -> impl Iterator<Item = i64> {
        let latest = until_ms - until_ms.rem_euclid(60_000);
        let floor = after_ms.max(until_ms - LOOKBACK_MINUTES * 60_000);
        (0..).map(move |n| latest - n * 60_000).take_while(move |at| *at > floor)
    }
}

/// An instant as `Date.prototype.toISOString` writes it.
pub fn iso_of(ms: i64) -> String {
    let ts = jiff::Timestamp::from_millisecond(ms).unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    format!("{}.{:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"), ms.rem_euclid(1000))
}

/// An ISO instant's milliseconds.
pub fn ms_of(iso: &str) -> Option<i64> {
    iso.parse::<jiff::Timestamp>().ok().map(|t| t.as_millisecond())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        ms_of(iso).unwrap()
    }

    #[test]
    fn a_manual_text_not_given_reads_as_the_empty_string_like_its_content() {
        let user = Js::Obj(Obj::new());
        let read = |text: Option<&str>, field: &str| {
            let arrival = invocation("2026-10-22T00:00:00.000Z", &user, text);
            let mut identity = Obj::new();
            identity.insert("data".into(), arrival.get("landing").and_then(|l| l.get("fields")).cloned().unwrap());
            let mut position = Obj::new();
            position.insert("recordType".into(), Js::str("Invocation"));
            position.insert("identity".into(), Js::Obj(identity));
            let args = Hv::Obj(vec![("position".into(), Hv::of_js(&Js::Obj(position))), ("fieldId".into(), Hv::Str(field.into()))]);
            call(MANUAL, "getFieldValue", &args).unwrap()
        };
        for field in ["text", "Text", "content", "Content"] {
            assert_eq!(read(None, field), Js::str(""), "{field}");
            assert_eq!(read(Some("hi there"), field), Js::str("hi there"), "{field}");
        }
        assert_eq!(read(None, "Fired at"), Js::str("2026-10-22T00:00:00.000Z"));
    }

    fn filter(text: &str) -> serde_json::Value {
        let walk = movement_checker::slots::expression_of_text(&format!("cron-[t:Ticks WHERE {text}]->")).unwrap();
        let Expression::Traverse { steps, .. } = walk else { panic!("a walk") };
        let movement_parser::lowering::expression::TraversalStep::Edge(step) = &steps[0] else { panic!("an edge step") };
        serde_json::to_value(step.expression_filter.as_deref().unwrap()).unwrap()
    }

    fn ticked_of(answer: &Js) -> Vec<(String, String)> {
        answer.get("arrivals").and_then(Js::as_array).unwrap().iter().map(|a| (a.get("identity").and_then(Js::as_str).unwrap().to_string(), a.get("landing").unwrap().to_json())).collect()
    }

    /// A poll at `now` of a key polled every `every_minutes`.
    fn poll(written: &str, cursor: Option<&Js>, now: i64, every_minutes: i64) -> Ticked {
        poll_ticks(Some(&filter(written)), cursor, PollClock { now_ms: now, every_ms: every_minutes * 60_000 }).unwrap()
    }

    fn identities(ticked: &Ticked) -> Vec<String> {
        ticked_of(&ticked.answer).into_iter().map(|(i, _)| i).collect()
    }

    #[test]
    fn a_poll_of_ticks_answers_each_schedule_and_zone_it_names() {
        let (armed, now) = (at("2026-10-19T08:30:00Z"), at("2026-10-19T09:30:00Z"));
        // The first poll only sets the cursor.
        let first = poll(r#"t.Schedule == "0 9 * * 1""#, None, armed, 60);
        assert_eq!(first.answer.to_json(), r#"{"arrivals":[],"cursor":"2026-10-19T08:30:00.000Z","pollAgainAt":"2026-10-19T09:00:00.000Z"}"#);
        let cursor = first.answer.get("cursor").cloned().unwrap();
        // 2026-10-19 is a Monday; with no zone, a schedule is read in UTC.
        let one = poll(r#"t.Schedule == "0 9 * * 1""#, Some(&cursor), now, 60);
        assert_eq!(
            ticked_of(&one.answer),
            [("tick:0 9 * * 1:UTC:2026-10-19T09:00:00.000Z".to_string(), r#"{"recordType":"Tick","fields":{"Fired at":"2026-10-19T09:00:00.000Z","Schedule":"0 9 * * 1","Zone":"UTC"}}"#.to_string())]
        );
        assert_eq!(one.answer.get("cursor").and_then(Js::as_str), Some("2026-10-19T09:30:00.000Z"));
        // Two schedules, by IN or by OR, each fire; in London 09:00 is 08:00 UTC, before the cursor's 08:30.
        for written in [r#"t.Schedule IN ["0 9 * * 1", "15 9 * * *"]"#, r#"t.Schedule == "0 9 * * 1" OR t.Schedule == "15 9 * * *""#] {
            assert_eq!(identities(&poll(written, Some(&cursor), now, 60)), ["tick:0 9 * * 1:UTC:2026-10-19T09:00:00.000Z", "tick:15 9 * * *:UTC:2026-10-19T09:15:00.000Z"], "{written}");
        }
        assert_eq!(identities(&poll(r#"t.Schedule == "0 9 * * 1" AND t.Zone == "Europe/London""#, Some(&cursor), now, 60)), Vec::<String>::new());
        assert_eq!(identities(&poll(r#"t.Schedule == "0 10 * * 1" AND t.Zone == "Europe/London""#, Some(&cursor), now, 60)), ["tick:0 10 * * 1:Europe/London:2026-10-19T09:00:00.000Z"]);
        assert!(poll_ticks(None, Some(&cursor), PollClock { now_ms: now, every_ms: 60_000 }).err().unwrap().contains("names no schedule"));
    }

    #[test]
    fn a_poll_fires_every_occurrence_in_its_window_and_one_catch_up_for_a_backlog() {
        let cursor = Js::str("2026-10-19T10:00:00.000Z");
        // Polled every five minutes, a minutely schedule fires five ticks a poll.
        let five = poll(r#"t.Schedule == "* * * * *""#, Some(&cursor), at("2026-10-19T10:05:00Z"), 5);
        assert_eq!(
            identities(&five),
            ["10:01", "10:02", "10:03", "10:04", "10:05"].map(|m| format!("tick:* * * * *:UTC:2026-10-19T{m}:00.000Z"))
        );
        // A poll that drifts past its interval still fires the occurrence between.
        let drifted = poll(r#"t.Schedule == "* * * * *""#, Some(&Js::str("2026-10-19T09:00:59.800Z")), at("2026-10-19T09:02:00.300Z"), 1);
        assert_eq!(identities(&drifted), ["09:01", "09:02"].map(|m| format!("tick:* * * * *:UTC:2026-10-19T{m}:00.000Z")));
        // After an hour with nothing polling, the backlog is one catch-up tick
        // (its latest occurrence), then the poll interval's own ticks.
        let after_downtime = poll(r#"t.Schedule == "* * * * *""#, Some(&Js::str("2026-10-19T09:00:00.000Z")), at("2026-10-19T10:05:00Z"), 5);
        assert_eq!(
            identities(&after_downtime),
            ["10:00", "10:01", "10:02", "10:03", "10:04", "10:05"].map(|m| format!("tick:* * * * *:UTC:2026-10-19T{m}:00.000Z"))
        );
        // A daily schedule missed for three days fires once.
        let daily = poll(r#"t.Schedule == "0 9 * * *""#, Some(&Js::str("2026-10-16T12:00:00.000Z")), at("2026-10-19T12:00:00Z"), 1);
        assert_eq!(identities(&daily), ["tick:0 9 * * *:UTC:2026-10-19T09:00:00.000Z"]);
    }

    fn poll_again_at(ticked: &Ticked) -> Option<&str> {
        ticked.answer.get("pollAgainAt").and_then(Js::as_str)
    }

    /// Each answer says when the next occurrence is due, within one interval,
    /// so the host polls then and the tick fires on time.
    #[test]
    fn a_poll_of_ticks_says_when_its_next_occurrence_is_due() {
        let weekdays = r#"t.Schedule == "30 8 * * 1-5""#;
        // 2026-10-19 is a Monday: armed at 08:29:45, the next tick is 15 seconds on.
        let armed = poll(weekdays, None, at("2026-10-19T08:29:45Z"), 1);
        assert_eq!(poll_again_at(&armed), Some("2026-10-19T08:30:00.000Z"), "the arming poll says it too");
        let cursor = armed.answer.get("cursor").cloned().unwrap();
        let on_time = poll(weekdays, Some(&cursor), at("2026-10-19T08:30:00.040Z"), 1);
        assert_eq!(identities(&on_time), ["tick:30 8 * * 1-5:UTC:2026-10-19T08:30:00.000Z"], "polled at the tick, it fires");
        assert_eq!(poll_again_at(&on_time), None, "tomorrow's is beyond the interval: the host polls on its cycle");
        // The earliest of every schedule and zone named; one exactly at a minute's start is due now, so the next is after it.
        let two = poll(r#"t.Schedule IN ["*/5 * * * *", "2 * * * *"]"#, Some(&cursor), at("2026-10-19T09:00:00Z"), 60);
        assert_eq!(poll_again_at(&two), Some("2026-10-19T09:02:00.000Z"));
        // In London's summer time, 09:00 there is 08:00 UTC.
        let zoned = poll(r#"t.Schedule == "0 9 * * *" AND t.Zone == "Europe/London""#, None, at("2026-07-01T07:59:30Z"), 1);
        assert_eq!(poll_again_at(&zoned), Some("2026-07-01T08:00:00.000Z"));
    }

    #[test]
    fn the_next_occurrence_in_a_window_is_the_earliest_after_its_start() {
        let hourly = parse_schedule("0 * * * *", None).unwrap();
        assert_eq!(hourly.next_in(at("2026-10-19T08:59:59.999Z"), at("2026-10-19T10:00:00Z")).map(iso_of).as_deref(), Some("2026-10-19T09:00:00.000Z"));
        assert_eq!(hourly.next_in(at("2026-10-19T09:00:00Z"), at("2026-10-19T10:00:00Z")).map(iso_of).as_deref(), Some("2026-10-19T10:00:00.000Z"), "its end is in the window, its start is not");
        assert_eq!(hourly.next_in(at("2026-10-19T09:00:00Z"), at("2026-10-19T09:59:59Z")), None);
    }

    #[test]
    fn one_instant_fires_once_whatever_spellings_the_filter_names() {
        let cursor = Js::str("2026-10-19T08:30:00.000Z");
        // 2026-10-19 is a Monday; in winter London is UTC.
        let spelled = poll(
            r#"t.Schedule IN ["0 9 * * 1-5", "0 9 * * MON-FRI"] AND t.Zone IN ["UTC", "Etc/UTC"]"#,
            Some(&cursor),
            at("2026-10-19T09:30:00Z"),
            60,
        );
        assert_eq!(identities(&spelled), ["tick:0 9 * * 1-5:UTC:2026-10-19T09:00:00.000Z"]);
    }

    #[test]
    fn a_zone_the_unit_cannot_read_fires_nothing_and_the_rest_of_the_poll_still_fires() {
        let cursor = Js::str("2026-10-19T08:30:00.000Z");
        let ticked = poll(r#"t.Schedule == "0 9 * * *" AND t.Zone IN ["Mars/Olympus", "UTC", "+01:00"]"#, Some(&cursor), at("2026-10-19T09:30:00Z"), 60);
        // An offset is read as the checker reads it: 09:00 at +01:00 is 08:00 UTC, before the cursor.
        assert_eq!(identities(&ticked), ["tick:0 9 * * *:UTC:2026-10-19T09:00:00.000Z"]);
        assert_eq!(ticked.unread, [r#"cron: schedule "0 9 * * *" in Mars/Olympus fires nothing: 'Mars/Olympus' is not a time zone"#]);
        let offset = poll(r#"t.Schedule == "0 10 * * *" AND t.Zone == "+01:00""#, Some(&cursor), at("2026-10-19T09:30:00Z"), 60);
        assert_eq!(identities(&offset), ["tick:0 10 * * *:+01:00:2026-10-19T09:00:00.000Z"]);
        let bad_schedule = poll(r#"t.Schedule IN ["0 9 * * *", "61 * * * *"]"#, Some(&cursor), at("2026-10-19T09:30:00Z"), 60);
        assert_eq!(identities(&bad_schedule), ["tick:0 9 * * *:UTC:2026-10-19T09:00:00.000Z"]);
        assert_eq!(bad_schedule.unread, [r#"cron: schedule "61 * * * *" in UTC fires nothing: '61' is not a value in 0-59"#]);
    }

    #[test]
    fn the_latest_occurrence_in_a_window_is_the_one_a_worker_fires() {
        let weekly = parse_schedule("0 9 * * mon", None).unwrap();
        // 2026-10-12 and 2026-10-19 are Mondays.
        assert_eq!(weekly.latest_in(at("2026-10-01T00:00:00Z"), at("2026-10-18T00:00:00Z")).map(iso_of).as_deref(), Some("2026-10-12T09:00:00.000Z"));
        assert_eq!(weekly.latest_in(at("2026-10-12T09:00:00Z"), at("2026-10-18T00:00:00Z")), None);
        let every_five = parse_schedule("*/5 * * * *", None).unwrap();
        assert_eq!(every_five.latest_in(at("2026-10-18T10:00:00Z"), at("2026-10-18T10:07:30Z")).map(iso_of).as_deref(), Some("2026-10-18T10:05:00.000Z"));
    }

    #[test]
    fn a_zoned_schedule_is_wall_clock_time_there() {
        let london = parse_schedule("0 9 * * *", Some("Europe/London")).unwrap();
        // British Summer Time: 09:00 in London is 08:00 UTC.
        assert_eq!(london.latest_in(at("2026-07-01T00:00:00Z"), at("2026-07-01T12:00:00Z")).map(iso_of).as_deref(), Some("2026-07-01T08:00:00.000Z"));
    }

    #[test]
    fn both_day_fields_restricted_match_either() {
        let s = parse_schedule("0 0 1 * fri", None).unwrap();
        // 2026-10-16 is a Friday (a Thursday is the first).
        assert_eq!(s.latest_in(at("2026-10-02T00:00:00Z"), at("2026-10-17T00:00:00Z")).map(iso_of).as_deref(), Some("2026-10-16T00:00:00.000Z"));
        assert_eq!(s.latest_in(at("2026-09-30T00:00:00Z"), at("2026-10-01T12:00:00Z")).map(iso_of).as_deref(), Some("2026-10-01T00:00:00.000Z"));
    }
}
