#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_approvals::CapabilityStore;
use ostia_approvals::approvals::{
    ApprovalAsk, RegisterApprovals, RegisteredApprovals, read_approval_mode, register_approvals,
};
use ostia_base::clock::system_clock;
use ostia_base::host::Host;
use ostia_base::{PaneId, WindowId, WorkspaceId};
use ostia_contract::approvals::{ApprovalAnswer, ApprovalMode, ApprovalOutcome as Outcome};
use ostia_contract::capabilities::Capability;
use ostia_control::CapabilityStore as _;
use ostia_control::{
    ApprovalOutcome, ApprovalRequest, Approver, AuthedConn, ControlAuth, ControlAuthParts,
    IdRegistry, PaneIdentity, PaneInput,
};
use ostia_rpc::RpcError;
use ostia_testkit::temp_host;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::task::JoinHandle;

struct Bridge(ostia_approvals::approvals::Approvals);

impl Approver for Bridge {
    fn request(&self, request: ApprovalRequest) -> BoxFuture<'static, ApprovalOutcome> {
        let waiting = self.0.request(ApprovalAsk {
            external_id: request.external_id,
            window_id: request.window_id.as_str().to_owned(),
            pane_id: request.pane_id.as_str().to_owned(),
            workspace_id: request.workspace_id.as_str().to_owned(),
            caps: request.caps,
            action: request.action,
            detail: request.detail,
            kind: None,
            subject: None,
        });
        async move {
            match waiting.await {
                Outcome::Timeout => ApprovalOutcome::Timeout,
                Outcome::Answer(ApprovalAnswer::Deny) => ApprovalOutcome::Deny,
                _ => ApprovalOutcome::Allow,
            }
        }
        .boxed()
    }
}

struct World {
    _dir: TempDir,
    host: Host,
    registered: RegisteredApprovals,
    auth: Arc<ControlAuth>,
    identity: PaneIdentity,
    conn: AuthedConn,
    sent: Arc<Mutex<Vec<ostia_contract::approvals::ApprovalState>>>,
    settings_changed: Arc<AtomicUsize>,
}

fn world() -> World {
    let (dir, host) = temp_host().unwrap();
    fs::create_dir_all(host.app_config_dir()).unwrap();
    fs::write(host.app_config_dir().join("settings.json"), "{}").unwrap();
    let store = CapabilityStore::new(&host);
    let sent: Arc<Mutex<Vec<ostia_contract::approvals::ApprovalState>>> = Arc::default();
    let settings_changed = Arc::new(AtomicUsize::new(0));
    let registered = register_approvals(RegisterApprovals {
        host: host.clone(),
        caps: store.clone(),
        publish: Box::new({
            let sent = Arc::clone(&sent);
            move |_window_id, state| {
                sent.lock().push(state.clone());
                true
            }
        }),
        reveal: Box::new(|_window_id| {}),
        settings_changed: Box::new({
            let settings_changed = Arc::clone(&settings_changed);
            move || {
                settings_changed.fetch_add(1, Ordering::SeqCst);
            }
        }),
        opened: None,
        settled: None,
    });
    let registry = IdRegistry::new(b"approvals-int");
    let identity = registry.register_pane(PaneInput {
        window_id: WindowId::new("7"),
        workspace_id: WorkspaceId::new("ws-int"),
        pane_id: PaneId::new("pane-int"),
    });
    let auth = Arc::new(ControlAuth::new(ControlAuthParts {
        registry,
        caps: Arc::new(store.clone()),
        script_tokens: Arc::new(|_| None),
        cap_filter: Arc::new(|_, _| true),
        approver: Some(Arc::new(Bridge(registered.approvals.clone()))),
        clock: system_clock(),
    }));
    let conn = auth
        .authenticate(&json!({"token": identity.token}))
        .unwrap();
    store.init_caps(&conn.external_id);
    World {
        _dir: dir,
        host,
        registered,
        auth,
        identity,
        conn,
        sent,
        settings_changed,
    }
}

impl World {
    async fn ask(&self) -> JoinHandle<Result<(), RpcError>> {
        let auth = Arc::clone(&self.auth);
        let conn = self.conn.clone();
        let identity = self.identity.clone();
        let waiting = tokio::spawn(async move {
            auth.ensure_caps(
                &conn,
                &identity,
                &[Capability::SettingsWrite],
                "settings.set",
                "sidebar.showSSH",
            )
            .await
        });
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        waiting
    }

    fn pending_id(&self) -> String {
        self.registered.approvals.state_for("7").pending[0]
            .id
            .clone()
    }

    fn answer(&self, choice: &str) -> bool {
        self.registered
            .approvals
            .answer("7", &self.pending_id(), &json!(choice))
    }

    fn history(&self) -> Vec<ApprovalOutcome> {
        let mut outcomes: Vec<Outcome> = self
            .registered
            .approvals
            .state_for("7")
            .history
            .iter()
            .map(|r| r.outcome)
            .collect();
        outcomes.reverse();
        outcomes
            .into_iter()
            .map(|o| match o {
                Outcome::Answer(ApprovalAnswer::Deny) => ApprovalOutcome::Deny,
                Outcome::Timeout => ApprovalOutcome::Timeout,
                _ => ApprovalOutcome::Allow,
            })
            .collect()
    }

    fn settings(&self) -> Value {
        serde_json::from_str(
            &fs::read_to_string(self.host.app_config_dir().join("settings.json")).unwrap(),
        )
        .unwrap()
    }

    fn write_settings(&self, value: &Value) {
        fs::write(
            self.host.app_config_dir().join("settings.json"),
            serde_json::to_string(value).unwrap(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn an_agent_call_that_lacks_a_capability_waits_for_the_human_and_continues_once_allowed() {
    let w = world();
    let first = w.ask().await;
    assert!(!first.is_finished());
    let pending = w.registered.approvals.state_for("7").pending;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].caps, vec![Capability::SettingsWrite]);
    assert_eq!(pending[0].action, "settings.set");

    assert!(w.answer("once"));
    first.await.unwrap().unwrap();

    let second = w.ask().await;
    assert_eq!(w.registered.approvals.state_for("7").pending.len(), 1);
    assert!(w.answer("deny"));
    let error = second.await.unwrap().unwrap_err();
    assert_eq!(error.message, "denied: settings-write");

    assert_eq!(
        w.history(),
        vec![ApprovalOutcome::Allow, ApprovalOutcome::Deny]
    );
    assert!(w.sent.lock().last().unwrap().pending.is_empty());
}

#[tokio::test]
async fn always_allow_saves_the_grant_stops_asking_and_remove_in_settings_asks_again() {
    let w = world();
    let first = w.ask().await;
    assert!(w.answer("always"));
    first.await.unwrap().unwrap();

    assert_eq!(
        w.settings()["capabilities"]["grants"],
        json!(["settings-write"])
    );

    let again = w.ask().await;
    assert!(w.registered.approvals.state_for("7").pending.is_empty());
    again.await.unwrap().unwrap();

    assert!(w.registered.remove_always(&json!("settings-write")));
    assert_eq!(w.settings()["capabilities"]["grants"], json!([]));

    let third = w.ask().await;
    assert_eq!(w.registered.approvals.state_for("7").pending.len(), 1);
    assert!(w.answer("deny"));
    assert_eq!(
        third.await.unwrap().unwrap_err().message,
        "denied: settings-write"
    );
}

#[tokio::test]
async fn always_allow_and_remove_always_tell_the_settings_listener() {
    let w = world();
    let first = w.ask().await;
    assert!(w.answer("always"));
    first.await.unwrap().unwrap();
    assert_eq!(w.settings_changed.load(Ordering::SeqCst), 1);

    assert!(w.registered.remove_always(&json!("settings-write")));
    assert_eq!(w.settings_changed.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn remove_always_refuses_a_name_that_is_not_a_capability() {
    let w = world();
    assert!(!w.registered.remove_always(&json!("not-a-capability")));
    assert!(!w.registered.remove_always(&json!(7)));
    assert!(!w.registered.remove_always(&Value::Null));
    assert_eq!(w.settings_changed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn set_reach_saves_the_mode_for_a_window_and_refuses_any_other_sender() {
    let w = world();
    assert!(!w.registered.set_reach(false, &json!("group")));
    assert_eq!(w.settings_changed.load(Ordering::SeqCst), 0);
    assert!(!w.registered.set_reach(true, &json!("galaxy")));
    assert_eq!(w.settings_changed.load(Ordering::SeqCst), 0);

    assert!(w.registered.set_reach(true, &json!("group")));
    assert_eq!(w.settings_changed.load(Ordering::SeqCst), 1);
    assert_eq!(w.settings()["capabilities"]["reach"], json!("group"));
}

#[tokio::test]
async fn an_allow_mode_in_settings_lets_a_request_through_and_ask_is_the_default() {
    let w = world();
    let held = w.registered.approvals.request(ApprovalAsk {
        external_id: w.conn.external_id.clone(),
        window_id: "7".to_owned(),
        pane_id: "pane-int".to_owned(),
        workspace_id: "ws-int".to_owned(),
        caps: vec![Capability::Browse],
        action: "browser.open".to_owned(),
        detail: "{}".to_owned(),
        kind: None,
        subject: None,
    });
    let held = tokio::spawn(held);
    tokio::task::yield_now().await;
    assert_eq!(w.registered.approvals.state_for("7").pending.len(), 1);
    w.registered
        .approvals
        .answer("7", &w.pending_id(), &json!("deny"));
    held.await.unwrap();

    w.write_settings(&json!({"approvals": {"mode": "allow"}}));
    let auto = w.registered.approvals.request(ApprovalAsk {
        external_id: w.conn.external_id.clone(),
        window_id: "7".to_owned(),
        pane_id: "pane-int".to_owned(),
        workspace_id: "ws-int".to_owned(),
        caps: vec![Capability::Browse],
        action: "browser.open".to_owned(),
        detail: "{}".to_owned(),
        kind: None,
        subject: None,
    });
    assert_eq!(auto.await, Outcome::Auto);
}

#[test]
fn read_approval_mode_reads_the_mode_and_falls_back_to_ask() {
    let rows: Vec<(&str, Option<&str>, ApprovalMode)> = vec![
        ("no settings file", None, ApprovalMode::Ask),
        ("empty object", Some("{}"), ApprovalMode::Ask),
        (
            "allow",
            Some(r#"{"approvals":{"mode":"allow"}}"#),
            ApprovalMode::Allow,
        ),
        (
            "ask",
            Some(r#"{"approvals":{"mode":"ask"}}"#),
            ApprovalMode::Ask,
        ),
        (
            "unknown mode",
            Some(r#"{"approvals":{"mode":"yolo"}}"#),
            ApprovalMode::Ask,
        ),
        (
            "approvals is not an object",
            Some(r#"{"approvals":"allow"}"#),
            ApprovalMode::Ask,
        ),
        ("broken json", Some("{not json"), ApprovalMode::Ask),
        ("a json array", Some("[1]"), ApprovalMode::Ask),
    ];
    for (name, text, expected) in rows {
        let (_dir, host) = temp_host().unwrap();
        fs::create_dir_all(host.app_config_dir()).unwrap();
        if let Some(text) = text {
            fs::write(host.app_config_dir().join("settings.json"), text).unwrap();
        }
        assert_eq!(read_approval_mode(&host), expected, "{name}");
    }
}
