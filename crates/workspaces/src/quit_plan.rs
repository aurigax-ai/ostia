use std::time::Duration;

use ostia_contract::windows_api::QuitAnswer;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

pub const UNATTENDED_QUIT_DEADLINE: Duration = Duration::from_millis(5000);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitPlan {
    Proceed,
    Ask,
    Unattended,
}

pub const QUIT_SIGNALS: [&str; 3] = ["SIGTERM", "SIGINT", "SIGHUP"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuitState {
    pub approved: bool,
    pub requested_by_ostia: bool,
    pub signaled: bool,
    pub platform: String,
}

pub fn plan_quit(state: &QuitState) -> QuitPlan {
    if state.approved {
        return QuitPlan::Proceed;
    }
    if state.signaled {
        return QuitPlan::Unattended;
    }
    if state.requested_by_ostia || state.platform == "darwin" {
        return QuitPlan::Ask;
    }
    QuitPlan::Unattended
}

pub fn exit_after_deadline(
    exit: impl FnOnce() + Send + 'static,
    deadline: Duration,
) -> JoinHandle<()> {
    let sleep = tokio::time::sleep(deadline);
    tokio::spawn(async move {
        sleep.await;
        exit();
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptOnQuit {
    pub kept: Vec<String>,
    pub offer: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuitPane {
    pub pane_id: String,
    pub kept: bool,
}

pub fn kept_on_quit(restart: bool, confirm: bool, panes: &[QuitPane]) -> KeptOnQuit {
    let kept: Vec<String> = panes
        .iter()
        .filter(|pane| pane.kept)
        .map(|pane| pane.pane_id.clone())
        .collect();
    if restart {
        return KeptOnQuit {
            kept,
            offer: Vec::new(),
        };
    }
    if !confirm {
        return KeptOnQuit {
            kept: Vec::new(),
            offer: Vec::new(),
        };
    }
    KeptOnQuit {
        offer: kept.clone(),
        kept,
    }
}

pub fn keeps_shells_on_quit(restart: bool, answer: Option<QuitAnswer>) -> bool {
    restart || answer == Some(QuitAnswer::KeepShells)
}

pub type QuitLog = Box<dyn Fn(&str, Value) + Send>;
pub type QuitClock = Box<dyn Fn() -> i64 + Send>;

pub struct QuitTrace {
    log: QuitLog,
    now: QuitClock,
    started_at: Option<i64>,
    stage_at: i64,
    name: String,
}

pub fn create_quit_trace(
    log: impl Fn(&str, Value) + Send + 'static,
    now: impl Fn() -> i64 + Send + 'static,
) -> QuitTrace {
    QuitTrace {
        log: Box::new(log),
        now: Box::new(now),
        started_at: None,
        stage_at: 0,
        name: "idle".to_owned(),
    }
}

impl QuitTrace {
    pub fn stage(&mut self, next: &str) {
        let at = (self.now)();
        let started_at = *self.started_at.get_or_insert_with(|| {
            self.stage_at = at;
            at
        });
        (self.log)(
            "quit-stage",
            json!({
                "stage": next,
                "after": self.name,
                "tookMs": at - self.stage_at,
                "totalMs": at - started_at,
            }),
        );
        next.clone_into(&mut self.name);
        self.stage_at = at;
    }

    pub fn current(&self) -> &str {
        &self.name
    }

    pub fn elapsed_ms(&self) -> i64 {
        self.started_at
            .map_or(0, |started_at| (self.now)() - started_at)
    }
}

pub fn summarize_kinds(kinds: &[&str]) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for kind in kinds {
        match counts.iter_mut().find(|(seen, _)| seen == kind) {
            Some((_, count)) => *count += 1,
            None => counts.push((kind, 1)),
        }
    }
    counts.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    counts
        .iter()
        .map(|(kind, count)| format!("{kind}:{count}"))
        .collect::<Vec<_>>()
        .join(",")
}
