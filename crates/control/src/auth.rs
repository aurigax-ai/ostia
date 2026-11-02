use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_base::clock::Clock;
use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_contract::capabilities::{Capability, CapabilityRefusal, capability_refusal_hint};
use ostia_rpc::RpcError;
use parking_lot::Mutex;
use serde_json::Value;

use crate::identity::{IdRegistry, IdentityKind, PaneIdentity};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthedConn {
    pub external_id: ExternalId,
    pub pane_id: PaneId,
    pub workspace_id: WorkspaceId,
    pub script_session: Option<String>,
}

pub struct ScriptTokenGrant {
    pub id: String,
    pub caps: Vec<Capability>,
    pub expires_at_ms: Option<i64>,
}

pub trait CapabilityStore: Send + Sync {
    fn init_caps(&self, external_id: &ExternalId);
    fn set_caps(&self, external_id: &ExternalId, caps: &[Capability]);
    fn has_cap(&self, external_id: &ExternalId, cap: Capability) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Allow,
    Deny,
    Timeout,
}

#[derive(Clone, Debug)]
pub struct ApprovalRequest {
    pub external_id: ExternalId,
    pub window_id: WindowId,
    pub pane_id: PaneId,
    pub workspace_id: WorkspaceId,
    pub caps: Vec<Capability>,
    pub action: String,
    pub detail: String,
}

pub trait Approver: Send + Sync {
    fn request(&self, request: ApprovalRequest) -> BoxFuture<'static, ApprovalOutcome>;
}

pub type ScriptTokenCheck = Arc<dyn Fn(&str) -> Option<ScriptTokenGrant> + Send + Sync>;
pub type CapFilter = Arc<dyn Fn(&AuthedConn, Capability) -> bool + Send + Sync>;

pub struct ControlAuthParts {
    pub registry: IdRegistry,
    pub caps: Arc<dyn CapabilityStore>,
    pub script_tokens: ScriptTokenCheck,
    pub cap_filter: CapFilter,
    pub approver: Option<Arc<dyn Approver>>,
    pub clock: Clock,
}

pub struct ControlAuth {
    parts: ControlAuthParts,
    script_expiry: Mutex<HashMap<ExternalId, i64>>,
}

pub fn needs_elevation(cap: Capability) -> RpcError {
    RpcError::invalid_request(format!("needs-elevation: {}", cap.name()))
}

fn cap_names(caps: &[Capability]) -> String {
    caps.iter()
        .map(|cap| cap.name())
        .collect::<Vec<_>>()
        .join(", ")
}

impl ControlAuth {
    pub fn new(parts: ControlAuthParts) -> Self {
        Self {
            parts,
            script_expiry: Mutex::default(),
        }
    }

    pub fn registry(&self) -> &IdRegistry {
        &self.parts.registry
    }

    pub fn authenticate(&self, hello: &Value) -> Option<AuthedConn> {
        let token = hello.get("token")?.as_str()?;
        if let Some(identity) = self.parts.registry.resolve_token(token)
            && identity.kind != IdentityKind::Script
        {
            self.parts.caps.init_caps(&identity.external_id);
            return Some(AuthedConn {
                external_id: identity.external_id,
                pane_id: identity.pane_id,
                workspace_id: identity.workspace_id,
                script_session: None,
            });
        }
        let script = (self.parts.script_tokens)(token)?;
        let identity = self.parts.registry.register_script(&script.id);
        self.parts
            .caps
            .set_caps(&identity.external_id, &script.caps);
        let mut expiry = self.script_expiry.lock();
        match script.expires_at_ms {
            Some(at) => expiry.insert(identity.external_id.clone(), at),
            None => expiry.remove(&identity.external_id),
        };
        Some(AuthedConn {
            external_id: identity.external_id,
            pane_id: PaneId::default(),
            workspace_id: WorkspaceId::default(),
            script_session: Some(identity.token),
        })
    }

    pub fn script_expired(&self, external_id: &ExternalId) -> bool {
        let now = (self.parts.clock)();
        self.script_expiry
            .lock()
            .get(external_id)
            .is_some_and(|at| *at <= now)
    }

    pub fn cap_allowed_here(&self, conn: &AuthedConn, cap: Capability) -> bool {
        (self.parts.cap_filter)(conn, cap)
    }

    pub fn conn_has_cap(&self, conn: &AuthedConn, cap: Capability) -> bool {
        self.cap_allowed_here(conn, cap) && self.parts.caps.has_cap(&conn.external_id, cap)
    }

    pub async fn ensure_caps(
        &self,
        authed: &AuthedConn,
        identity: &PaneIdentity,
        caps: &[Capability],
        action: &str,
        detail: &str,
    ) -> Result<(), RpcError> {
        let mut missing: Vec<Capability> = Vec::new();
        for cap in caps {
            if !missing.contains(cap) && !self.conn_has_cap(authed, *cap) {
                missing.push(*cap);
            }
        }
        let Some(first) = missing.first().copied() else {
            return Ok(());
        };
        if let Some(fenced) = missing
            .iter()
            .find(|cap| !self.cap_allowed_here(authed, **cap))
        {
            return Err(RpcError::invalid_request(format!(
                "sandboxed: {}",
                fenced.name()
            )));
        }
        let approver = match &self.parts.approver {
            Some(approver)
                if identity.kind == IdentityKind::Pane
                    && identity.external_id == authed.external_id =>
            {
                Arc::clone(approver)
            }
            _ => return Err(needs_elevation(first)),
        };
        let outcome = approver
            .request(ApprovalRequest {
                external_id: authed.external_id.clone(),
                window_id: identity.window_id.clone(),
                pane_id: identity.pane_id.clone(),
                workspace_id: identity.workspace_id.clone(),
                caps: missing.clone(),
                action: action.to_owned(),
                detail: detail.to_owned(),
            })
            .await;
        match outcome {
            ApprovalOutcome::Allow => Ok(()),
            ApprovalOutcome::Timeout => Err(RpcError::invalid_request(format!(
                "not-approved: {}",
                cap_names(&missing)
            ))
            .with_hint(capability_refusal_hint(
                CapabilityRefusal::NotApproved,
                &missing,
            ))),
            ApprovalOutcome::Deny => Err(RpcError::invalid_request(format!(
                "denied: {}",
                cap_names(&missing)
            ))
            .with_hint(capability_refusal_hint(CapabilityRefusal::Denied, &missing))),
        }
    }
}
