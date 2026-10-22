//! The callback door's pages, for a person who opens a callback's `url` in a
//! browser, as the hosted door renders them (lf-platform
//! `interfaces/rest/callbacks.ts`).
//!
//! GET never fires. It renders a self-contained confirm page whose form POSTs
//! back; prefetch safety is the reason, and it is structural: the only
//! resolving verb is POST. A browser's form post wants a page back, and a
//! module or a server wants JSON: decided by what the caller asked for.

use crate::backend::CallbackRecord;
use crate::callbacks::CallOutcome;
use crate::http::{Response, header, query_pairs};
use crate::json::{Js, Obj};

/// GET `/api/cb/<id>`: the confirm page, or why there is nothing to confirm.
pub fn get(callback: Option<&CallbackRecord>) -> Response {
    let Some(callback) = callback else {
        return html(404, &message_page("This link is not valid", "Nothing here — the link may have been mistyped."));
    };
    if let Some((status, page)) = terminal_page(callback) {
        return html(status, &page);
    }
    html(200, &confirm_page(callback))
}

/// A form post from the confirm page wants a page back.
pub fn prefers_html(headers: &[(String, String)]) -> bool {
    let accept = header(headers, "accept").unwrap_or("");
    !accept.contains("application/json") && accept.contains("text/html")
}

/// The call's values: the query string's keys under the body's, the body a
/// JSON object or a urlencoded form. None when the body is neither.
pub fn call_values(headers: &[(String, String)], raw_body: &[u8], query: &str) -> Option<Obj> {
    let mut values: Obj = query_pairs(query).into_iter().map(|(k, v)| (k, Js::Str(v))).collect();
    if raw_body.is_empty() {
        return Some(values);
    }
    let form = header(headers, "content-type").is_some_and(|t| t.starts_with("application/x-www-form-urlencoded"));
    if form {
        let text = std::str::from_utf8(raw_body).ok()?;
        values.extend(query_pairs(text).into_iter().map(|(k, v)| (k, Js::Str(v))));
        return Some(values);
    }
    let Ok(Js::Obj(body)) = Js::parse(raw_body) else { return None };
    values.extend(body);
    Some(values)
}

/// The page a browser's POST is answered with.
pub fn answered(status: u16, outcome: &CallOutcome) -> Response {
    let page = match outcome {
        CallOutcome::Recorded { .. } => message_page("Done", "Thanks — that has been recorded and the workflow is carrying on."),
        CallOutcome::NotFound => message_page("This link is not valid", "Nothing here — the link may have been mistyped."),
        CallOutcome::Closed => message_page("This action was closed", "This is no longer open — it was already used, or the workflow it belonged to has finished. Nothing more is needed here."),
        CallOutcome::Expired => message_page("This action has expired", "This was only available for a limited time, and that window has passed."),
        CallOutcome::Mismatch(message) => message_page("That doesn't match what this action expects", message),
    };
    html(status, &page)
}

fn html(status: u16, page: &str) -> Response {
    Response { status, content_type: Some("text/html; charset=utf-8"), body: page.as_bytes().to_vec() }
}

/// A fired, revoked or expired callback renders the closed page, on GET as on POST.
fn terminal_page(callback: &CallbackRecord) -> Option<(u16, String)> {
    match callback.status.as_str() {
        "fired" => return Some((410, message_page("This action was closed", "This was already used. Nothing more is needed here."))),
        "revoked" => {
            return Some((410, message_page("This action was closed", "The workflow this belonged to has finished, so there is nothing left to do here.")));
        }
        _ => {}
    }
    let expired = callback.expires_at.as_deref().and_then(|at| at.parse::<jiff::Timestamp>().ok()).is_some_and(|at| at <= jiff::Timestamp::now());
    expired.then(|| (410, message_page("This action has expired", "This was only available for a limited time, and that window has passed.")))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn shell(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{}</title>\
<style>body{{font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.5}}\
h1{{font-size:1.25rem}}button{{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #d0d0d0;background:#111;color:#fff;cursor:pointer}}\
.muted{{color:#666}}form{{margin-top:1.5rem}}\
label{{display:block;margin-bottom:1rem}}label span{{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#888;margin-bottom:.25rem}}\
input,select,textarea{{font:inherit;width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #d0d0d0;border-radius:.5rem}}\
.actions{{margin-top:1.5rem}}</style></head><body>{body}</body></html>",
        escape(title)
    )
}

fn message_page(title: &str, detail: &str) -> String {
    shell(title, &format!("<h1>{}</h1><p class=\"muted\">{}</p>", escape(title), escape(detail)))
}

/// One control per declared parameter, in declaration order, so what the
/// page can submit and what the call accepts come from one declaration.
fn confirm_page(callback: &CallbackRecord) -> String {
    let action = format!("/api/cb/{}", escape(&callback.id));
    let params: Vec<(String, String)> = callback
        .params
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p.get("name")?.as_str()?.to_string(), p.get("type")?.as_str()?.to_string())))
        .collect();
    let intro = "<h1>Confirm this action</h1><p class=\"muted\">This carries on a workflow that is waiting on you.</p>";
    if params.is_empty() {
        return shell("Confirm", &format!("{intro}<form method=\"post\" action=\"{action}\"><button type=\"submit\">Confirm</button></form>"));
    }
    let fields: String = params.iter().map(|(name, kind)| control(name, kind)).collect();
    shell("Confirm", &format!("{intro}<form method=\"post\" action=\"{action}\">{fields}<div class=\"actions\"><button type=\"submit\">Confirm</button></div></form>"))
}

fn control(name: &str, kind: &str) -> String {
    let name = escape(name);
    let label = format!("<span>{name}</span>");
    let input = match kind {
        "boolean" => format!("<select name=\"{name}\"><option value=\"true\">Yes</option><option value=\"false\">No</option></select>"),
        "number" => format!("<input type=\"number\" step=\"any\" name=\"{name}\" required>"),
        "date" => format!("<input type=\"date\" name=\"{name}\" required>"),
        "datetime" => format!("<input type=\"datetime-local\" name=\"{name}\" required>"),
        "json" => format!("<textarea name=\"{name}\" rows=\"4\" required placeholder=\"{{ }}\"></textarea>"),
        // A file parameter is a handle the calling system owns.
        "file" => format!("<input type=\"text\" name=\"{name}\" required placeholder=\"supplied by the calling system\">"),
        _ => format!("<input type=\"text\" name=\"{name}\" required>"),
    };
    format!("<label>{label}{input}</label>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(status: &str, expires_at: Option<&str>, params: Js) -> CallbackRecord {
        CallbackRecord {
            id: "cb_abc".into(),
            team_id: String::new(),
            run_id: String::new(),
            address: String::new(),
            params,
            state: Js::Null,
            calls: Js::Arr(Vec::new()),
            single_use: true,
            expires_at: expires_at.map(str::to_string),
            status: status.into(),
        }
    }

    fn page(response: &Response) -> String {
        String::from_utf8(response.body.clone()).unwrap_or_default()
    }

    #[test]
    fn a_live_callback_renders_a_form_that_posts_back_one_control_per_parameter() {
        let params = Js::parse(br#"[{"name":"when","type":"date"},{"name":"note","type":"text"}]"#).unwrap_or(Js::Null);
        let shown = get(Some(&record("live", None, params)));
        assert_eq!(shown.status, 200);
        let html = page(&shown);
        assert!(html.contains("<form method=\"post\" action=\"/api/cb/cb_abc\">"));
        assert!(html.contains("<input type=\"date\" name=\"when\""));
        assert!(html.find("name=\"when\"") < html.find("name=\"note\""));
    }

    #[test]
    fn a_closed_expired_or_unknown_callback_renders_why() {
        assert_eq!(get(None).status, 404);
        assert_eq!(get(Some(&record("fired", None, Js::Null))).status, 410);
        assert_eq!(get(Some(&record("revoked", None, Js::Null))).status, 410);
        let expired = get(Some(&record("live", Some("2020-01-01T00:00:00.000Z"), Js::Null)));
        assert_eq!(expired.status, 410);
        assert!(page(&expired).contains("This action has expired"));
    }

    #[test]
    fn a_calls_values_are_the_bodys_over_the_querys() {
        let values = call_values(&[], br#"{"note":"body"}"#, "note=query&other=1").unwrap();
        assert_eq!(Js::Obj(values).to_json(), r#"{"note":"body","other":"1"}"#);
        assert!(call_values(&[], b"[1]", "").is_none());
        assert!(call_values(&[], b"not json", "").is_none());
        assert_eq!(call_values(&[], b"", "a=b").map(|v| Js::Obj(v).to_json()).as_deref(), Some(r#"{"a":"b"}"#));
    }

    #[test]
    fn a_form_body_is_read_as_values_over_the_query() {
        let headers = vec![("content-type".to_string(), "application/x-www-form-urlencoded".to_string())];
        let values = call_values(&headers, b"note=from+the+form", "note=q&x=1").unwrap_or_default();
        assert_eq!(values.get("note").and_then(Js::as_str), Some("from the form"));
        assert_eq!(values.get("x").and_then(Js::as_str), Some("1"));
        assert!(call_values(&[], b"note=x", "").is_none(), "a body that is neither JSON nor a declared form is refused");
    }
}
