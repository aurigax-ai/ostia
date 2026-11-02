pub mod attention_file;
pub mod control_mode;
pub mod folder_access;
pub mod headless_screen;
pub mod history_feed;
pub mod history_ipc;
pub mod history_records;
pub mod history_search;
pub mod history_spill;
pub mod keep_shells_banner;
pub mod kept_attention;
pub mod pane_banner;
pub mod pane_histories;
pub mod pane_history;
pub mod pane_launcher;
pub mod pty_flow;
pub mod pty_reaper;
pub mod pty_ring_buffer;
pub mod pty_size;
pub mod screen_replay;
pub mod screen_title_filter;
pub mod scrollback_history;
pub mod spill_host;
pub mod spill_terminal;
pub mod tmux_command;
pub mod tmux_conf;
pub mod tmux_pane;

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
