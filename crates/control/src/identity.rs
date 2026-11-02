use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use hmac::{Hmac, KeyInit, Mac};
use ostia_base::random::random_bytes;
use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use parking_lot::Mutex;
use sha2::Sha256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityKind {
    Pane,
    Extension,
    Script,
}

impl IdentityKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Pane => "pane",
            Self::Extension => "extension",
            Self::Script => "script",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct PaneIdentity {
    pub kind: IdentityKind,
    pub external_id: ExternalId,
    pub token: String,
    pub window_id: WindowId,
    pub workspace_id: WorkspaceId,
    pub pane_id: PaneId,
    pub ext_id: Option<String>,
    pub manager: bool,
}

impl fmt::Debug for PaneIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PaneIdentity")
            .field("kind", &self.kind)
            .field("external_id", &self.external_id)
            .field("window_id", &self.window_id)
            .field("workspace_id", &self.workspace_id)
            .field("pane_id", &self.pane_id)
            .field("ext_id", &self.ext_id)
            .field("manager", &self.manager)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct PaneInput {
    pub window_id: WindowId,
    pub workspace_id: WorkspaceId,
    pub pane_id: PaneId,
}

#[derive(Default)]
struct Tables {
    by_external: HashMap<ExternalId, PaneIdentity>,
    by_token: HashMap<String, ExternalId>,
    by_pane: HashMap<PaneId, ExternalId>,
    by_extension: HashMap<String, ExternalId>,
    by_script: HashMap<String, ExternalId>,
}

impl Tables {
    fn index(&mut self, identity: PaneIdentity) {
        self.by_token
            .insert(identity.token.clone(), identity.external_id.clone());
        self.by_external
            .insert(identity.external_id.clone(), identity);
    }

    fn unindex(&mut self, external_id: &ExternalId) {
        if let Some(identity) = self.by_external.remove(external_id) {
            self.by_token.remove(&identity.token);
        }
    }

    fn remove_pane(&mut self, pane_id: &PaneId) -> bool {
        match self.by_pane.remove(pane_id) {
            Some(external) => {
                self.unindex(&external);
                true
            }
            None => false,
        }
    }

    fn pane_mut(&mut self, pane_id: &PaneId) -> Option<&mut PaneIdentity> {
        let external = self.by_pane.get(pane_id)?;
        self.by_external.get_mut(external)
    }

    fn panes(&self) -> impl Iterator<Item = &PaneIdentity> {
        self.by_pane
            .values()
            .filter_map(|external| self.by_external.get(external))
    }
}

pub type NameDrop = Arc<dyn Fn(&PaneId) + Send + Sync>;

#[derive(Clone)]
pub struct IdRegistry {
    salt: Arc<[u8]>,
    tables: Arc<Mutex<Tables>>,
    name_drop: NameDrop,
}

#[allow(clippy::expect_used)]
fn hmac_hex(salt: &[u8], text: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt).expect("HMAC takes a key of any length");
    mac.update(text.as_bytes());
    hex::encode(mac.finalize().into_bytes().as_slice())
}

pub fn stable_pane_external_id(salt: &[u8], pane_id: &PaneId) -> ExternalId {
    let h = hmac_hex(salt, pane_id.as_str());
    let nibble = u8::from_str_radix(&h[16..17], 16).unwrap_or(0);
    let variant = (nibble & 0x3) | 0x8;
    ExternalId(format!(
        "{}-{}-4{}-{variant:x}{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32],
    ))
}

fn new_token() -> String {
    hex::encode(random_bytes::<32>())
}

impl IdRegistry {
    pub fn new(salt: &[u8]) -> Self {
        Self::with_name_drop(salt, Arc::new(|_| {}))
    }

    pub fn with_name_drop(salt: &[u8], name_drop: NameDrop) -> Self {
        Self {
            salt: Arc::from(salt),
            tables: Arc::default(),
            name_drop,
        }
    }

    pub fn register_pane(&self, input: PaneInput) -> PaneIdentity {
        let mut tables = self.tables.lock();
        if let Some(external) = tables.by_pane.get(&input.pane_id).cloned()
            && let Some(existing) = tables.by_external.get_mut(&external)
        {
            existing.window_id = input.window_id;
            if !input.workspace_id.is_empty() {
                existing.workspace_id = input.workspace_id;
            }
            return existing.clone();
        }
        let identity = PaneIdentity {
            kind: IdentityKind::Pane,
            external_id: stable_pane_external_id(&self.salt, &input.pane_id),
            token: new_token(),
            window_id: input.window_id,
            workspace_id: input.workspace_id,
            pane_id: input.pane_id,
            ext_id: None,
            manager: false,
        };
        tables
            .by_pane
            .insert(identity.pane_id.clone(), identity.external_id.clone());
        tables.index(identity.clone());
        identity
    }

    pub fn adopt_pane(&self, input: PaneInput) -> PaneIdentity {
        let mut dropped = Vec::new();
        let identity = {
            let mut tables = self.tables.lock();
            if tables.remove_pane(&input.pane_id) {
                dropped.push(input.pane_id.clone());
            }
            let external_id = stable_pane_external_id(&self.salt, &input.pane_id);
            if let Some(taken) = tables
                .by_external
                .get(&external_id)
                .map(|t| t.pane_id.clone())
                && tables.remove_pane(&taken)
            {
                dropped.push(taken);
            }
            let identity = PaneIdentity {
                kind: IdentityKind::Pane,
                external_id,
                token: new_token(),
                window_id: input.window_id,
                workspace_id: input.workspace_id,
                pane_id: input.pane_id,
                ext_id: None,
                manager: false,
            };
            tables
                .by_pane
                .insert(identity.pane_id.clone(), identity.external_id.clone());
            tables.index(identity.clone());
            identity
        };
        self.drop_names(&dropped);
        identity
    }

    pub fn remove_pane(&self, pane_id: &PaneId) {
        let removed = self.tables.lock().remove_pane(pane_id);
        if removed {
            (self.name_drop)(pane_id);
        }
    }

    pub fn remove_window(&self, window_id: &WindowId) {
        let mut dropped = Vec::new();
        {
            let mut tables = self.tables.lock();
            let doomed: Vec<PaneId> = tables
                .panes()
                .filter(|identity| identity.window_id == *window_id)
                .map(|identity| identity.pane_id.clone())
                .collect();
            for pane_id in doomed {
                if tables.remove_pane(&pane_id) {
                    dropped.push(pane_id);
                }
            }
        }
        self.drop_names(&dropped);
    }

    pub fn panes_owned_by(&self, pane_ids: &[PaneId], window_id: &WindowId) -> bool {
        let tables = self.tables.lock();
        pane_ids.iter().all(|pane_id| {
            tables
                .by_pane
                .get(pane_id)
                .and_then(|external| tables.by_external.get(external))
                .is_none_or(|identity| identity.window_id == *window_id)
        })
    }

    pub fn rehome_panes(&self, pane_ids: &[PaneId], window_id: &WindowId) -> Vec<PaneIdentity> {
        let mut tables = self.tables.lock();
        pane_ids
            .iter()
            .filter_map(|pane_id| {
                let identity = tables.pane_mut(pane_id)?;
                identity.window_id = window_id.clone();
                Some(identity.clone())
            })
            .collect()
    }

    pub fn move_to_workspace(
        &self,
        pane_ids: &[PaneId],
        workspace_id: &WorkspaceId,
    ) -> Vec<PaneIdentity> {
        let mut tables = self.tables.lock();
        pane_ids
            .iter()
            .filter_map(|pane_id| {
                let identity = tables.pane_mut(pane_id)?;
                identity.workspace_id = workspace_id.clone();
                Some(identity.clone())
            })
            .collect()
    }

    pub fn rehome_workspace(
        &self,
        source_id: &WorkspaceId,
        target_id: &WorkspaceId,
    ) -> Vec<PaneIdentity> {
        let mut tables = self.tables.lock();
        let members: Vec<PaneId> = tables
            .panes()
            .filter(|identity| identity.workspace_id == *source_id)
            .map(|identity| identity.pane_id.clone())
            .collect();
        members
            .iter()
            .filter_map(|pane_id| {
                let identity = tables.pane_mut(pane_id)?;
                identity.workspace_id = target_id.clone();
                Some(identity.clone())
            })
            .collect()
    }

    pub fn workspace_has_manager(&self, workspace_id: &WorkspaceId) -> bool {
        self.tables
            .lock()
            .panes()
            .any(|identity| identity.workspace_id == *workspace_id && identity.manager)
    }

    pub fn pane_identities(&self) -> Vec<PaneIdentity> {
        self.tables.lock().panes().cloned().collect()
    }

    pub fn window_of_workspace(&self, workspace_id: &WorkspaceId) -> Option<WindowId> {
        self.tables
            .lock()
            .panes()
            .find(|identity| identity.workspace_id == *workspace_id)
            .map(|identity| identity.window_id.clone())
    }

    fn drop_names(&self, pane_ids: &[PaneId]) {
        for pane_id in pane_ids {
            (self.name_drop)(pane_id);
        }
    }

    pub fn register_extension(&self, ext_id: &str) -> PaneIdentity {
        self.remove_extension(ext_id, None);
        let mut tables = self.tables.lock();
        let identity = PaneIdentity {
            kind: IdentityKind::Extension,
            external_id: ExternalId(uuid::Uuid::new_v4().to_string()),
            token: new_token(),
            window_id: WindowId::default(),
            workspace_id: WorkspaceId::default(),
            pane_id: PaneId::default(),
            ext_id: Some(ext_id.to_owned()),
            manager: false,
        };
        tables
            .by_extension
            .insert(ext_id.to_owned(), identity.external_id.clone());
        tables.index(identity.clone());
        identity
    }

    pub fn remove_extension(&self, ext_id: &str, external_id: Option<&ExternalId>) {
        let mut tables = self.tables.lock();
        let Some(current) = tables.by_extension.get(ext_id) else {
            return;
        };
        if external_id.is_some_and(|given| given != current) {
            return;
        }
        let current = current.clone();
        tables.by_extension.remove(ext_id);
        tables.unindex(&current);
    }

    pub fn remove_script(&self, script_id: &str) {
        let mut tables = self.tables.lock();
        if let Some(external) = tables.by_script.remove(script_id) {
            tables.unindex(&external);
        }
    }

    pub fn register_script(&self, script_id: &str) -> PaneIdentity {
        let mut tables = self.tables.lock();
        if let Some(existing) = tables
            .by_script
            .get(script_id)
            .and_then(|external| tables.by_external.get(external))
        {
            return existing.clone();
        }
        let identity = PaneIdentity {
            kind: IdentityKind::Script,
            external_id: ExternalId::new(script_id),
            token: new_token(),
            window_id: WindowId::default(),
            workspace_id: WorkspaceId::default(),
            pane_id: PaneId::default(),
            ext_id: None,
            manager: false,
        };
        tables
            .by_script
            .insert(script_id.to_owned(), identity.external_id.clone());
        tables.index(identity.clone());
        identity
    }

    pub fn mark_manager(&self, pane_id: &PaneId) -> Option<PaneIdentity> {
        let mut tables = self.tables.lock();
        let external = tables.by_pane.get(pane_id)?.clone();
        let identity = tables.by_external.get_mut(&external)?;
        identity.manager = true;
        Some(identity.clone())
    }

    pub fn get_by_pane_id(&self, pane_id: &PaneId) -> Option<PaneIdentity> {
        let tables = self.tables.lock();
        tables
            .by_external
            .get(tables.by_pane.get(pane_id)?)
            .cloned()
    }

    pub fn resolve_external(&self, external_id: &ExternalId) -> Option<PaneIdentity> {
        self.tables.lock().by_external.get(external_id).cloned()
    }

    pub fn resolve_token(&self, token: &str) -> Option<PaneIdentity> {
        let tables = self.tables.lock();
        tables.by_external.get(tables.by_token.get(token)?).cloned()
    }
}
