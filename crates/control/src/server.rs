use std::collections::HashMap;
use std::fs::{self, DirBuilder, Permissions};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream::FuturesUnordered;
use futures_util::{FutureExt, StreamExt};
use ostia_base::error::io_error;
use ostia_base::random::random_bytes;
use ostia_base::{ExternalId, PaneId, Result, WorkspaceId};
use ostia_contract::capabilities::Capability;
use ostia_contract::terminal_state::TerminalStateSnapshot;
use ostia_contract::{SANDBOXED_REFUSAL, TARGET_PANE_PARAM};
use ostia_rpc::{
    CONTROL_MESSAGE_MAX, FrameCodec, Incoming, RpcError, classify, error_body, is_falsy,
    normalize_params, params_given, parse_body, success_body,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::codec::FramedRead;
use tokio_util::sync::CancellationToken;

use crate::auth::{AuthedConn, ControlAuth, needs_elevation};
use crate::conn::ConnHandle;
use crate::foreign_sandbox::{Peer, escapes_sandbox, read_peer, sandboxed_by_kernel};
use crate::identity::{IdentityKind, PaneIdentity};
use crate::method::{Callers, MethodContext, MethodTable, caller_allowed};

const DETAIL_HIDDEN_PREFIXES: [&str; 2] = ["vault.", "secret."];

pub type PtyPid = Arc<dyn Fn(&PaneId) -> Option<i32> + Send + Sync>;
pub type TerminalState = Arc<dyn Fn(&PaneId) -> Option<TerminalStateSnapshot> + Send + Sync>;
pub type ReadProc = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type ScriptCovers =
    Arc<dyn Fn(PaneIdentity, AuthedConn, WorkspaceId) -> BoxFuture<'static, bool> + Send + Sync>;

pub struct ServerDeps {
    pub auth: Arc<ControlAuth>,
    pub version: Option<String>,
    pub is_sandboxed: Arc<dyn Fn(&WorkspaceId) -> bool + Send + Sync>,
    pub pty_pid: PtyPid,
    pub terminal_state: TerminalState,
    pub script_covers: ScriptCovers,
    pub read_proc: ReadProc,
}

pub struct ControlServer {
    deps: ServerDeps,
    methods: MethodTable,
}

struct Session {
    authed: Mutex<Option<AuthedConn>>,
    peer: Option<Peer>,
    conn: ConnHandle,
    cancels: Mutex<HashMap<String, CancellationToken>>,
}

fn describe_params(method: &str, params: &Value, given: bool) -> String {
    if !given {
        return String::new();
    }
    if DETAIL_HIDDEN_PREFIXES
        .iter()
        .any(|prefix| method.starts_with(prefix))
    {
        return String::new();
    }
    params.to_string()
}

#[cfg(target_os = "linux")]
fn peer_pid(stream: &UnixStream) -> Option<i32> {
    stream.peer_cred().ok()?.pid().filter(|pid| *pid > 0)
}

#[cfg(not(target_os = "linux"))]
fn peer_pid(_stream: &UnixStream) -> Option<i32> {
    None
}

async fn write_frames(
    mut write: OwnedWriteHalf,
    mut queue: mpsc::UnboundedReceiver<Vec<u8>>,
    closed: CancellationToken,
) {
    loop {
        let frame = tokio::select! {
            () = closed.cancelled() => break,
            frame = queue.recv() => frame,
        };
        let Some(frame) = frame else { break };
        if write.write_all(&frame).await.is_err() {
            closed.cancel();
            break;
        }
    }
}

fn request_key(id: &Value) -> String {
    id.to_string()
}

fn bind_private(path: &Path) -> Result<UnixListener> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let holder = parent.join(format!(".{}", hex::encode(random_bytes::<4>())));
    DirBuilder::new()
        .mode(0o700)
        .create(&holder)
        .map_err(io_error(&holder))?;
    let inner = holder.join("s");
    let bound = UnixListener::bind(&inner)
        .map_err(io_error(&inner))
        .and_then(|listener| {
            fs::set_permissions(&inner, Permissions::from_mode(0o600)).map_err(io_error(&inner))?;
            fs::rename(&inner, path).map_err(io_error(path))?;
            Ok(listener)
        });
    let _ = fs::remove_file(&inner);
    let _ = fs::remove_dir(&holder);
    bound
}

impl ControlServer {
    pub fn new(deps: ServerDeps, methods: MethodTable) -> Arc<Self> {
        Arc::new(Self { deps, methods })
    }

    fn require_identity(
        &self,
        session: &Session,
        callers: Callers,
        scripts: bool,
    ) -> std::result::Result<PaneIdentity, RpcError> {
        let authed = session
            .authed
            .lock()
            .clone()
            .ok_or_else(|| RpcError::invalid_request("call hello first"))?;
        let me = self
            .deps
            .auth
            .registry()
            .resolve_external(&authed.external_id)
            .filter(|me| {
                me.kind != IdentityKind::Script
                    || authed.script_session.as_deref() == Some(me.token.as_str())
            })
            .ok_or_else(|| RpcError::invalid_request("unknown identity"))?;
        if me.kind == IdentityKind::Script && self.deps.auth.script_expired(&me.external_id) {
            return Err(RpcError::invalid_request(
                "token-expired: this script token has expired",
            ));
        }
        if !caller_allowed(&me, callers, scripts) {
            return Err(RpcError::invalid_request(format!(
                "not-available-to-{}",
                me.kind.name()
            )));
        }
        Ok(me)
    }

    fn authed(session: &Session) -> std::result::Result<AuthedConn, RpcError> {
        session
            .authed
            .lock()
            .clone()
            .ok_or_else(|| RpcError::invalid_request("call hello first"))
    }

    fn hello(&self, session: &Session, params: &Value) -> std::result::Result<Value, RpcError> {
        let authed = self.deps.auth.authenticate(params);
        *session.authed.lock() = authed.clone();
        let authed = authed.ok_or_else(|| RpcError::invalid_request("invalid or missing token"))?;
        let mut answer = Map::new();
        answer.insert("externalId".to_owned(), json!(authed.external_id));
        if let Some(version) = &self.deps.version {
            answer.insert("version".to_owned(), json!(version));
        }
        Ok(Value::Object(answer))
    }

    fn whoami(&self, session: &Session) -> std::result::Result<Value, RpcError> {
        let me = self.require_identity(session, Callers::All, true)?;
        Ok(match me.kind {
            IdentityKind::Extension => {
                json!({"externalId": me.external_id, "extensionId": me.ext_id})
            }
            IdentityKind::Script => json!({"externalId": me.external_id, "kind": "script"}),
            IdentityKind::Pane => {
                json!({"externalId": me.external_id, "paneId": me.pane_id, "workspaceId": me.workspace_id})
            }
        })
    }

    async fn pane_info(
        &self,
        session: &Session,
        params: &Value,
    ) -> std::result::Result<Value, RpcError> {
        let me = self.require_identity(session, Callers::Panes, true)?;
        let authed = Self::authed(session)?;
        if !self.deps.auth.conn_has_cap(&authed, Capability::ReadBoard) {
            return Err(needs_elevation(Capability::ReadBoard));
        }
        let script = me.kind == IdentityKind::Script;
        let state = |pane: &PaneId| json!((self.deps.terminal_state)(pane));
        let given = params.get("paneId").filter(|given| !is_falsy(given));
        let Some(given) = given else {
            if script {
                return Err(RpcError::invalid_params("bad-request: paneId"));
            }
            return Ok(state(&me.pane_id));
        };
        let other = given.as_str().and_then(|id| {
            self.deps
                .auth
                .registry()
                .resolve_external(&ExternalId::new(id))
        });
        let Some(other) =
            other.filter(|other| other.kind == IdentityKind::Pane && !(script && other.manager))
        else {
            return Ok(Value::Null);
        };
        if script && !(self.deps.script_covers)(me, authed, other.workspace_id.clone()).await {
            return Ok(Value::Null);
        }
        Ok(state(&other.pane_id))
    }

    fn sandboxed_peer(&self, session: &Session, me: &PaneIdentity) -> bool {
        if (self.deps.is_sandboxed)(&me.workspace_id) {
            return false;
        }
        sandboxed_by_kernel(
            session.peer.as_ref(),
            (self.deps.pty_pid)(&me.pane_id),
            &*self.deps.read_proc,
        )
    }

    fn acting_pane(
        &self,
        authed: &AuthedConn,
        params: Value,
    ) -> std::result::Result<(PaneIdentity, Value), RpcError> {
        if !self
            .deps
            .auth
            .conn_has_cap(authed, Capability::AllWorkspaces)
        {
            return Err(needs_elevation(Capability::AllWorkspaces));
        }
        let mut rest = match params {
            Value::Object(record) => record,
            _ => Map::new(),
        };
        let target_id = rest.remove(TARGET_PANE_PARAM);
        let Some(target_id) = target_id.filter(|target| !is_falsy(target)) else {
            return Err(RpcError::invalid_params(format!(
                "needs-target: {TARGET_PANE_PARAM}"
            )));
        };
        let target = target_id
            .as_str()
            .and_then(|id| {
                self.deps
                    .auth
                    .registry()
                    .resolve_external(&ExternalId::new(id))
            })
            .filter(|target| target.kind == IdentityKind::Pane);
        let Some(target) = target else {
            let shown = target_id
                .as_str()
                .map_or_else(|| target_id.to_string(), str::to_owned);
            return Err(RpcError::invalid_params(format!("unknown-target: {shown}")));
        };
        Ok((target, Value::Object(rest)))
    }

    async fn call_table(
        &self,
        session: &Session,
        name: &str,
        params: Value,
        given: bool,
        cancel: CancellationToken,
    ) -> std::result::Result<Value, RpcError> {
        let Some(method) = self.methods.get(name) else {
            return Err(RpcError::method_not_found(format!(
                "Unhandled method {name}"
            )));
        };
        let caller = self.require_identity(session, method.allowed_callers(), method.scripts)?;
        let authed = Self::authed(session)?;
        if caller.kind == IdentityKind::Pane
            && escapes_sandbox(name, &params, caller.external_id.as_str())
            && self.sandboxed_peer(session, &caller)
        {
            return Err(RpcError::invalid_request(SANDBOXED_REFUSAL));
        }
        if let Some(cap) = method.cap {
            let detail = describe_params(name, &params, given);
            self.deps
                .auth
                .ensure_caps(&authed, &caller, &[cap], name, &detail)
                .await?;
        }
        let (identity, params) = if caller.kind == IdentityKind::Extension && method.targetable {
            self.acting_pane(&authed, params)?
        } else {
            (caller, params)
        };
        let context = MethodContext {
            identity,
            authed,
            conn: session.conn.clone(),
            cancel,
            auth: Arc::clone(&self.deps.auth),
        };
        (method.handler)(params, context).await
    }

    async fn call(
        &self,
        session: &Session,
        name: &str,
        params: Value,
        given: bool,
        cancel: CancellationToken,
    ) -> std::result::Result<Value, RpcError> {
        match name {
            "hello" => self.hello(session, &params),
            "whoami" => self.whoami(session),
            "pane.info" => self.pane_info(session, &params).await,
            _ => self.call_table(session, name, params, given, cancel).await,
        }
    }

    async fn answer_request(
        self: Arc<Self>,
        session: Arc<Session>,
        id: Value,
        name: String,
        params: Option<Value>,
    ) {
        let cancel = CancellationToken::new();
        let key = request_key(&id);
        session.cancels.lock().insert(key.clone(), cancel.clone());
        let given = params_given(params.as_ref());
        let params = normalize_params(params);
        let outcome = AssertUnwindSafe(self.call(&session, &name, params, given, cancel))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(RpcError::thrown("the handler panicked")));
        session.cancels.lock().remove(&key);
        session.conn.send_frame(&match outcome {
            Ok(result) => success_body(&id, result),
            Err(error) => error_body(&id, error.into_reply(&name).to_json()),
        });
    }

    fn cancel_request(session: &Session, params: Option<&Value>) {
        if let Some(id) = params.and_then(|params| params.get("id"))
            && let Some(cancel) = session.cancels.lock().get(&request_key(id))
        {
            cancel.cancel();
        }
    }

    async fn serve(self: Arc<Self>, stream: UnixStream) {
        let peer = peer_pid(&stream).and_then(|pid| read_peer(pid, &*self.deps.read_proc));
        let (read, write) = stream.into_split();
        let (outgoing, queue) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        tokio::spawn(write_frames(write, queue, closed.clone()));
        let session = Arc::new(Session {
            authed: Mutex::new(None),
            peer,
            conn: ConnHandle::new(outgoing, closed.clone()),
            cancels: Mutex::default(),
        });
        let mut frames = FramedRead::new(read, FrameCodec::new(CONTROL_MESSAGE_MAX));
        let mut inflight: FuturesUnordered<BoxFuture<'static, ()>> = FuturesUnordered::new();
        let mut reading = true;
        loop {
            tokio::select! {
                biased;
                Some(()) = inflight.next(), if !inflight.is_empty() => {}
                frame = frames.next(), if reading => {
                    let message = match frame {
                        Some(Ok(body)) => parse_body(&body).ok(),
                        Some(Err(_)) | None => None,
                    };
                    let Some(message) = message else {
                        reading = false;
                        closed.cancel();
                        session.conn.fail_waiting();
                        continue;
                    };
                    match classify(message) {
                        Incoming::Request { id, method, params } => {
                            inflight.push(Arc::clone(&self).answer_request(Arc::clone(&session), id, method, params).boxed());
                        }
                        Incoming::Notification { method, params } => {
                            if method == "$/cancelRequest" {
                                Self::cancel_request(&session, params.as_ref());
                            }
                        }
                        Incoming::Response { id, outcome } => session.conn.answer(&id, outcome),
                        Incoming::Invalid => tracing::warn!("control socket: invalid message"),
                    }
                }
                else => break,
            }
        }
    }

    pub fn listen(self: &Arc<Self>, path: &Path) -> Result<ControlListener> {
        let listener = bind_private(path)?;
        let server = Arc::clone(self);
        let accept = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        tokio::spawn(Arc::clone(&server).serve(stream));
                    }
                    Err(error) => {
                        tracing::error!(%error, "control socket accept failed");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });
        Ok(ControlListener {
            path: path.to_path_buf(),
            accept,
        })
    }
}

pub struct ControlListener {
    path: PathBuf,
    accept: JoinHandle<()>,
}

impl ControlListener {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn stop(self) {
        self.accept.abort();
        let _ = fs::remove_file(&self.path);
    }
}
