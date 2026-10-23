//! A record a library movement returns keeps the system it was read from:
//! the caller acts on it through that system's connection, whatever either
//! file calls its own connection.

use super::test_time::block_on;
use super::*;

/// One adapter, `chat`: channels (a collection) each with a writable
/// `Messages` edge. Two credentials reach it, each its own workspace.
fn catalog(library: &str) -> Catalog {
    let schema = r#"{
      "positions": {
        "Channel": { "properties": { "Name": "text" }, "edges": { "Messages": { "target": "Message", "writable": true } } },
        "Message": { "properties": { "Text": "text" }, "edges": {} }
      },
      "collections": { "Channels": { "target": "Channel" } },
      "eventPosition": "Message",
      "supportsInPlaceUpdate": true,
      "createShapes": { "Message": { "fields": { "Text": "text" }, "resultShape": { "externalId": "text", "Text": "text" } } }
    }"#;
    let json = format!(
        r#"{{
      "adapters": {{ "chat": {{
        "constructionArgs": [{{ "kind": "credential", "name": "credentials", "required": true }}],
        "canFire": true, "triggerConfig": ["events"],
        "schemas": {{ "team": {schema}, "other": {schema} }}
      }} }},
      "credentials": {{ "team": {{ "adapters": ["chat"] }}, "other": {{ "adapters": ["chat"] }} }},
      "plugins": {{}},
      "files": {{ "lib/channels": {{ "source": {library} }} }}
    }}"#,
        library = serde_json::to_string(library).unwrap()
    );
    Catalog::from_json(&json).unwrap()
}

/// The library connects `chat` as `slack_a` and returns its `#general`.
fn library(credential: &str) -> String {
    format!(
        "import {{ chat }} from adapters\nimport {{ {credential} }} from credentials\nslack_a = connect chat using {credential}\nexport function general() {{\n  ch = only(slack_a-[c:Channels WHERE c.Name == \"general\"]->)\n  return ch\n}}\n"
    )
}

/// The caller connects the same adapter as `slack_b` and acts on what the
/// library returned.
fn caller(credential: &str, body: &str) -> String {
    caller_naming("slack_b", credential, body)
}

fn caller_naming(connection: &str, credential: &str, body: &str) -> String {
    format!(
        "import {{ chat }} from adapters\nimport {{ {credential} }} from credentials\nimport {{ general }} from \"lib/channels\"\n{connection} = connect chat using {credential}\nfunction m(msg: <{connection}-[:Message]->>) {{\n  ch = general()\n  if (ch == null) {{ fail(\"no general\") }}\n{body}}}\nlisten to {connection} {{ events: [\"message\"] }} fire m\n"
    )
}

/// Each instance is named by the credential it was resolved with, so a call
/// says which workspace it went to.
#[derive(Default)]
struct Chat {
    calls: Vec<(String, String, Data)>,
}

impl Adapters for Chat {
    fn resolve(&mut self, request: AdapterRequest) -> HostFuture<AdapterInstance> {
        assert_eq!(request.adapter_type, "chat");
        let id = format!("chat:{}", request.credentials_id.unwrap_or_default());
        ready(Ok(AdapterInstance { id, methods: ["createRecord", "updateRecord", "resolveEntity", "getRelated", "getFieldValue", "describe"].map(String::from).to_vec() }))
    }

    fn call(&mut self, call: AdapterCall) -> HostFuture<AdapterReply> {
        self.calls.push((call.instance.clone(), call.method.clone(), call.args.clone()));
        let workspace = call.instance.trim_start_matches("chat:").to_string();
        ready(Ok(match call.method.as_str() {
            "getRelated" => AdapterReply::ok(Data::List(vec![Data::map([(
                "position",
                Data::map([
                    ("recordType", Data::text("Channel")),
                    ("identity", Data::map([("kind", Data::text("stable")), ("recordId", Data::text(format!("{workspace}-general"))), ("data", Data::map([("Name", Data::text("general"))]))])),
                ]),
            )])])),
            "getFieldValue" => {
                let field = call.args.get("fieldId").and_then(Data::as_text).unwrap_or_default().to_string();
                let data = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                AdapterReply::ok(data.and_then(|d| d.get(&field).cloned()).unwrap_or(Data::Null))
            }
            "describe" => AdapterReply::ok(Data::Null),
            "resolveEntity" => AdapterReply::ok(Data::map([("candidates", Data::List(Vec::new()))])),
            "createRecord" | "updateRecord" => {
                let record_type = call.args.get("recordType").and_then(Data::as_text).unwrap_or("Channel").to_string();
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                AdapterReply::ok(Data::map([("adapterType", Data::text("chat")), ("externalId", Data::text(format!("{workspace}-written"))), ("recordType", Data::text(record_type)), ("data", fields)]))
            }
            other => AdapterReply::error("adapter_error", format!("chat does not answer {other}")),
        }))
    }
}

impl Chat {
    /// The writes made, each with the instance (so the workspace) it went to.
    fn writes(&self) -> Vec<(&str, &str, Data)> {
        self.calls
            .iter()
            .filter(|(_, method, _)| method == "createRecord" || method == "updateRecord")
            .map(|(instance, method, args)| (instance.as_str(), method.as_str(), args.clone()))
            .collect()
    }
}

fn run_with(library_credential: &str, caller_credential: &str, body: &str) -> (Result<Outcome, EmbedError>, Chat) {
    run_source(library_credential, caller(caller_credential, body))
}

fn run_source(library_credential: &str, source: String) -> (Result<Outcome, EmbedError>, Chat) {
    let input = input(library_credential, source);
    let mut chat = Chat::default();
    let outcome = block_on(run(&mut Hosts::new().adapters(&mut chat), &input));
    (outcome, chat)
}

fn input(library_credential: &str, source: String) -> RunInput {
    let catalog = catalog(&library(library_credential));
    let problems: Vec<Problem> = check(&source, &catalog, LANGUAGE_VERSION).into_iter().filter(|p| p.severity == Severity::Error).collect();
    assert_eq!(problems, vec![], "{source}");
    let event = Event::new("chat", Data::map([("Text", Data::text("hello"))])).of_type("message").about("Message", "m1");
    RunInput::new(source, event, "2026-03-12T12:00:00.000Z").function("m").catalog(catalog)
}

fn finished(outcome: Result<Outcome, EmbedError>) -> RunResult {
    match outcome.unwrap() {
        Outcome::Finished(ran) => ran,
        other => panic!("not finished: {other:?}"),
    }
}

const POST: &str = "  write ch-[:Messages]-> { Text: \"hi\" }\n";

#[test]
fn a_linked_write_under_a_returned_record_goes_to_the_system_it_came_from() {
    let (outcome, chat) = run_with("team", "team", POST);
    finished(outcome);
    let writes = chat.writes();
    let [(instance, "createRecord", args)] = writes.as_slice() else { panic!("{:?}", chat.calls) };
    assert_eq!(*instance, "chat:team");
    assert_eq!(args.get("recordType").and_then(Data::as_text), Some("Message"));
}

#[test]
fn an_update_of_a_returned_record_goes_to_the_system_it_came_from() {
    let (outcome, chat) = run_with("team", "team", "  write ch { Name: \"general-2\" }\n");
    finished(outcome);
    let writes = chat.writes();
    let [(instance, "updateRecord", args)] = writes.as_slice() else { panic!("{:?}", chat.calls) };
    assert_eq!(*instance, "chat:team");
    assert_eq!(args.get("externalId").and_then(Data::as_text), Some("team-general"));
}

/// The library reads with its own credential; the record lives in that
/// workspace, so the write goes there too, not to the caller's.
#[test]
fn a_returned_record_read_with_another_credential_is_written_through_that_credential() {
    let (outcome, chat) = run_with("other", "team", POST);
    finished(outcome);
    let writes = chat.writes();
    let [(instance, "createRecord", _)] = writes.as_slice() else { panic!("{:?}", chat.calls) };
    assert_eq!(*instance, "chat:other");
}

/// The caller's connection sharing the library's name is no evidence it is
/// the same system: the record still goes back to the workspace it was read
/// from.
#[test]
fn a_caller_connection_of_the_same_name_does_not_capture_a_returned_record() {
    let (outcome, chat) = run_source("other", caller_naming("slack_a", "team", POST));
    finished(outcome);
    let writes = chat.writes();
    let [(instance, "createRecord", _)] = writes.as_slice() else { panic!("{:?}", chat.calls) };
    assert_eq!(*instance, "chat:other");
}

/// A park holds the returned record's system, not the library's name for
/// it: the resume, in the caller's scope, writes to the same workspace.
#[test]
fn a_returned_record_parked_and_resumed_still_goes_to_the_system_it_came_from() {
    for connection in ["slack_b", "slack_a"] {
        let input = input("other", caller_naming(connection, "team", &format!("  await sleep(1h)\n{POST}")));
        let (mut chat, mut parks) = (Chat::default(), super::end_to_end::Parks::default());
        let parked = block_on(run(&mut Hosts::new().adapters(&mut chat).store(&mut parks), &input)).unwrap();
        assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
        let timer = parks.timers.remove(0);
        let resumed = block_on(resume(&mut Hosts::new().adapters(&mut chat).store(&mut parks), &input, &timer.state, Wake::Timer)).unwrap();
        assert!(matches!(resumed, Outcome::Finished(_)), "{connection}: {resumed:?}");
        let writes = chat.writes();
        let [(instance, "createRecord", _)] = writes.as_slice() else { panic!("{:?}", chat.calls) };
        assert_eq!(*instance, "chat:other", "{connection}");
    }
}
