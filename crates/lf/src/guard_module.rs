//! A loop guard module listen-fire does not build in: the loopGuard slot filled by a
//! third-party module (crate::core), spoken to over the slot's methods
//! (docs/contracts/loop-guard-slot.md) carried as adapter protocol 2 calls
//! (crate::slot_client), opened by `guard.open` with the module's settings.

use std::collections::BTreeMap;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::loop_guard::{LoopGuard, Wrote};
use crate::obj;
use crate::slot_client::SlotClient;

pub struct ProcessGuard {
    client: SlotClient,
}

impl ProcessGuard {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessGuard, String> {
        let guard = ProcessGuard { client: SlotClient::start("loop guard", name, process, settings)? };
        guard.call("guard.open", obj! { "settings" => Js::from(guard.client.settings()) })?;
        Ok(guard)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.client.call_text(method, params)
    }
}

impl LoopGuard for ProcessGuard {
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String> {
        let params = obj! {
            "adapter" => Js::str(&wrote.adapter),
            "recordType" => Js::str(&wrote.record_type),
            "externalId" => Js::str(&wrote.external_id),
            "writer" => Js::str(writer),
            "record" => wrote.record.clone(),
        };
        self.call("guard.recordWrite", params).map(|_| ())
    }
}
