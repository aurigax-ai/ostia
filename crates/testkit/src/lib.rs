use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ostia_app::App;
use ostia_base::host::{Host, Platform};
use ostia_base::{PaneId, WindowId, WorkspaceId};
use ostia_control::{PaneIdentity, PaneInput};
use ostia_rpc::Client;
use serde_json::json;
use tempfile::TempDir;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn fixture_text(relative: &str) -> std::io::Result<String> {
    std::fs::read_to_string(repo_root().join("test/fixtures").join(relative))
}

pub fn temp_host() -> std::io::Result<(TempDir, Host)> {
    let dir = TempDir::new()?;
    let env: BTreeMap<String, String> = [
        ("XDG_DATA_HOME", dir.path().join("data")),
        ("XDG_CONFIG_HOME", dir.path().join("config")),
        ("XDG_RUNTIME_DIR", dir.path().to_path_buf()),
        ("TMPDIR", dir.path().to_path_buf()),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value.to_string_lossy().into_owned()))
    .collect();
    let host = Host {
        env,
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        platform: Platform::current(),
    };
    Ok((dir, host))
}

pub fn pane_input(window: &str, workspace: &str, pane: &str) -> PaneInput {
    PaneInput {
        window_id: WindowId::new(window),
        workspace_id: WorkspaceId::new(workspace),
        pane_id: PaneId::new(pane),
    }
}

pub struct TestApp {
    pub app: App,
    pub host: Host,
    _dir: TempDir,
}

impl TestApp {
    pub fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let (dir, host) = temp_host()?;
        let app = App::start(&host)?;
        Ok(Self {
            app,
            host,
            _dir: dir,
        })
    }

    pub fn pane(&self, window: &str, workspace: &str, pane: &str) -> PaneIdentity {
        self.app
            .registry
            .register_pane(pane_input(window, workspace, pane))
    }

    pub async fn client(&self, token: &str) -> Result<Client, Box<dyn std::error::Error>> {
        let client = Client::connect(&self.app.socket).await?;
        client
            .request("hello", Some(&json!({ "token": token })))
            .await?;
        Ok(client)
    }
}
