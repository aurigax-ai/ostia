use ostia_contract::attention::{AttentionState, WorkspaceLiveState};

pub struct RailStrings {
    pub state_working: String,
    pub state_waiting: String,
    pub state_done: String,
    pub state_error: String,
    pub state_idle: String,
}

#[derive(Clone, Copy)]
pub enum RailKey {
    Working,
    Waiting,
    Done,
    Error,
    Idle,
}

impl From<WorkspaceLiveState> for RailKey {
    fn from(state: WorkspaceLiveState) -> Self {
        match state {
            WorkspaceLiveState::Working => Self::Working,
            WorkspaceLiveState::Waiting => Self::Waiting,
            WorkspaceLiveState::Done => Self::Done,
            WorkspaceLiveState::Error => Self::Error,
            WorkspaceLiveState::Idle => Self::Idle,
        }
    }
}

impl From<AttentionState> for RailKey {
    fn from(state: AttentionState) -> Self {
        match state {
            AttentionState::Working => Self::Working,
            AttentionState::Waiting => Self::Waiting,
            AttentionState::Done => Self::Done,
            AttentionState::Error => Self::Error,
            AttentionState::None => Self::Idle,
        }
    }
}

pub fn state_label(strings: &RailStrings, state: impl Into<RailKey>) -> &str {
    match state.into() {
        RailKey::Working => strings.state_working.as_str(),
        RailKey::Waiting => strings.state_waiting.as_str(),
        RailKey::Done => strings.state_done.as_str(),
        RailKey::Error => strings.state_error.as_str(),
        RailKey::Idle => strings.state_idle.as_str(),
    }
}
