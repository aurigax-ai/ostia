pub mod screen_replay;
pub mod screen_title_filter;
pub mod tmux_command;
pub mod tmux_conf;

use std::collections::HashMap;
use std::sync::Arc;

use ostia_base::PaneId;
use ostia_contract::terminal_state::TerminalStateSnapshot;
use parking_lot::Mutex;

#[derive(Clone, Default)]
pub struct TerminalStates {
    states: Arc<Mutex<HashMap<PaneId, TerminalStateSnapshot>>>,
}

impl TerminalStates {
    pub fn push(&self, snapshot: TerminalStateSnapshot) {
        self.states
            .lock()
            .insert(snapshot.pane_id.clone(), snapshot);
    }

    pub fn get(&self, pane_id: &PaneId) -> Option<TerminalStateSnapshot> {
        self.states.lock().get(pane_id).cloned()
    }
}
