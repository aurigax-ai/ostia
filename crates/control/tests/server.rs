#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_base::clock::system_clock;
use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_contract::SANDBOXED_REFUSAL;
use ostia_contract::capabilities::Capability;
use ostia_contract::terminal_state::TerminalStateSnapshot;
use ostia_control::foreign_sandbox::proc_fs;
use ostia_control::identity::stable_pane_external_id;
use ostia_control::server::ReadProc;
use ostia_control::{
    ApprovalOutcome, ApprovalRequest, Approver, AuthedConn, Callers, CapabilityStore, ControlAuth,
    ControlAuthParts, ControlListener, ControlMethod, ControlServer, IdRegistry, MethodRefused,
    MethodTable, PaneIdentity, PaneInput, ScriptTokenGrant, ServerDeps,
};
use ostia_rpc::{Client, ClientError, RpcError, codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

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

struct FixedAnswer(ApprovalOutcome, Mutex<Vec<ApprovalRequest>>);

impl Approver for FixedAnswer {
    fn request(&self, request: ApprovalRequest) -> BoxFuture<'static, ApprovalOutcome> {
        self.1.lock().push(request);
        let outcome = self.0;
        async move { outcome }.boxed()
    }
}

struct Fixture {
    _dir: TempDir,
    socket: PathBuf,
    registry: IdRegistry,
    grants: Arc<Grants>,
    listener: ControlListener,
}

const SCRIPT_TOKEN: &str = "ostia_script_token";

fn methods() -> MethodTable {
    let mut table = MethodTable::default();
    table
        .register(
            "test.echo",
            ControlMethod::new(|params, _ctx| async move { Ok(params) }),
        )
        .unwrap();
    table
        .register(
            "test.shell",
            ControlMethod::new(|_params, _ctx| async move { Ok(json!("ran")) })
                .cap(Capability::Shell),
        )
        .unwrap();
    table
        .register(
            "test.extensions",
            ControlMethod::new(|_params, _ctx| async move { Ok(json!("ran")) })
                .callers(Callers::Extensions),
        )
        .unwrap();
    table
        .register(
            "test.target",
            ControlMethod::new(|params, ctx| async move {
                Ok(json!({"pane": ctx.identity.pane_id, "params": params}))
            })
            .targetable(),
        )
        .unwrap();
    for name in ["process.run", "pane.input"] {
        table
            .register(
                name,
                ControlMethod::new(|_params, _ctx| async move { Ok(json!("ran")) }),
            )
            .unwrap();
    }
    table
        .register(
            "test.failing",
            ControlMethod::new(
                |_params, _ctx| async move { Err::<Value, _>(RpcError::thrown("boom")) },
            ),
        )
        .unwrap();
    table
        .register(
            "test.waitCancel",
            ControlMethod::new(|_params, ctx| async move {
                ctx.cancel.cancelled().await;
                Ok(json!("cancelled"))
            }),
        )
        .unwrap();
    table
        .register(
            "test.askClient",
            ControlMethod::new(|_params, ctx| async move {
                ctx.conn.request("client.ping", None).await
            }),
        )
        .unwrap();
    table
}

fn fixture(approver: Option<Arc<dyn Approver>>) -> Fixture {
    fixture_with(approver, None, Arc::new(proc_fs))
}

fn fixture_with(
    approver: Option<Arc<dyn Approver>>,
    shell_pid: Option<i32>,
    read_proc: ReadProc,
) -> Fixture {
    fixture_versioned(approver, shell_pid, read_proc, Some("9.9.9".to_owned()))
}

fn fixture_versioned(
    approver: Option<Arc<dyn Approver>>,
    shell_pid: Option<i32>,
    read_proc: ReadProc,
    version: Option<String>,
) -> Fixture {
    let dir = TempDir::new().unwrap();
    let socket = dir.path().join("c.sock");
    let registry = IdRegistry::new(&[1; 32]);
    let grants = Arc::new(Grants::default());
    let auth = Arc::new(ControlAuth::new(ControlAuthParts {
        registry: registry.clone(),
        caps: grants.clone(),
        script_tokens: Arc::new(|token| {
            (token == SCRIPT_TOKEN).then(|| ScriptTokenGrant {
                id: "script-1".to_owned(),
                caps: vec![Capability::ReadBoard],
                expires_at_ms: None,
            })
        }),
        cap_filter: Arc::new(|_, _| true),
        approver,
        clock: system_clock(),
    }));
    let deps = ServerDeps {
        auth,
        version,
        is_sandboxed: Arc::new(|_| false),
        pty_pid: Arc::new(move |_| shell_pid),
        terminal_state: Arc::new(|pane: &PaneId| {
            Some(TerminalStateSnapshot {
                pane_id: pane.clone(),
                generation: 1,
                cwd: Some("/work".to_owned()),
                running: false,
                block_count: 0,
                last_exit_code: None,
                remote: None,
            })
        }),
        script_covers: Arc::new(|_, _, _| async { false }.boxed()),
        read_proc,
    };
    let listener = ControlServer::new(deps, methods()).listen(&socket).unwrap();
    Fixture {
        _dir: dir,
        socket,
        registry,
        grants,
        listener,
    }
}

fn pane(fixture: &Fixture, id: &str) -> PaneIdentity {
    fixture.registry.register_pane(PaneInput {
        window_id: WindowId::new("w1"),
        workspace_id: WorkspaceId::new("s1"),
        pane_id: PaneId::new(id),
    })
}

async fn connected(fixture: &Fixture, token: &str) -> Client {
    let client = Client::connect(&fixture.socket).await.unwrap();
    client
        .request("hello", Some(&json!({"token": token})))
        .await
        .unwrap();
    client
}

fn rpc_error(result: Result<Value, ClientError>) -> RpcError {
    match result {
        Err(ClientError::Rpc(error)) => error,
        other => panic!("expected an rpc error, got {other:?}"),
    }
}

#[test]
fn a_stable_pane_id_is_the_same_as_the_ts_one() {
    assert_eq!(
        stable_pane_external_id(&[1; 32], &PaneId::new("p1")).as_str(),
        "3de081bb-401f-43a7-8d3d-ff492a3f06fc"
    );
}

#[tokio::test]
async fn accepts_hello_with_the_real_token_and_serves_whoami() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = Client::connect(&fixture.socket).await.unwrap();
    let hello = client
        .request("hello", Some(&json!({"token": identity.token})))
        .await
        .unwrap();
    assert_eq!(
        hello,
        json!({"externalId": identity.external_id, "version": "9.9.9"})
    );
    let who = client.request("whoami", None).await.unwrap();
    assert_eq!(
        who.to_string(),
        json!({"externalId": identity.external_id, "paneId": "p1", "workspaceId": "s1"})
            .to_string()
    );
}

#[tokio::test]
async fn leaves_the_version_out_of_hello_when_it_is_empty() {
    let fixture = fixture_versioned(None, None, Arc::new(proc_fs), Some(String::new()));
    let identity = pane(&fixture, "p1");
    let client = Client::connect(&fixture.socket).await.unwrap();
    let hello = client
        .request("hello", Some(&json!({"token": identity.token})))
        .await
        .unwrap();
    assert_eq!(hello, json!({"externalId": identity.external_id}));
}

#[tokio::test]
async fn rejects_hello_with_a_bogus_or_missing_token() {
    let fixture = fixture(None);
    let client = Client::connect(&fixture.socket).await.unwrap();
    for params in [json!({"token": "bogus"}), json!({"token": 123}), json!({})] {
        let error = rpc_error(client.request("hello", Some(&params)).await);
        assert_eq!(error.code, codes::INVALID_REQUEST);
        assert_eq!(error.message, "invalid or missing token");
    }
}

#[tokio::test]
async fn rejects_whoami_before_a_successful_hello() {
    let fixture = fixture(None);
    let client = Client::connect(&fixture.socket).await.unwrap();
    let error = rpc_error(client.request("whoami", None).await);
    assert_eq!(error.message, "call hello first");
}

#[tokio::test]
async fn a_failed_second_hello_drops_the_first_login() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    rpc_error(
        client
            .request("hello", Some(&json!({"token": "bogus"})))
            .await,
    );
    assert_eq!(
        rpc_error(client.request("whoami", None).await).message,
        "call hello first"
    );
}

#[tokio::test]
async fn an_unknown_method_gets_the_library_answer() {
    let fixture = fixture(None);
    let client = Client::connect(&fixture.socket).await.unwrap();
    let error = rpc_error(client.request("no.such", None).await);
    assert_eq!(error.code, codes::METHOD_NOT_FOUND);
    assert_eq!(error.message, "Unhandled method no.such");
}

#[tokio::test]
async fn a_handler_error_gets_the_library_wording() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    let error = rpc_error(client.request("test.failing", None).await);
    assert_eq!(error.code, codes::INTERNAL_ERROR);
    assert_eq!(
        error.message,
        "Request test.failing failed with message: boom"
    );
}

#[tokio::test]
async fn params_reach_the_handler_as_the_ts_reader_gives_them() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    assert_eq!(client.request("test.echo", None).await.unwrap(), json!({}));
    assert_eq!(
        client
            .request("test.echo", Some(&json!([{"a": 1}, 2])))
            .await
            .unwrap(),
        json!({"a": 1})
    );
    assert_eq!(
        client
            .request("test.echo", Some(&json!(null)))
            .await
            .unwrap(),
        json!(null)
    );
}

#[tokio::test]
async fn a_method_with_a_cap_is_refused_without_an_approver() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    let error = rpc_error(client.request("test.shell", None).await);
    assert_eq!(error.code, codes::INVALID_REQUEST);
    assert_eq!(error.message, "needs-elevation: shell");
    fixture
        .grants
        .set_caps(&identity.external_id, &[Capability::Shell]);
    assert_eq!(
        client.request("test.shell", None).await.unwrap(),
        json!("ran")
    );
}

#[tokio::test]
async fn an_approver_answer_decides_a_missing_cap() {
    for (outcome, message) in [
        (ApprovalOutcome::Allow, None),
        (ApprovalOutcome::Deny, Some("denied: shell")),
        (ApprovalOutcome::Timeout, Some("not-approved: shell")),
    ] {
        let approver = Arc::new(FixedAnswer(outcome, Mutex::default()));
        let fixture = fixture(Some(approver.clone()));
        let identity = pane(&fixture, "p1");
        let client = connected(&fixture, &identity.token).await;
        let result = client.request("test.shell", Some(&json!({"a": 1}))).await;
        match message {
            None => assert_eq!(result.unwrap(), json!("ran")),
            Some(message) => {
                let error = rpc_error(result);
                assert_eq!(error.message, message);
                let hint = error.data.unwrap()["hint"].as_str().unwrap().to_owned();
                assert!(hint.contains("shell lets you type commands into terminals"));
            }
        }
        let requests = approver.1.lock();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].action, "test.shell");
        assert_eq!(requests[0].detail, r#"{"a":1}"#);
    }
}

#[tokio::test]
async fn a_method_for_extensions_refuses_a_pane_and_a_script_needs_a_scripts_method() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    assert_eq!(
        rpc_error(client.request("test.extensions", None).await).message,
        "not-available-to-pane"
    );
    let script = connected(&fixture, SCRIPT_TOKEN).await;
    assert_eq!(
        rpc_error(script.request("test.echo", None).await).message,
        "not-available-to-script"
    );
    assert_eq!(
        script.request("whoami", None).await.unwrap()["kind"],
        json!("script")
    );
    let extension = fixture.registry.register_extension("activity");
    let client = connected(&fixture, &extension.token).await;
    assert_eq!(
        client.request("test.extensions", None).await.unwrap(),
        json!("ran")
    );
    assert_eq!(
        client.request("whoami", None).await.unwrap()["extensionId"],
        json!("activity")
    );
}

#[tokio::test]
async fn an_extension_acts_for_a_pane_only_with_all_workspaces_and_a_real_target() {
    let fixture = fixture(None);
    let target = pane(&fixture, "p1");
    let extension = fixture.registry.register_extension("ext");
    let client = connected(&fixture, &extension.token).await;
    let params = json!({"targetPaneId": target.external_id, "x": 1});
    assert_eq!(
        rpc_error(client.request("test.target", Some(&params)).await).message,
        "needs-elevation: all-workspaces"
    );
    fixture
        .grants
        .set_caps(&extension.external_id, &[Capability::AllWorkspaces]);
    assert_eq!(
        client.request("test.target", Some(&params)).await.unwrap(),
        json!({"pane": "p1", "params": {"x": 1}})
    );
    assert_eq!(
        rpc_error(client.request("test.target", Some(&json!({"x": 1}))).await).message,
        "needs-target: targetPaneId"
    );
    assert_eq!(
        rpc_error(
            client
                .request("test.target", Some(&json!({"targetPaneId": "nope"})))
                .await
        )
        .message,
        "unknown-target: nope"
    );
}

#[tokio::test]
async fn pane_info_answers_for_the_caller_and_a_script_stays_in_scope() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    let info = client.request("pane.info", None).await.unwrap();
    assert_eq!(info["cwd"], json!("/work"));
    assert_eq!(info["paneId"], json!("p1"));
    let script = connected(&fixture, SCRIPT_TOKEN).await;
    assert_eq!(
        rpc_error(script.request("pane.info", None).await).message,
        "bad-request: paneId"
    );
    let params = json!({"paneId": identity.external_id});
    assert_eq!(
        script.request("pane.info", Some(&params)).await.unwrap(),
        json!(null)
    );
}

#[tokio::test]
async fn a_hello_and_a_call_sent_together_run_in_order() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let mut stream = UnixStream::connect(&fixture.socket).await.unwrap();
    let mut bytes = ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {"token": identity.token}}),
    );
    bytes.extend(ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "id": 2, "method": "whoami"}),
    ));
    stream.write_all(&bytes).await.unwrap();
    let mut text = String::new();
    let mut buffer = [0u8; 4096];
    while !text.contains(r#""id":2"#) {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0, "closed: {text}");
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
    }
    assert!(text.contains(r#""paneId":"p1""#), "{text}");
}

#[tokio::test]
async fn a_cancel_notification_reaches_the_handler() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let mut stream = UnixStream::connect(&fixture.socket).await.unwrap();
    let mut bytes = ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {"token": identity.token}}),
    );
    bytes.extend(ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "id": 2, "method": "test.waitCancel"}),
    ));
    bytes.extend(ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 2}}),
    ));
    stream.write_all(&bytes).await.unwrap();
    let mut text = String::new();
    let mut buffer = [0u8; 4096];
    while !text.contains("cancelled") {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0, "closed: {text}");
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
    }
}

#[tokio::test]
async fn a_message_over_the_cap_closes_the_connection() {
    let fixture = fixture(None);
    let mut stream = UnixStream::connect(&fixture.socket).await.unwrap();
    stream
        .write_all(b"Content-Length: 99999999999\r\n\r\n")
        .await
        .unwrap();
    let mut buffer = [0u8; 16];
    assert_eq!(stream.read(&mut buffer).await.unwrap(), 0);
}

#[tokio::test]
async fn the_server_can_ask_the_client_and_gets_the_answer() {
    let fixture = fixture(None);
    let identity = pane(&fixture, "p1");
    let mut stream = UnixStream::connect(&fixture.socket).await.unwrap();
    let mut bytes = ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {"token": identity.token}}),
    );
    bytes.extend(ostia_rpc::encode_frame(
        &json!({"jsonrpc": "2.0", "id": 2, "method": "test.askClient"}),
    ));
    stream.write_all(&bytes).await.unwrap();
    let mut text = String::new();
    let mut buffer = [0u8; 4096];
    while !text.contains("client.ping") {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0, "closed: {text}");
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
    }
    stream
        .write_all(&ostia_rpc::encode_frame(
            &json!({"jsonrpc": "2.0", "id": 0, "result": "pong"}),
        ))
        .await
        .unwrap();
    while !text.contains("pong") {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0, "closed: {text}");
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
    }
}

#[tokio::test]
async fn the_socket_is_0600_and_stop_removes_it() {
    let fixture = fixture(None);
    let mode = fs::metadata(&fixture.socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let path = fixture.socket.clone();
    fixture.listener.stop();
    assert!(!path.exists());
}

#[tokio::test]
async fn the_socket_folder_keeps_no_temp_entry_and_the_moved_socket_still_accepts() {
    let fixture = fixture(None);
    let names: Vec<_> = fs::read_dir(fixture._dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["c.sock"]);
    let identity = pane(&fixture, "p1");
    connected(&fixture, &identity.token).await;
}

#[tokio::test]
async fn an_approval_card_shows_no_detail_for_a_call_without_params() {
    let approver = Arc::new(FixedAnswer(ApprovalOutcome::Allow, Mutex::default()));
    let fixture = fixture(Some(approver.clone()));
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    client.request("test.shell", None).await.unwrap();
    client
        .request("test.shell", Some(&json!([])))
        .await
        .unwrap();
    client
        .request("test.shell", Some(&json!(null)))
        .await
        .unwrap();
    let details: Vec<String> = approver
        .1
        .lock()
        .iter()
        .map(|request| request.detail.clone())
        .collect();
    assert_eq!(details, ["", "", "null"]);
}

#[test]
fn a_method_cannot_take_a_name_the_server_answers_itself() {
    let mut table = MethodTable::default();
    for name in [
        "hello",
        "whoami",
        "pane.info",
        "command.list",
        "command.exec",
        "cwd.get",
    ] {
        let refused = table.register(
            name,
            ControlMethod::new(|_params, _ctx| async move { Ok(json!(1)) }),
        );
        assert!(matches!(refused, Err(MethodRefused::BuiltIn(_))), "{name}");
    }
    table
        .register(
            "a",
            ControlMethod::new(|_params, _ctx| async move { Ok(json!(1)) }),
        )
        .unwrap();
    let again = table.register(
        "a",
        ControlMethod::new(|_params, _ctx| async move { Ok(json!(1)) }),
    );
    assert!(matches!(again, Err(MethodRefused::AlreadyRegistered(_))));
}

#[test]
fn debug_output_hides_the_session_token() {
    let conn = AuthedConn {
        external_id: ExternalId::new("e"),
        pane_id: PaneId::default(),
        workspace_id: WorkspaceId::default(),
        script_session: Some("secret-session".to_owned()),
    };
    assert!(!format!("{conn:?}").contains("secret-session"));
}

fn world(peer_seccomp: u32, shell_seccomp: u32) -> ReadProc {
    let peer = format!("/proc/{}/", std::process::id());
    let rest = (0..19).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
    Arc::new(move |path: &str| {
        if path.ends_with("/stat") {
            return Some(format!("1 (x) {rest} 100 1"));
        }
        let mode = if path.starts_with(&peer) {
            peer_seccomp
        } else {
            shell_seccomp
        };
        Some(format!("Seccomp:\t{mode}\n"))
    })
}

#[tokio::test]
async fn a_kernel_sandboxed_peer_is_refused_a_call_that_leaves_the_sandbox() {
    let fixture = fixture_with(None, Some(7), world(2, 0));
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    let error = rpc_error(client.request("process.run", None).await);
    assert_eq!(error.code, codes::INVALID_REQUEST);
    assert_eq!(error.message, SANDBOXED_REFUSAL);
    let other = json!({"pane": "other"});
    assert_eq!(
        rpc_error(client.request("pane.input", Some(&other)).await).message,
        SANDBOXED_REFUSAL
    );
    let own = json!({"pane": identity.external_id});
    assert_eq!(
        client.request("pane.input", Some(&own)).await.unwrap(),
        json!("ran")
    );
    assert_eq!(
        client.request("test.echo", Some(&json!(1))).await.unwrap(),
        json!(1)
    );
}

#[tokio::test]
async fn a_peer_filtered_like_its_shell_or_not_filtered_passes() {
    for (peer, shell) in [(2, 2), (0, 0)] {
        let fixture = fixture_with(None, Some(7), world(peer, shell));
        let identity = pane(&fixture, "p1");
        let client = connected(&fixture, &identity.token).await;
        assert_eq!(
            client.request("process.run", None).await.unwrap(),
            json!("ran")
        );
    }
}

#[tokio::test]
async fn a_filtered_peer_with_no_known_shell_is_refused() {
    let fixture = fixture_with(None, None, world(2, 0));
    let identity = pane(&fixture, "p1");
    let client = connected(&fixture, &identity.token).await;
    assert_eq!(
        rpc_error(client.request("process.run", None).await).message,
        SANDBOXED_REFUSAL
    );
}
