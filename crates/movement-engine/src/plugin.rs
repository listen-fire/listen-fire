//! A plugin called plainly (run.ts `executePluginCall`): `page =
//! fetch_url(url: c.website)`, `x = p()`, or `p(…)` as a statement. Its named
//! arguments are evaluated in the order written and handed to the plugin as
//! its config; the invocation is timed (`clock.now` either side), refused
//! before the host is asked when the plugin is priced and the cap is spent,
//! and traced; what comes back is bound as the plugin's DECLARED output
//! (`PluginSpec.output`): a `value` output its value, in the type it
//! declares (a text spelling a declared number or boolean read as one; any
//! other misfit bound as before and noted on the run), a
//! `record` output a node of the fields it attached (its text under `text`),
//! a `records` output one such node per record it found.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::catalog::plugin_args::{EXTRACTED_RECORD_PARAM, PluginCallSite};
use movement_parser::catalog::types::{Composite, FieldType, JsMap, PluginOutput, PluginSpec, Scalar, SchemaFieldType};

use crate::bindings::{Binding, Node, Scope};
use crate::env::{Trail, ValueBinding};
use crate::js::{Js, JsObject};
use movement_parser::ast::CallArg;
use serde_json::Value as Json;

use crate::host;
use crate::run::{Address, Failure, Run, Stop};
use crate::trace::{Members, TraceEntry};

/// The field a `record` output hands its fetched text back under.
const FETCHED_TEXT_FIELD: &str = "text";

/// `pluginSpecNamed`: a plugin by either spelling — a program writes
/// `vc_url_retrieval` for a plugin registered as `vc-url-retrieval`, and the
/// snapshot keys the underscore one.
pub fn spec_named<'p>(plugins: &'p JsMap<PluginSpec>, plugin: &str) -> Option<&'p PluginSpec> {
    use movement_parser::catalog::packages::{FoundPlugin, find_plugin};
    // A package member's key is matched as written (a package tag may carry dashes).
    match find_plugin(plugins, plugin) {
        FoundPlugin::One { spec, .. } => Some(spec),
        FoundPlugin::Ambiguous(_) => None,
        FoundPlugin::None => match find_plugin(plugins, &plugin.replace('-', "_")) {
            FoundPlugin::One { spec, .. } => Some(spec),
            _ => None,
        },
    }
}

impl Run<'_> {
    /// `executeCall` for a plugin: the statement's next call opened (so it is
    /// numbered, a `suspendAt` before it suspends, and a statement re-run
    /// hands back what it bound rather than invoking it again), then
    /// `executePluginCall`.
    pub(crate) async fn plugin_call(&self, written: &str, args: &[CallArg], scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Binding, Stop> {
        let event = self.begin_call_event().await?;
        if let Some(replayed) = &event.replayed {
            return Ok(replayed.value.clone().unwrap_or_else(|| Binding::Value(ValueBinding { value: Js::Undefined, trail: None, many: false })));
        }
        let bound = self.invoke_plugin(written, args, scope, at, path).await?;
        self.finish_call(&event, Some(&bound));
        Ok(bound)
    }

    /// `executePluginCall`: `args` are the call's named arguments, in the
    /// order written.
    pub(crate) async fn invoke_plugin(&self, written: &str, args: &[CallArg], scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Binding, Stop> {
        let registered = self.registered_plugin(written, scope);
        let declared = self.plugin_spec(&registered).and_then(|spec| spec.output.clone());
        // A plugin that declares no output runs as a statement,
        // for its effects, and binds nothing; the checker refuses its value.
        let for_effects = declared.is_none() && self.plugin_spec(&registered).is_some();
        if declared.is_none() && !for_effects {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{written}' declares no output, so there is nothing a call to it can hand back — the checker should have caught this"),
            )));
        }
        // Its arguments are by position, bound to its
        // parameters as the checker bound them.
        let bound = match self.plugin_spec(&registered) {
            Some(spec) if args.iter().any(|arg| arg.name().is_none()) => {
                let callable = spec.as_called();
                let bound = callable.bind_args(PluginCallSite::Plain, args);
                if !bound.misfits.is_empty() {
                    let positional = callable.positional_params(PluginCallSite::Plain);
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("{} — the checker should have caught this", bound.misfits[0].message(written, &positional)),
                    )));
                }
                Some(bound.args)
            }
            _ => None,
        };
        let args = bound.as_deref().unwrap_or(args);
        if args.first().is_some_and(|arg| arg.name().is_none()) {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{written}' is a plugin, and a plugin's arguments are named — the checker should have caught this"),
            )));
        }
        let mut config = JsObject::new();
        // A plugin fed only by an extraction runs on a record's fields, which a
        // stage handed it as the extracted context; a call hands it the record as its argument, on the same wire.
        let fed_record = self.plugin_spec(&registered).is_some_and(|spec| spec.fed_by_extraction == Some(true));
        let mut extracted_context = JsObject::new();
        let mut origins: Vec<u32> = Vec::new();
        for (position, arg) in args.iter().enumerate() {
            let Some(name) = arg.name() else { continue };
            let (value, trail) = match arg {
                // A plugin's parameters are values: a write is an effect, and
                // a function or a type is no value yet.
                CallArg::Write { .. } | CallArg::Closure { .. } | CallArg::Type { .. } => {
                    let kind = match arg {
                        CallArg::Write { .. } => "write",
                        CallArg::Closure { .. } => "closure",
                        _ => "type",
                    };
                    return Err(Stop::Thrown(Failure::unsupported(
                        &format!("a {kind} argument to the plugin '{written}'"),
                        "a plugin takes values — pass a field or an expression",
                    )));
                }
                CallArg::Expr { expr, .. } => {
                    let evaluated = self.evaluate_slot(expr, scope).await?;
                    (evaluated.value, self.trail_of(&evaluated.prov, scope).unwrap_or_default())
                }
                // `pluginArgValue` over `evaluateCallArg`: a value with its
                // trail; a record as the binding it is, with none.
                CallArg::Call { .. } | CallArg::Node { .. } => {
                    let bound = self.plugin_bound_arg(arg, scope, at, &format!("{path}/args/{position}")).await?;
                    match bound {
                        Binding::Value(value) => (value.value, value.trail.unwrap_or_default()),
                        record => (Js::Record(Rc::new(record)), Trail::default()),
                    }
                }
            };
            // A record reaches only an argument that takes structured data:
            // what that takes is the record's fields (`recordFields`).
            let value = match crate::record::binding_of(&value) {
                Some(record) => Js::object(crate::record::fields_of(&record).map_err(|e| Stop::Thrown(Failure::of_eval(e, "")))?),
                None => value,
            };
            if fed_record && name == EXTRACTED_RECORD_PARAM {
                if let Js::Object(record) = &value {
                    extracted_context = JsObject::clone_of(record);
                }
            } else {
                config.set(name.to_string(), value);
            }
            for origin in trail.origins {
                if !origins.contains(&origin) {
                    origins.push(origin);
                }
            }
        }
        // What the plugin brought back is no longer justified by the quote
        // that pointed at it: the origins survive, the direct citation not.
        let trail = Trail { origins, direct: None };
        let started = self.clock_now().await.map_err(Stop::Thrown)?;
        let result = self.invoke(&registered, &config, &extracted_context).await.map_err(Stop::Thrown)?;
        let duration = self.clock_now().await.map_err(Stop::Thrown)? - started;
        let mut misfit_note: Option<String> = None;
        let (binding, handed_back) = match declared {
            None => (Binding::Value(ValueBinding { value: Js::Undefined, trail: None, many: false }), false),
            Some(PluginOutput::Value { type_ }) => {
                let answered = declared_value(&result, &type_);
                let value = if matches!(answered, Js::Null) || fits(&answered, &type_) {
                    answered
                } else if let Some(converted) = text_as(&answered, &type_) {
                    converted
                } else {
                    // The 0.12 releases bound a misfit as they always had (a
                    // file's `data.value`, else the text), so a saved movement
                    // runs as written; the run notes it. Failing the call is
                    // a tightened rule, for the next compatibility key.
                    misfit_note = Some(misfit(written, &type_, &answered));
                    if matches!(type_, FieldType::Scalar(Scalar::File)) { answered } else { result.text().map_or(Js::Null, Js::str) }
                };
                let handed_back = !matches!(value, Js::Null);
                (Binding::Value(ValueBinding { value, trail: Some(trail), many: false }), handed_back)
            }
            // A record that may be none, and none was answered: absent, as
            // the checker typed it.
            Some(PluginOutput::Record { fields, maybe_absent: true }) => match maybe_absent_record(&result, &fields, &registered).map_err(Stop::Thrown)? {
                None => (Binding::Value(ValueBinding { value: Js::Null, trail: Some(trail), many: false }), false),
                Some(fields) => {
                    let handed_back = !fields.entries().is_empty();
                    (Binding::Node(Rc::new(RefCell::new(record_node(fields, &trail)))), handed_back)
                }
            },
            Some(PluginOutput::Record { .. }) => {
                let fields = record_fields(&result);
                let handed_back = !fields.entries().is_empty();
                (Binding::Node(Rc::new(RefCell::new(record_node(fields, &trail)))), handed_back)
            }
            // One record per thing the plugin found, in its order: the
            // landings a hop would give, so FIRST, MAP and a field read work
            // across them (`pluginCallBinding`). None found is the empty list.
            Some(PluginOutput::Records { .. }) => {
                let mut landings: Vec<Binding> = Vec::new();
                for record in &result.records {
                    // `{ ...record }`: every record is an object (`PluginResult::of`).
                    let Js::Object(object) = record else { unreachable!("PluginResult::of holds records to objects") };
                    let fields = JsObject::clone_of(object);
                    let field_order: Vec<String> = fields.entries().iter().map(|(k, _)| k.clone()).collect();
                    let field_provenance = field_order.iter().map(|name| (name.clone(), trail.clone())).collect();
                    landings.push(Binding::Node(Rc::new(RefCell::new(Node { fields, field_order, field_provenance, landed_on: None, edges: Vec::new(), resources: Vec::new() }))));
                }
                let handed_back = !landings.is_empty();
                (Binding::Positions(landings), handed_back)
            }
        };
        let mut entry = Members::default();
        entry.set("plugin", Js::str(registered.clone()));
        if let Some(Js::String(url)) = config.get("url") {
            entry.set("url", Js::str(crate::extract::emission::cut(url.as_str(), crate::extract::run::TRACE_URL_CHARS)));
        }
        entry.set("durationMs", Js::Number(duration));
        result.trace_into(&mut entry);
        entry.set("returned", Js::str(if handed_back { "value" } else { "absent" }));
        self.trace(TraceEntry::Plugin(entry));
        if let Some(message) = misfit_note {
            self.trace(TraceEntry::Warning { code: "MOVENG_PLUGIN_WARNING".into(), message });
        }
        for message in &result.warnings {
            self.trace(TraceEntry::Warning { code: "MOVENG_PLUGIN_WARNING".into(), message: message.clone() });
        }
        Ok(binding)
    }
}

impl Run<'_> {
    /// A plugin called inside an expression (a pure one, in a wait's WHERE,
    /// judged once per arrival): `args` by position, bound to its parameters
    /// in the order it declares them, and its value as it declares it. Timed
    /// and traced as a plain call is. A plugin whose output is a value or one
    /// record is called so; a list of records is read only off a bound name.
    ///
    /// A pure plugin on a host that keeps answers (`llm.transforms.answer`)
    /// is asked through it instead, as a listen's filter is: a host that
    /// could not ask it fails the evaluation `MOVENG_HOST_UNREACHABLE`,
    /// which a wait reads as an arrival it cannot judge yet.
    pub(crate) async fn expression_call(&self, written: &str, args: Vec<Js>, scope: &Scope) -> Result<Js, Failure> {
        let registered = self.registered_plugin(written, scope);
        let Some(spec) = self.plugin_spec(&registered) else {
            return Err(Failure::engine("MOVENG_RUNTIME", format!("'{written}' is no plugin the catalog holds — the checker should have caught this")));
        };
        let output = match spec.output.clone() {
            Some(output @ (PluginOutput::Value { .. } | PluginOutput::Record { .. })) => output,
            Some(PluginOutput::Records { .. }) | None => {
                return Err(Failure::unsupported(&format!("'{written}' inside an expression"), "a plugin called inside an expression hands back a value or one record; bind the records it answers first"));
            }
        };
        let mut values = Vec::with_capacity(args.len());
        for value in args {
            values.push(match crate::record::binding_of(&value) {
                Some(record) => Js::object(crate::record::fields_of(&record).map_err(|e| Failure::of_eval(e, ""))?),
                None => value,
            });
        }
        let started = self.clock_now().await?;
        let (answered, result) = match spec.pure() && self.serves(KEPT_ANSWERS) {
            true => (self.kept_answer(&registered, &values).await?, None),
            false => {
                let mut config = JsObject::new();
                for (name, value) in spec.as_called().positional_params(PluginCallSite::Plain).into_iter().zip(values) {
                    config.set(name.to_string(), value);
                }
                let result = self.invoke(&registered, &config, &JsObject::new()).await?;
                (expression_value(&result, &output, &registered)?, Some(result))
            }
        };
        let duration = self.clock_now().await? - started;
        let value = match &output {
            PluginOutput::Value { type_ } if !matches!(answered, Js::Null) && !fits(&answered, type_) => text_as(&answered, type_).unwrap_or(Js::Null),
            _ => answered,
        };
        let mut entry = Members::default();
        entry.set("plugin", Js::str(registered.clone()));
        entry.set("durationMs", Js::Number(duration));
        if let Some(result) = &result {
            result.trace_into(&mut entry);
        }
        entry.set("returned", Js::str(if matches!(value, Js::Null) { "absent" } else { "value" }));
        self.trace(TraceEntry::Plugin(entry));
        Ok(value)
    }

    /// A pure plugin's value for `args`, as its host keeps it.
    async fn kept_answer(&self, registered: &str, args: &[Js]) -> Result<Js, Failure> {
        let args = Json::Array(args.iter().map(crate::env::json_of_js).collect());
        let answer = self.ask(host::llm::transforms_answer(self.segment(), registered, args)).await?;
        match answer.as_ref().and_then(Json::as_object) {
            Some(answered) if answered.contains_key("value") => Ok(crate::env::js_of_json(&answered["value"])),
            Some(answered) if answered.get("unreachable").is_some_and(Json::is_string) => Err(Failure::engine(
                HOST_UNREACHABLE,
                format!("the host could not answer {registered} ({})", answered["unreachable"].as_str().unwrap_or_default()),
            )),
            _ => Err(Failure::host_answer("llm.transforms.answer", "{ value } or { unreachable }", &answer.as_ref().map_or(Js::Undefined, crate::env::js_of_json))),
        }
    }
}

/// The host method that keeps pure plugins' answers.
const KEPT_ANSWERS: &str = "llm.transforms.answer";

/// The code a plugin's answer the host could not get fails an evaluation
/// with: a wait leaves the arrival it was judging for later.
pub(crate) const HOST_UNREACHABLE: &str = "MOVENG_HOST_UNREACHABLE";

impl Run<'_> {
    /// Whether `failure` is a pure plugin's answer its host could not get.
    pub(crate) fn host_unreachable(failure: &Failure) -> bool {
        matches!(failure, Failure::Engine { class: crate::eval::ErrorClass::Engine(code), .. } if *code == HOST_UNREACHABLE)
    }
}

/// A `value` output's value: a plugin answers it as `data.value`, in its own
/// type; a text output may answer it as the text it fetched instead.
fn declared_value(result: &crate::extract::run::PluginResult, declared: &FieldType) -> Js {
    let data_value = match &result.data {
        Some(Js::Object(data)) => data.get("value").cloned().filter(|value| !value.is_nullish()),
        _ => None,
    };
    let text = result.text().map(Js::str);
    let first = if matches!(declared, FieldType::Scalar(Scalar::Text)) { text.or(data_value) } else { data_value.or(text) };
    first.unwrap_or(Js::Null)
}

/// A record a plugin answered: its text (under `text`), then `data`'s
/// entries. None answered is no field at all.
fn record_fields(result: &crate::extract::run::PluginResult) -> JsObject {
    let mut fields = JsObject::new();
    if let Some(text) = result.text() {
        fields.set(FETCHED_TEXT_FIELD.into(), Js::str(text));
    }
    if let Some(Js::Object(data)) = &result.data {
        for (key, value) in data.entries() {
            fields.set(key.clone(), value.clone());
        }
    }
    fields
}

fn record_node(fields: JsObject, trail: &Trail) -> Node {
    let field_order: Vec<String> = fields.entries().iter().map(|(k, _)| k.clone()).collect();
    let field_provenance = field_order.iter().map(|name| (name.clone(), trail.clone())).collect();
    Node { fields, field_order, field_provenance, landed_on: None, edges: Vec::new(), resources: Vec::new() }
}

/// A record that may be none, as the plugin answered it: none is an answer
/// with no `data` and no text (text alone is malformed); `data: {}` is a record whose fields are each absent,
/// which only a record whose fields may all be absent can be (otherwise the
/// answer is malformed, never silently none).
fn maybe_absent_record(result: &crate::extract::run::PluginResult, declared: &JsMap<SchemaFieldType>, plugin: &str) -> Result<Option<JsObject>, Failure> {
    let Some(Js::Object(data)) = &result.data else {
        if result.text().is_some() {
            return Err(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{plugin} answered text without `data` for a record that may be none: the host answered something malformed (a record is its `data` object; none is an answer with neither `data` nor text)"),
            ));
        }
        return Ok(None);
    };
    if data.entries().is_empty() {
        if let Some((name, _)) = declared.iter().find(|(_, type_)| !type_.admits_absent()) {
            return Err(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{plugin} answered an empty `data` for a record whose field {name} is required: the host answered something malformed (none is an answer with no `data`)"),
            ));
        }
    }
    Ok(Some(record_fields(result)))
}

/// What a plugin called inside an expression answers, as its output declares
/// it: a value, or a record's fields as a map (`null` where none was
/// answered), which a field read reads on.
fn expression_value(result: &crate::extract::run::PluginResult, output: &PluginOutput, registered: &str) -> Result<Js, Failure> {
    match output {
        PluginOutput::Value { type_ } => {
            let answered = declared_value(result, type_);
            Ok(if matches!(answered, Js::Null) || fits(&answered, type_) { answered } else { text_as(&answered, type_).unwrap_or(Js::Null) })
        }
        PluginOutput::Record { fields, maybe_absent: true } => maybe_absent_record(result, fields, registered).map(|record| record.map_or(Js::Null, Js::object)),
        PluginOutput::Record { .. } => Ok(Js::object(record_fields(result))),
        PluginOutput::Records { .. } => unreachable!("expression_call refuses a records output before it invokes"),
    }
}

/// Whether a plugin's value is of the type it declares, as the checker
/// typed the call's value.
fn fits(value: &Js, declared: &FieldType) -> bool {
    match declared {
        FieldType::Scalar(scalar) => match scalar {
            Scalar::Text | Scalar::Date | Scalar::Datetime => matches!(value, Js::String(_)),
            Scalar::Number => matches!(value, Js::Number(_)),
            Scalar::Boolean => matches!(value, Js::Bool(_)),
            Scalar::File => matches!(value, Js::File(_)),
            Scalar::Json => !matches!(value, Js::Undefined),
            Scalar::Absent => value.is_nullish(),
            Scalar::Never => false,
        },
        FieldType::Composite(composite) => match composite {
            Composite::List { of, .. } => matches!(value, Js::Array(list) if list.items().iter().all(|member| fits(member, of))),
            Composite::Tuple { of, rest } => match value {
                Js::Array(list) => {
                    let items = list.items();
                    let fixed = items.len() == of.len() || rest.is_some();
                    fixed && items.iter().zip(of).all(|(member, slot)| slot.as_ref().is_none_or(|slot| fits(member, slot)))
                }
                _ => false,
            },
            Composite::Dict { of, shape } => match value {
                Js::Object(object) => match shape {
                    Some(shape) => shape.iter().all(|(key, slot)| match (object.get(key), slot) {
                        (Some(member), Some(slot)) => fits(member, slot),
                        (None, Some(slot)) => fits(&Js::Null, slot),
                        (_, None) => true,
                    }),
                    None => object.entries().iter().all(|(_, member)| fits(member, of)),
                },
                _ => false,
            },
            Composite::Enum { options, open } => matches!(value, Js::String(text) if open.is_some() || options.iter().any(|o| o.as_str() == text.as_str())),
            Composite::MaybeAbsent { of } => value.is_nullish() || fits(value, of),
            Composite::Branded { of, .. } => fits(value, of),
            Composite::Union { of } => of.iter().any(|arm| fits(value, arm)),
            Composite::Record { .. } => matches!(value, Js::Object(_) | Js::Record(_)),
            Composite::Owned { .. } => matches!(value, Js::String(_)),
        },
    }
}

/// A text answered for a number or a boolean, read as one where it spells
/// one (`"0.8"`, `"true"`): what a plugin answering only text could say.
fn text_as(value: &Js, declared: &FieldType) -> Option<Js> {
    let Js::String(text) = value else { return None };
    let text = text.as_str();
    let text = text.trim();
    match declared {
        FieldType::Scalar(Scalar::Number) => text.parse::<f64>().ok().filter(|n| n.is_finite()).map(Js::Number),
        FieldType::Scalar(Scalar::Boolean) => match text {
            "true" => Some(Js::Bool(true)),
            "false" => Some(Js::Bool(false)),
            _ => None,
        },
        _ => None,
    }
}

/// What the run notes of a plugin whose value is not of the type it
/// declares, naming the plugin.
fn misfit(written: &str, declared: &FieldType, value: &Js) -> String {
    let declared = movement_parser::catalog::written_type::spell_field_type(declared);
    let printed: String = crate::js::json_stringify(value, 0).chars().take(80).collect();
    format!("'{written}' declares it hands back {declared}, and it handed back {} ({printed}); the value is bound as the 0.12 releases bind it", value.type_of())
}

#[cfg(test)]
mod keyed_by_module {
    use super::*;
    use movement_parser::catalog::packages::plugin_key;

    fn plugins() -> JsMap<PluginSpec> {
        let spec = |package: &str, name: &str| -> PluginSpec {
            serde_json::from_str(&format!(r#"{{"args":["text"],"priced":false,"package":"{package}","name":"{name}"}}"#)).unwrap()
        };
        [
            (plugin_key("@lf/pdf", "render"), spec("@lf/pdf", "render")),
            (plugin_key("@lf/web", "render"), spec("@lf/web", "render")),
            (plugin_key("@lf/web", "fetch_url"), spec("@lf/web", "fetch_url")),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn two_modules_may_each_serve_a_render() {
        let plugins = plugins();
        assert_eq!(spec_named(&plugins, "@lf/pdf/render").and_then(|s| s.package.as_deref()), Some("@lf/pdf"));
        assert_eq!(spec_named(&plugins, "@lf/web/render").and_then(|s| s.package.as_deref()), Some("@lf/web"));
    }

    #[test]
    fn a_bare_name_reaches_the_one_plugin_that_has_it_and_not_one_two_have() {
        let plugins = plugins();
        assert_eq!(spec_named(&plugins, "fetch-url").and_then(|s| s.package.as_deref()), Some("@lf/web"));
        assert!(spec_named(&plugins, "render").is_none());
    }
}
