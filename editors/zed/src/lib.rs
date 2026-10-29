use zed_extension_api::{self as zed, LanguageServerId, Result};

/// Starts `listen-fire lsp`, the language server built into the `listen-fire` binary.
///
/// Zed calls this only when settings name no `lsp.listen-fire.binary.path` (with a
/// path, Zed runs it itself, with the settings' `arguments`). Zed adds the
/// login shell's environment and the settings' `env` and `arguments` on top.
struct ListenFire;

impl zed::Extension for ListenFire {
    fn new() -> Self {
        ListenFire
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let command = worktree.which("listen-fire").ok_or_else(|| {
            "listen-fire: no `listen-fire` on this project's PATH. Put it on PATH, or set \
             \"lsp\": { \"listen-fire\": { \"binary\": { \"path\": \"/path/to/listen-fire\", \"arguments\": [\"lsp\"] } } } \
             in Zed's settings."
                .to_string()
        })?;
        Ok(zed::Command { command, args: vec!["lsp".to_string()], env: Vec::new() })
    }
}

zed::register_extension!(ListenFire);
