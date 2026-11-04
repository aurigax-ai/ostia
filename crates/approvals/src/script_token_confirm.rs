use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ostia_contract::capabilities::Capability;
use ostia_contract::script_tokens::ScriptTokenScope;
use ostia_rpc::RpcError;
use parking_lot::Mutex;

use crate::script_token_requests::fail;
use crate::user_presence::{PresenceFailure, PresenceResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceAction {
    Generate,
    Regenerate,
}

impl PresenceAction {
    fn word(self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::Regenerate => "regenerate",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresenceRequest {
    pub action: PresenceAction,
    pub name: String,
}

pub type UserPresenceCheck = Arc<
    dyn Fn(PresenceRequest) -> Pin<Box<dyn Future<Output = PresenceResult> + Send>> + Send + Sync,
>;

fn unavailable_check() -> UserPresenceCheck {
    Arc::new(|_| {
        Box::pin(async {
            PresenceResult::Refused {
                code: PresenceFailure::Unavailable,
                detail: "no user presence check is set up".to_owned(),
                hint: None,
            }
        })
    })
}

#[derive(Clone)]
pub struct ScriptTokenConfirm {
    check: Arc<Mutex<UserPresenceCheck>>,
}

impl Default for ScriptTokenConfirm {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptTokenConfirm {
    pub fn new() -> Self {
        Self {
            check: Arc::new(Mutex::new(unavailable_check())),
        }
    }

    pub fn set_user_presence_check(&self, check: UserPresenceCheck) {
        *self.check.lock() = check;
    }

    pub fn check_user_presence(
        &self,
        request: PresenceRequest,
    ) -> impl Future<Output = PresenceResult> + Send + use<> {
        let check = Arc::clone(&self.check.lock());
        check(request)
    }

    pub fn confirm_user_presence(
        &self,
        request: PresenceRequest,
    ) -> impl Future<Output = Result<(), RpcError>> + Send + use<> {
        let what = format!(
            "{} the script token \"{}\"",
            request.action.word(),
            request.name
        );
        let checking = self.check_user_presence(request);
        async move {
            match checking.await {
                PresenceResult::Granted { .. } => Ok(()),
                PresenceResult::Refused { code, detail, .. } => Err(fail(format!(
                    "presence-{}: could not confirm it is you to {what} ({detail})",
                    code.name()
                ))),
            }
        }
    }
}

pub fn describe_scope(scope: &ScriptTokenScope) -> String {
    match scope {
        ScriptTokenScope::All => "every workspace".to_owned(),
        ScriptTokenScope::Limited {
            groups,
            workspaces,
            own_workspaces,
        } => {
            let mut parts: Vec<String> = groups.iter().map(|id| format!("group {id}")).collect();
            parts.extend(workspaces.iter().map(|id| format!("workspace {id}")));
            if *own_workspaces {
                parts.push("the workspaces it creates there".to_owned());
            }
            parts.join(", ")
        }
    }
}

pub fn describe_expiry(expires_at: Option<&str>) -> String {
    match expires_at {
        None => "NEVER expires (warning: it stays valid until revoked)".to_owned(),
        Some(date) => format!("expires {date}"),
    }
}

pub fn approval_caps(caps: &[Capability], scope: &ScriptTokenScope) -> Vec<Capability> {
    let mut out = vec![Capability::SettingsWrite];
    out.extend_from_slice(caps);
    if matches!(scope, ScriptTokenScope::All) {
        out.push(Capability::AllWorkspaces);
    }
    out
}
