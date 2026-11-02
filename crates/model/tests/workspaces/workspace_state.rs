#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::{AttentionState, WorkspaceLiveState};
use ostia_model::workspaces::workspace_state::{RailStrings, state_label};

fn rail() -> RailStrings {
    RailStrings {
        state_working: "Working".to_string(),
        state_waiting: "Waiting for input".to_string(),
        state_done: "Done".to_string(),
        state_error: "Error".to_string(),
        state_idle: "Idle".to_string(),
    }
}

#[test]
fn labels_each_workspace_state_from_the_rail_text() {
    let d = rail();
    let table = [
        (WorkspaceLiveState::Working, "Working"),
        (WorkspaceLiveState::Waiting, "Waiting for input"),
        (WorkspaceLiveState::Done, "Done"),
        (WorkspaceLiveState::Error, "Error"),
        (WorkspaceLiveState::Idle, "Idle"),
    ];
    for (state, text) in table {
        assert_eq!(state_label(&d, state), text, "{state:?}");
    }
}

#[test]
fn labels_each_attention_state_and_reads_none_as_idle() {
    let d = rail();
    let table = [
        (AttentionState::Working, "Working"),
        (AttentionState::Waiting, "Waiting for input"),
        (AttentionState::Done, "Done"),
        (AttentionState::Error, "Error"),
        (AttentionState::None, "Idle"),
    ];
    for (state, text) in table {
        assert_eq!(state_label(&d, state), text, "{state:?}");
    }
}
