use std::collections::BTreeSet;

use serde_json::Value;

const MAX_WATCHED: usize = 500;

#[derive(Clone, Debug, Default)]
pub struct WatchSets {
    by_window: Vec<(String, BTreeSet<String>)>,
}

impl WatchSets {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, window_id: &str, raw: &Value) -> bool {
        let next: BTreeSet<String> = raw
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .take(MAX_WATCHED)
            .map(str::to_owned)
            .collect();
        let position = self.by_window.iter().position(|(id, _)| id == window_id);
        let unchanged = match position {
            Some(index) => self.by_window[index].1 == next,
            None => next.is_empty(),
        };
        if unchanged {
            return false;
        }
        match (position, next.is_empty()) {
            (Some(index), true) => {
                self.by_window.remove(index);
            }
            (Some(index), false) => self.by_window[index].1 = next,
            (None, _) => self.by_window.push((window_id.to_owned(), next)),
        }
        true
    }

    pub fn drop_window(&mut self, window_id: &str) -> bool {
        let before = self.by_window.len();
        self.by_window.retain(|(id, _)| id != window_id);
        self.by_window.len() != before
    }

    pub fn is_empty(&self) -> bool {
        self.by_window.is_empty()
    }

    pub fn union(&self) -> BTreeSet<String> {
        self.by_window
            .iter()
            .flat_map(|(_, ids)| ids.iter().cloned())
            .collect()
    }

    pub fn windows(&self) -> Vec<(String, BTreeSet<String>)> {
        self.by_window.clone()
    }
}
