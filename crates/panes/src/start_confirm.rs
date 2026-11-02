use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::EventHub;
use ostia_base::js::{is_js_space, js_trim};
use tokio::time::{Instant, interval_at, sleep};

const OUTPUT_LINES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryStatus {
    Starting,
    Running,
    Exited,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryView {
    pub pane_id: String,
    pub status: EntryStatus,
    pub exit_code: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartOutcome {
    Started,
    Exited,
    Failed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartTiming {
    pub settle: Duration,
    pub process: Duration,
    pub agent: Duration,
    pub turn: Duration,
    pub poll: Duration,
}

pub const START_TIMING: StartTiming = StartTiming {
    settle: Duration::from_millis(1000),
    process: Duration::from_millis(15_000),
    agent: Duration::from_millis(60_000),
    turn: Duration::from_millis(20_000),
    poll: Duration::from_millis(200),
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartReport {
    pub status: StartOutcome,
    pub turn_started: Option<bool>,
    pub session: Option<String>,
    pub exit_code: Option<i64>,
    pub output: Option<Vec<String>>,
    pub reason: Option<String>,
}

pub struct StartWatch {
    pub entry: Arc<dyn Fn() -> EntryView + Send + Sync>,
    pub output: Arc<dyn Fn() -> String + Send + Sync>,
    pub agent_hook: bool,
    pub agent_started: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub changes: EventHub<()>,
    pub timing: StartTiming,
}

pub trait TurnProbe: Send + Sync {
    fn turn_state(&self, pane_id: &str) -> impl Future<Output = Option<String>> + Send;
    fn session(&self, pane_id: &str) -> impl Future<Output = Option<String>> + Send;
}

pub struct TurnWatch<P> {
    pub entry: Arc<dyn Fn() -> EntryView + Send + Sync>,
    pub probe: P,
    pub changes: EventHub<()>,
    pub timing: StartTiming,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnReport {
    pub turn_started: bool,
    pub session: Option<String>,
}

fn blank(status: StartOutcome) -> StartReport {
    StartReport {
        status,
        turn_started: None,
        session: None,
        exit_code: None,
        output: None,
        reason: None,
    }
}

async fn settle<T, Fut>(
    changes: &EventHub<()>,
    poll: Duration,
    timeout: Duration,
    mut observe: impl FnMut() -> Fut,
    on_timeout: impl FnOnce() -> T,
) -> T
where
    Fut: Future<Output = Option<T>>,
{
    let mut signals = changes.subscribe();
    let mut ticks = interval_at(Instant::now() + poll, poll);
    let deadline = sleep(timeout);
    tokio::pin!(deadline);
    loop {
        if let Some(settled) = observe().await {
            return settled;
        }
        tokio::select! {
            () = &mut deadline => return on_timeout(),
            Some(()) = signals.recv() => {}
            _ = ticks.tick() => {}
        }
    }
}

fn last_lines(text: &str) -> Vec<String> {
    if js_trim(text).is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = text.trim_end_matches(is_js_space).split('\n').collect();
    lines
        .iter()
        .rev()
        .take(OUTPUT_LINES)
        .rev()
        .map(|line| (*line).to_owned())
        .collect()
}

fn exited_report(watch: &StartWatch, view: &EntryView) -> StartReport {
    let output = last_lines(&(watch.output)());
    let code = view.exit_code;
    if !watch.agent_hook && code == Some(0) {
        return StartReport {
            exit_code: Some(0),
            output: Some(output),
            ..blank(StartOutcome::Exited)
        };
    }
    let reason = if watch.agent_hook {
        let code_text = code.map_or_else(String::new, |code| format!(" with exit code {code}"));
        format!("the agent's command ended{code_text} before the agent started")
    } else {
        let code_text = code.map_or_else(|| "unknown".to_owned(), |code| code.to_string());
        format!("the command ended with exit code {code_text}")
    };
    StartReport {
        exit_code: code,
        output: Some(output),
        reason: Some(reason),
        ..blank(StartOutcome::Failed)
    }
}

fn observe_start(watch: &StartWatch, running_since: &mut Option<Instant>) -> Option<StartReport> {
    let view = (watch.entry)();
    match view.status {
        EntryStatus::Closed => {
            return Some(StartReport {
                reason: Some("its tab was closed".to_owned()),
                ..blank(StartOutcome::Failed)
            });
        }
        EntryStatus::Exited => return Some(exited_report(watch, &view)),
        EntryStatus::Starting | EntryStatus::Running => {}
    }
    if watch.agent_hook && (watch.agent_started)(&view.pane_id) {
        return Some(blank(StartOutcome::Started));
    }
    if view.status != EntryStatus::Running {
        return None;
    }
    let since = *running_since.get_or_insert_with(Instant::now);
    if watch.agent_hook || since.elapsed() < watch.timing.settle {
        return None;
    }
    Some(blank(StartOutcome::Started))
}

fn timed_out(watch: &StartWatch) -> StartReport {
    let reason = if (watch.entry)().status == EntryStatus::Starting {
        "the command did not start: its tab never reached a ready prompt"
    } else {
        "the agent did not report its start"
    };
    StartReport {
        reason: Some(reason.to_owned()),
        ..blank(StartOutcome::TimedOut)
    }
}

pub async fn confirm_start(watch: StartWatch) -> StartReport {
    let timeout = if watch.agent_hook {
        watch.timing.agent
    } else {
        watch.timing.process
    };
    let mut running_since = None;
    settle(
        &watch.changes,
        watch.timing.poll,
        timeout,
        || std::future::ready(observe_start(&watch, &mut running_since)),
        || timed_out(&watch),
    )
    .await
}

async fn observe_turn<P: TurnProbe>(watch: &TurnWatch<P>) -> Option<bool> {
    let view = (watch.entry)();
    if matches!(view.status, EntryStatus::Closed | EntryStatus::Exited) {
        return Some(false);
    }
    let state = watch.probe.turn_state(&view.pane_id).await;
    matches!(
        state.as_deref(),
        Some("working" | "waiting" | "done" | "error")
    )
    .then_some(true)
}

pub async fn confirm_turn<P: TurnProbe>(watch: TurnWatch<P>) -> TurnReport {
    let pane_id = (watch.entry)().pane_id;
    let watch_ref = &watch;
    let turn_started = settle(
        &watch.changes,
        watch.timing.poll,
        watch.timing.turn,
        || observe_turn(watch_ref),
        || false,
    )
    .await;
    let session = watch
        .probe
        .session(&pane_id)
        .await
        .filter(|session| !session.is_empty());
    TurnReport {
        turn_started,
        session,
    }
}

pub fn start_message(name: &str, pane_id: &str, report: &StartReport) -> String {
    let status = match report.status {
        StartOutcome::Started => "started",
        StartOutcome::Exited => "exited",
        StartOutcome::Failed => "failed",
        StartOutcome::TimedOut => "timed-out",
    };
    let head = format!("ostia: {name} ({pane_id}) {status}");
    let code = report
        .exit_code
        .map_or_else(String::new, |code| format!(", exit code {code}"));
    let why = report
        .reason
        .as_deref()
        .filter(|reason| !reason.is_empty())
        .map_or_else(String::new, |reason| format!(": {reason}"));
    let tail = report
        .output
        .as_ref()
        .filter(|lines| !lines.is_empty())
        .map_or_else(String::new, |lines| format!("\n{}", lines.join("\n")));
    format!("{head}{code}{why}{tail}")
}
