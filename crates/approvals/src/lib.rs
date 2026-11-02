pub mod reach_scope;
pub mod script_token_requests;

use std::collections::{HashMap, HashSet};

use ostia_base::ExternalId;
use ostia_contract::capabilities::{Capability, DEFAULT_CAPABILITIES};
use ostia_control::CapabilityStore;
use parking_lot::Mutex;

#[derive(Default)]
pub struct GrantTable {
    grants: Mutex<HashMap<ExternalId, HashSet<Capability>>>,
}

impl GrantTable {
    pub fn grant(&self, external_id: &ExternalId, cap: Capability) {
        self.init_caps(external_id);
        if let Some(caps) = self.grants.lock().get_mut(external_id) {
            caps.insert(cap);
        }
    }
}

impl CapabilityStore for GrantTable {
    fn init_caps(&self, external_id: &ExternalId) {
        self.grants
            .lock()
            .entry(external_id.clone())
            .or_insert_with(|| DEFAULT_CAPABILITIES.into_iter().collect());
    }

    fn set_caps(&self, external_id: &ExternalId, caps: &[Capability]) {
        self.grants
            .lock()
            .insert(external_id.clone(), caps.iter().copied().collect());
    }

    fn has_cap(&self, external_id: &ExternalId, cap: Capability) -> bool {
        self.grants
            .lock()
            .get(external_id)
            .is_some_and(|caps| caps.contains(&cap))
    }
}
