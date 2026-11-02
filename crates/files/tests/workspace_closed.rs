#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::Arc;

use ostia_contract::open_files::WaitOutcome;
use ostia_files::open_waits::{OpenWaits, WaitRequest};
use ostia_files::workspace_closed::{WorkspaceClosedDeps, WorkspaceStep, create_workspace_closed};
use parking_lot::Mutex;

const STEPS: [&str; 11] = [
    "removeWorkspace",
    "forgetReach",
    "closeProcesses",
    "forgetNames",
    "clearChips",
    "closeRemoteFolders",
    "tellExtensions",
    "closeArtifacts",
    "removeScratch",
    "forgetRequests",
    "forgetSandbox",
];

type Calls = Arc<Mutex<Vec<(String, String)>>>;

fn recorder(calls: &Calls, name: &str) -> WorkspaceStep {
    let calls = Arc::clone(calls);
    let name = name.to_string();
    Arc::new(move |workspace_id: &str| {
        calls.lock().push((name.clone(), workspace_id.to_string()));
    })
}

struct Rig {
    open_waits: OpenWaits,
    calls: Calls,
    closed: WorkspaceStep,
}

fn setup() -> Rig {
    let open_waits = OpenWaits::default();
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let steps: BTreeMap<&str, WorkspaceStep> = STEPS
        .iter()
        .map(|name| (*name, recorder(&calls, name)))
        .collect();
    let step = |name: &str| Arc::clone(&steps[name]);
    let closed = create_workspace_closed(WorkspaceClosedDeps {
        open_waits: open_waits.clone(),
        remove_workspace: step("removeWorkspace"),
        forget_reach: step("forgetReach"),
        close_processes: step("closeProcesses"),
        forget_names: step("forgetNames"),
        clear_chips: step("clearChips"),
        close_remote_folders: step("closeRemoteFolders"),
        tell_extensions: step("tellExtensions"),
        close_artifacts: step("closeArtifacts"),
        remove_scratch: step("removeScratch"),
        forget_requests: step("forgetRequests"),
        forget_sandbox: step("forgetSandbox"),
    });
    Rig {
        open_waits,
        calls,
        closed,
    }
}

fn request(workspace_id: &str, caller: &str, pane: &str) -> WaitRequest {
    WaitRequest {
        window_id: "1".to_string(),
        workspace_id: workspace_id.to_string(),
        caller_pane_id: caller.to_string(),
        pane_ids: vec![pane.to_string()],
    }
}

#[tokio::test]
async fn closing_the_workspace_ends_a_waiting_editor_with_a_failure_instead_of_hanging() {
    let rig = setup();
    let mine = rig.open_waits.start(request("w1", "term", "notes"));
    let other = rig.open_waits.start(request("w2", "t2", "other"));
    (rig.closed)("w1");
    assert_eq!(rig.open_waits.size(), 1);
    assert_eq!(mine.done.await.unwrap(), WaitOutcome::Gone);
    rig.open_waits.pane_closed("other");
    assert_eq!(other.done.await.unwrap(), WaitOutcome::Closed);
}

#[test]
fn tells_each_step_which_workspace_closed() {
    for step in STEPS {
        let rig = setup();
        (rig.closed)("w1");
        let calls = rig.calls.lock();
        assert!(
            calls.contains(&(step.to_string(), "w1".to_string())),
            "step {step}"
        );
    }
}

#[test]
fn runs_the_steps_in_the_order_the_workspace_closes() {
    let rig = setup();
    (rig.closed)("w1");
    let order: Vec<String> = rig
        .calls
        .lock()
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    assert_eq!(order, STEPS.map(String::from).to_vec());
}
