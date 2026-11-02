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
}

#[derive(Clone)]
pub struct IdRegistry {
    salt: Arc<[u8]>,
    tables: Arc<Mutex<Tables>>,
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
        Self {
            salt: Arc::from(salt),
            tables: Arc::default(),
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

    pub fn remove_pane(&self, pane_id: &PaneId) {
        let mut tables = self.tables.lock();
        if let Some(external) = tables.by_pane.remove(pane_id) {
            tables.unindex(&external);
        }
    }

    pub fn register_extension(&self, ext_id: &str) -> PaneIdentity {
        let mut tables = self.tables.lock();
        if let Some(external) = tables.by_extension.remove(ext_id) {
            tables.unindex(&external);
        }
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
