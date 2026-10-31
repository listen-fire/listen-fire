//! Arrivals as modules report them (adapter protocol 2.5, and 2.6 for root
//! edges, carried parents and listens): what landed on a listenable edge,
//! read off a module's answer about an inbound delivery
//! (`preprocessInbound`, `checkInbound`'s acceptance) or a push to the `wake`
//! door. One naming the record it landed on is logged, and a `wake_await` row
//! queued for each wait parked there (crate::waits); one that landed is
//! judged against the listens on its edge (crate::routing::Listen::fires).

use crate::backend::RunHostStore;
use crate::json::{Js, Obj};
use crate::obj;
use crate::store::iso;
use crate::waits::NewArrival;

/// One arrival as its module reported it.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrivalIn {
    pub edge: String,
    /// The record whose edge it landed on; None on one of the connection's
    /// root edges, which no wait is on.
    pub key: Option<String>,
    /// What the edge declares names an arrival; None for a gone one.
    pub identity: Option<String>,
    pub version: Option<String>,
    /// `{ recordId?, recordType?, fields }`; None for a gone one.
    pub landing: Option<Js>,
    /// The record is gone: nothing more arrives on its edges.
    pub gone: bool,
    /// The records it carries from the earlier hops its edge declares, in
    /// that order, each a landing or null.
    pub parents: Vec<Js>,
    /// The record it is about, when that is not its landing.
    pub about: Option<Js>,
    /// The listen it must not run, by its pipeline.
    pub not_for: Option<String>,
    /// Its module applied the listen's taken filter before reporting it.
    pub taken_applied: bool,
}

impl ArrivalIn {
    /// As the waits' log keeps it: one naming its record only.
    pub fn logged(&self) -> Option<NewArrival> {
        let key = self.key.clone()?;
        Some(NewArrival { edge: self.edge.clone(), key, identity: self.identity.clone(), version: self.version.clone(), landing: self.landing.clone(), gone: self.gone })
    }

    /// On the wire, as a module reports it: what a queued row carries.
    pub fn to_js(&self) -> Js {
        let mut out = obj! { "edge" => Js::str(&self.edge) };
        if let Some(key) = &self.key {
            out.insert("key".into(), Js::str(key));
        }
        if self.gone {
            out.insert("gone".into(), Js::Bool(true));
            return Js::Obj(out);
        }
        let text = |out: &mut Obj, name: &str, value: &Option<String>| {
            if let Some(value) = value {
                out.insert(name.into(), Js::str(value));
            }
        };
        text(&mut out, "identity", &self.identity);
        text(&mut out, "version", &self.version);
        out.insert("landing".into(), self.landing.clone().unwrap_or(Js::Null));
        if !self.parents.is_empty() {
            out.insert("parents".into(), Js::Arr(self.parents.clone()));
        }
        if let Some(about) = &self.about {
            out.insert("about".into(), about.clone());
        }
        text(&mut out, "notFor", &self.not_for);
        if self.taken_applied {
            out.insert("takenApplied".into(), Js::Bool(true));
        }
        Js::Obj(out)
    }
}

/// The ones of `arrivals` the waits' log keeps: each naming its record.
pub fn logged(arrivals: &[ArrivalIn]) -> Vec<NewArrival> {
    arrivals.iter().filter_map(ArrivalIn::logged).collect()
}

/// What one listen notes it ran an arrival under: the same arrival
/// delivered again runs the listen once.
pub fn arrival_receipt_key(edge: &str, key: Option<&str>, identity: &str, version: Option<&str>) -> String {
    format!("{edge}:{}:{identity}:{}", key.unwrap_or_default(), version.unwrap_or_default())
}

/// The `arrivals` an answer reports, in its order; none when it names none.
/// An arrival names its edge and its identity, and the record it landed on
/// unless it is on a root edge; a gone one names its record and no identity.
pub fn arrivals_of(answer: &Js) -> Result<Vec<ArrivalIn>, String> {
    let Some(listed) = answer.get("arrivals") else { return Ok(Vec::new()) };
    let Js::Arr(items) = listed else { return Err("arrivals: expected an array".into()) };
    items.iter().enumerate().map(|(index, item)| arrival_of(index, item)).collect()
}

fn arrival_of(index: usize, item: &Js) -> Result<ArrivalIn, String> {
    let named = |key: &str| item.get(key).and_then(Js::as_str).filter(|text| !text.is_empty()).map(str::to_string);
    let edge = named("edge").ok_or_else(|| format!("arrival {index} names no edge"))?;
    let key = named("key");
    let bare = ArrivalIn { edge, key, identity: None, version: None, landing: None, gone: false, parents: Vec::new(), about: None, not_for: None, taken_applied: false };
    if Js::is_true(item.get("gone")) {
        if bare.key.is_none() {
            return Err(format!("arrival {index} on '{}' is gone but names no key", bare.edge));
        }
        return Ok(ArrivalIn { gone: true, ..bare });
    }
    let edge = &bare.edge;
    let identity = named("identity").ok_or_else(|| format!("arrival {index} on '{edge}' has no identity"))?;
    let version = match item.get("version") {
        None => None,
        Some(Js::Str(version)) => Some(version.clone()),
        Some(_) => return Err(format!("arrival {index} on '{edge}': its version is not a text")),
    };
    let landing = item.get("landing").filter(|landing| matches!(landing.get("fields"), Some(Js::Obj(_))));
    let landing = landing.ok_or_else(|| format!("arrival {index} on '{edge}' has no landing with fields"))?.clone();
    let parents = match item.get("parents") {
        None => Vec::new(),
        Some(Js::Arr(parents)) => parents.clone(),
        Some(_) => return Err(format!("arrival {index} on '{edge}': its parents are not a list")),
    };
    let not_for = named("notFor");
    Ok(ArrivalIn {
        identity: Some(identity),
        version,
        landing: Some(landing),
        parents,
        about: item.get("about").cloned(),
        not_for,
        taken_applied: Js::is_true(item.get("takenApplied")),
        ..bare
    })
}

/// Log `arrivals` pushed to the `wake` door, and a wake queued for each wait
/// parked on a record they landed on, in the log's one write: how many wakes
/// were queued. (A delivery's arrivals are logged in the write that keeps
/// it.)
pub fn log_and_wake(store: &dyn RunHostStore, team_id: &str, adapter_type: &str, arrivals: &[NewArrival]) -> Result<usize, String> {
    if arrivals.is_empty() {
        return Ok(0);
    }
    let wakes = store.log_arrivals(team_id, adapter_type, arrivals, &iso(0)).map_err(|e| e.to_string())?.wakes;
    for _ in &wakes {
        crate::wake::queued("wake_await", None);
    }
    Ok(wakes.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ClaimDue, Park, ParkKind, RunStart, Store};
    use crate::waits::OpenWait;

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn an_answer_reads_as_its_arrivals_in_order() {
        let read = arrivals_of(&js(
            r#"{"arrivals":[{"edge":"Comments","key":"thread:c1","identity":"k1","version":"2","landing":{"fields":{"Text":"hi"}}},{"edge":"Comments","key":"thread:c2","gone":true}]}"#,
        ))
        .unwrap();
        let bare = ArrivalIn { edge: "Comments".into(), key: None, identity: None, version: None, landing: None, gone: false, parents: Vec::new(), about: None, not_for: None, taken_applied: false };
        assert_eq!(
            read,
            vec![
                ArrivalIn { key: Some("thread:c1".into()), identity: Some("k1".into()), version: Some("2".into()), landing: Some(js(r#"{"fields":{"Text":"hi"}}"#)), ..bare.clone() },
                ArrivalIn { key: Some("thread:c2".into()), gone: true, ..bare },
            ]
        );
        assert_eq!(arrivals_of(&js(r#"{"events":[]}"#)).unwrap(), vec![]);
    }

    #[test]
    fn an_arrival_on_a_root_edge_names_no_key_and_is_not_logged_for_waits() {
        let text = r#"{"edge":"Company","identity":"company-1","landing":{"recordId":"company-1","fields":{"id":"company-1","Name":"Osprey"}},"parents":[null],"about":{"recordType":"Company","externalId":"company-1"},"notFor":"listen:a:b","takenApplied":true}"#;
        let read = arrivals_of(&js(&format!(r#"{{"arrivals":[{text}]}}"#))).unwrap();
        assert_eq!(read[0].key, None);
        assert_eq!((read[0].not_for.as_deref(), read[0].taken_applied, read[0].parents.len()), (Some("listen:a:b"), true, 1));
        assert_eq!(read[0].to_js().to_json(), text, "it is written back as it was read");
        assert_eq!(logged(&read), vec![]);
        assert_eq!(arrival_receipt_key("Company", None, "company-1", None), "Company::company-1:");
        assert_eq!(arrival_receipt_key("Comments", Some("thread:c1"), "k1", Some("2")), "Comments:thread:c1:k1:2");
    }

    #[test]
    fn an_arrival_missing_what_names_it_is_refused_by_its_place() {
        let refused = |text: &str| arrivals_of(&js(&format!(r#"{{"arrivals":[{text}]}}"#))).unwrap_err();
        assert_eq!(refused(r#"{"edge":"Comments","key":"thread:c1","landing":{"fields":{}}}"#), "arrival 0 on 'Comments' has no identity");
        assert_eq!(refused(r#"{"edge":"Comments","key":"thread:c1","identity":"","landing":{"fields":{}}}"#), "arrival 0 on 'Comments' has no identity");
        assert_eq!(refused(r#"{"key":"thread:c1","identity":"k1"}"#), "arrival 0 names no edge");
        assert_eq!(refused(r#"{"edge":"Comments","gone":true}"#), "arrival 0 on 'Comments' is gone but names no key");
        assert_eq!(refused(r#"{"edge":"Comments","key":"thread:c1","identity":"k1"}"#), "arrival 0 on 'Comments' has no landing with fields");
        assert_eq!(refused(r#"{"edge":"Company","identity":"k1","landing":{"fields":{}},"parents":{}}"#), "arrival 0 on 'Company': its parents are not a list");
        assert_eq!(arrivals_of(&js(r#"{"arrivals":{}}"#)).unwrap_err(), "arrivals: expected an array");
    }

    #[test]
    fn logging_queues_a_wake_per_parked_wait() {
        let dir = std::env::temp_dir().join(format!("lf-arrivals-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None }).unwrap();
        let since = store.arrival_mark().unwrap();
        let wait = store.open_wait(&OpenWait { run_id: "run-1", team_id: "t", adapter_type: "acme", edge: "Comments", key: Some("thread:c1"), since }).unwrap();
        store.commit_park(&Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } }).unwrap();

        let arrivals = arrivals_of(&js(r#"{"arrivals":[{"edge":"Comments","key":"thread:c1","identity":"k1","landing":{"fields":{"Text":"hi"}}},{"edge":"Comments","key":"thread:c9","identity":"k2","landing":{"fields":{}}}]}"#)).unwrap();
        assert_eq!(log_and_wake(&store, "t", "acme", &logged(&arrivals)).unwrap(), 1);
        let rows = store.claim_due(&ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None }).unwrap();
        let rows: Vec<(String, String)> = rows.into_iter().map(|r| (r.kind, r.payload.to_json())).collect();
        assert_eq!(rows, [("wake_await".to_string(), format!(r#"{{"waitId":"{wait}","runId":"run-1","address":"s1"}}"#))]);
        assert_eq!(store.wait_arrivals(&wait).unwrap().arrivals.iter().map(|a| a.identity.as_str()).collect::<Vec<_>>(), ["k1"]);
        std::fs::remove_dir_all(dir).ok();
    }
}
