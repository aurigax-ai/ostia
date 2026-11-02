use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct PaneActivity {
    last_activity: HashMap<String, f64>,
}

impl PaneActivity {
    pub fn mark(&mut self, pane_id: &str, at: f64) {
        self.last_activity.insert(pane_id.to_owned(), at);
    }

    pub fn at(&self, pane_id: &str) -> Option<f64> {
        self.last_activity.get(pane_id).copied()
    }

    pub fn forget(&mut self, pane_id: &str) {
        self.last_activity.remove(pane_id);
    }
}
