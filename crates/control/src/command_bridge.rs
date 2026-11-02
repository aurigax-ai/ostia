use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_contract::commands::CommandDescriptor;
use ostia_contract::terminal_state::TerminalStateSnapshot;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;
use tokio::time::sleep;

use crate::identity::{IdRegistry, PaneInput};

const COMMAND_TIMEOUT: Duration = Duration::from_millis(5000);
const OPEN_TERMINAL_TIMEOUT: Duration = Duration::from_millis(5000);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSource {
    Control,
    Phone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<WindowId>,
    pub workspace_id: WorkspaceId,
    pub pane_id: Option<PaneId>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInvoke {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    pub target: CommandTarget,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub from_main: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<CommandSource>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CommandResult {
    Ok(Value),
    Err { code: String, message: String },
}

impl CommandResult {
    fn failed(message: &str) -> Self {
        Self::Err {
            code: "command-failed".to_owned(),
            message: message.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenTerminalRequest {
    pub window_id: Option<WindowId>,
    pub workspace_id: Option<WorkspaceId>,
    pub payload: Value,
}

pub trait CommandWindows: Send + Sync {
    fn is_open(&self, window: &WindowId) -> bool;
    fn main_window(&self) -> Option<WindowId>;
    fn send_command(&self, window: &WindowId, request_id: &str, invoke: &CommandInvoke);
    fn send_open_terminal(&self, window: &WindowId, payload: &Value);
}

pub type WorkspaceWindow = Arc<dyn Fn(&WorkspaceId) -> Option<WindowId> + Send + Sync>;

pub struct CommandBridgeDeps {
    pub commands_by_window: Arc<Mutex<HashMap<WindowId, Vec<CommandDescriptor>>>>,
    pub terminal_state: Arc<Mutex<HashMap<PaneId, TerminalStateSnapshot>>>,
    pub windows: Arc<dyn CommandWindows>,
    pub workspace_window: WorkspaceWindow,
    pub registry: IdRegistry,
}

struct PendingTerminal {
    window: WindowId,
    workspace: WorkspaceId,
    answer: oneshot::Sender<Option<ExternalId>>,
}

#[derive(Default)]
struct Pending {
    command_seq: u64,
    terminal_seq: u64,
    commands: HashMap<String, oneshot::Sender<CommandResult>>,
    terminals: HashMap<String, PendingTerminal>,
}

type SharedPending = Arc<Mutex<Pending>>;

struct Forget {
    pending: SharedPending,
    request_id: String,
}

impl Drop for Forget {
    fn drop(&mut self) {
        let mut pending = self.pending.lock();
        pending.commands.remove(&self.request_id);
        pending.terminals.remove(&self.request_id);
    }
}

pub struct CommandBridge {
    deps: CommandBridgeDeps,
    pending: SharedPending,
}

impl CommandBridge {
    pub fn new(deps: CommandBridgeDeps) -> Self {
        Self {
            deps,
            pending: Arc::default(),
        }
    }

    pub fn list_commands_for(&self, window: &WindowId) -> Vec<CommandDescriptor> {
        self.deps
            .commands_by_window
            .lock()
            .get(window)
            .cloned()
            .unwrap_or_default()
    }

    pub fn get_terminal_state(&self, pane: &PaneId) -> Option<TerminalStateSnapshot> {
        self.deps.terminal_state.lock().get(pane).cloned()
    }

    fn open_window(&self, window: Option<WindowId>) -> Option<WindowId> {
        window.filter(|id| self.deps.windows.is_open(id))
    }

    pub fn exec_command(
        &self,
        target: CommandTarget,
        id: &str,
        args: Option<Value>,
        from_main: bool,
        source: Option<CommandSource>,
    ) -> impl Future<Output = CommandResult> + Send + use<> {
        let window = match target.window_id.clone().filter(|window| !window.is_empty()) {
            Some(window) => self.open_window(Some(window)),
            None => self.open_window(self.deps.windows.main_window()),
        };
        let started = window.map(|window| {
            let (sender, receiver) = oneshot::channel();
            let request_id = {
                let mut pending = self.pending.lock();
                pending.command_seq += 1;
                let request_id = format!("cmd-{}", pending.command_seq);
                pending.commands.insert(request_id.clone(), sender);
                request_id
            };
            let forget = Forget {
                pending: Arc::clone(&self.pending),
                request_id: request_id.clone(),
            };
            let invoke = CommandInvoke {
                id: id.to_owned(),
                args,
                target,
                from_main,
                source,
            };
            self.deps
                .windows
                .send_command(&window, &request_id, &invoke);
            (receiver, forget, sleep(COMMAND_TIMEOUT))
        });
        async move {
            let Some((receiver, forget, timer)) = started else {
                return CommandResult::failed("target window not available");
            };
            let result = tokio::select! {
                answer = receiver => answer.unwrap_or_else(|_| CommandResult::failed("command timed out")),
                () = timer => CommandResult::failed("command timed out"),
            };
            drop(forget);
            result
        }
    }

    pub fn command_result(&self, request_id: &str, result: CommandResult) {
        let sender = self.pending.lock().commands.remove(request_id);
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    pub fn open_terminal_in_window(
        &self,
        request: OpenTerminalRequest,
    ) -> impl Future<Output = Option<ExternalId>> + Send + use<> {
        let OpenTerminalRequest {
            window_id,
            workspace_id,
            payload,
        } = request;
        let workspace_ref = workspace_id.filter(|workspace| !workspace.is_empty());
        let requested = window_id.or_else(|| {
            workspace_ref
                .as_ref()
                .and_then(|workspace| (self.deps.workspace_window)(workspace))
        });
        let window = match requested {
            Some(window) => self.open_window(Some(window)),
            None => self.open_window(self.deps.windows.main_window()),
        };
        let started = window.map(|window| {
            let (answer, receiver) = oneshot::channel();
            let request_id = {
                let mut pending = self.pending.lock();
                pending.terminal_seq += 1;
                let request_id = format!("term-{}", pending.terminal_seq);
                pending.terminals.insert(
                    request_id.clone(),
                    PendingTerminal {
                        window: window.clone(),
                        workspace: workspace_ref.clone().unwrap_or_default(),
                        answer,
                    },
                );
                request_id
            };
            let forget = Forget {
                pending: Arc::clone(&self.pending),
                request_id: request_id.clone(),
            };
            let mut body = match payload {
                Value::Object(object) => object,
                _ => Map::new(),
            };
            if let Some(workspace) = &workspace_ref {
                body.entry("workspaceId")
                    .or_insert_with(|| Value::String(workspace.as_str().to_owned()));
            }
            body.insert("requestId".to_owned(), Value::String(request_id));
            self.deps
                .windows
                .send_open_terminal(&window, &Value::Object(body));
            (receiver, forget, sleep(OPEN_TERMINAL_TIMEOUT))
        });
        async move {
            let (receiver, forget, timer) = started?;
            let result = tokio::select! {
                answer = receiver => answer.unwrap_or(None),
                () = timer => None,
            };
            drop(forget);
            result
        }
    }

    pub fn open_terminal_result(&self, window: &WindowId, request_id: &str, pane_id: Option<&str>) {
        let pending = {
            let mut pending = self.pending.lock();
            let matches = pending
                .terminals
                .get(request_id)
                .is_some_and(|entry| &entry.window == window);
            if matches {
                pending.terminals.remove(request_id)
            } else {
                None
            }
        };
        let Some(pending) = pending else {
            return;
        };
        let external = pane_id.filter(|pane| !pane.is_empty()).map(|pane| {
            self.deps
                .registry
                .register_pane(PaneInput {
                    window_id: window.clone(),
                    workspace_id: pending.workspace.clone(),
                    pane_id: PaneId::new(pane),
                })
                .external_id
        });
        let _ = pending.answer.send(external);
    }
}
