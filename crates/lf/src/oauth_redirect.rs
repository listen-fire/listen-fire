//! Where the provider sends the person back after they sign in, for `listen-fire
//! credential add` / `update` of an OAuth 2 credential. Three ways, because listen-fire runs on a laptop, on a headless
//! box over ssh, and deployed behind a URL:
//!
//!   loopback (default)  listen-fire listens on 127.0.0.1 for the one redirect
//!                       (RFC 8252); the redirect URI is
//!                       http://127.0.0.1:<port>/callback.
//!   headless            listen-fire prints the authorize URL and reads back the URL
//!                       the browser was sent to (it fails to load; it is
//!                       copied from the address bar). Same redirect URI, so
//!                       the port must be the registered one.
//!   public              the redirect URI is <publicUrl>/oauth/callback, which
//!                       `listen-fire serve` answers by leaving the redirect in .lf/oauth
//!                       for the waiting command to pick up
//!                       (`deliver_public_redirect`, which serve mounts). lf.yaml's
//!                       `oauth: { redirectUri }` names another URI to send the
//!                       provider instead: a relay (a platform whose registered
//!                       callback receives the redirect) forwards the `code` and
//!                       `state` query on to `listen-fire serve`'s GET /oauth/callback.


use std::path::PathBuf;


pub const LOOPBACK_CALLBACK_PATH: &str = "/callback";
pub const PUBLIC_CALLBACK_PATH: &str = "/oauth/callback";

pub enum RedirectMode {
    Loopback { port: u16, open_browser: bool },
    Headless { port: u16 },
    /// `redirect_uri` is what the provider is sent and the code is exchanged under.
    Public { redirect_uri: String, lf_dir: PathBuf },
}

pub fn loopback_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}")
}

pub fn public_redirect_uri(public_url: &str) -> String {
    format!("{}{PUBLIC_CALLBACK_PATH}", public_url.trim_end_matches('/'))
}

#[cfg(feature = "oauth")]
pub use crate::oauth_signin::authorize_at_provider;

/// Without the `oauth` feature this listen-fire signs no one in at a provider.
#[cfg(not(feature = "oauth"))]
pub async fn authorize_at_provider(
    _: &crate::oauth2::OAuth2Declaration,
    _: &crate::oauth2::ClientApp,
    _: &RedirectMode,
    _: &mut crate::prompt::Prompter,
    _: &str,
) -> Result<crate::secrets_family::Fields, String> {
    Err(crate::core::NO_OAUTH.to_string())
}
