use std::collections::{BTreeSet, HashMap};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::future::join_all;
use ostia_contract::utf16_prefix::utf16_prefix;
use ostia_contract::windows_api::{QuitAnswer, RunningGroup};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::time::{Sleep, sleep};

pub const RUNNING_ANSWER: Duration = Duration::from_millis(2_000);

const GROUPS_MAX: usize = 64;
const ITEMS_MAX: usize = 32;
const TEXT_MAX: usize = 512;

pub trait Window: Send + Sync {
    fn id(&self) -> u64;
    fn is_destroyed(&self) -> bool;
    fn is_loading(&self) -> bool;
    fn is_crashed(&self) -> bool;
    fn is_minimized(&self) -> bool;
    fn restore(&self);
    fn focus(&self);
    fn send(&self, channel: &str, args: &[Value]);
}

fn unresponsive(win: &dyn Window) -> bool {
    win.is_destroyed() || win.is_loading() || win.is_crashed()
}

enum Reply {
    Answer(Value),
    Gone,
    Late,
}

struct PendingAnswer {
    sender_id: u64,
    settle: oneshot::Sender<Reply>,
}

#[derive(Default)]
struct Shared {
    last_request_id: AtomicU64,
    pending: Mutex<HashMap<u64, PendingAnswer>>,
}

#[derive(Clone, Default)]
pub struct CloseGuard {
    shared: Arc<Shared>,
}

impl CloseGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn answer(&self, sender_id: u64, request_id: u64, value: Value) {
        let answer = {
            let mut pending = self.shared.pending.lock();
            match pending.get(&request_id) {
                Some(answer) if answer.sender_id == sender_id => pending.remove(&request_id),
                _ => None,
            }
        };
        if let Some(answer) = answer {
            let _ = answer.settle.send(Reply::Answer(value));
        }
    }

    pub fn window_gone(&self, sender_id: u64) {
        let gone: Vec<PendingAnswer> = {
            let mut pending = self.shared.pending.lock();
            let ids: Vec<u64> = pending
                .iter()
                .filter(|(_, answer)| answer.sender_id == sender_id)
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| pending.remove(id)).collect()
        };
        for answer in gone {
            let _ = answer.settle.send(Reply::Gone);
        }
    }

    pub fn ask(
        &self,
        win: Arc<dyn Window>,
        channel: &str,
        payload: Value,
        gone: Value,
        timeout: Option<Duration>,
        late: Option<Value>,
    ) -> impl Future<Output = Value> + Send + use<> {
        let reply = self.request(win, channel, payload, timeout);
        async move {
            match reply.await {
                Reply::Answer(value) => value,
                Reply::Gone => gone,
                Reply::Late => late.unwrap_or(gone),
            }
        }
    }

    fn request(
        &self,
        win: Arc<dyn Window>,
        channel: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> impl Future<Output = Reply> + Send + use<> {
        let waiting = if unresponsive(&*win) {
            None
        } else {
            let request_id = self.shared.last_request_id.fetch_add(1, Ordering::SeqCst) + 1;
            let (settle, answered) = oneshot::channel();
            self.shared.pending.lock().insert(
                request_id,
                PendingAnswer {
                    sender_id: win.id(),
                    settle,
                },
            );
            if unresponsive(&*win) {
                self.shared.pending.lock().remove(&request_id);
                None
            } else {
                let deadline = timeout.map(|limit| Box::pin(sleep(limit)));
                win.send(channel, &[json!(request_id), payload]);
                Some((request_id, answered, deadline))
            }
        };
        let shared = self.shared.clone();
        async move {
            let Some((request_id, mut answered, deadline)) = waiting else {
                return Reply::Gone;
            };
            let Some(deadline) = deadline else {
                return answered.await.unwrap_or(Reply::Gone);
            };
            wait_until(&shared, request_id, &mut answered, deadline).await
        }
    }
}

async fn wait_until(
    shared: &Shared,
    request_id: u64,
    answered: &mut oneshot::Receiver<Reply>,
    deadline: Pin<Box<Sleep>>,
) -> Reply {
    tokio::select! {
        biased;
        reply = &mut *answered => reply.unwrap_or(Reply::Gone),
        () = deadline => {
            if shared.pending.lock().remove(&request_id).is_some() {
                Reply::Late
            } else {
                answered.await.unwrap_or(Reply::Gone)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneProcess {
    pub pane_id: String,
    pub workspace_id: String,
    pub program: Option<String>,
    pub agent_running: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceName {
    pub id: String,
    pub name: String,
}

fn strings(raw: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .take(ITEMS_MAX)
        .map(|text| utf16_prefix(text, TEXT_MAX).to_owned())
        .collect()
}

pub fn parse_running_groups(raw: &Value) -> Vec<RunningGroup> {
    let Value::Array(entries) = raw else {
        return Vec::new();
    };
    let mut groups = Vec::new();
    for entry in entries.iter().take(GROUPS_MAX) {
        let Value::Object(entry) = entry else {
            continue;
        };
        let (Some(workspace_id), Some(workspace)) = (
            entry.get("workspaceId").and_then(Value::as_str),
            entry.get("workspace").and_then(Value::as_str),
        ) else {
            continue;
        };
        groups.push(RunningGroup {
            workspace_id: utf16_prefix(workspace_id, TEXT_MAX).to_owned(),
            workspace: utf16_prefix(workspace, TEXT_MAX).to_owned(),
            commands: strings(entry.get("commands")),
            agents: strings(entry.get("agents")),
            files: strings(entry.get("files")),
            unanswered: false,
            scratch_files: 0,
        });
    }
    groups
}

pub fn with_scratch_files(
    groups: &[RunningGroup],
    scratch_files: impl Fn(&str) -> usize,
) -> Vec<RunningGroup> {
    let mut out = Vec::new();
    for group in groups {
        let count = scratch_files(&group.workspace_id);
        let mut next = group.clone();
        if count > 0 {
            next.scratch_files = count;
        }
        let loses = !next.commands.is_empty()
            || !next.agents.is_empty()
            || !next.files.is_empty()
            || count > 0;
        if loses || next.unanswered {
            out.push(next);
        }
    }
    out
}

pub fn groups_from_ptys(
    workspaces: &[WorkspaceName],
    processes: &[PaneProcess],
    kept: &BTreeSet<String>,
    unanswered: bool,
) -> Vec<RunningGroup> {
    workspaces
        .iter()
        .map(|workspace| {
            let mut commands = Vec::new();
            let mut agents = Vec::new();
            for pane in processes {
                if pane.workspace_id != workspace.id || kept.contains(&pane.pane_id) {
                    continue;
                }
                if pane.agent_running {
                    agents.push(pane.program.clone().unwrap_or_default());
                } else if let Some(program) = &pane.program {
                    commands.push(program.clone());
                }
            }
            RunningGroup {
                workspace_id: workspace.id.clone(),
                workspace: workspace.name.clone(),
                commands,
                agents,
                files: Vec::new(),
                unanswered,
                scratch_files: 0,
            }
        })
        .collect()
}

type NativeConfirm = Box<
    dyn Fn(&[RunningGroup], usize) -> Pin<Box<dyn Future<Output = QuitAnswer> + Send>>
        + Send
        + Sync,
>;

pub type WorkspacesOf = Box<dyn Fn(&dyn Window) -> Vec<WorkspaceName> + Send + Sync>;

pub struct QuitCheck {
    pub scratch_files: Box<dyn Fn(&str) -> usize + Send + Sync>,
    pub kept: Vec<String>,
    pub kept_shells: Vec<String>,
    pub workspaces_of: WorkspacesOf,
    pub processes: Box<dyn Fn() -> Vec<PaneProcess> + Send + Sync>,
    pub confirm_native: NativeConfirm,
}

pub fn parse_quit_answer(raw: &Value, offered: bool) -> QuitAnswer {
    match raw.as_str() {
        Some("quit") => QuitAnswer::Quit,
        Some("keep-shells") if offered => QuitAnswer::KeepShells,
        _ => QuitAnswer::Cancel,
    }
}

pub async fn confirm_quit(
    guard: &CloseGuard,
    windows: &[Arc<dyn Window>],
    asker: Option<&Arc<dyn Window>>,
    check: &QuitCheck,
) -> QuitAnswer {
    let live: Vec<Arc<dyn Window>> = windows
        .iter()
        .filter(|win| !win.is_destroyed())
        .cloned()
        .collect();
    let replies = join_all(live.iter().map(|win| {
        guard.request(
            win.clone(),
            "window:running",
            json!(check.kept),
            Some(RUNNING_ANSWER),
        )
    }))
    .await;
    let kept: BTreeSet<String> = check.kept.iter().cloned().collect();
    let mut answered: Vec<&Arc<dyn Window>> = Vec::new();
    let mut found: Vec<RunningGroup> = Vec::new();
    for (win, reply) in live.iter().zip(replies) {
        let (value, late) = match reply {
            Reply::Answer(value) => (Some(value), false),
            Reply::Gone => (None, false),
            Reply::Late => (None, true),
        };
        if let Some(value) = value {
            answered.push(win);
            found.extend(parse_running_groups(&value));
            continue;
        }
        let workspaces = if win.is_destroyed() {
            Vec::new()
        } else {
            (check.workspaces_of)(&**win)
        };
        found.extend(groups_from_ptys(
            &workspaces,
            &(check.processes)(),
            &kept,
            late,
        ));
    }
    let groups = with_scratch_files(&found, |id| (check.scratch_files)(id));
    let offered = !check.kept_shells.is_empty();
    if groups.is_empty() && !offered {
        return QuitAnswer::Quit;
    }
    let showing: Vec<&Arc<dyn Window>> = answered
        .into_iter()
        .filter(|win| !unresponsive(&***win))
        .collect();
    let target = asker
        .and_then(|asker| showing.iter().find(|win| win.id() == asker.id()))
        .or_else(|| showing.first());
    let Some(target) = target else {
        return (check.confirm_native)(&groups, check.kept_shells.len()).await;
    };
    if target.is_minimized() {
        target.restore();
    }
    target.focus();
    let gone = if offered { "keep-shells" } else { "quit" };
    let question = json!({
        "groups": serde_json::to_value(&groups).unwrap_or_default(),
        "keptShells": check.kept_shells,
    });
    let reply = guard
        .ask(
            (*target).clone(),
            "window:confirm-close",
            question,
            json!(gone),
            None,
            None,
        )
        .await;
    parse_quit_answer(&reply, offered)
}

pub fn freeze_all(windows: &[Arc<dyn Window>]) {
    for win in windows {
        if !win.is_destroyed() {
            win.send("window:freeze", &[]);
        }
    }
}
