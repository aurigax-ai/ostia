use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;

use crate::browser_profile::{
    BrowserProfile, SHARED_BROWSER_PARTITION, is_isolated_browser_partition,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserPaneOwner {
    pub window_id: String,
    pub workspace_id: String,
}

pub struct BrowserProfilesDeps {
    pub owner_of: Arc<dyn Fn(&str) -> Option<BrowserPaneOwner> + Send + Sync>,
    pub is_scratch: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub is_sandboxed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

#[derive(Clone)]
pub struct BrowserProfiles {
    deps: Arc<BrowserProfilesDeps>,
    profiles: Arc<Mutex<HashMap<String, BrowserProfile>>>,
}

impl BrowserProfiles {
    pub fn new(deps: BrowserProfilesDeps) -> Self {
        Self {
            deps: Arc::new(deps),
            profiles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn shared_allowed(&self, pane_id: &str, window_id: &str) -> bool {
        let Some(owner) = (self.deps.owner_of)(pane_id) else {
            return false;
        };
        if owner.window_id != window_id || owner.workspace_id.is_empty() {
            return false;
        }
        !(self.deps.is_scratch)(&owner.workspace_id)
            && !(self.deps.is_sandboxed)(&owner.workspace_id)
    }

    pub fn claim(&self, pane_id: &Value, window_id: &str, requested: &Value) -> BrowserProfile {
        let Some(pane_id) = pane_id.as_str().filter(|id| !id.is_empty()) else {
            return BrowserProfile::Isolated;
        };
        match (self.deps.owner_of)(pane_id) {
            Some(owner) if owner.window_id == window_id => {}
            _ => return BrowserProfile::Isolated,
        }
        let allowed =
            requested.as_str() == Some("shared") && self.shared_allowed(pane_id, window_id);
        let mut profiles = self.profiles.lock();
        let shared = allowed && profiles.get(pane_id) != Some(&BrowserProfile::Isolated);
        let profile = if shared {
            BrowserProfile::Shared
        } else {
            BrowserProfile::Isolated
        };
        profiles.insert(pane_id.to_owned(), profile);
        profile
    }

    pub fn accepts_attach(&self, partition: Option<&str>, window_id: &str) -> bool {
        if is_isolated_browser_partition(partition) {
            return true;
        }
        if partition != Some(SHARED_BROWSER_PARTITION) {
            return false;
        }
        let shared_panes: Vec<String> = self
            .profiles
            .lock()
            .iter()
            .filter(|(_, profile)| **profile == BrowserProfile::Shared)
            .map(|(pane_id, _)| pane_id.clone())
            .collect();
        shared_panes
            .iter()
            .any(|pane_id| self.shared_allowed(pane_id, window_id))
    }

    pub fn profile_of(&self, pane_id: &str) -> BrowserProfile {
        self.profiles
            .lock()
            .get(pane_id)
            .copied()
            .unwrap_or(BrowserProfile::Isolated)
    }

    pub fn is_shared(&self, pane_id: &str) -> bool {
        self.profiles.lock().get(pane_id) == Some(&BrowserProfile::Shared)
    }

    pub fn forget(&self, pane_id: &str) {
        self.profiles.lock().remove(pane_id);
    }
}
