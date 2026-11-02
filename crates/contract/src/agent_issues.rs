use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;

pub const MAIL_PANE_CLOSED: &str = "pane-closed";
pub const MAIL_REFUSED: &str = "agent-refused";
pub const MAIL_INBOX_FULL: &str = "inbox-full";
pub const MAIL_LEASE_TIMEOUT: &str = "lease-timeout";
pub const WAKE_NOT_READY: &str = "wake-not-ready";
pub const READBACK_MISMATCH: &str = "readback-mismatch";
pub const OVER_BUDGET: &str = "over-budget";
pub const WAKE_BUDGET_MS: u64 = 2 * 60_000;
pub const STALE_MAIL_MS: u64 = 10 * 60_000;

pub const READBACK_CODES: [&str; 5] = [
    "not-submitted",
    "not-queued",
    "not-started",
    "not-recorded",
    "still-open",
];

static VERB_CODE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^([a-z][a-z-]{0,40})(?::|$)"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerbBudget {
    pub ms: Option<u64>,
    pub bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetBreach {
    Ms,
    Bytes,
}

pub fn mail_expired(pending: &str) -> String {
    format!("expired:{pending}")
}

pub fn verb_code(message: &str) -> String {
    VERB_CODE
        .captures(message)
        .and_then(|captures| captures.get(1))
        .map_or_else(|| "error".to_owned(), |code| code.as_str().to_owned())
}

pub fn verb_budget(method: &str) -> Option<VerbBudget> {
    let (ms, bytes) = match method {
        "pane.list" => (None, Some(24_000)),
        "pane.read" => (Some(3000), Some(16_000)),
        "pane.status" => (Some(3000), Some(6000)),
        "pane.transcript" => (Some(3000), Some(32_000)),
        "pane.input" => (Some(8000), None),
        "pane.wait" => (None, Some(2000)),
        "bus.send" => (Some(3000), Some(2000)),
        "bus.inbox" => (None, Some(12_000)),
        "bus.sent" => (None, Some(12_000)),
        _ => return None,
    };
    Some(VerbBudget { ms, bytes })
}

pub fn budget_breach(method: &str, ms: u64, bytes: u64) -> Option<BudgetBreach> {
    let budget = verb_budget(method)?;
    if budget.ms.is_some_and(|limit| ms > limit) {
        return Some(BudgetBreach::Ms);
    }
    if budget.bytes.is_some_and(|limit| bytes > limit) {
        return Some(BudgetBreach::Bytes);
    }
    None
}
