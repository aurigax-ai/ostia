use ostia_base::js::non_empty;
use ostia_contract::attention::WorkspaceLiveState;

use crate::layout::types::{PaneNode, SurfaceKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowMark {
    Working,
    Waiting,
    Error,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactTone {
    Waiting,
    Error,
    Plain,
    Muted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowFact {
    pub text: String,
    pub tone: FactTone,
}

#[derive(Clone, Copy, Debug)]
pub struct RowFactInput<'a> {
    pub state: WorkspaceLiveState,
    pub message: Option<&'a str>,
    pub offline: Option<&'a str>,
    pub running: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StateCounts {
    pub waiting: usize,
    pub error: usize,
    pub working: usize,
}

pub fn row_mark(state: WorkspaceLiveState) -> Option<RowMark> {
    match state {
        WorkspaceLiveState::Idle => None,
        WorkspaceLiveState::Working => Some(RowMark::Working),
        WorkspaceLiveState::Waiting => Some(RowMark::Waiting),
        WorkspaceLiveState::Error => Some(RowMark::Error),
        WorkspaceLiveState::Done => Some(RowMark::Done),
    }
}

pub fn live_terminal_count(panes: &[PaneNode]) -> usize {
    panes
        .iter()
        .filter(|pane| {
            matches!(pane.kind, SurfaceKind::Terminal | SurfaceKind::Agent) && !pane.hibernated
        })
        .count()
}

pub fn row_fact(input: RowFactInput<'_>) -> Option<RowFact> {
    if let Some(message) = non_empty(input.message) {
        let tone = match input.state {
            WorkspaceLiveState::Waiting => FactTone::Waiting,
            WorkspaceLiveState::Error => FactTone::Error,
            _ => FactTone::Plain,
        };
        return Some(RowFact {
            text: message.to_owned(),
            tone,
        });
    }
    non_empty(input.offline)
        .or(non_empty(input.running))
        .map(|text| RowFact {
            text: text.to_owned(),
            tone: FactTone::Muted,
        })
}

pub fn state_counts(states: &[WorkspaceLiveState]) -> StateCounts {
    let mut counts = StateCounts::default();
    for state in states {
        match state {
            WorkspaceLiveState::Working => counts.working += 1,
            WorkspaceLiveState::Waiting => counts.waiting += 1,
            WorkspaceLiveState::Error => counts.error += 1,
            WorkspaceLiveState::Idle | WorkspaceLiveState::Done => {}
        }
    }
    counts
}
