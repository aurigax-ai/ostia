use std::future::{Future, ready};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ostia_contract::act_then_confirm::{
    ConfirmSpec, Off, Settled, Subscribe, act_then_confirm, confirmed, mismatch,
};

pub const CONFIRM_MAX_MS: u64 = 10_000;
const CLOSE_CONFIRM_MS: u64 = 3_000;
const CONFIRM_POLL_MS: u64 = 50;
const SUBMIT_CONFIRM_MS: u64 = 5_000;
const TIMEOUT_FACTOR: u64 = 10;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmTarget {
    pub external_id: String,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedPane {
    pub pane_id: String,
    pub agent: Option<String>,
}

pub type OutputCursor = Arc<dyn Fn(&str) -> Option<i64> + Send + Sync>;
pub type AttentionState = Arc<dyn Fn(&ConfirmTarget) -> BoxFuture<Option<String>> + Send + Sync>;
pub type PaneListing = Arc<dyn Fn() -> BoxFuture<Vec<ListedPane>> + Send + Sync>;
pub type Delay = Arc<dyn Fn(u64) -> BoxFuture<()> + Send + Sync>;
pub type HooksOn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct PaneConfirmDeps {
    pub output_cursor: OutputCursor,
    pub attention: AttentionState,
    pub panes: PaneListing,
    pub delay: Delay,
    pub hooks_on: HooksOn,
}

#[derive(Clone)]
pub struct PaneConfirms {
    deps: PaneConfirmDeps,
}

fn in_turn(state: Option<&str>) -> bool {
    matches!(state, Some("working" | "waiting"))
}

fn timeout_of(ms: u64) -> Duration {
    Duration::from_millis(ms * TIMEOUT_FACTOR)
}

fn done_or_reason(settled: Settled<()>) -> Result<(), String> {
    match settled {
        Settled::Confirmed(()) => Ok(()),
        Settled::Mismatch { reason, .. } => Err(reason),
    }
}

impl PaneConfirms {
    pub fn new(deps: PaneConfirmDeps) -> Self {
        Self { deps }
    }

    fn ticks(&self) -> Subscribe {
        let delay = Arc::clone(&self.deps.delay);
        Subscribe::new(move |wake| {
            let delay = Arc::clone(&delay);
            let task = tokio::spawn(async move {
                loop {
                    delay(CONFIRM_POLL_MS).await;
                    wake();
                }
            });
            Box::new(move || task.abort()) as Off
        })
    }

    pub async fn confirm_gone(&self, to: &ConfirmTarget) -> Result<(), String> {
        let polls = Arc::new(AtomicU64::new(0));
        let panes = Arc::clone(&self.deps.panes);
        let external_id = to.external_id.clone();
        let timed_out = to.external_id.clone();
        let settled = act_then_confirm(ConfirmSpec {
            act: || ready(()),
            observe: move || {
                let listing = panes();
                let polls = Arc::clone(&polls);
                let external_id = external_id.clone();
                async move {
                    let listed = listing.await;
                    if !listed.iter().any(|pane| pane.pane_id == external_id) {
                        return Some(confirmed(()));
                    }
                    let seen = polls.fetch_add(1, Ordering::SeqCst) + 1;
                    if seen * CONFIRM_POLL_MS <= CLOSE_CONFIRM_MS {
                        return None;
                    }
                    Some(mismatch(
                        format!(
                            "still-open: {external_id} is still open; the human was asked about its unsaved files"
                        ),
                        None,
                    ))
                }
            },
            signal: self.ticks(),
            timeout: timeout_of(CLOSE_CONFIRM_MS),
            on_timeout: move || {
                ready(mismatch(
                    format!("still-open: {timed_out} is still open"),
                    None,
                ))
            },
        })
        .await;
        done_or_reason(settled)
    }

    pub async fn confirm_input(&self, to: &ConfirmTarget, before: Option<i64>, ms: u64) -> bool {
        let mut polls = 0u64;
        let cursor = Arc::clone(&self.deps.output_cursor);
        let pane_id = to.pane_id.clone();
        let seen = act_then_confirm(ConfirmSpec {
            act: || ready(()),
            observe: move || {
                ready(match cursor(&pane_id) {
                    None => Some(confirmed(false)),
                    Some(now) if before.is_some_and(|earlier| now > earlier) => {
                        Some(confirmed(true))
                    }
                    Some(_) => {
                        polls += 1;
                        (polls * CONFIRM_POLL_MS > ms).then(|| confirmed(false))
                    }
                })
            },
            signal: self.ticks(),
            timeout: timeout_of(CONFIRM_MAX_MS),
            on_timeout: || ready(confirmed(false)),
        })
        .await;
        matches!(seen, Settled::Confirmed(true))
    }

    pub async fn confirm_submitted(&self, to: &ConfirmTarget) -> Result<(), String> {
        let polls = Arc::new(AtomicU64::new(0));
        let attention = Arc::clone(&self.deps.attention);
        let target = to.clone();
        let timed_out = to.external_id.clone();
        let settled = act_then_confirm(ConfirmSpec {
            act: || ready(()),
            observe: move || {
                let state = attention(&target);
                let polls = Arc::clone(&polls);
                let external_id = target.external_id.clone();
                async move {
                    if in_turn(state.await.as_deref()) {
                        return Some(confirmed(()));
                    }
                    let seen = polls.fetch_add(1, Ordering::SeqCst) + 1;
                    if seen * CONFIRM_POLL_MS <= SUBMIT_CONFIRM_MS {
                        return None;
                    }
                    Some(mismatch(
                        format!(
                            "not-submitted: {external_id} shows the text at its prompt but did not start a turn after Enter; press Enter with ostia pane key {external_id} enter, or read it with ostia pane read"
                        ),
                        None,
                    ))
                }
            },
            signal: self.ticks(),
            timeout: timeout_of(SUBMIT_CONFIRM_MS),
            on_timeout: move || {
                ready(mismatch(
                    format!("not-submitted: {timed_out} did not start a turn"),
                    None,
                ))
            },
        })
        .await;
        done_or_reason(settled)
    }

    pub async fn watches_submit(&self, to: &ConfirmTarget) -> bool {
        let listed = (self.deps.panes)().await;
        let Some(entry) = listed.iter().find(|pane| pane.pane_id == to.external_id) else {
            return false;
        };
        let Some(agent) = entry.agent.as_deref().filter(|agent| !agent.is_empty()) else {
            return false;
        };
        if !(self.deps.hooks_on)(agent) {
            return false;
        }
        !in_turn((self.deps.attention)(to).await.as_deref())
    }
}
