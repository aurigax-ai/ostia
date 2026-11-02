use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ostia_base::js::non_empty;
use ostia_contract::install_method::{
    InstallMethod, UpdateRunStart, UpdateRunState, update_command_line,
};
use parking_lot::Mutex;

#[derive(Clone, PartialEq, Eq)]
pub struct UpdateTerminalRequest {
    pub command: String,
    pub host_token: String,
    pub title: String,
}

impl fmt::Debug for UpdateTerminalRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UpdateTerminalRequest")
            .field("command", &self.command)
            .field("title", &self.title)
            .finish_non_exhaustive()
    }
}

pub type OpenFuture = Pin<Box<dyn Future<Output = Option<String>> + Send>>;

pub struct UpdateRunnerDeps {
    pub method: Box<dyn Fn() -> InstallMethod + Send + Sync>,
    pub title: Box<dyn Fn() -> String + Send + Sync>,
    pub open_terminal: Box<dyn Fn(UpdateTerminalRequest) -> OpenFuture + Send + Sync>,
    pub host_token: Box<dyn Fn(&str) -> String + Send + Sync>,
    pub on_change: Box<dyn Fn(&UpdateRunState) + Send + Sync>,
}

struct Inner {
    state: UpdateRunState,
    pane_id: Option<String>,
    opening: bool,
}

struct Shared {
    deps: UpdateRunnerDeps,
    inner: Mutex<Inner>,
}

impl Shared {
    fn set(&self, next: UpdateRunState) {
        self.inner.lock().state = next.clone();
        (self.deps.on_change)(&next);
    }
}

struct OpeningGuard(Arc<Shared>);

impl Drop for OpeningGuard {
    fn drop(&mut self) {
        self.0.inner.lock().opening = false;
    }
}

#[derive(Clone)]
pub struct UpdateRunner {
    shared: Arc<Shared>,
}

impl UpdateRunner {
    pub fn new(deps: UpdateRunnerDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                deps,
                inner: Mutex::new(Inner {
                    state: UpdateRunState::Idle,
                    pane_id: None,
                    opening: false,
                }),
            }),
        }
    }

    pub fn state(&self) -> UpdateRunState {
        self.shared.inner.lock().state.clone()
    }

    pub fn start(&self) -> impl Future<Output = UpdateRunStart> + Send + use<> {
        let begun = self.begin();
        let shared = Arc::clone(&self.shared);
        async move {
            let (open, _guard) = match begun {
                Ok(begun) => begun,
                Err(refused) => return refused,
            };
            let Some(pane) = non_empty(open.await.as_deref()).map(str::to_owned) else {
                return UpdateRunStart::NotOpened;
            };
            shared.inner.lock().pane_id = Some(pane);
            shared.set(UpdateRunState::Running);
            UpdateRunStart::Opened
        }
    }

    fn begin(&self) -> Result<(OpenFuture, OpeningGuard), UpdateRunStart> {
        let shared = &self.shared;
        let Some(command) = update_command_line((shared.deps.method)()) else {
            return Err(UpdateRunStart::NoAction);
        };
        {
            let mut inner = shared.inner.lock();
            if inner.opening || inner.state == UpdateRunState::Running {
                return Err(UpdateRunStart::Busy);
            }
            inner.opening = true;
        }
        let guard = OpeningGuard(Arc::clone(shared));
        let request = UpdateTerminalRequest {
            host_token: (shared.deps.host_token)(&command),
            title: (shared.deps.title)(),
            command,
        };
        Ok(((shared.deps.open_terminal)(request), guard))
    }

    pub fn pane_state(&self, pane_id: &str, running: bool, exit_code: Option<i32>) {
        let next = {
            let mut inner = self.shared.inner.lock();
            if inner.pane_id.as_deref() != Some(pane_id) || inner.state != UpdateRunState::Running {
                return;
            }
            let Some(code) = exit_code.filter(|_| !running) else {
                return;
            };
            inner.pane_id = None;
            let next = if code == 0 {
                UpdateRunState::Done
            } else {
                UpdateRunState::Failed {
                    exit_code: Some(code),
                }
            };
            inner.state = next.clone();
            next
        };
        (self.shared.deps.on_change)(&next);
    }

    pub fn pane_closed(&self, pane_id: &str) {
        let next = {
            let mut inner = self.shared.inner.lock();
            if inner.pane_id.as_deref() != Some(pane_id) || inner.state != UpdateRunState::Running {
                return;
            }
            inner.pane_id = None;
            let next = UpdateRunState::Failed { exit_code: None };
            inner.state = next.clone();
            next
        };
        (self.shared.deps.on_change)(&next);
    }
}
