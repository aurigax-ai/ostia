pub mod pane_banner;
pub mod pane_launcher;
pub mod pty_flow;
pub mod pty_reaper;
pub mod pty_ring_buffer;

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
