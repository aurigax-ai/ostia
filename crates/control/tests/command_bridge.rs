#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use ostia_base::{PaneId, WindowId, WorkspaceId};
use ostia_contract::commands::{CommandDescriptor, TargetMode};
use ostia_contract::terminal_state::TerminalStateSnapshot;
use ostia_control::command_bridge::{
    CommandBridge, CommandBridgeDeps, CommandInvoke, CommandResult, CommandSource, CommandTarget,
    CommandWindows, OpenTerminalRequest,
};
use ostia_control::{IdRegistry, IdentityKind};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::time::Instant;

#[derive(Default)]
struct FakeWindows {
    open: Mutex<HashSet<WindowId>>,
    main: Mutex<Option<WindowId>>,
    commands: Mutex<Vec<(WindowId, String, CommandInvoke)>>,
    terminals: Mutex<Vec<(WindowId, Value)>>,
}

impl CommandWindows for FakeWindows {
    fn is_open(&self, window: &WindowId) -> bool {
        self.open.lock().contains(window)
    }

    fn main_window(&self) -> Option<WindowId> {
        self.main.lock().clone()
    }

    fn send_command(&self, window: &WindowId, request_id: &str, invoke: &CommandInvoke) {
        self.commands
            .lock()
            .push((window.clone(), request_id.to_owned(), invoke.clone()));
    }

    fn send_open_terminal(&self, window: &WindowId, payload: &Value) {
        self.terminals
            .lock()
            .push((window.clone(), payload.clone()));
    }
}

struct Fixture {
    bridge: Arc<CommandBridge>,
    windows: Arc<FakeWindows>,
    registry: IdRegistry,
    commands_by_window: Arc<Mutex<HashMap<WindowId, Vec<CommandDescriptor>>>>,
    terminal_state: Arc<Mutex<HashMap<PaneId, TerminalStateSnapshot>>>,
}

fn fixture() -> Fixture {
    let windows = Arc::new(FakeWindows::default());
    windows.open.lock().insert(WindowId::new("w1"));
    windows.open.lock().insert(WindowId::new("w2"));
    *windows.main.lock() = Some(WindowId::new("w1"));
    let registry = IdRegistry::new(&[9; 32]);
    let commands_by_window: Arc<Mutex<HashMap<WindowId, Vec<CommandDescriptor>>>> = Arc::default();
    let terminal_state: Arc<Mutex<HashMap<PaneId, TerminalStateSnapshot>>> = Arc::default();
    let bridge = Arc::new(CommandBridge::new(CommandBridgeDeps {
        commands_by_window: commands_by_window.clone(),
        terminal_state: terminal_state.clone(),
        windows: windows.clone(),
        workspace_window: Arc::new(|workspace: &WorkspaceId| {
            (workspace.as_str() == "s2").then(|| WindowId::new("w2"))
        }),
        registry: registry.clone(),
    }));
    Fixture {
        bridge,
        windows,
        registry,
        commands_by_window,
        terminal_state,
    }
}

fn descriptor(id: &str) -> CommandDescriptor {
    CommandDescriptor {
        id: id.to_owned(),
        title: id.to_owned(),
        category: None,
        hidden: false,
        args_schema: None,
        result_schema: None,
        capabilities: Vec::new(),
        target: TargetMode::None,
        extension: None,
    }
}

fn snapshot(pane: &str) -> TerminalStateSnapshot {
    TerminalStateSnapshot {
        pane_id: PaneId::new(pane),
        generation: 3,
        cwd: Some("/work".to_owned()),
        running: true,
        block_count: 2,
        last_exit_code: None,
        remote: None,
    }
}

fn target(window: Option<&str>) -> CommandTarget {
    CommandTarget {
        window_id: window.map(WindowId::new),
        workspace_id: WorkspaceId::new("s1"),
        pane_id: None,
    }
}

fn ok(value: Value) -> CommandResult {
    CommandResult::Ok(value)
}

async fn settle() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

#[test]
fn list_commands_for_returns_the_commands_a_window_published() {
    let fx = fixture();
    fx.commands_by_window
        .lock()
        .insert(WindowId::new("w1"), vec![descriptor("a"), descriptor("b")]);
    let ids: Vec<String> = fx
        .bridge
        .list_commands_for(&WindowId::new("w1"))
        .into_iter()
        .map(|command| command.id)
        .collect();
    assert_eq!(ids, ["a", "b"]);
}

#[test]
fn list_commands_for_is_empty_for_a_window_that_published_nothing() {
    let fx = fixture();
    assert!(fx.bridge.list_commands_for(&WindowId::new("w9")).is_empty());
}

#[test]
fn get_terminal_state_returns_the_snapshot_of_a_pane() {
    let fx = fixture();
    fx.terminal_state
        .lock()
        .insert(PaneId::new("p1"), snapshot("p1"));
    assert_eq!(
        fx.bridge.get_terminal_state(&PaneId::new("p1")),
        Some(snapshot("p1"))
    );
}

#[test]
fn get_terminal_state_is_none_for_a_pane_without_a_snapshot() {
    let fx = fixture();
    assert_eq!(fx.bridge.get_terminal_state(&PaneId::new("p9")), None);
}

#[tokio::test(start_paused = true)]
async fn exec_command_resolves_with_the_result_the_window_sends_back() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .exec_command(
                target(Some("w2")),
                "pane.list",
                Some(json!({"a": 1})),
                false,
                None,
            )
            .await
    });
    settle().await;
    let (window, request_id, invoke) = fx.windows.commands.lock()[0].clone();
    assert_eq!(window, WindowId::new("w2"));
    assert_eq!(request_id, "cmd-1");
    assert_eq!(invoke.id, "pane.list");
    assert_eq!(invoke.args, Some(json!({"a": 1})));
    assert_eq!(invoke.target, target(Some("w2")));
    fx.bridge.command_result(&request_id, ok(json!({"n": 2})));
    assert_eq!(call.await.unwrap(), ok(json!({"n": 2})));
}

#[tokio::test(start_paused = true)]
async fn exec_command_sends_from_main_and_source_only_when_given() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let plain = tokio::spawn({
        let bridge = Arc::clone(&bridge);
        async move {
            bridge
                .exec_command(target(None), "a", None, false, None)
                .await
        }
    });
    let flagged = tokio::spawn({
        let bridge = Arc::clone(&bridge);
        async move {
            bridge
                .exec_command(target(None), "b", None, true, Some(CommandSource::Phone))
                .await
        }
    });
    settle().await;
    let sent = fx.windows.commands.lock().clone();
    let find = |id: &str| {
        sent.iter()
            .find(|(_, _, invoke)| invoke.id == id)
            .unwrap()
            .clone()
    };
    let (_, plain_request, plain_invoke) = find("a");
    let (_, flagged_request, flagged_invoke) = find("b");
    assert!(!plain_invoke.from_main);
    assert_eq!(plain_invoke.source, None);
    assert!(flagged_invoke.from_main);
    assert_eq!(flagged_invoke.source, Some(CommandSource::Phone));
    fx.bridge.command_result(&plain_request, ok(json!(null)));
    fx.bridge.command_result(&flagged_request, ok(json!(null)));
    plain.await.unwrap();
    flagged.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn exec_command_uses_the_main_window_when_the_target_names_no_window() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .exec_command(target(None), "a", None, false, None)
            .await
    });
    settle().await;
    let (window, request_id, _) = fx.windows.commands.lock()[0].clone();
    assert_eq!(window, WindowId::new("w1"));
    fx.bridge.command_result(&request_id, ok(json!(1)));
    call.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn exec_command_gives_each_request_its_own_id() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let first = tokio::spawn({
        let bridge = Arc::clone(&bridge);
        async move {
            bridge
                .exec_command(target(None), "a", None, false, None)
                .await
        }
    });
    settle().await;
    let second = tokio::spawn({
        let bridge = Arc::clone(&bridge);
        async move {
            bridge
                .exec_command(target(None), "b", None, false, None)
                .await
        }
    });
    settle().await;
    let ids: Vec<String> = fx
        .windows
        .commands
        .lock()
        .iter()
        .map(|(_, request_id, _)| request_id.clone())
        .collect();
    assert_eq!(ids, ["cmd-1", "cmd-2"]);
    fx.bridge.command_result("cmd-2", ok(json!("second")));
    fx.bridge.command_result("cmd-1", ok(json!("first")));
    assert_eq!(first.await.unwrap(), ok(json!("first")));
    assert_eq!(second.await.unwrap(), ok(json!("second")));
}

#[tokio::test(start_paused = true)]
async fn exec_command_ignores_a_result_that_carries_another_request_id() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .exec_command(target(None), "a", None, false, None)
            .await
    });
    settle().await;
    fx.bridge.command_result("cmd-77", ok(json!("wrong")));
    settle().await;
    assert!(!call.is_finished());
    fx.bridge.command_result("cmd-1", ok(json!("right")));
    assert_eq!(call.await.unwrap(), ok(json!("right")));
}

#[tokio::test(start_paused = true)]
async fn exec_command_takes_only_the_first_result_for_a_request() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .exec_command(target(None), "a", None, false, None)
            .await
    });
    settle().await;
    fx.bridge.command_result("cmd-1", ok(json!("first")));
    fx.bridge.command_result("cmd-1", ok(json!("second")));
    assert_eq!(call.await.unwrap(), ok(json!("first")));
}

#[tokio::test(start_paused = true)]
async fn exec_command_passes_a_failed_result_through() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .exec_command(target(None), "a", None, false, None)
            .await
    });
    settle().await;
    let failure = CommandResult::Err {
        code: "unknown-command".to_owned(),
        message: "no such command".to_owned(),
    };
    fx.bridge.command_result("cmd-1", failure.clone());
    assert_eq!(call.await.unwrap(), failure);
}

#[tokio::test(start_paused = true)]
async fn exec_command_fails_after_5_seconds_when_the_window_never_answers() {
    let fx = fixture();
    let started = Instant::now();
    let result = fx
        .bridge
        .exec_command(target(None), "a", None, false, None)
        .await;
    assert_eq!(
        result,
        CommandResult::Err {
            code: "command-failed".to_owned(),
            message: "command timed out".to_owned()
        }
    );
    assert_eq!(started.elapsed(), Duration::from_millis(5000));
}

#[tokio::test(start_paused = true)]
async fn exec_command_ignores_a_result_that_arrives_after_the_timeout() {
    let fx = fixture();
    fx.bridge
        .exec_command(target(None), "a", None, false, None)
        .await;
    fx.bridge.command_result("cmd-1", ok(json!("late")));
    let bridge = Arc::clone(&fx.bridge);
    let next = tokio::spawn(async move {
        bridge
            .exec_command(target(None), "b", None, false, None)
            .await
    });
    settle().await;
    fx.bridge.command_result("cmd-2", ok(json!("on time")));
    assert_eq!(next.await.unwrap(), ok(json!("on time")));
}

#[tokio::test(start_paused = true)]
async fn exec_command_fails_at_once_when_the_target_window_is_not_available() {
    let fx = fixture();
    let started = Instant::now();
    let result = fx
        .bridge
        .exec_command(target(Some("w9")), "a", None, false, None)
        .await;
    assert_eq!(
        result,
        CommandResult::Err {
            code: "command-failed".to_owned(),
            message: "target window not available".to_owned()
        }
    );
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert!(fx.windows.commands.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn exec_command_fails_at_once_when_there_is_no_main_window() {
    let fx = fixture();
    *fx.windows.main.lock() = None;
    let result = fx
        .bridge
        .exec_command(target(None), "a", None, false, None)
        .await;
    assert_eq!(
        result,
        CommandResult::Err {
            code: "command-failed".to_owned(),
            message: "target window not available".to_owned()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn exec_command_does_not_use_up_a_request_id_for_a_window_that_is_not_available() {
    let fx = fixture();
    fx.bridge
        .exec_command(target(Some("w9")), "a", None, false, None)
        .await;
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .exec_command(target(None), "b", None, false, None)
            .await
    });
    settle().await;
    assert_eq!(fx.windows.commands.lock()[0].1, "cmd-1");
    fx.bridge.command_result("cmd-1", ok(json!(1)));
    call.await.unwrap();
}

fn terminal_request(window: Option<&str>, workspace: Option<&str>) -> OpenTerminalRequest {
    OpenTerminalRequest {
        window_id: window.map(WindowId::new),
        workspace_id: workspace.map(WorkspaceId::new),
        payload: json!({"command": "htop"}),
    }
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_registers_the_pane_the_window_reports_and_returns_its_external_id()
{
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .open_terminal_in_window(terminal_request(Some("w2"), Some("s1")))
            .await
    });
    settle().await;
    let (window, payload) = fx.windows.terminals.lock()[0].clone();
    assert_eq!(window, WindowId::new("w2"));
    assert_eq!(payload["requestId"], "term-1");
    assert_eq!(payload["command"], "htop");
    assert!(payload.get("windowId").is_none());
    fx.bridge
        .open_terminal_result(&WindowId::new("w2"), "term-1", Some("pane-new"));
    let external = call.await.unwrap().unwrap();
    let identity = fx.registry.resolve_external(&external).unwrap();
    assert_eq!(identity.kind, IdentityKind::Pane);
    assert_eq!(identity.pane_id, PaneId::new("pane-new"));
    assert_eq!(identity.window_id, WindowId::new("w2"));
    assert_eq!(identity.workspace_id, WorkspaceId::new("s1"));
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_registers_an_empty_workspace_when_the_request_has_none() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .open_terminal_in_window(terminal_request(Some("w1"), None))
            .await
    });
    settle().await;
    fx.bridge
        .open_terminal_result(&WindowId::new("w1"), "term-1", Some("pane-new"));
    let external = call.await.unwrap().unwrap();
    let identity = fx.registry.resolve_external(&external).unwrap();
    assert_eq!(identity.workspace_id, WorkspaceId::default());
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_finds_the_window_of_the_workspace_when_the_request_names_none() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .open_terminal_in_window(terminal_request(None, Some("s2")))
            .await
    });
    settle().await;
    assert_eq!(fx.windows.terminals.lock()[0].0, WindowId::new("w2"));
    fx.bridge
        .open_terminal_result(&WindowId::new("w2"), "term-1", Some("pane-new"));
    assert!(call.await.unwrap().is_some());
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_falls_back_to_the_main_window() {
    let fx = fixture();
    for request in [
        terminal_request(None, None),
        terminal_request(Some("w9"), None),
        terminal_request(None, Some("s-unknown")),
    ] {
        fx.windows.terminals.lock().clear();
        let bridge = Arc::clone(&fx.bridge);
        let call = tokio::spawn(async move { bridge.open_terminal_in_window(request).await });
        settle().await;
        let (window, payload) = fx.windows.terminals.lock()[0].clone();
        assert_eq!(window, WindowId::new("w1"));
        let request_id = payload["requestId"].as_str().unwrap().to_owned();
        fx.bridge
            .open_terminal_result(&WindowId::new("w1"), &request_id, None);
        assert_eq!(call.await.unwrap(), None);
    }
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_returns_none_at_once_when_no_window_is_available() {
    let fx = fixture();
    *fx.windows.main.lock() = None;
    let started = Instant::now();
    let result = fx
        .bridge
        .open_terminal_in_window(terminal_request(Some("w9"), None))
        .await;
    assert_eq!(result, None);
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert!(fx.windows.terminals.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_returns_none_after_5_seconds_without_an_answer() {
    let fx = fixture();
    let started = Instant::now();
    let result = fx
        .bridge
        .open_terminal_in_window(terminal_request(Some("w1"), None))
        .await;
    assert_eq!(result, None);
    assert_eq!(started.elapsed(), Duration::from_millis(5000));
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_ignores_an_answer_from_another_window_or_for_another_request() {
    let fx = fixture();
    let bridge = Arc::clone(&fx.bridge);
    let call = tokio::spawn(async move {
        bridge
            .open_terminal_in_window(terminal_request(Some("w2"), None))
            .await
    });
    settle().await;
    fx.bridge
        .open_terminal_result(&WindowId::new("w1"), "term-1", Some("pane-a"));
    fx.bridge
        .open_terminal_result(&WindowId::new("w2"), "term-9", Some("pane-b"));
    settle().await;
    assert!(!call.is_finished());
    fx.bridge
        .open_terminal_result(&WindowId::new("w2"), "term-1", Some("pane-c"));
    let external = call.await.unwrap().unwrap();
    assert_eq!(
        fx.registry.resolve_external(&external).unwrap().pane_id,
        PaneId::new("pane-c")
    );
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_returns_none_when_the_window_reports_no_pane() {
    let fx = fixture();
    for reported in [None, Some("")] {
        let bridge = Arc::clone(&fx.bridge);
        let call = tokio::spawn(async move {
            bridge
                .open_terminal_in_window(terminal_request(Some("w1"), None))
                .await
        });
        settle().await;
        let request_id = fx.windows.terminals.lock().last().unwrap().1["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        fx.bridge
            .open_terminal_result(&WindowId::new("w1"), &request_id, reported);
        assert_eq!(call.await.unwrap(), None, "{reported:?}");
    }
    assert!(fx.registry.pane_identities().is_empty());
}

#[tokio::test(start_paused = true)]
async fn open_terminal_in_window_gives_each_request_its_own_id() {
    let fx = fixture();
    let first = fx
        .bridge
        .open_terminal_in_window(terminal_request(Some("w1"), None))
        .await;
    let second = fx
        .bridge
        .open_terminal_in_window(terminal_request(Some("w1"), None))
        .await;
    assert_eq!((first, second), (None, None));
    let ids: Vec<String> = fx
        .windows
        .terminals
        .lock()
        .iter()
        .map(|(_, payload)| payload["requestId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["term-1", "term-2"]);
}

#[test]
fn builds_the_exec_and_open_terminal_futures_on_a_thread_with_no_runtime() {
    let fx = fixture();
    let exec = fx
        .bridge
        .exec_command(target(Some("w2")), "pane.list", None, false, None);
    let open = fx
        .bridge
        .open_terminal_in_window(terminal_request(Some("w1"), None));
    assert_eq!(fx.windows.commands.lock().len(), 1);
    assert_eq!(fx.windows.terminals.lock().len(), 1);
    drop((exec, open));
}
