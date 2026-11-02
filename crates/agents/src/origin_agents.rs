use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex, utf16_len};
use ostia_contract::attention::AttentionState;
use ostia_contract::utf16_prefix::utf16_prefix;
use ostia_contract::windows_api::{
    OriginAgentTarget, OriginAgents, OriginReferenceRequest, PaneAgentKind, ReferenceInsert,
    WindowPaneSummary, WindowWorkspaceReport, WindowWorkspaceSummary,
};
use ostia_workspaces::window_book::crosses_sandbox;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;
use tokio::sync::oneshot;

pub const REFERENCE_TEXT_MAX: usize = 64 * 1024;
pub const REFERENCE_NOTE_MAX: usize = 120;
const REFERENCE_REPLY: Duration = Duration::from_millis(3000);
const ID_MAX: usize = 256;

static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));

pub type WindowReports = Vec<(String, Vec<WindowWorkspaceReport>)>;

pub trait OriginRules {
    fn is_sandboxed(&self, workspace_id: &str) -> bool;
    fn is_scratch(&self, workspace_id: &str) -> bool;
    fn is_manager_pane(&self, pane_id: &str) -> bool;
    fn owner_of_pane(&self, pane_id: &str) -> Option<String>;
}

pub fn parse_pane_agent(raw: &Value) -> Option<PaneAgentKind> {
    match raw.as_str()? {
        "other" => Some(PaneAgentKind::Other),
        "claude" => Some(PaneAgentKind::Claude),
        "codex" => Some(PaneAgentKind::Codex),
        "agy" => Some(PaneAgentKind::Agy),
        _ => None,
    }
}

pub fn parse_attention_state(raw: &Value) -> Option<AttentionState> {
    match raw.as_str()? {
        "none" => Some(AttentionState::None),
        "working" => Some(AttentionState::Working),
        "waiting" => Some(AttentionState::Waiting),
        "done" => Some(AttentionState::Done),
        "error" => Some(AttentionState::Error),
        _ => None,
    }
}

pub fn summary_of(report: &WindowWorkspaceReport) -> WindowWorkspaceSummary {
    WindowWorkspaceSummary {
        id: report.id.clone(),
        name: report.name.clone(),
        work_dir: report.work_dir.clone(),
        state: report.state,
        unread_at: report.unread_at,
        panes: report
            .panes
            .iter()
            .map(|pane| WindowPaneSummary {
                id: pane.id.clone(),
                title: pane.title.clone(),
            })
            .collect(),
    }
}

struct OriginHome<'a> {
    window_id: &'a str,
    workspace: &'a WindowWorkspaceReport,
}

fn reports_of<'a>(
    reports: &'a WindowReports,
    window_id: &str,
) -> Option<&'a Vec<WindowWorkspaceReport>> {
    reports
        .iter()
        .find(|(owner, _)| owner == window_id)
        .map(|(_, workspaces)| workspaces)
}

fn origin_home<'a>(
    reports: &'a WindowReports,
    rules: &dyn OriginRules,
    window_id: &str,
    workspace_id: &str,
) -> Option<OriginHome<'a>> {
    let own = reports_of(reports, window_id)?
        .iter()
        .find(|workspace| workspace.id == workspace_id)?;
    let origin = own.origin.as_deref().filter(|origin| !origin.is_empty())?;
    if origin == own.id {
        return None;
    }
    if rules.is_scratch(&own.id) || rules.is_scratch(origin) {
        return None;
    }
    if crosses_sandbox(&[Some(own.id.as_str())], origin, |id| {
        rules.is_sandboxed(id)
    }) {
        return None;
    }
    for (owner, workspaces) in reports {
        if owner == window_id {
            continue;
        }
        if let Some(workspace) = workspaces.iter().find(|workspace| workspace.id == origin) {
            return Some(OriginHome {
                window_id: owner,
                workspace,
            });
        }
    }
    None
}

fn agent_targets(home: &OriginHome, rules: &dyn OriginRules) -> Vec<OriginAgentTarget> {
    let mut targets = Vec::new();
    for pane in &home.workspace.panes {
        let Some(agent) = pane.agent else {
            continue;
        };
        if rules.is_manager_pane(&pane.id) {
            continue;
        }
        if rules.owner_of_pane(&pane.id).as_deref() != Some(home.window_id) {
            continue;
        }
        targets.push(OriginAgentTarget {
            pane_id: pane.id.clone(),
            title: pane.title.clone(),
            agent,
            state: pane.state.unwrap_or(AttentionState::None),
            cwd: pane.cwd.clone().filter(|cwd| !cwd.is_empty()),
        });
    }
    targets
}

pub fn origin_agents(
    reports: &WindowReports,
    rules: &dyn OriginRules,
    window_id: &str,
    workspace_id: &Value,
) -> Option<OriginAgents> {
    let workspace_id = workspace_id.as_str()?;
    let home = origin_home(reports, rules, window_id, workspace_id)?;
    Some(OriginAgents {
        workspace_id: home.workspace.id.clone(),
        workspace_name: home.workspace.name.clone(),
        targets: agent_targets(&home, rules),
    })
}

pub fn origin_agent_owner(
    reports: &WindowReports,
    rules: &dyn OriginRules,
    window_id: &str,
    workspace_id: &str,
    pane_id: &str,
) -> Option<String> {
    let home = origin_home(reports, rules, window_id, workspace_id)?;
    agent_targets(&home, rules)
        .iter()
        .any(|target| target.pane_id == pane_id)
        .then(|| home.window_id.to_owned())
}

pub fn workspace_of_pane(
    reports: &WindowReports,
    window_id: &str,
    pane_id: &str,
) -> Option<String> {
    reports_of(reports, window_id)?
        .iter()
        .find(|workspace| workspace.panes.iter().any(|pane| pane.id == pane_id))
        .map(|workspace| workspace.id.clone())
}

pub fn reaches_target(
    reports: &WindowReports,
    rules: &dyn OriginRules,
    sender_window_id: &str,
    source_pane_id: &str,
    target_pane_id: &str,
) -> bool {
    if rules.owner_of_pane(source_pane_id).as_deref() != Some(sender_window_id) {
        return false;
    }
    if rules.owner_of_pane(target_pane_id).as_deref() == Some(sender_window_id) {
        return true;
    }
    let Some(workspace_id) = workspace_of_pane(reports, sender_window_id, source_pane_id) else {
        return false;
    };
    origin_agent_owner(
        reports,
        rules,
        sender_window_id,
        &workspace_id,
        target_pane_id,
    )
    .is_some()
}

fn id_field<'a>(record: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    let id = record.get(key)?.as_str()?;
    (!id.is_empty() && utf16_len(id) <= ID_MAX).then_some(id)
}

pub fn parse_reference_request(raw: &Value) -> Option<OriginReferenceRequest> {
    let record = raw.as_object()?;
    let workspace_id = id_field(record, "workspaceId")?;
    let pane_id = id_field(record, "paneId")?;
    let text = record.get("text")?.as_str()?;
    if text.is_empty() || utf16_len(text) > REFERENCE_TEXT_MAX {
        return None;
    }
    let note = record
        .get("note")
        .and_then(Value::as_str)
        .map(|note| {
            let spaced = SPACE_RUN.replace_all(js_trim(note), " ");
            utf16_prefix(&spaced, REFERENCE_NOTE_MAX).to_owned()
        })
        .filter(|note| !note.is_empty());
    Some(OriginReferenceRequest {
        workspace_id: workspace_id.to_owned(),
        pane_id: pane_id.to_owned(),
        text: text.to_owned(),
        note,
    })
}

type Deliver = Box<dyn Fn(&str, ReferenceInsert) -> bool + Send + Sync>;

struct Pending {
    window_id: String,
    settle: oneshot::Sender<bool>,
}

#[derive(Default)]
struct Book {
    pending: HashMap<String, Pending>,
    seq: u64,
}

struct Relay {
    deliver: Deliver,
    reply: Duration,
    book: Mutex<Book>,
}

#[derive(Clone)]
pub struct ReferenceRelay {
    relay: Arc<Relay>,
}

impl Relay {
    fn settle(&self, request_id: &str, inserted: bool) {
        let entry = self.book.lock().pending.remove(request_id);
        if let Some(entry) = entry {
            let _ = entry.settle.send(inserted);
        }
    }
}

impl ReferenceRelay {
    pub fn new(
        deliver: impl Fn(&str, ReferenceInsert) -> bool + Send + Sync + 'static,
        reply: Duration,
    ) -> Self {
        Self {
            relay: Arc::new(Relay {
                deliver: Box::new(deliver),
                reply,
                book: Mutex::new(Book::default()),
            }),
        }
    }

    pub fn with_default_reply(
        deliver: impl Fn(&str, ReferenceInsert) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self::new(deliver, REFERENCE_REPLY)
    }

    pub fn forward(
        &self,
        window_id: &str,
        request: OriginReferenceRequest,
    ) -> impl Future<Output = bool> + use<> {
        let relay = Arc::clone(&self.relay);
        let (settle, mut settled) = oneshot::channel();
        let request_id = {
            let mut book = relay.book.lock();
            book.seq += 1;
            let request_id = format!("reference-{}", book.seq);
            book.pending.insert(
                request_id.clone(),
                Pending {
                    window_id: window_id.to_owned(),
                    settle,
                },
            );
            request_id
        };
        let timer = tokio::time::sleep(relay.reply);
        let insert = ReferenceInsert {
            request_id: request_id.clone(),
            pane_id: request.pane_id,
            text: request.text,
            note: request.note,
        };
        if !(relay.deliver)(window_id, insert) {
            relay.settle(&request_id, false);
        }
        async move {
            tokio::pin!(timer);
            tokio::select! {
                biased;
                answer = &mut settled => answer.unwrap_or(false),
                () = &mut timer => {
                    let removed = relay.book.lock().pending.remove(&request_id).is_some();
                    if removed {
                        false
                    } else {
                        settled.await.unwrap_or(false)
                    }
                }
            }
        }
    }

    pub fn answer(&self, window_id: &str, request_id: &Value, inserted: &Value) {
        let Some(request_id) = request_id.as_str() else {
            return;
        };
        let owned = self
            .relay
            .book
            .lock()
            .pending
            .get(request_id)
            .is_some_and(|entry| entry.window_id == window_id);
        if owned {
            self.relay
                .settle(request_id, *inserted == Value::Bool(true));
        }
    }

    pub fn window_closed(&self, window_id: &str) {
        let ids: Vec<String> = self
            .relay
            .book
            .lock()
            .pending
            .iter()
            .filter(|(_, entry)| entry.window_id == window_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.relay.settle(&id, false);
        }
    }
}
