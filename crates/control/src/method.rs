use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_contract::capabilities::Capability;
use ostia_rpc::RpcError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::auth::{AuthedConn, ControlAuth};
use crate::conn::ConnHandle;
use crate::identity::{IdentityKind, PaneIdentity};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Callers {
    Panes,
    Extensions,
    Manager,
    All,
}

pub fn caller_allowed(identity: &PaneIdentity, callers: Callers, scripts: bool) -> bool {
    if identity.kind == IdentityKind::Script {
        return scripts;
    }
    match callers {
        Callers::All => true,
        Callers::Manager => identity.kind == IdentityKind::Pane && identity.manager,
        Callers::Extensions => identity.kind == IdentityKind::Extension,
        Callers::Panes => identity.kind == IdentityKind::Pane,
    }
}

#[derive(Clone)]
pub struct MethodContext {
    pub identity: PaneIdentity,
    pub authed: AuthedConn,
    pub conn: ConnHandle,
    pub cancel: CancellationToken,
    pub auth: Arc<ControlAuth>,
}

type Handler =
    Arc<dyn Fn(Value, MethodContext) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

#[derive(Clone)]
pub struct ControlMethod {
    pub(crate) cap: Option<Capability>,
    pub(crate) callers: Callers,
    pub(crate) scripts: bool,
    pub(crate) targetable: bool,
    pub(crate) handler: Handler,
}

impl ControlMethod {
    pub fn new<F, Fut>(handler: F) -> Self
    where
        F: Fn(Value, MethodContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, RpcError>> + Send + 'static,
    {
        Self {
            cap: None,
            callers: Callers::Panes,
            scripts: false,
            targetable: false,
            handler: Arc::new(move |params, ctx| handler(params, ctx).boxed()),
        }
    }

    pub fn cap(mut self, cap: Capability) -> Self {
        self.cap = Some(cap);
        self
    }

    pub fn callers(mut self, callers: Callers) -> Self {
        self.callers = callers;
        self
    }

    pub fn scripts(mut self) -> Self {
        self.scripts = true;
        self
    }

    pub fn targetable(mut self) -> Self {
        self.targetable = true;
        self
    }

    pub(crate) fn allowed_callers(&self) -> Callers {
        if self.targetable {
            Callers::All
        } else {
            self.callers
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("control method already registered: {0}")]
pub struct DuplicateMethod(pub String);

#[derive(Clone, Default)]
pub struct MethodTable {
    methods: HashMap<String, ControlMethod>,
}

impl MethodTable {
    pub fn register(&mut self, name: &str, method: ControlMethod) -> Result<(), DuplicateMethod> {
        if self.methods.contains_key(name) {
            return Err(DuplicateMethod(name.to_owned()));
        }
        self.methods.insert(name.to_owned(), method);
        Ok(())
    }

    pub(crate) fn get(&self, name: &str) -> Option<&ControlMethod> {
        self.methods.get(name)
    }
}
