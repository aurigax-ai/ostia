use std::collections::HashSet;

#[derive(Clone, Debug, Default)]
pub struct ReplacedShells {
    panes: HashSet<String>,
}

impl ReplacedShells {
    pub fn note(&mut self, pane_id: &str) {
        self.panes.insert(pane_id.to_owned());
    }

    pub fn has(&self, pane_id: &str) -> bool {
        self.panes.contains(pane_id)
    }

    pub fn reset(&mut self) {
        self.panes.clear();
    }
}
