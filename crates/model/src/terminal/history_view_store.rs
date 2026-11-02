use std::collections::HashMap;

use ostia_contract::scrollback_history::{HistoryMatch, HistorySearchOptions};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryFind {
    pub query: String,
    pub options: HistorySearchOptions,
    pub matches: Vec<HistoryMatch>,
    pub index: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryTarget {
    AboveLive,
    Line(i64),
    Match(HistoryFind),
}

#[derive(Clone, Debug, Default)]
pub struct HistoryViewStore {
    open: HashMap<String, HistoryTarget>,
}

impl HistoryViewStore {
    pub fn of_pane(&self, pane_id: &str) -> Option<&HistoryTarget> {
        self.open.get(pane_id)
    }

    pub fn show(&mut self, pane_id: &str, target: HistoryTarget) {
        self.open.insert(pane_id.to_owned(), target);
    }

    pub fn close(&mut self, pane_id: &str) -> bool {
        self.open.remove(pane_id).is_some()
    }
}
