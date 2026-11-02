use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::ExternalId;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::host::Host;
use ostia_base::json_store::load_json;
use ostia_contract::capabilities::{Capability, DEFAULT_CAPABILITIES};
use ostia_control::CapabilityStore as ControlCapabilityStore;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::reach::{ReachMode, parse_reach_mode};

const ALWAYS_ASK: [Capability; 2] = [Capability::Destructive, Capability::Credentials];

fn read_settings(path: &Path) -> Option<Value> {
    load_json(path)
}

fn capability_named(raw: &Value) -> Option<Capability> {
    serde_json::from_value(raw.clone()).ok()
}

fn grants_in(capabilities: Option<&Value>) -> Vec<Capability> {
    capabilities
        .and_then(|value| value.get("grants"))
        .and_then(Value::as_array)
        .map(|raw| raw.iter().filter_map(capability_named).collect())
        .unwrap_or_default()
}

fn grants_of(settings: Option<&Value>) -> Vec<Capability> {
    grants_in(settings.and_then(|value| value.get("capabilities")))
}

fn reach_of(settings: Option<&Value>) -> ReachMode {
    parse_reach_mode(
        settings
            .and_then(|value| value.get("capabilities"))
            .and_then(|value| value.get("reach")),
    )
}

fn unique(caps: impl IntoIterator<Item = Capability>) -> Vec<Capability> {
    let mut seen = HashSet::new();
    caps.into_iter().filter(|cap| seen.insert(*cap)).collect()
}

fn spread(capabilities: Option<&Value>) -> Map<String, Value> {
    match capabilities {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item.clone()))
            .collect(),
        _ => Map::new(),
    }
}

struct State {
    settings_path: PathBuf,
    grants: HashMap<ExternalId, HashSet<Capability>>,
    follows_settings: HashSet<ExternalId>,
    granted_caps_cache: Option<Vec<Capability>>,
    reach_mode_cache: Option<ReachMode>,
}

impl State {
    fn load_granted_caps(&mut self) -> Vec<Capability> {
        if let Some(cached) = &self.granted_caps_cache {
            return cached.clone();
        }
        let loaded = grants_of(read_settings(&self.settings_path).as_ref());
        self.granted_caps_cache = Some(loaded.clone());
        loaded
    }

    fn apply_granted_caps(&mut self, next: Vec<Capability>) {
        let before = self.load_granted_caps();
        let next = unique(next);
        let added: Vec<Capability> = next
            .iter()
            .copied()
            .filter(|cap| !before.contains(cap))
            .collect();
        let removed: Vec<Capability> = before
            .iter()
            .copied()
            .filter(|cap| !next.contains(cap) && !DEFAULT_CAPABILITIES.contains(cap))
            .collect();
        self.granted_caps_cache = Some(next);
        for external_id in &self.follows_settings {
            let Some(set) = self.grants.get_mut(external_id) else {
                continue;
            };
            set.extend(added.iter().copied());
            for cap in &removed {
                set.remove(cap);
            }
        }
    }

    fn write_capabilities(&self, change: impl FnOnce(&mut Map<String, Value>)) -> bool {
        if !self.settings_path.parent().is_some_and(Path::is_dir) {
            return false;
        }
        let mut settings = if self.settings_path.exists() {
            match load_json(&self.settings_path) {
                Some(Value::Object(map)) => map,
                _ => return false,
            }
        } else {
            Map::new()
        };
        let mut next = spread(settings.get("capabilities"));
        change(&mut next);
        settings.insert("capabilities".to_owned(), Value::Object(next));
        let Ok(mut text) = serde_json::to_string_pretty(&Value::Object(settings)) else {
            return false;
        };
        text.push('\n');
        write_file_atomic(
            &self.settings_path,
            text.as_bytes(),
            AtomicWriteOptions::default(),
        )
        .is_ok()
    }

    fn write_granted_caps(
        &mut self,
        change: impl FnOnce(Vec<Capability>) -> Vec<Capability>,
    ) -> bool {
        let mut next = Vec::new();
        let written = self.write_capabilities(|capabilities| {
            let current = grants_in(Some(&Value::Object(capabilities.clone())));
            next = change(current);
            capabilities.insert(
                "grants".to_owned(),
                Value::Array(
                    next.iter()
                        .map(|cap| Value::String(cap.name().to_owned()))
                        .collect(),
                ),
            );
        });
        if written {
            self.apply_granted_caps(next);
        }
        written
    }

    fn init_caps(&mut self, external_id: &ExternalId) {
        if self.grants.contains_key(external_id) {
            return;
        }
        let mut set: HashSet<Capability> = DEFAULT_CAPABILITIES.into_iter().collect();
        set.extend(self.load_granted_caps());
        self.grants.insert(external_id.clone(), set);
        self.follows_settings.insert(external_id.clone());
    }
}

#[derive(Clone)]
pub struct CapabilityStore {
    state: Arc<Mutex<State>>,
}

impl CapabilityStore {
    pub fn new(host: &Host) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                settings_path: host.app_config_dir().join("settings.json"),
                grants: HashMap::new(),
                follows_settings: HashSet::new(),
                granted_caps_cache: None,
                reach_mode_cache: None,
            })),
        }
    }

    pub fn grant(&self, external_id: &ExternalId, cap: Capability) {
        let mut state = self.state.lock();
        state.init_caps(external_id);
        if let Some(set) = state.grants.get_mut(external_id) {
            set.insert(cap);
        }
    }

    pub fn drop_identity(&self, external_id: &ExternalId) {
        let mut state = self.state.lock();
        state.grants.remove(external_id);
        state.follows_settings.remove(external_id);
    }

    pub fn revoke(&self, external_id: &ExternalId, cap: Capability) {
        if let Some(set) = self.state.lock().grants.get_mut(external_id) {
            set.remove(&cap);
        }
    }

    pub fn refresh_capability_settings(&self) {
        let mut state = self.state.lock();
        let settings = read_settings(&state.settings_path);
        state.apply_granted_caps(grants_of(settings.as_ref()));
        state.reach_mode_cache = Some(reach_of(settings.as_ref()));
    }

    pub fn load_reach_mode(&self) -> ReachMode {
        let mut state = self.state.lock();
        if let Some(mode) = state.reach_mode_cache {
            return mode;
        }
        let mode = reach_of(read_settings(&state.settings_path).as_ref());
        state.reach_mode_cache = Some(mode);
        mode
    }

    pub fn set_reach_mode(&self, mode: &Value) -> bool {
        let Some(mode) = ReachMode::parse(mode) else {
            return false;
        };
        let mut state = self.state.lock();
        let written = state.write_capabilities(|capabilities| {
            capabilities.insert("reach".to_owned(), Value::String(mode.name().to_owned()));
        });
        if written {
            state.reach_mode_cache = Some(mode);
        }
        written
    }

    pub fn add_standing_grants(&self, caps: &[Capability]) -> bool {
        if caps.iter().any(|cap| ALWAYS_ASK.contains(cap)) {
            return false;
        }
        let caps = caps.to_vec();
        self.state
            .lock()
            .write_granted_caps(|current| unique(current.into_iter().chain(caps)))
    }

    pub fn remove_standing_grant(&self, cap: Capability) -> bool {
        self.state
            .lock()
            .write_granted_caps(|current| current.into_iter().filter(|c| *c != cap).collect())
    }
}

impl ControlCapabilityStore for CapabilityStore {
    fn init_caps(&self, external_id: &ExternalId) {
        self.state.lock().init_caps(external_id);
    }

    fn set_caps(&self, external_id: &ExternalId, caps: &[Capability]) {
        let mut state = self.state.lock();
        state
            .grants
            .insert(external_id.clone(), caps.iter().copied().collect());
        state.follows_settings.remove(external_id);
    }

    fn has_cap(&self, external_id: &ExternalId, cap: Capability) -> bool {
        self.state
            .lock()
            .grants
            .get(external_id)
            .is_some_and(|set| set.contains(&cap))
    }
}
