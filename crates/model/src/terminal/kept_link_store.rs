use std::collections::HashMap;

use ostia_contract::pty_api::KeptLink;

#[derive(Clone, Debug, Default)]
pub struct KeptLinkStore {
    by_pane: HashMap<String, KeptLink>,
}

impl KeptLinkStore {
    pub fn of_pane(&self, pane_id: &str) -> Option<KeptLink> {
        self.by_pane.get(pane_id).copied()
    }

    pub fn set(&mut self, pane_id: &str, link: KeptLink) -> bool {
        if link == KeptLink::Up {
            return self.by_pane.remove(pane_id).is_some();
        }
        if self.by_pane.get(pane_id) == Some(&link) {
            return false;
        }
        self.by_pane.insert(pane_id.to_owned(), link);
        true
    }
}
