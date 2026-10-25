//! A module as the host serves it, whatever its kind: its manifest, and one
//! entry point for every other method. Each kind's trait (an adapter, a
//! plugin package, a core slot) is wrapped into this.

use std::future::Future;
use std::pin::Pin;

use module_wire::json::{Js, Obj};

use crate::context::{Answer, Ctx};

/// A future driven on the host's one thread: never required to be `Send`.
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

pub trait Module {
    /// The `manifest` method's answer.
    fn manifest(&self) -> Js;

    /// Every method but `manifest`: its result as wire JSON.
    fn call<'a>(&'a self, ctx: &'a Ctx, method: &'a str, params: Js) -> LocalFuture<'a, Answer<Js>>;
}

/// The manifest's frame every kind shares: the protocol version and the minor
/// of it the module uses, the kind, the module's name, the triggers it
/// supports, what traversal it offers and the methods it implements.
/// `declarations` follow (and may replace `runtimeCapabilities`); a declared
/// `protocolMinor` raises the minor its methods use, never lowers it.
pub(crate) fn manifest_frame(kind: &str, name: &str, supported_triggers: &[String], methods: &[String], declarations: &Obj) -> Js {
    let mut manifest = Obj::new();
    manifest.insert("protocolVersion".into(), Js::Num(2.into()));
    manifest.insert("protocolMinor".into(), Js::Num(0.into()));
    manifest.insert("kind".into(), Js::str(kind));
    manifest.insert("adapterType".into(), Js::str(name));
    manifest.insert("supportedTriggers".into(), Js::strings(supported_triggers));
    manifest.insert("runtimeCapabilities".into(), no_traversal());
    manifest.insert("methods".into(), Js::strings(methods));
    for (key, value) in declarations {
        manifest.insert(key.clone(), value.clone());
    }
    let declared = match declarations.get("protocolMinor") {
        Some(Js::Num(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    };
    let minor = module_wire::envelope::protocol_minor_of(&Js::Obj(manifest.clone())).max(declared);
    manifest.insert("protocolMinor".into(), Js::Num(minor.into()));
    Js::Obj(manifest)
}

fn no_traversal() -> Js {
    let mut traversal = Obj::new();
    traversal.insert("incoming".into(), Js::Bool(false));
    traversal.insert("edgeProperties".into(), Js::Bool(false));
    let mut capabilities = Obj::new();
    capabilities.insert("traversal".into(), Js::Obj(traversal));
    capabilities.insert("resources".into(), Js::Bool(false));
    Js::Obj(capabilities)
}
