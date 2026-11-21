//! The host's plugins door (adapter protocol 2.10): a host that keeps a pure
//! plugin's answers forgets them when the module that serves it says they
//! changed (`plugins.invalidate`), through the door `LF_HOST_URL` names.
//!
//! ```no_run
//! # use module_kit::*;
//! # async fn left(ctx: &Ctx, email: &str) -> Answer<()> {
//! ctx.invalidate_plugin_answers("isMember", Some(&[Js::str(email)])).await
//! # }
//! ```
//!
//! A host before 2.10 serves no such door, and keeps no answers: the module
//! is answered as though there were none to forget. So is a module served
//! by no host that names its doors.

use module_wire::json::Js;
use module_wire::obj;

use crate::context::{Answer, Ctx, ModuleError};

impl Ctx {
    /// Forget the host's kept answer of `plugin` (the name the module
    /// declares) for `args`, as a call passes them; every answer of it
    /// when `args` is None.
    pub async fn invalidate_plugin_answers(&self, plugin: &str, args: Option<&[Js]>) -> Answer<()> {
        let Some(door) = self.host_doors() else { return Ok(()) };
        let mut params = obj! { "plugin" => Js::str(plugin) };
        if let Some(args) = args {
            params.insert("args".into(), Js::Arr(args.to_vec()));
        }
        let body = Js::Obj(obj! { "method" => Js::str("plugins.invalidate"), "params" => Js::Obj(params) });
        let url = format!("{}/plugins", door.base);
        let (status, answer) = crate::host_limits::post_to_door(&url, &door.token, body.to_json()).await.map_err(|e| ModuleError::adapter(format!("the host's plugins door at {url}: {e}")))?;
        match status {
            200..=299 | 404 => Ok(()),
            _ => {
                let message = Js::parse(&answer).ok().and_then(|answer| answer.get("message").and_then(Js::as_str).map(str::to_string));
                Err(ModuleError::adapter(message.unwrap_or_else(|| format!("the host's plugins door answered {status}: {}", String::from_utf8_lossy(&answer)))))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_ocr::tests::door;

    #[tokio::test(flavor = "current_thread")]
    async fn an_invalidation_goes_through_the_door_and_an_older_host_has_none_to_forget() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (doors, log) = door(200, r#"{"result":null}"#).await;
                let ctx = Ctx::new(None, None, None, None).with_host_doors(Some(doors));
                ctx.invalidate_plugin_answers("isMember", Some(&[Js::str("ann@acme.com")])).await.unwrap();
                ctx.invalidate_plugin_answers("isMember", None).await.unwrap();
                assert_eq!(
                    *log.borrow(),
                    [
                        r#"/api/public/adapter/notes/plugins Bearer host-token {"method":"plugins.invalidate","params":{"plugin":"isMember","args":["ann@acme.com"]}}"#,
                        r#"/api/public/adapter/notes/plugins Bearer host-token {"method":"plugins.invalidate","params":{"plugin":"isMember"}}"#,
                    ]
                );
                let (older, _) = door(404, r#"{"error":"not found"}"#).await;
                Ctx::new(None, None, None, None).with_host_doors(Some(older)).invalidate_plugin_answers("isMember", None).await.unwrap();
                let (refusing, _) = door(400, r#"{"error":"bad_request","message":"plugins.invalidate names its plugin"}"#).await;
                let refused = Ctx::new(None, None, None, None).with_host_doors(Some(refusing)).invalidate_plugin_answers("isMember", None).await.unwrap_err();
                assert_eq!(refused.message, "plugins.invalidate names its plugin");
                Ctx::new(None, None, None, None).invalidate_plugin_answers("isMember", None).await.unwrap();
            })
            .await;
    }
}
