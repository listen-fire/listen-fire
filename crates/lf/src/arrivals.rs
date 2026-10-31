//! Arrivals as modules report them (adapter protocol 2.5): what landed on a
//! listenable edge, read off a module's answer about an inbound delivery
//! (`preprocessInbound`, `checkInbound`'s acceptance) or a push to the `wake`
//! door, then logged, and a `wake_await` row queued for each wait parked on
//! the record it landed on (crate::waits).

use crate::backend::RunHostStore;
use crate::json::Js;
use crate::store::iso;
use crate::waits::NewArrival;

/// The `arrivals` an answer reports, in its order; none when it names none.
/// An arrival names its edge, its record's key and its identity; a gone one
/// names no identity.
pub fn arrivals_of(answer: &Js) -> Result<Vec<NewArrival>, String> {
    let Some(listed) = answer.get("arrivals") else { return Ok(Vec::new()) };
    let Js::Arr(items) = listed else { return Err("arrivals: expected an array".into()) };
    items.iter().enumerate().map(|(index, item)| arrival_of(index, item)).collect()
}

fn arrival_of(index: usize, item: &Js) -> Result<NewArrival, String> {
    let named = |key: &str| item.get(key).and_then(Js::as_str).filter(|text| !text.is_empty()).map(str::to_string);
    let edge = named("edge").ok_or_else(|| format!("arrival {index} names no edge"))?;
    let key = named("key").ok_or_else(|| format!("arrival {index} on '{edge}' names no key"))?;
    if Js::is_true(item.get("gone")) {
        return Ok(NewArrival { edge, key, identity: None, version: None, landing: None, gone: true });
    }
    let identity = named("identity").ok_or_else(|| format!("arrival {index} on '{edge}' has no identity"))?;
    let version = match item.get("version") {
        None => None,
        Some(Js::Str(version)) => Some(version.clone()),
        Some(_) => return Err(format!("arrival {index} on '{edge}': its version is not a text")),
    };
    let landing = item.get("landing").filter(|landing| matches!(landing.get("fields"), Some(Js::Obj(_))));
    let landing = landing.ok_or_else(|| format!("arrival {index} on '{edge}' has no landing with fields"))?;
    Ok(NewArrival { edge, key, identity: Some(identity), version, landing: Some(landing.clone()), gone: false })
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
        assert_eq!(
            read,
            vec![
                NewArrival {
                    edge: "Comments".into(),
                    key: "thread:c1".into(),
                    identity: Some("k1".into()),
                    version: Some("2".into()),
                    landing: Some(js(r#"{"fields":{"Text":"hi"}}"#)),
                    gone: false
                },
                NewArrival { edge: "Comments".into(), key: "thread:c2".into(), identity: None, version: None, landing: None, gone: true },
            ]
        );
        assert_eq!(arrivals_of(&js(r#"{"events":[]}"#)).unwrap(), vec![]);
    }

    #[test]
    fn an_arrival_missing_what_names_it_is_refused_by_its_place() {
        let refused = |text: &str| arrivals_of(&js(&format!(r#"{{"arrivals":[{text}]}}"#))).unwrap_err();
        assert_eq!(refused(r#"{"edge":"Comments","key":"thread:c1","landing":{"fields":{}}}"#), "arrival 0 on 'Comments' has no identity");
        assert_eq!(refused(r#"{"edge":"Comments","key":"thread:c1","identity":"","landing":{"fields":{}}}"#), "arrival 0 on 'Comments' has no identity");
        assert_eq!(refused(r#"{"key":"thread:c1","identity":"k1"}"#), "arrival 0 names no edge");
        assert_eq!(refused(r#"{"edge":"Comments","identity":"k1"}"#), "arrival 0 on 'Comments' names no key");
        assert_eq!(refused(r#"{"edge":"Comments","key":"thread:c1","identity":"k1"}"#), "arrival 0 on 'Comments' has no landing with fields");
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
        assert_eq!(log_and_wake(&store, "t", "acme", &arrivals).unwrap(), 1);
        let rows = store.claim_due(&ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None }).unwrap();
        let rows: Vec<(String, String)> = rows.into_iter().map(|r| (r.kind, r.payload.to_json())).collect();
        assert_eq!(rows, [("wake_await".to_string(), format!(r#"{{"waitId":"{wait}","runId":"run-1","address":"s1"}}"#))]);
        assert_eq!(store.wait_arrivals(&wait).unwrap().arrivals.iter().map(|a| a.identity.as_str()).collect::<Vec<_>>(), ["k1"]);
        std::fs::remove_dir_all(dir).ok();
    }
}
