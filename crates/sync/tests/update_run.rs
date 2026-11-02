#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use ostia_contract::install_method::{InstallMethod, UpdateRunStart, UpdateRunState};
use ostia_sync::update_run::{UpdateRunner, UpdateRunnerDeps, UpdateTerminalRequest};
use tokio::sync::oneshot;

type OpenFuture = Pin<Box<dyn Future<Output = Option<String>> + Send>>;

struct Harness {
    runner: UpdateRunner,
    opened: Arc<Mutex<Vec<UpdateTerminalRequest>>>,
    states: Arc<Mutex<Vec<UpdateRunState>>>,
    resolve: Arc<Mutex<Option<oneshot::Sender<Option<String>>>>>,
    pane_id: Option<String>,
}

impl Harness {
    fn open(&self) {
        let sender = self.resolve.lock().unwrap().take().unwrap();
        sender.send(self.pane_id.clone()).unwrap();
    }

    fn opened(&self) -> Vec<UpdateTerminalRequest> {
        self.opened.lock().unwrap().clone()
    }

    fn states(&self) -> Vec<UpdateRunState> {
        self.states.lock().unwrap().clone()
    }
}

fn harness(method: InstallMethod, pane_id: Option<&str>) -> Harness {
    let opened: Arc<Mutex<Vec<UpdateTerminalRequest>>> = Arc::default();
    let states: Arc<Mutex<Vec<UpdateRunState>>> = Arc::default();
    let resolve: Arc<Mutex<Option<oneshot::Sender<Option<String>>>>> = Arc::default();
    let runner = UpdateRunner::new(UpdateRunnerDeps {
        method: Box::new(move || method),
        title: Box::new(|| "Update Ostia".to_owned()),
        open_terminal: Box::new({
            let opened = Arc::clone(&opened);
            let resolve = Arc::clone(&resolve);
            move |request: UpdateTerminalRequest| -> OpenFuture {
                opened.lock().unwrap().push(request);
                let (sender, receiver) = oneshot::channel();
                *resolve.lock().unwrap() = Some(sender);
                Box::pin(async move { receiver.await.ok().flatten() })
            }
        }),
        host_token: Box::new(|command| format!("token:{command}")),
        on_change: Box::new({
            let states = Arc::clone(&states);
            move |state| states.lock().unwrap().push(state.clone())
        }),
    });
    Harness {
        runner,
        opened,
        states,
        resolve,
        pane_id: pane_id.map(str::to_owned),
    }
}

const APT_COMMAND: &str = "sudo apt update && sudo apt install --only-upgrade ostia";

#[tokio::test]
async fn opens_one_terminal_with_the_fixed_command_and_a_host_token_for_a_managed_install() {
    let h = harness(InstallMethod::Apt, Some("pane-1"));
    let start = h.runner.start();
    h.open();
    assert_eq!(start.await, UpdateRunStart::Opened);
    assert_eq!(
        h.opened(),
        [UpdateTerminalRequest {
            command: APT_COMMAND.to_owned(),
            host_token: format!("token:{APT_COMMAND}"),
            title: "Update Ostia".to_owned(),
        }]
    );
    assert_eq!(h.runner.state(), UpdateRunState::Running);
}

#[tokio::test]
async fn does_nothing_for_an_install_without_a_package_manager() {
    for method in [
        InstallMethod::Local,
        InstallMethod::Tarball,
        InstallMethod::Dmg,
        InstallMethod::Dev,
    ] {
        let h = harness(method, Some("pane-1"));
        assert_eq!(
            h.runner.start().await,
            UpdateRunStart::NoAction,
            "{method:?}"
        );
        assert!(h.opened().is_empty(), "{method:?}");
    }
}

#[tokio::test]
async fn refuses_a_second_run_while_one_is_opening_or_running() {
    let h = harness(InstallMethod::Brew, Some("pane-1"));
    let first = h.runner.start();
    assert_eq!(h.runner.start().await, UpdateRunStart::Busy);
    h.open();
    first.await;
    assert_eq!(h.runner.start().await, UpdateRunStart::Busy);
    assert_eq!(h.opened().len(), 1);
}

#[tokio::test]
async fn is_done_after_the_command_in_its_pane_ends_with_code_0_failed_otherwise() {
    let h = harness(InstallMethod::Apt, Some("pane-1"));
    let start = h.runner.start();
    h.open();
    start.await;
    h.runner.pane_state("other", false, Some(0));
    h.runner.pane_state("pane-1", false, None);
    h.runner.pane_state("pane-1", true, None);
    assert_eq!(h.runner.state(), UpdateRunState::Running);
    h.runner.pane_state("pane-1", false, Some(0));
    assert_eq!(h.runner.state(), UpdateRunState::Done);
    assert_eq!(h.states(), [UpdateRunState::Running, UpdateRunState::Done]);

    let f = harness(InstallMethod::Apt, Some("pane-1"));
    let second = f.runner.start();
    f.open();
    second.await;
    f.runner.pane_state("pane-1", false, Some(100));
    assert_eq!(
        f.runner.state(),
        UpdateRunState::Failed {
            exit_code: Some(100)
        }
    );
    let again = f.runner.start();
    f.open();
    assert_eq!(again.await, UpdateRunStart::Opened);
}

#[tokio::test]
async fn fails_when_its_pane_closes_before_the_command_ends_and_allows_a_new_run() {
    let h = harness(InstallMethod::Apt, Some("pane-1"));
    let start = h.runner.start();
    h.open();
    start.await;
    h.runner.pane_closed("pane-1");
    assert_eq!(h.runner.state(), UpdateRunState::Failed { exit_code: None });
    let again = h.runner.start();
    h.open();
    assert_eq!(again.await, UpdateRunStart::Opened);
}

#[tokio::test]
async fn reports_not_opened_when_no_window_takes_the_terminal() {
    let h = harness(InstallMethod::Apt, None);
    let start = h.runner.start();
    h.open();
    assert_eq!(start.await, UpdateRunStart::NotOpened);
    assert_eq!(h.runner.state(), UpdateRunState::Idle);
}

#[tokio::test]
async fn ignores_a_pane_that_closes_while_nothing_runs_and_lets_a_new_run_start_after_a_refusal() {
    let h = harness(InstallMethod::Apt, None);
    h.runner.pane_closed("pane-1");
    assert_eq!(h.runner.state(), UpdateRunState::Idle);
    let start = h.runner.start();
    h.open();
    assert_eq!(start.await, UpdateRunStart::NotOpened);
    let again = h.runner.start();
    h.open();
    assert_eq!(again.await, UpdateRunStart::NotOpened);
    assert_eq!(h.opened().len(), 2);
    assert!(h.states().is_empty());
}
