use std::collections::HashMap;

use ostia_contract::remote_folders::RemoteCwd;

#[derive(Clone, Debug, Default)]
pub struct RemoteCwdStore {
    by_pane: HashMap<String, RemoteCwd>,
}

impl RemoteCwdStore {
    pub fn of_pane(&self, pane_id: &str) -> Option<&RemoteCwd> {
        self.by_pane.get(pane_id)
    }

    pub fn report(&mut self, pane_id: &str, remote: Option<RemoteCwd>) -> bool {
        let Some(remote) = remote else {
            return self.by_pane.remove(pane_id).is_some();
        };
        if self.by_pane.get(pane_id) == Some(&remote) {
            return false;
        }
        self.by_pane.insert(pane_id.to_owned(), remote);
        true
    }
}
