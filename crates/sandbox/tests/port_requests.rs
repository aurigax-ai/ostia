#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::FutureExt;
use ostia_base::{Platform, WorkspaceId};
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_contract::sandbox::PortsPolicy;
use ostia_sandbox::port_forwarder::{ExposeError, ExposeRefusal, ExposeResult, SandboxListener};
use ostia_sandbox::port_requests::{
    KeptExposure, PortAsk, PortAskOrigin, PortForwarding, PortGrant, PortNotice, PortRequestError,
    PortRequests, PortRequestsDeps, PortRow,
};
use parking_lot::Mutex;

#[derive(Clone, Default)]
struct FakeForwarder {
    exposed: Arc<Mutex<Vec<u16>>>,
    listeners: Arc<Mutex<Vec<SandboxListener>>>,
    refusal: Arc<Mutex<Option<ExposeRefusal>>>,
}

impl PortForwarding for FakeForwarder {
    fn listeners(&self, _workspace_id: &WorkspaceId) -> Vec<SandboxListener> {
        self.listeners.lock().clone()
    }

    fn exposed(&self, _workspace_id: &WorkspaceId) -> Vec<u16> {
        self.exposed.lock().clone()
    }

    fn refusal(&self, _workspace_id: &WorkspaceId) -> Option<ExposeRefusal> {
        *self.refusal.lock()
    }

    async fn expose(&self, _workspace_id: &WorkspaceId, port: u16) -> ExposeResult {
        let mut exposed = self.exposed.lock();
        if !exposed.contains(&port) {
            exposed.push(port);
        }
        Ok(port)
    }

    async fn unexpose(&self, _workspace_id: &WorkspaceId, port: u16) {
        self.exposed.lock().retain(|exposed| *exposed != port);
    }
}

struct Options {
    platform: Platform,
    policy: PortsPolicy,
    outcome: ApprovalOutcome,
    refusal: Option<ExposeRefusal>,
    sandboxed: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            platform: Platform::Linux,
            policy: PortsPolicy::Ask,
            outcome: workspace(),
            refusal: None,
            sandboxed: true,
        }
    }
}

struct Setup {
    requests: PortRequests<FakeForwarder>,
    asks: Arc<Mutex<Vec<PortAsk>>>,
    forwarder: FakeForwarder,
}

impl Setup {
    fn asked_ports(&self) -> Vec<u16> {
        self.asks.lock().iter().map(|ask| ask.port).collect()
    }

    fn exposed(&self) -> Vec<u16> {
        self.forwarder.exposed.lock().clone()
    }

    fn listen(&self, listeners: Vec<SandboxListener>) {
        *self.forwarder.listeners.lock() = listeners;
    }

    fn set_refusal(&self, refusal: Option<ExposeRefusal>) {
        *self.forwarder.refusal.lock() = refusal;
    }
}

fn workspace() -> ApprovalOutcome {
    ApprovalOutcome::Answer(ApprovalAnswer::Workspace)
}

fn denied() -> ApprovalOutcome {
    ApprovalOutcome::Answer(ApprovalAnswer::Deny)
}

fn ws() -> WorkspaceId {
    WorkspaceId::new("ws")
}

fn node(port: u16) -> SandboxListener {
    SandboxListener {
        port,
        process: Some("node".to_owned()),
        pid: None,
    }
}

fn running(port: u16, process: &str, pid: u32) -> SandboxListener {
    SandboxListener {
        port,
        process: Some(process.to_owned()),
        pid: Some(pid),
    }
}

fn kept(port: u16, pid: u32) -> KeptExposure {
    KeptExposure {
        port,
        process: "node".to_owned(),
        pid: Some(pid),
        by_human: false,
    }
}

fn setup(options: Options) -> Setup {
    let asks = Arc::new(Mutex::new(Vec::new()));
    let forwarder = FakeForwarder::default();
    *forwarder.refusal.lock() = options.refusal;
    let ask_log = asks.clone();
    let outcome = options.outcome;
    let policy = options.policy;
    let sandboxed = options.sandboxed;
    let requests = PortRequests::new(PortRequestsDeps {
        platform: options.platform,
        is_sandboxed: Arc::new(move |_| sandboxed),
        policy: Arc::new(move |_| policy),
        ask: Arc::new(move |ask| {
            ask_log.lock().push(ask);
            async move { outcome }.boxed()
        }),
        forwarder: forwarder.clone(),
    });
    Setup {
        requests,
        asks,
        forwarder,
    }
}

fn with_policy(policy: PortsPolicy) -> Setup {
    setup(Options {
        policy,
        ..Options::default()
    })
}

#[tokio::test]
async fn sbx_c48_refuses_a_port_outside_1024_65535_or_not_a_number_without_a_card() {
    let s = setup(Options::default());
    for port in ["80", "0", "70000", "abc", "3000.5"] {
        assert_eq!(
            s.requests.request(&ws(), "pane", port).await,
            Err(PortRequestError::InvalidPort),
            "{port}"
        );
    }
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
}

#[tokio::test]
async fn sbx_c49_tells_an_agent_on_macos_that_forwarding_is_not_needed_without_a_card() {
    let s = setup(Options {
        platform: Platform::Darwin,
        ..Options::default()
    });
    assert_eq!(
        s.requests.request(&ws(), "pane", "3000").await,
        Ok(PortGrant {
            port: 3000,
            notice: Some(PortNotice::NotNeededOnMacos),
        })
    );
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    assert!(s.exposed().is_empty());
}

#[tokio::test]
async fn sbx_c63_asks_about_a_new_listener_when_ports_policy_is_ask_and_exposes_it_on_approval() {
    let s = with_policy(PortsPolicy::Ask);
    s.listen(vec![node(5173)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), vec![5173]);
    assert_eq!(s.exposed(), vec![5173]);
    assert_eq!(
        s.requests.ports(&ws()),
        vec![PortRow {
            port: 5173,
            process: Some("node".to_owned()),
            exposed: true,
        }]
    );
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), vec![5173]);
}

#[tokio::test]
async fn sbx_c64_exposes_a_new_listener_without_a_card_when_ports_policy_is_allow() {
    let s = with_policy(PortsPolicy::Allow);
    s.listen(vec![node(5173)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    assert_eq!(s.exposed(), vec![5173]);
}

#[tokio::test]
async fn sbx_c65_does_nothing_for_a_new_listener_when_ports_policy_is_deny_but_the_human_can_expose_it()
 {
    let s = with_policy(PortsPolicy::Deny);
    s.listen(vec![node(5173)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    assert!(s.exposed().is_empty());
    assert_eq!(s.requests.expose_by_human(&ws(), 5173).await, Ok(5173));
    assert_eq!(s.exposed(), vec![5173]);
}

#[tokio::test]
async fn sbx_c66_drops_an_exposed_port_from_the_list_and_releases_it_when_its_process_exits() {
    let s = with_policy(PortsPolicy::Allow);
    s.listen(vec![node(5173)]);
    s.requests.scan(&ws()).await;
    s.listen(Vec::new());
    s.requests.scan(&ws()).await;
    assert!(s.exposed().is_empty());
    assert_eq!(s.requests.ports(&ws()), Vec::new());
}

#[tokio::test]
async fn answers_an_agent_that_unix_sockets_are_off_without_a_card() {
    let s = setup(Options {
        refusal: Some(ExposeRefusal::UnixSocketsOff),
        ..Options::default()
    });
    assert_eq!(
        s.requests.request(&ws(), "pane", "3000").await,
        Err(PortRequestError::Expose(ExposeError::UnixSocketsOff))
    );
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    assert!(s.exposed().is_empty());
}

#[tokio::test]
async fn shows_no_card_for_a_new_listener_while_its_port_cannot_be_forwarded() {
    for policy in [PortsPolicy::Ask, PortsPolicy::Allow] {
        let s = setup(Options {
            policy,
            refusal: Some(ExposeRefusal::UnixSocketsOff),
            ..Options::default()
        });
        s.listen(vec![node(5173)]);
        s.requests.scan(&ws()).await;
        assert_eq!(s.asked_ports(), Vec::<u16>::new());
        assert!(s.exposed().is_empty());
        assert_eq!(
            s.requests.ports(&ws()),
            vec![PortRow {
                port: 5173,
                process: Some("node".to_owned()),
                exposed: false,
            }]
        );
    }
}

#[tokio::test]
async fn does_not_ask_again_about_a_listener_whose_port_is_already_exposed_as_after_a_restart() {
    let s = with_policy(PortsPolicy::Ask);
    s.forwarder.exposed.lock().push(3000);
    s.listen(vec![node(3000)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    assert_eq!(s.exposed(), vec![3000]);
}

#[tokio::test]
async fn ksh_c58_exposes_a_kept_port_again_without_asking_while_the_same_program_listens_on_it() {
    let s = with_policy(PortsPolicy::Ask);
    s.requests.keep(&ws(), &[kept(3000, 41)]);
    s.listen(vec![running(3000, "node", 41)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    assert_eq!(s.exposed(), vec![3000]);
}

#[tokio::test]
async fn asks_again_about_a_kept_port_whose_server_stopped_and_started_again() {
    let s = with_policy(PortsPolicy::Ask);
    s.requests.keep(&ws(), &[kept(3000, 41)]);
    s.listen(vec![running(3000, "node", 41)]);
    s.requests.scan(&ws()).await;
    s.listen(Vec::new());
    s.requests.scan(&ws()).await;
    s.listen(vec![running(3000, "node", 41)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), vec![3000]);
}

#[tokio::test]
async fn ksh_c76_asks_again_about_a_kept_port_when_another_program_listens_on_it_now() {
    for listener in [running(3000, "python3", 41), running(3000, "node", 77)] {
        let s = setup(Options {
            outcome: denied(),
            ..Options::default()
        });
        s.requests.keep(&ws(), &[kept(3000, 41)]);
        s.listen(vec![listener.clone()]);
        s.requests.scan(&ws()).await;
        assert_eq!(s.asked_ports(), vec![3000], "{listener:?}");
        assert!(s.exposed().is_empty(), "{listener:?}");
    }
}

#[tokio::test]
async fn ksh_c77_restores_a_kept_port_under_the_deny_policy_only_when_the_human_exposed_it() {
    let by_agent = with_policy(PortsPolicy::Deny);
    by_agent.requests.keep(&ws(), &[kept(3000, 41)]);
    by_agent.listen(vec![running(3000, "node", 41)]);
    by_agent.requests.scan(&ws()).await;
    assert!(by_agent.exposed().is_empty());
    assert_eq!(by_agent.asked_ports(), Vec::<u16>::new());

    let by_human = with_policy(PortsPolicy::Deny);
    by_human.requests.keep(
        &ws(),
        &[KeptExposure {
            by_human: true,
            ..kept(3000, 41)
        }],
    );
    by_human.listen(vec![running(3000, "node", 41)]);
    by_human.requests.scan(&ws()).await;
    assert_eq!(by_human.exposed(), vec![3000]);
    assert_eq!(
        by_human.requests.exposures(&ws(), None),
        vec![KeptExposure {
            by_human: true,
            ..kept(3000, 41)
        }]
    );
}

#[tokio::test]
async fn waits_to_restore_a_kept_port_until_it_can_be_forwarded_then_drops_kept_ports_nobody_listens_on()
 {
    let s = setup(Options {
        refusal: Some(ExposeRefusal::NotRunning),
        ..Options::default()
    });
    s.listen(vec![running(3000, "node", 41)]);
    s.requests.keep(&ws(), &[kept(3000, 41), kept(4000, 42)]);
    s.requests.scan(&ws()).await;
    assert!(s.exposed().is_empty());
    s.set_refusal(None);
    s.requests.scan(&ws()).await;
    assert_eq!(s.exposed(), vec![3000]);
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
    s.listen(vec![running(3000, "node", 41), running(4000, "node", 42)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.asked_ports(), vec![4000]);
}

#[tokio::test]
async fn records_the_program_serving_an_exposed_port_from_listeners_read_now_before_a_scan_saw_it()
{
    let s = with_policy(PortsPolicy::Ask);
    s.requests.expose_by_human(&ws(), 3000).await.unwrap();
    assert_eq!(s.requests.exposures(&ws(), None), Vec::new());
    assert_eq!(
        s.requests
            .exposures(&ws(), Some(&[running(3000, "node", 41)])),
        vec![KeptExposure {
            by_human: true,
            ..kept(3000, 41)
        }]
    );
}

#[tokio::test]
async fn records_what_program_serves_each_exposed_port_and_whether_the_human_exposed_it() {
    let s = with_policy(PortsPolicy::Allow);
    s.listen(vec![
        running(3000, "node", 41),
        SandboxListener {
            port: 4000,
            process: None,
            pid: None,
        },
    ]);
    s.requests.scan(&ws()).await;
    s.requests.expose_by_human(&ws(), 5000).await.unwrap();
    assert_eq!(s.requests.exposures(&ws(), None), vec![kept(3000, 41)]);
    s.listen(vec![running(3000, "node", 41), running(5000, "vite", 50)]);
    s.requests.scan(&ws()).await;
    assert_eq!(
        s.requests.exposures(&ws(), None),
        vec![
            kept(3000, 41),
            KeptExposure {
                port: 5000,
                process: "vite".to_owned(),
                pid: Some(50),
                by_human: true,
            },
        ]
    );
}

#[tokio::test]
async fn refuses_an_agent_request_for_a_workspace_that_is_not_sandboxed_without_a_card() {
    let s = setup(Options {
        sandboxed: false,
        ..Options::default()
    });
    assert_eq!(
        s.requests.request(&ws(), "pane", "3000").await,
        Err(PortRequestError::NotSandboxed)
    );
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
}

#[tokio::test]
async fn answers_an_agent_request_for_an_exposed_port_without_a_card() {
    let s = setup(Options::default());
    s.forwarder.exposed.lock().push(3000);
    assert_eq!(
        s.requests.request(&ws(), "pane", "3000").await,
        Ok(PortGrant {
            port: 3000,
            notice: None,
        })
    );
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
}

#[tokio::test]
async fn answers_an_agent_that_no_terminal_runs_when_the_forwarder_refuses_for_that() {
    let s = setup(Options {
        refusal: Some(ExposeRefusal::NotRunning),
        ..Options::default()
    });
    assert_eq!(
        s.requests.request(&ws(), "pane", "3000").await,
        Err(PortRequestError::Expose(ExposeError::NotRunning))
    );
    assert_eq!(s.asked_ports(), Vec::<u16>::new());
}

#[tokio::test]
async fn asks_about_an_agent_request_with_the_pane_the_origin_and_the_program_a_scan_saw() {
    let s = setup(Options::default());
    s.listen(vec![node(3000)]);
    s.requests.scan(&ws()).await;
    s.forwarder.exposed.lock().clear();
    s.asks.lock().clear();
    assert_eq!(
        s.requests.request(&ws(), "pane-7", "3000").await,
        Ok(PortGrant {
            port: 3000,
            notice: None,
        })
    );
    assert_eq!(
        *s.asks.lock(),
        vec![PortAsk {
            workspace_id: ws(),
            pane_id: Some("pane-7".to_owned()),
            port: 3000,
            process: Some("node".to_owned()),
            origin: PortAskOrigin::Agent,
        }]
    );
    assert_eq!(s.exposed(), vec![3000]);
}

#[tokio::test]
async fn asks_about_a_new_listener_with_the_listener_origin_and_no_pane() {
    let s = with_policy(PortsPolicy::Ask);
    s.listen(vec![node(5173)]);
    s.requests.scan(&ws()).await;
    assert_eq!(
        *s.asks.lock(),
        vec![PortAsk {
            workspace_id: ws(),
            pane_id: None,
            port: 5173,
            process: Some("node".to_owned()),
            origin: PortAskOrigin::Listener,
        }]
    );
}

#[tokio::test]
async fn treats_only_the_workspace_and_session_answers_as_a_grant() {
    let rows = [
        (workspace(), true),
        (ApprovalOutcome::Answer(ApprovalAnswer::Session), true),
        (ApprovalOutcome::Answer(ApprovalAnswer::Once), false),
        (ApprovalOutcome::Answer(ApprovalAnswer::Always), false),
        (denied(), false),
        (ApprovalOutcome::Auto, false),
        (ApprovalOutcome::Timeout, false),
    ];
    for (outcome, granted) in rows {
        let s = setup(Options {
            outcome,
            ..Options::default()
        });
        let result = s.requests.request(&ws(), "pane", "3000").await;
        let expected = if granted {
            Ok(PortGrant {
                port: 3000,
                notice: None,
            })
        } else {
            Err(PortRequestError::Denied)
        };
        assert_eq!(result, expected, "{outcome:?}");
        assert_eq!(s.exposed().is_empty(), !granted, "{outcome:?}");

        let listener = setup(Options {
            outcome,
            ..Options::default()
        });
        listener.listen(vec![node(5173)]);
        listener.requests.scan(&ws()).await;
        assert_eq!(listener.exposed().is_empty(), !granted, "{outcome:?}");
    }
}

#[tokio::test]
async fn scans_nothing_on_macos_or_for_a_workspace_that_is_not_sandboxed() {
    let darwin = setup(Options {
        platform: Platform::Darwin,
        policy: PortsPolicy::Allow,
        ..Options::default()
    });
    darwin.listen(vec![node(5173)]);
    darwin.requests.scan(&ws()).await;
    assert!(darwin.exposed().is_empty());
    assert_eq!(darwin.requests.ports(&ws()), Vec::new());

    let plain = setup(Options {
        policy: PortsPolicy::Allow,
        sandboxed: false,
        ..Options::default()
    });
    plain.listen(vec![node(5173)]);
    plain.requests.scan(&ws()).await;
    assert!(plain.exposed().is_empty());
    assert_eq!(plain.requests.ports(&ws()), Vec::new());
}

#[tokio::test]
async fn forgets_the_human_mark_when_the_human_unexposes_a_port_or_its_process_exits() {
    let s = with_policy(PortsPolicy::Allow);
    s.listen(vec![running(3000, "node", 41), running(4000, "node", 42)]);
    s.requests.scan(&ws()).await;
    s.requests.expose_by_human(&ws(), 3000).await.unwrap();
    s.requests.expose_by_human(&ws(), 4000).await.unwrap();
    assert_eq!(
        s.requests.exposures(&ws(), None),
        vec![
            KeptExposure {
                by_human: true,
                ..kept(3000, 41)
            },
            KeptExposure {
                by_human: true,
                ..kept(4000, 42)
            },
        ]
    );
    s.requests.unexpose_by_human(&ws(), 3000).await;
    assert_eq!(s.exposed(), vec![4000]);
    s.forwarder.expose(&ws(), 3000).await.unwrap();
    s.listen(vec![running(3000, "node", 41)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.exposed(), vec![3000]);
    s.listen(vec![running(3000, "node", 41), running(4000, "node", 42)]);
    s.requests.scan(&ws()).await;
    assert_eq!(
        s.requests.exposures(&ws(), None),
        vec![kept(3000, 41), kept(4000, 42)]
    );
}

#[tokio::test]
async fn forgets_everything_it_knows_about_a_workspace() {
    let s = with_policy(PortsPolicy::Allow);
    s.listen(vec![running(3000, "node", 41)]);
    s.requests.scan(&ws()).await;
    s.requests.keep(&ws(), &[kept(4000, 42)]);
    s.requests.forget(&ws());
    assert_eq!(s.requests.ports(&ws()), Vec::new());
    assert_eq!(s.requests.exposures(&ws(), None), Vec::new());
    s.requests.keep(&ws(), &[kept(5000, 43)]);
    s.listen(vec![running(5000, "node", 43)]);
    s.forwarder.exposed.lock().clear();
    s.requests.scan(&ws()).await;
    assert_eq!(s.exposed(), vec![5000]);
}

#[tokio::test]
async fn keeps_the_first_list_of_kept_ports_and_ignores_a_second_one() {
    let s = with_policy(PortsPolicy::Ask);
    s.requests.keep(&ws(), &[kept(3000, 41)]);
    s.requests.keep(&ws(), &[kept(4000, 42)]);
    s.listen(vec![running(3000, "node", 41), running(4000, "node", 42)]);
    s.requests.scan(&ws()).await;
    assert_eq!(s.exposed(), vec![3000, 4000]);
    assert_eq!(s.asked_ports(), vec![4000]);
}
