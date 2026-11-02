use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

type SeedsByWorkspace = HashMap<String, HashMap<String, String>>;

#[derive(Clone, Debug, Default)]
pub struct SplitTabSeeds {
    seeds: Arc<Mutex<SeedsByWorkspace>>,
}

impl SplitTabSeeds {
    pub fn seed_split_tab(&self, workspace_id: &str, name: &str, pane_id: &str) {
        self.seeds
            .lock()
            .entry(workspace_id.to_owned())
            .or_default()
            .insert(name.to_owned(), pane_id.to_owned());
    }

    pub fn split_tab_seed(&self, workspace_id: &str, name: &str) -> Option<String> {
        self.seeds.lock().get(workspace_id)?.get(name).cloned()
    }

    pub fn forget_split_tab_seeds<I, S>(&self, pane_ids: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let gone: Vec<S> = pane_ids.into_iter().collect();
        for named in self.seeds.lock().values_mut() {
            named.retain(|_, pane_id| !gone.iter().any(|id| id.as_ref() == pane_id));
        }
    }
}
