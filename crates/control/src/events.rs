use std::fmt;
use std::sync::Arc;

use ostia_attention::WorkspaceLiveState;
use ostia_base::EventHub;
use serde_json::Value;
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformEventType {
    Notify,
    AgentNeedsInput,
    AgentDone,
    SessionState,
    PaneState,
    AskCreated,
    AskResolved,
    ArtifactChanged,
}

pub const PLATFORM_EVENT_TYPES: [PlatformEventType; 8] = [
    PlatformEventType::Notify,
    PlatformEventType::AgentNeedsInput,
    PlatformEventType::AgentDone,
    PlatformEventType::SessionState,
    PlatformEventType::PaneState,
    PlatformEventType::AskCreated,
    PlatformEventType::AskResolved,
    PlatformEventType::ArtifactChanged,
];

impl PlatformEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Notify => "notify",
            Self::AgentNeedsInput => "agent.needs-input",
            Self::AgentDone => "agent.done",
            Self::SessionState => "session.state",
            Self::PaneState => "pane.state",
            Self::AskCreated => "ask.created",
            Self::AskResolved => "ask.resolved",
            Self::ArtifactChanged => "artifact.changed",
        }
    }

    fn slot(self) -> usize {
        match self {
            Self::Notify => 0,
            Self::AgentNeedsInput => 1,
            Self::AgentDone => 2,
            Self::SessionState => 3,
            Self::PaneState => 4,
            Self::AskCreated => 5,
            Self::AskResolved => 6,
            Self::ArtifactChanged => 7,
        }
    }
}

#[derive(Clone, PartialEq)]
pub enum PlatformEvent {
    Notify {
        title: String,
        body: Option<String>,
        from: String,
    },
    AgentNeedsInput {
        session_id: String,
    },
    AgentDone {
        session_id: String,
    },
    SessionState {
        session_id: String,
        state: WorkspaceLiveState,
    },
    PaneState {
        pane_id: String,
        generation: i64,
        cwd: Option<String>,
        running: bool,
        block_count: i64,
        last_exit_code: Option<i64>,
    },
    AskCreated {
        ask: Value,
    },
    AskResolved {
        ask_id: String,
        outcome: String,
    },
    ArtifactChanged {
        session_id: String,
        path: String,
        change: String,
    },
}

impl fmt::Debug for PlatformEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Notify { from, .. } => f
                .debug_struct("Notify")
                .field("from", from)
                .finish_non_exhaustive(),
            Self::AgentNeedsInput { session_id } => f
                .debug_struct("AgentNeedsInput")
                .field("session_id", session_id)
                .finish(),
            Self::AgentDone { session_id } => f
                .debug_struct("AgentDone")
                .field("session_id", session_id)
                .finish(),
            Self::SessionState { session_id, state } => f
                .debug_struct("SessionState")
                .field("session_id", session_id)
                .field("state", state)
                .finish(),
            Self::PaneState {
                pane_id,
                generation,
                running,
                block_count,
                last_exit_code,
                ..
            } => f
                .debug_struct("PaneState")
                .field("pane_id", pane_id)
                .field("generation", generation)
                .field("running", running)
                .field("block_count", block_count)
                .field("last_exit_code", last_exit_code)
                .finish_non_exhaustive(),
            Self::AskCreated { .. } => f.debug_struct("AskCreated").finish_non_exhaustive(),
            Self::AskResolved { ask_id, outcome } => f
                .debug_struct("AskResolved")
                .field("ask_id", ask_id)
                .field("outcome", outcome)
                .finish(),
            Self::ArtifactChanged {
                session_id, change, ..
            } => f
                .debug_struct("ArtifactChanged")
                .field("session_id", session_id)
                .field("change", change)
                .finish_non_exhaustive(),
        }
    }
}

impl PlatformEvent {
    pub fn kind(&self) -> PlatformEventType {
        match self {
            Self::Notify { .. } => PlatformEventType::Notify,
            Self::AgentNeedsInput { .. } => PlatformEventType::AgentNeedsInput,
            Self::AgentDone { .. } => PlatformEventType::AgentDone,
            Self::SessionState { .. } => PlatformEventType::SessionState,
            Self::PaneState { .. } => PlatformEventType::PaneState,
            Self::AskCreated { .. } => PlatformEventType::AskCreated,
            Self::AskResolved { .. } => PlatformEventType::AskResolved,
            Self::ArtifactChanged { .. } => PlatformEventType::ArtifactChanged,
        }
    }
}

#[derive(Clone, Default)]
pub struct PlatformEvents {
    hubs: Arc<[EventHub<PlatformEvent>; 8]>,
}

impl PlatformEvents {
    pub fn subscribe_to(&self, kind: PlatformEventType) -> UnboundedReceiver<PlatformEvent> {
        self.hubs[kind.slot()].subscribe()
    }

    pub fn emit(&self, event: PlatformEvent) {
        self.hubs[event.kind().slot()].emit(event);
    }

    pub fn emit_session_state(&self, session_id: &str, state: WorkspaceLiveState) {
        self.emit(PlatformEvent::SessionState {
            session_id: session_id.to_owned(),
            state,
        });
        match state {
            WorkspaceLiveState::Waiting => self.emit(PlatformEvent::AgentNeedsInput {
                session_id: session_id.to_owned(),
            }),
            WorkspaceLiveState::Done => self.emit(PlatformEvent::AgentDone {
                session_id: session_id.to_owned(),
            }),
            _ => {}
        }
    }
}
