//! The envelope every protocol call travels in: `{ protocolVersion, method,
//! cacheScopeId, params, credential?, settings? }` in, `{ ok: true, result }`
//! or `{ ok: false, error: { code, message, retryable? } }` out, over HTTP 200.

use crate::json::Js;

pub const PROTOCOL_VERSION: &str = "2";
/// The highest minor of version 2 this kit knows (`PROTOCOL_MINOR`): a module
/// states the minor its manifest uses, from 0 to this.
pub const PROTOCOL_MINOR: u64 = 3;

/// What a manifest shows of a feature (`ProtocolMinorUse`): a method it lists,
/// by name or by its ending.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MinorUse {
    Method(&'static str),
    MethodEndingWith(&'static str),
}

/// A minor of version 2 and the feature a manifest using it lists.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProtocolMinor {
    pub minor: u64,
    pub feature: &'static str,
    pub uses: MinorUse,
}

/// Each minor of version 2 whose feature a manifest can show
/// (`PROTOCOL_MINORS`, test-held equal to it in crates/lf). 2.3, labelled
/// poll events, shows in none: an author states it.
pub const PROTOCOL_MINORS: &[ProtocolMinor] = &[
    ProtocolMinor { minor: 1, feature: "a <slot>.watch method", uses: MinorUse::MethodEndingWith(".watch") },
    ProtocolMinor { minor: 2, feature: "work.enqueueIfAbsent", uses: MinorUse::Method("work.enqueueIfAbsent") },
];

/// The minor a manifest states (`protocolMinorOf`): the highest among the
/// features its `methods` list, so a module rebuilt with a newer kit is never
/// refused by an older host for a feature it does not use.
pub fn protocol_minor_of(manifest: &Js) -> u64 {
    let methods: Vec<&str> = manifest.get("methods").and_then(Js::as_array).unwrap_or(&[]).iter().filter_map(Js::as_str).collect();
    let lists = |uses: MinorUse| match uses {
        MinorUse::Method(name) => methods.contains(&name),
        MinorUse::MethodEndingWith(ending) => methods.iter().any(|m| m.ends_with(ending)),
    };
    PROTOCOL_MINORS.iter().filter(|entry| lists(entry.uses)).map(|entry| entry.minor).max().unwrap_or(0)
}
/// The header naming the calling team (`ADAPTER_TEAM_HEADER`).
pub const ADAPTER_TEAM_HEADER: &str = "x-listen-fire-team";
/// The error code a module answers when the provider refused the request's
/// credential (`CREDENTIAL_REFUSED_CODE`): refreshed and retried once.
pub const CREDENTIAL_REFUSED_CODE: &str = "credential_refused";
/// An unknown method, or one the module does not implement.
pub const METHOD_NOT_IMPLEMENTED_CODE: &str = "method_not_implemented";
/// The module's own code failed.
pub const ADAPTER_ERROR_CODE: &str = "adapter_error";
/// `params` did not match the method's schema, or the module refused them.
pub const BAD_REQUEST_CODE: &str = "bad_request";
/// The request's `protocolVersion` is not [`PROTOCOL_VERSION`].
pub const PROTOCOL_VERSION_CODE: &str = "protocol_version";

/// What came back, as `RemoteResponseShapeError` describes it.
pub fn received(value: &Js) -> String {
    match value {
        Js::Arr(items) => format!("received an array ({} item{})", items.len(), if items.len() == 1 { "" } else { "s" }),
        Js::Null => "received null".into(),
        Js::Obj(map) => format!("received an object with keys [{}]", map.keys().cloned().collect::<Vec<_>>().join(", ")),
        Js::Bool(_) => "received boolean".into(),
        Js::Num(_) => "received number".into(),
        Js::Str(_) => "received string".into(),
    }
}

/// `RemoteResponseShapeError`'s wording: what came back, and what was expected.
pub fn shape_error(method: &str, adapter: &str, received_value: &Js, expected: &str) -> String {
    format!("Remote adapter \"{adapter}\" returned an unexpected shape from \"{method}\": {}. {expected}", received(received_value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing(methods: &[&str]) -> Js {
        Js::Obj([("methods".to_string(), Js::strings(methods))].into_iter().collect())
    }

    #[test]
    fn a_manifest_states_the_highest_minor_its_methods_use() {
        assert_eq!(protocol_minor_of(&listing(&["manifest", "describe"])), 0);
        assert_eq!(protocol_minor_of(&listing(&["manifest", "movements.list", "movements.watch"])), 1);
        assert_eq!(protocol_minor_of(&listing(&["store.watch", "work.enqueueIfAbsent"])), 2);
        assert_eq!(protocol_minor_of(&Js::Null), 0);
        // 2.3 (labelled poll events) shows in no manifest: the author states it.
        assert!(PROTOCOL_MINORS.iter().map(|e| e.minor).max() <= Some(PROTOCOL_MINOR));
    }
}
