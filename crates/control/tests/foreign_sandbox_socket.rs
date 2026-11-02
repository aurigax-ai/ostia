#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg(target_os = "linux")]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use ostia_base::clock::system_clock;
use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_contract::SANDBOXED_REFUSAL;
use ostia_contract::capabilities::Capability;
use ostia_control::foreign_sandbox::proc_fs;
use ostia_control::{
    CapabilityStore, ControlAuth, ControlAuthParts, ControlListener, ControlMethod, ControlServer,
    IdRegistry, MethodTable, PaneIdentity, PaneInput, ServerDeps,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::process::Command;

const CLIENT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/seccomp_client.py"
);

#[derive(Default)]
struct Grants(Mutex<HashMap<ExternalId, HashSet<Capability>>>);

impl CapabilityStore for Grants {
    fn init_caps(&self, external_id: &ExternalId) {
        self.0
            .lock()
            .entry(external_id.clone())
            .or_insert_with(|| HashSet::from([Capability::ReadBoard]));
    }

    fn set_caps(&self, external_id: &ExternalId, caps: &[Capability]) {
        self.0
            .lock()
            .insert(external_id.clone(), caps.iter().copied().collect());
    }

    fn has_cap(&self, external_id: &ExternalId, cap: Capability) -> bool {
        self.0
            .lock()
            .get(external_id)
            .is_some_and(|caps| caps.contains(&cap))
    }
}

struct Served {
    dir: TempDir,
    identity: PaneIdentity,
    _listener: ControlListener,
}

fn methods() -> MethodTable {
    let mut table = MethodTable::default();
    for name in ["process.run", "pane.setResume", "bus.send"] {
        table
            .register(
                name,
                ControlMethod::new(|_params, _ctx| async move { Ok(json!("ran")) }),
            )
            .unwrap();
    }
    table
}

fn own_pid() -> i32 {
    i32::try_from(std::process::id()).unwrap()
}

fn serve(shell_pid: i32) -> Served {
    let dir = TempDir::new().unwrap();
    let registry = IdRegistry::new(&[7; 32]);
    let auth = Arc::new(ControlAuth::new(ControlAuthParts {
        registry: registry.clone(),
        caps: Arc::new(Grants::default()),
        script_tokens: Arc::new(|_| None),
        cap_filter: Arc::new(|_, _| true),
        approver: None,
        clock: system_clock(),
    }));
    let deps = ServerDeps {
        auth,
        version: None,
        is_sandboxed: Arc::new(|_| false),
        pty_pid: Arc::new(move |_| Some(shell_pid)),
        terminal_state: Arc::new(|_: &PaneId| None),
        script_covers: Arc::new(|_, _, _| async { false }.boxed()),
        read_proc: Arc::new(proc_fs),
    };
    let listener = ControlServer::new(deps, methods())
        .listen(&dir.path().join("peer.sock"))
        .unwrap();
    let identity = registry.register_pane(PaneInput {
        window_id: WindowId::new("w1"),
        workspace_id: WorkspaceId::new("s1"),
        pane_id: PaneId::new("pPeer"),
    });
    Served {
        dir,
        identity,
        _listener: listener,
    }
}

async fn client(served: &Served, filtered: bool) -> Value {
    let socket: &Path = &served.dir.path().join("peer.sock");
    let child = Command::new("python3")
        .arg("-I")
        .arg(CLIENT)
        .arg(socket)
        .arg(&served.identity.token)
        .arg(if filtered { "yes" } else { "no" })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "client failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn refuses_process_run_and_pane_set_resume_and_allows_bus_send_under_a_seccomp_filter() {
    let served = serve(own_pid());
    let out = client(&served, true).await;
    assert_eq!(out["run"]["ok"], json!(false));
    assert!(
        out["run"]["e"]
            .as_str()
            .unwrap()
            .contains(SANDBOXED_REFUSAL)
    );
    assert_eq!(out["resume"]["ok"], json!(false));
    assert!(
        out["resume"]["e"]
            .as_str()
            .unwrap()
            .contains(SANDBOXED_REFUSAL)
    );
    assert_eq!(out["bus"]["ok"], json!(true));
}

#[tokio::test]
async fn allows_both_without_a_filter() {
    let served = serve(own_pid());
    let out = client(&served, false).await;
    assert_eq!(out["run"]["ok"], json!(true));
    assert_eq!(out["resume"]["ok"], json!(true));
    assert_eq!(out["bus"]["ok"], json!(true));
}
