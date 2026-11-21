//! What listen-fire answers the judge when a filter calls a pure plugin (a
//! host function, `team.isMember(m.`User Email`)`): each answer is kept by
//! its plugin and arguments, so a cached answer costs no call, until the
//! module says it changed (`plugins.invalidate`, adapter protocol 2.10) or
//! its age passes: the plugin's declared maximum age (`maxAgeSeconds`), and
//! never more than five minutes (`LONGEST_KEPT`). An answer the host could not
//! get is never kept: the arrival waits and is asked again.
//!
//! One cache per process: the door a module invalidates through and every
//! judgement in the process read the same answers.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use movement_engine::listen_judge::{PluginAnswer, PluginAnswers, PluginQuestion};
use movement_parser::catalog::plugin_args::PluginCallSite;
use movement_parser::catalog::types::{FieldType, PluginOutput, PluginSpec, Scalar};
use serde_json::Value as Json;

use crate::externals::{ModuleCall, RunningExternal, Unanswered};
use crate::json::Js;
use crate::secrets::Credentials;

/// The longest any answer is kept. An invalidation reaches only the process
/// that started the module (`listen-fire drain` beside a door process does
/// not hear it), so a kept answer that outlived its fact would let a
/// removed member's messages through for as long as it is kept.
pub const LONGEST_KEPT: Duration = Duration::from_secs(300);

/// The answers a process holds, by question.
#[derive(Default)]
pub struct AnswerCache {
    kept: HashMap<String, Kept>,
    /// Each plugin's maximum age, by catalog key, as its module declares
    /// it; one that declares none keeps its answers for `LONGEST_KEPT`.
    max_ages: HashMap<String, Duration>,
    /// Each plugin asked, by its module and the name it declares it under,
    /// to its catalog key: what the module names when it invalidates.
    served: HashMap<(String, String), String>,
    /// How often each plugin's answers were invalidated, by catalog key.
    invalidations: HashMap<String, u64>,
}

/// A judgement's questions as their asks begin: those no live answer is
/// kept for, and how often each plugin had been invalidated then. An
/// answer that comes back across an invalidation of its plugin may be the
/// one its module just said changed: it answers the judgement that asked,
/// and is not kept.
pub struct Asks {
    questions: Vec<PluginQuestion>,
    /// The questions to ask their modules, in order, each once.
    pub missing: Vec<PluginQuestion>,
    invalidations: HashMap<String, u64>,
}

struct Kept {
    plugin: String,
    value: Json,
    until: Instant,
}

impl AnswerCache {
    /// How long `plugin`'s answers are kept, as its module declares it now.
    pub fn keep_for(&mut self, plugin: &str, max_age: Option<Duration>) {
        match max_age {
            Some(age) => self.max_ages.insert(plugin.to_string(), age),
            None => self.max_ages.remove(plugin),
        };
    }

    /// `questions` as their asks begin (`Asks`).
    pub fn asks(&mut self, questions: &[PluginQuestion], now: Instant) -> Asks {
        let mut missing: Vec<PluginQuestion> = Vec::new();
        for question in questions {
            if self.live(question, now).is_none() && !missing.contains(question) {
                missing.push(question.clone());
            }
        }
        let invalidations = questions.iter().map(|question| (question.plugin.clone(), self.invalidations_of(&question.plugin))).collect();
        Asks { questions: questions.to_vec(), missing, invalidations }
    }

    /// An answer to each of `asks`' questions: the one kept, else what `ask`
    /// answers, kept when it is a value and its plugin was not invalidated
    /// since the asks began.
    pub fn answers(&mut self, asks: &Asks, mut ask: impl FnMut(&PluginQuestion) -> PluginAnswer, now: Instant) -> PluginAnswers {
        let mut answers = PluginAnswers::default();
        for question in &asks.questions {
            if answers.get(question).is_some() {
                continue;
            }
            let answer = match self.live(question, now) {
                Some(value) => PluginAnswer::Value(value),
                None => {
                    let answer = ask(question);
                    let unchanged = asks.invalidations.get(&question.plugin).is_some_and(|then| *then == self.invalidations_of(&question.plugin));
                    if let PluginAnswer::Value(value) = &answer
                        && unchanged
                    {
                        let age = self.max_ages.get(&question.plugin).map_or(LONGEST_KEPT, |age| (*age).min(LONGEST_KEPT));
                        self.kept.insert(question.key(), Kept { plugin: question.plugin.clone(), value: value.clone(), until: now + age });
                    }
                    answer
                }
            };
            answers.insert(question, answer);
        }
        answers
    }

    fn invalidations_of(&self, plugin: &str) -> u64 {
        self.invalidations.get(plugin).copied().unwrap_or_default()
    }

    /// `plugin` is served by `module`, which declares it as `declared`.
    pub fn served_as(&mut self, plugin: &str, module: &str, declared: &str) {
        self.served.insert((module.to_string(), declared.to_string()), plugin.to_string());
    }

    /// `invalidate`, the plugin named as its module declares it. One never
    /// asked has nothing kept to forget.
    pub fn invalidate_declared(&mut self, module: &str, declared: &str, args: Option<&[Json]>) {
        if let Some(plugin) = self.served.get(&(module.to_string(), declared.to_string())).cloned() {
            self.invalidate(&plugin, args);
        }
    }

    /// Forget `plugin`'s answer for `args`, or every answer of it when
    /// `args` is None.
    pub fn invalidate(&mut self, plugin: &str, args: Option<&[Json]>) {
        *self.invalidations.entry(plugin.to_string()).or_default() += 1;
        match args {
            Some(args) => {
                self.kept.remove(&PluginQuestion { plugin: plugin.to_string(), args: args.to_vec() }.key());
            }
            None => self.kept.retain(|_, kept| kept.plugin != plugin),
        }
    }

    /// The value kept for `question`, while it lives; an expired one is dropped.
    fn live(&mut self, question: &PluginQuestion, now: Instant) -> Option<Json> {
        let key = question.key();
        let kept = self.kept.get(&key)?;
        if now >= kept.until {
            self.kept.remove(&key);
            return None;
        }
        Some(kept.value.clone())
    }
}

thread_local! {
    static ANSWERS: RefCell<AnswerCache> = RefCell::new(AnswerCache::default());
}

/// The process's cache, borrowed for `f` alone: never across an await.
pub fn with_cache<T>(f: impl FnOnce(&mut AnswerCache) -> T) -> T {
    ANSWERS.with(|cache| f(&mut cache.borrow_mut()))
}

/// The plugin modules a process asks its host functions of.
#[derive(Clone, Copy)]
pub struct HostFunctions<'a> {
    pub running: &'a [Rc<RunningExternal>],
    pub credentials: &'a Credentials,
    pub tenant: &'a str,
}

/// A module that answered a question with an error of its own: no host
/// trouble, so nothing waits for it to come back.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub plugin: String,
    pub why: String,
}

/// The host functions a judgement asks: the plugin modules of a process,
/// or a test's.
// listen-fire runs on one thread, so no caller needs the future to be Send.
#[allow(async_fn_in_trait)]
pub trait AnswersHost {
    /// An answer to each of `questions`, or the first a module refused.
    async fn answer(&self, questions: &[PluginQuestion]) -> Result<PluginAnswers, Refused>;
}

impl AnswersHost for HostFunctions<'_> {
    /// The answer kept for each question, else its module's. A module's own
    /// error is no answer: nothing is kept for it.
    async fn answer(&self, questions: &[PluginQuestion]) -> Result<PluginAnswers, Refused> {
        let now = Instant::now();
        let asks = with_cache(|cache| {
            for question in questions {
                let Some((running, declared, spec)) = self.target(&question.plugin) else { continue };
                cache.served_as(&question.plugin, &running.external.manifest.name, &declared);
                cache.keep_for(&question.plugin, spec.max_age_seconds.map(|seconds| Duration::from_secs(u64::from(seconds))));
            }
            cache.asks(questions, now)
        });
        let mut fetched: HashMap<String, PluginAnswer> = HashMap::new();
        for question in &asks.missing {
            fetched.insert(question.key(), self.ask(question).await?);
        }
        Ok(with_cache(|cache| cache.answers(&asks, |question| fetched.remove(&question.key()).unwrap_or_else(|| PluginAnswer::Unreachable("it was not asked".into())), now)))
    }
}

impl HostFunctions<'_> {
    /// One question, asked of the module that serves its plugin
    /// (`invokePlugin`): its arguments bound to the plugin's parameters by
    /// position, as a call in a program binds them.
    pub async fn ask(&self, question: &PluginQuestion) -> Result<PluginAnswer, Refused> {
        let refused = |why: String| Err(Refused { plugin: question.plugin.clone(), why });
        let (running, declared, spec) = match crate::externals::plugin_target(self.running, &question.plugin) {
            Ok(Some((running, declared))) => match spec_of(running, &declared) {
                Some(spec) => (running, declared, spec),
                None => return refused(format!("module {} declares {declared} in a form listen-fire does not read", running.external.manifest.name)),
            },
            Ok(None) => return Ok(PluginAnswer::Unreachable("no plugin module in this project serves it".into())),
            Err(why) => return refused(why),
        };
        let config: serde_json::Map<String, Json> = spec.as_called().positional_params(PluginCallSite::Plain).into_iter().map(str::to_string).zip(question.args.iter().cloned()).collect();
        let params = serde_json::json!({ "name": declared, "config": config, "extractedContext": {} });
        let credential = crate::secrets::credential_for(self.credentials, &running.external.manifest.name);
        let call = ModuleCall { credentials: self.credentials, credential, tenant: self.tenant, method: "invokePlugin", params, settings: None };
        match crate::externals::rpc_reaching(running, call).await {
            Ok(answer) => match value_of(&answer, &spec) {
                Ok(value) => Ok(PluginAnswer::Value(value)),
                Err(why) => refused(why),
            },
            Err(Unanswered::Unreachable(why)) => Ok(PluginAnswer::Unreachable(why)),
            Err(Unanswered::Refused(why)) => refused(why),
        }
    }

    /// The module serving `plugin`, the name it declares it under, and its spec.
    fn target(&self, plugin: &str) -> Option<(&RunningExternal, String, PluginSpec)> {
        let (running, declared) = crate::externals::plugin_target(self.running, plugin).ok()??;
        let spec = spec_of(running, &declared)?;
        Some((running, declared, spec))
    }
}

/// The spec `running` declares its plugin `declared` with, as the catalog reads it.
fn spec_of(running: &RunningExternal, declared: &str) -> Option<PluginSpec> {
    let (_, spec) = crate::externals::plugin_entries(running.plugins.as_ref()).into_iter().find(|(name, _)| name == declared)?;
    serde_json::from_str(&spec.to_json()).ok()
}

/// A plugin's value in its answer, as a run reads it: `data.value`, or the
/// text it answered (first, for a plugin declaring a text value). A record
/// is its text (as `text`) plus `data`'s entries. A record that may be none
/// is none when the answer has no `data` and no text (text alone, or a
/// `data` that is not an object, is malformed); `data: {}` is a record whose
/// fields are each absent, which only a record whose fields may all be
/// absent can be: otherwise the answer is malformed.
fn value_of(answer: &Js, spec: &PluginSpec) -> Result<Json, String> {
    if let Some(PluginOutput::Record { fields, maybe_absent }) = &spec.output {
        let data = match answer.get("data").map(crate::wire::json_of_js) {
            Some(Json::Object(data)) => Some(data),
            Some(Json::Null) | None => None,
            Some(other) if *maybe_absent => return Err(format!("it answered a `data` that is not an object ({other}); a record is an object, and none is an answer with no `data`")),
            Some(_) => None,
        };
        if *maybe_absent && data.is_none() {
            if answer.get("text").and_then(Js::as_str).is_some() {
                return Err("it answered text without `data`; a record is its `data` object, and none is an answer with neither `data` nor text".into());
            }
            return Ok(Json::Null);
        }
        let mut record = serde_json::Map::new();
        if let Some(text) = answer.get("text").and_then(Js::as_str) {
            record.insert("text".into(), Json::String(text.to_string()));
        }
        if let Some(data) = data {
            if data.is_empty() && *maybe_absent {
                if let Some((name, _)) = fields.iter().find(|(_, type_)| !type_.admits_absent()) {
                    return Err(format!("it answered an empty `data` for a record whose field {name} is required; none is an answer with no `data`"));
                }
            }
            record.extend(data);
        }
        return Ok(Json::Object(record));
    }
    let data_value = answer.get("data").and_then(|data| data.get("value")).filter(|value| !matches!(value, Js::Null)).map(crate::wire::json_of_js);
    let text = answer.get("text").and_then(Js::as_str).map(|text| Json::String(text.to_string()));
    let declares_text = matches!(&spec.output, Some(PluginOutput::Value { type_: FieldType::Scalar(Scalar::Text) }));
    let first = if declares_text { text.or(data_value) } else { data_value.or(text) };
    Ok(first.unwrap_or(Json::Null))
}

/// The path segment of the door a module invalidates through
/// (`/api/public/adapter/<module>/plugins`, adapter protocol 2.10).
pub const DOOR_VERB: &str = "plugins";

/// The plugins door's answer to `body` from `module`: `{ method:
/// "plugins.invalidate", params: { plugin, args? } }`, the plugin named as
/// the module declares it, and `args` (absent: every answer of it) as a
/// program passes them, by position. The caller has checked the host token.
pub fn answer(module: &str, body: &Js) -> (u16, Js) {
    let refuse = |status: u16, error: &str, message: String| (status, Js::Obj(crate::obj! { "error" => Js::str(error), "message" => Js::Str(message) }));
    match body.get("method").and_then(Js::as_str) {
        Some("plugins.invalidate") => {}
        other => return refuse(400, "bad_request", format!("{}: the plugins door serves plugins.invalidate", other.unwrap_or("no method"))),
    }
    let params = body.get("params");
    let Some(plugin) = params.and_then(|p| p.get("plugin")).and_then(Js::as_str) else {
        return refuse(400, "bad_request", "plugins.invalidate names its plugin: { plugin, args? }".into());
    };
    let args = match params.and_then(|p| p.get("args")) {
        None | Some(Js::Null) => None,
        Some(Js::Arr(args)) => Some(args.iter().map(crate::wire::json_of_js).collect::<Vec<_>>()),
        Some(_) => return refuse(400, "bad_request", "plugins.invalidate's args are a list, as a call passes them".into()),
    };
    with_cache(|cache| cache.invalidate_declared(module, plugin, args.as_deref()));
    (200, Js::Obj(crate::obj! { "result" => Js::Null }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(email: &str) -> PluginQuestion {
        PluginQuestion { plugin: "@lf-platform/team/isMember".into(), args: vec![Json::String(email.into())] }
    }

    /// An asker that answers true, counting each question it is asked.
    fn counting(asked: &RefCell<Vec<String>>) -> impl FnMut(&PluginQuestion) -> PluginAnswer + '_ {
        |question| {
            asked.borrow_mut().push(question.key());
            PluginAnswer::Value(Json::Bool(true))
        }
    }

    /// `questions` answered at `now`, asked and answered with nothing between.
    fn answered(cache: &mut AnswerCache, questions: &[PluginQuestion], ask: impl FnMut(&PluginQuestion) -> PluginAnswer, now: Instant) -> PluginAnswers {
        let asks = cache.asks(questions, now);
        cache.answers(&asks, ask, now)
    }

    fn missing(cache: &mut AnswerCache, questions: &[PluginQuestion], now: Instant) -> Vec<PluginQuestion> {
        cache.asks(questions, now).missing
    }

    #[test]
    fn a_record_answer_is_its_fields_and_none_answered_is_no_record() {
        let spec: PluginSpec = serde_json::from_value(serde_json::json!({
            "args": ["e"], "priced": false, "pure": true,
            "output": { "kind": "record", "fields": { "Level": { "kind": "enum", "options": ["read", "admin"] } }, "maybeAbsent": true }
        }))
        .unwrap();
        let answer = |json: Json| value_of(&crate::wire::js_of_json(&json), &spec).unwrap();
        assert_eq!(answer(serde_json::json!({ "data": { "Id": "U1", "Level": "admin" } })), serde_json::json!({ "Id": "U1", "Level": "admin" }));
        assert_eq!(answer(serde_json::json!({ "data": null })), Json::Null);
        assert_eq!(answer(serde_json::json!({})), Json::Null);
    }

    #[test]
    fn a_text_only_or_non_object_data_answer_for_a_record_that_may_be_none_is_malformed() {
        let spec: PluginSpec = serde_json::from_value(serde_json::json!({
            "args": ["e"], "priced": false, "pure": true,
            "output": { "kind": "record", "fields": { "Level": { "kind": "enum", "options": ["read", "admin"] } }, "maybeAbsent": true }
        }))
        .unwrap();
        for malformed in [
            serde_json::json!({ "text": "ignored" }),
            serde_json::json!({ "data": "admin" }),
            serde_json::json!({ "data": 3 }),
            serde_json::json!({ "data": ["admin"] }),
            serde_json::json!({ "data": null, "text": "ignored" }),
        ] {
            let why = value_of(&crate::wire::js_of_json(&malformed), &spec).unwrap_err();
            assert!(why.contains("malformed") || why.contains("text") || why.contains("object"), "{malformed}: {why}");
        }
    }

    #[test]
    fn an_empty_data_is_a_record_of_absent_fields_or_malformed() {
        let spec = |fields: Json| -> PluginSpec {
            serde_json::from_value(serde_json::json!({ "args": ["e"], "priced": false, "pure": true, "output": { "kind": "record", "fields": fields, "maybeAbsent": true } })).unwrap()
        };
        let empty = crate::wire::js_of_json(&serde_json::json!({ "data": {} }));
        let optional = spec(serde_json::json!({ "Nickname": { "kind": "maybeAbsent", "of": "text" } }));
        assert_eq!(value_of(&empty, &optional), Ok(serde_json::json!({})));
        let required = spec(serde_json::json!({ "Level": "text" }));
        let why = value_of(&empty, &required).unwrap_err();
        assert!(why.contains("empty `data`") && why.contains("Level"), "{why}");
    }

    #[test]
    fn a_cached_answer_asks_no_plugin() {
        let mut cache = AnswerCache::default();
        let asked = RefCell::new(Vec::new());
        let now = Instant::now();
        let first = answered(&mut cache, &[member("a@acme.com")], counting(&asked), now);
        assert_eq!(first.get(&member("a@acme.com")), Some(&PluginAnswer::Value(Json::Bool(true))));
        let again = answered(&mut cache, &[member("a@acme.com")], counting(&asked), now + Duration::from_secs(299));
        assert_eq!(again.get(&member("a@acme.com")), Some(&PluginAnswer::Value(Json::Bool(true))));
        assert_eq!(asked.borrow().len(), 1, "the second judgement read the kept answer");
        assert_eq!(missing(&mut cache, &[member("a@acme.com"), member("b@acme.com")], now), [member("b@acme.com")]);
        // An answer the host could not get is never kept.
        let unreachable = answered(&mut cache, &[member("b@acme.com")], |_| PluginAnswer::Unreachable("connection refused".into()), now);
        assert_eq!(unreachable.get(&member("b@acme.com")), Some(&PluginAnswer::Unreachable("connection refused".into())));
        assert_eq!(missing(&mut cache, &[member("b@acme.com")], now), [member("b@acme.com")], "asked again next time");
    }

    #[test]
    fn an_answer_expires_after_its_maximum_age() {
        let mut cache = AnswerCache::default();
        cache.keep_for("@lf-platform/team/isMember", Some(Duration::from_secs(60)));
        let asked = RefCell::new(Vec::new());
        let now = Instant::now();
        answered(&mut cache, &[member("a@acme.com")], counting(&asked), now);
        answered(&mut cache, &[member("a@acme.com")], counting(&asked), now + Duration::from_secs(59));
        assert_eq!(asked.borrow().len(), 1, "within its age");
        answered(&mut cache, &[member("a@acme.com")], counting(&asked), now + Duration::from_secs(60));
        assert_eq!(asked.borrow().len(), 2, "asked again once its age passed");
    }

    /// An invalidation reaches only the process that started the module, so
    /// no answer outlives five minutes, whatever its plugin declares.
    #[test]
    fn an_answer_lives_at_most_five_minutes_without_a_declared_age() {
        let asked = RefCell::new(Vec::new());
        let now = Instant::now();
        for declared in [None, Some(Duration::from_secs(3600))] {
            let mut cache = AnswerCache::default();
            cache.keep_for("@lf-platform/team/isMember", declared);
            asked.borrow_mut().clear();
            answered(&mut cache, &[member("a@acme.com")], counting(&asked), now);
            answered(&mut cache, &[member("a@acme.com")], counting(&asked), now + Duration::from_secs(299));
            assert_eq!(asked.borrow().len(), 1, "{declared:?}: kept within five minutes");
            answered(&mut cache, &[member("a@acme.com")], counting(&asked), now + Duration::from_secs(300));
            assert_eq!(asked.borrow().len(), 2, "{declared:?}: asked again at five minutes");
        }
    }

    #[test]
    fn invalidate_clears_one_argument_or_the_whole_plugin() {
        let mut cache = AnswerCache::default();
        let asked = RefCell::new(Vec::new());
        let now = Instant::now();
        let other = PluginQuestion { plugin: "@lf-platform/team/userFor".into(), args: vec![Json::String("a@acme.com".into())] };
        let all = [member("a@acme.com"), member("b@acme.com"), other.clone()];
        answered(&mut cache, &all, counting(&asked), now);
        cache.invalidate("@lf-platform/team/isMember", Some(&[Json::String("a@acme.com".into())]));
        assert_eq!(missing(&mut cache, &all, now), [member("a@acme.com")], "one argument's answer");
        answered(&mut cache, &all, counting(&asked), now);
        cache.invalidate("@lf-platform/team/isMember", None);
        assert_eq!(missing(&mut cache, &all, now), [member("a@acme.com"), member("b@acme.com")], "every answer of the plugin, and no other plugin's");
        // As a module names it: by the name it declares.
        answered(&mut cache, &all, counting(&asked), now);
        cache.served_as("@lf-platform/team/isMember", "team", "isMember");
        cache.invalidate_declared("team", "isMember", Some(&[Json::String("b@acme.com".into())]));
        cache.invalidate_declared("other", "isMember", None);
        assert_eq!(missing(&mut cache, &all, now), [member("b@acme.com")], "another module's plugin of the name is not this one");
    }

    /// A module says its answers changed while a question of it is being
    /// asked: the answer that comes back may be the one it said changed, so
    /// it is not kept, and the next judgement asks again.
    #[test]
    fn an_answer_asked_across_an_invalidation_is_not_kept() {
        let mut cache = AnswerCache::default();
        let now = Instant::now();
        let questions = [member("a@acme.com")];
        let asks = cache.asks(&questions, now);
        assert_eq!(asks.missing, questions);
        cache.invalidate("@lf-platform/team/isMember", None);
        let answers = cache.answers(&asks, |_| PluginAnswer::Value(Json::Bool(true)), now);
        assert_eq!(answers.get(&member("a@acme.com")), Some(&PluginAnswer::Value(Json::Bool(true))), "it answers the judgement that asked");
        assert_eq!(missing(&mut cache, &questions, now), questions, "and is not kept");
        // Asked again with nothing between, it is kept.
        answered(&mut cache, &questions, |_| PluginAnswer::Value(Json::Bool(true)), now);
        assert!(missing(&mut cache, &questions, now).is_empty(), "kept");
    }

    #[test]
    fn the_door_refuses_what_is_not_an_invalidation() {
        let ask = |body: &str| answer("team", &Js::parse(body.as_bytes()).unwrap()).0;
        assert_eq!(ask(r#"{"method":"plugins.invalidate","params":{"plugin":"isMember","args":["a@acme.com"]}}"#), 200);
        assert_eq!(ask(r#"{"method":"plugins.invalidate","params":{"plugin":"isMember"}}"#), 200);
        assert_eq!(ask(r#"{"method":"plugins.forget","params":{"plugin":"isMember"}}"#), 400);
        assert_eq!(ask(r#"{"method":"plugins.invalidate","params":{"args":[]}}"#), 400);
        assert_eq!(ask(r#"{"method":"plugins.invalidate","params":{"plugin":"isMember","args":"a@acme.com"}}"#), 400);
    }
}
