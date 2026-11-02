use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppLinkPrompt {
    Ask { url: String, app: String },
    NoApp { url: String },
    Failed { url: String, app: String },
}

#[derive(Clone, Debug, Default)]
pub struct AppLinkStore {
    by_pane: HashMap<String, AppLinkPrompt>,
}

impl AppLinkStore {
    pub fn of_pane(&self, pane_id: &str) -> Option<&AppLinkPrompt> {
        self.by_pane.get(pane_id)
    }

    pub fn show(&mut self, pane_id: &str, prompt: AppLinkPrompt) {
        self.by_pane.insert(pane_id.to_owned(), prompt);
    }

    pub fn release(&mut self, pane_id: &str) -> bool {
        self.by_pane.remove(pane_id).is_some()
    }
}
