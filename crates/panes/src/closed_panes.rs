use std::collections::VecDeque;
use std::sync::Arc;

use ostia_base::js::{non_empty, utf16_len};
use parking_lot::Mutex;

const SHORT_ID_LENGTH: usize = 8;
const CLOSED_MAX: usize = 256;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

pub const PREFIX_MIN: usize = SHORT_ID_LENGTH;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedPane {
    pub external_id: String,
    pub workspace_id: String,
    pub name: Option<String>,
    pub closed_at: i64,
}

#[derive(Clone, Default)]
pub struct ClosedPanes {
    closed: Arc<Mutex<VecDeque<ClosedPane>>>,
}

impl ClosedPanes {
    pub fn remember(&self, pane: ClosedPane) {
        let mut closed = self.closed.lock();
        closed.retain(|held| held.external_id != pane.external_id);
        closed.push_back(pane);
        if closed.len() > CLOSED_MAX {
            closed.pop_front();
        }
    }

    pub fn recall(&self, reference: &str, visible: impl Fn(&str) -> bool) -> Option<ClosedPane> {
        let closed = self.closed.lock();
        if let Some(exact) = closed.iter().find(|pane| pane.external_id == reference) {
            return visible(&exact.workspace_id).then(|| exact.clone());
        }
        if utf16_len(reference) < PREFIX_MIN {
            return None;
        }
        let mut matches = closed
            .iter()
            .filter(|pane| pane.external_id.starts_with(reference) && visible(&pane.workspace_id));
        let only = matches.next()?;
        matches.next().is_none().then(|| only.clone())
    }

    pub fn forget_all(&self) {
        self.closed.lock().clear();
    }
}

fn age_label(ms: i64) -> String {
    if ms < MINUTE_MS {
        format!("{}s", ms.div_euclid(1000).max(0))
    } else if ms < HOUR_MS {
        format!("{}m", ms / MINUTE_MS)
    } else if ms < DAY_MS {
        format!("{}h", ms / HOUR_MS)
    } else {
        format!("{}d", ms / DAY_MS)
    }
}

pub fn closed_label(pane: &ClosedPane, now: i64) -> String {
    let name = non_empty(pane.name.as_deref())
        .map(|name| format!(" ({name})"))
        .unwrap_or_default();
    format!(
        "closed {} ago{name}",
        age_label(now.saturating_sub(pane.closed_at))
    )
}
