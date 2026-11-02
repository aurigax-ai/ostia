use crate::dict::Dict;

const ERROR_SGR: &str = "\x1b[38;2;239;89;111m";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneBannerText {
    pub hidden_home: String,
    pub install: String,
    pub integration_not_loaded: String,
    pub keep_shells: String,
    pub keep_shells_lost: String,
    pub missing: String,
    pub no_shell: String,
    pub node_pty_missing: String,
    pub other_workspace: String,
    pub restored: String,
    pub sandbox_ended: String,
    pub sandbox_not_kept: String,
    pub sandbox_unavailable: String,
    pub tmux_missing: String,
    pub woke: String,
}

impl PaneBannerText {
    pub fn from_dict(dict: &Dict) -> Self {
        let section = dict
            .get("native")
            .and_then(|native| native.get("paneBanner"));
        let text = |key: &str| {
            section
                .and_then(|section| section.get(key))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_owned()
        };
        Self {
            hidden_home: text("hiddenHome"),
            install: text("install"),
            integration_not_loaded: text("integrationNotLoaded"),
            keep_shells: text("keepShells"),
            keep_shells_lost: text("keepShellsLost"),
            missing: text("missing"),
            no_shell: text("noShell"),
            node_pty_missing: text("nodePtyMissing"),
            other_workspace: text("otherWorkspace"),
            restored: text("restored"),
            sandbox_ended: text("sandboxEnded"),
            sandbox_not_kept: text("sandboxNotKept"),
            sandbox_unavailable: text("sandboxUnavailable"),
            tmux_missing: text("tmuxMissing"),
            woke: text("woke"),
        }
    }
}

pub fn error_banner(text: &str) -> String {
    format!("\r\n{ERROR_SGR} {text}\x1b[0m\r\n")
}
