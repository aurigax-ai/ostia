use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::{Arc, Weak};

use futures_util::future::BoxFuture;
use ostia_base::js::{js_number, js_number_text, utf16_len};
use ostia_contract::PRODUCT_DISPLAY_NAME;
use ostia_contract::agent_resume::{AgentResume, parse_agent_resume};
use ostia_contract::manager_settings::{
    MANAGER_MAX_ARG_LENGTH, MANAGER_MAX_ARGS, PI_MANAGER_AGENT, is_manager_agent_name,
};
use parking_lot::Mutex;
use serde_json::{Map, Value};

const MAX_PATH_LENGTH: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagerError(String);

impl ManagerError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ManagerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ManagerError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagerOpenRequest {
    pub agent: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagerInfo {
    pub pane_id: String,
    pub agent: String,
    pub session: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub info: ManagerInfo,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatePane {
    pub agent: String,
    pub cwd: String,
    pub session: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavedManagerResume {
    pub agent: String,
    pub resume: AgentResume,
}

#[derive(Clone)]
pub struct SpawnRequest {
    pub pane_id: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
    pub path: Option<String>,
    pub resume: Option<AgentResume>,
    pub on_exit: Arc<dyn Fn() + Send + Sync>,
}

pub struct ManagerDeps {
    pub agents: Box<dyn Fn() -> BTreeMap<String, Vec<String>> + Send + Sync>,
    pub create_pane: Box<dyn Fn(CreatePane) -> BoxFuture<'static, Option<String>> + Send + Sync>,
    pub adopt: Box<dyn Fn(&str) -> bool + Send + Sync>,
    pub spawn: Box<dyn Fn(SpawnRequest) -> bool + Send + Sync>,
    pub load_resume: Box<dyn Fn() -> Value + Send + Sync>,
    pub save_resume: Box<dyn Fn(Option<SavedManagerResume>) + Send + Sync>,
}

fn parse_saved_resume(raw: &Value) -> Option<SavedManagerResume> {
    let record = raw.as_object()?;
    let mut resume = parse_agent_resume(record.get("resume").unwrap_or(&Value::Null))?;
    resume.typed = None;
    let agent = record.get("agent")?.as_str()?;
    if !is_manager_agent_name(agent) {
        return None;
    }
    Some(SavedManagerResume {
        agent: agent.to_owned(),
        resume,
    })
}

fn bad_request(field: &str) -> ManagerError {
    ManagerError::new(format!("bad-request: {field}"))
}

pub fn parse_open_request(raw: &Value) -> Result<ManagerOpenRequest, ManagerError> {
    let empty = Map::new();
    let record = raw.as_object().unwrap_or(&empty);
    let agent = record
        .get("agent")
        .and_then(Value::as_str)
        .filter(|agent| is_manager_agent_name(agent))
        .ok_or_else(|| bad_request("agent"))?;
    let args = match record.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= MANAGER_MAX_ARGS => items.clone(),
        Some(_) => return Err(bad_request("args")),
    };
    let args = args
        .iter()
        .map(|arg| {
            arg.as_str()
                .filter(|text| utf16_len(text) <= MANAGER_MAX_ARG_LENGTH)
                .map(str::to_owned)
                .ok_or_else(|| bad_request("args"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cwd = record
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| cwd.starts_with('/'))
        .ok_or_else(|| bad_request("cwd"))?;
    let path = match record.get("path") {
        None => None,
        Some(Value::String(path)) if utf16_len(path) <= MAX_PATH_LENGTH => Some(path.clone()),
        Some(_) => return Err(bad_request("path")),
    };
    Ok(ManagerOpenRequest {
        agent: agent.to_owned(),
        args,
        cwd: cwd.to_owned(),
        cols: clamp_dim(record.get("cols"), 80),
        rows: clamp_dim(record.get("rows"), 24),
        path,
    })
}

fn value_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_number(text),
        Some(Value::Array(items)) => js_number(&array_text(items)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn array_text(items: &[Value]) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            Value::Bool(flag) => flag.to_string(),
            Value::Number(number) => number
                .as_f64()
                .map_or_else(|| "NaN".to_owned(), js_number_text),
            Value::String(text) => text.clone(),
            Value::Array(inner) => array_text(inner),
            Value::Object(_) => "[object Object]".to_owned(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn clamp_dim(value: Option<&Value>, fallback: u32) -> u32 {
    let number = value_number(value);
    if number.fract() == 0.0 && number > 0.0 && number <= 1000.0 {
        number as u32
    } else {
        fallback
    }
}

pub fn manager_window_id<'a>(
    main_window_id: Option<&'a str>,
    ready_window_ids: &HashSet<String>,
) -> Option<&'a str> {
    main_window_id.filter(|id| ready_window_ids.contains(*id))
}

type EndListener = Arc<dyn Fn(&str) + Send + Sync>;

struct Current {
    serial: u64,
    info: ManagerInfo,
}

#[derive(Default)]
struct State {
    current: Option<Current>,
    stopping: bool,
    serial: u64,
    listener_id: u64,
    listeners: Vec<(u64, EndListener)>,
}

struct Inner {
    deps: ManagerDeps,
    state: Mutex<State>,
    opening: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct ManagerService {
    inner: Arc<Inner>,
}

impl ManagerService {
    pub fn new(deps: ManagerDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State::default()),
                opening: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn live(&self) -> Option<ManagerInfo> {
        self.inner
            .state
            .lock()
            .current
            .as_ref()
            .map(|current| current.info.clone())
    }

    pub fn is_manager_pane(&self, pane_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .current
            .as_ref()
            .is_some_and(|current| current.info.pane_id == pane_id)
    }

    pub fn on_end(
        &self,
        listener: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Box<dyn FnOnce() + Send + Sync> {
        let id = {
            let mut state = self.inner.state.lock();
            state.listener_id += 1;
            let id = state.listener_id;
            state.listeners.push((id, listener));
            id
        };
        let inner = Arc::clone(&self.inner);
        Box::new(move || inner.state.lock().listeners.retain(|(held, _)| *held != id))
    }

    pub fn pane_closed(&self, pane_id: &str) {
        let listeners: Vec<EndListener> = {
            let mut state = self.inner.state.lock();
            let ends = state
                .current
                .as_ref()
                .is_some_and(|current| current.info.pane_id == pane_id && current.info.session);
            if !ends {
                return;
            }
            state.current = None;
            state
                .listeners
                .iter()
                .map(|(_, listener)| Arc::clone(listener))
                .collect()
        };
        for listener in listeners {
            listener(pane_id);
        }
    }

    pub fn remember_resume(&self, resume: AgentResume) {
        let state = self.inner.state.lock();
        if let Some(current) = state.current.as_ref() {
            (self.inner.deps.save_resume)(Some(SavedManagerResume {
                agent: current.info.agent.clone(),
                resume,
            }));
        }
    }

    pub fn shutdown(&self) {
        self.inner.state.lock().stopping = true;
    }

    pub async fn open(&self, req: ManagerOpenRequest) -> Result<Opened, ManagerError> {
        let deps = &self.inner.deps;
        let agents = (deps.agents)();
        let session = req.agent == PI_MANAGER_AGENT;
        if session && !req.args.is_empty() {
            return Err(bad_request("args"));
        }
        let preset = if session {
            Vec::new()
        } else {
            agents.get(&req.agent).cloned().ok_or_else(|| {
                let known: Vec<&str> = std::iter::once(PI_MANAGER_AGENT)
                    .chain(agents.keys().map(String::as_str))
                    .collect();
                ManagerError::new(format!(
                    "unknown-agent: {} (known: {})",
                    req.agent,
                    known.join(", ")
                ))
            })?
        };
        let _opening = self.inner.opening.lock().await;
        let existing = self
            .inner
            .state
            .lock()
            .current
            .as_ref()
            .map(|current| current.info.clone());
        if let Some(info) = existing {
            if info.agent != req.agent {
                return Err(ManagerError::new(format!(
                    "manager-busy: the manager is running {}",
                    info.agent
                )));
            }
            return Ok(Opened {
                info,
                created: false,
            });
        }
        let info = if session {
            self.start_session(&req).await?
        } else {
            let argv: Vec<String> = preset.into_iter().chain(req.args.iter().cloned()).collect();
            self.start(&req, argv).await?
        };
        Ok(Opened {
            info,
            created: true,
        })
    }

    async fn start_session(&self, req: &ManagerOpenRequest) -> Result<ManagerInfo, ManagerError> {
        let deps = &self.inner.deps;
        let pane_id = (deps.create_pane)(CreatePane {
            agent: req.agent.clone(),
            cwd: req.cwd.clone(),
            session: true,
        })
        .await
        .filter(|id| !id.is_empty())
        .ok_or_else(no_window)?;
        if !(deps.adopt)(&pane_id) {
            return Err(ManagerError::new(format!(
                "spawn-failed: could not start the {} manager",
                req.agent
            )));
        }
        let info = ManagerInfo {
            pane_id,
            agent: req.agent.clone(),
            session: true,
        };
        self.set_current(info.clone());
        Ok(info)
    }

    async fn start(
        &self,
        req: &ManagerOpenRequest,
        argv: Vec<String>,
    ) -> Result<ManagerInfo, ManagerError> {
        let deps = &self.inner.deps;
        let pane_id = (deps.create_pane)(CreatePane {
            agent: req.agent.clone(),
            cwd: req.cwd.clone(),
            session: false,
        })
        .await
        .filter(|id| !id.is_empty())
        .ok_or_else(no_window)?;
        let info = ManagerInfo {
            pane_id: pane_id.clone(),
            agent: req.agent.clone(),
            session: false,
        };
        let resume = parse_saved_resume(&(deps.load_resume)())
            .filter(|saved| saved.agent == req.agent && req.args.is_empty())
            .map(|saved| saved.resume);
        let serial = {
            let mut state = self.inner.state.lock();
            state.serial += 1;
            state.current = Some(Current {
                serial: state.serial,
                info: info.clone(),
            });
            state.serial
        };
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let first = argv.first().cloned();
        let spawned = (deps.spawn)(SpawnRequest {
            pane_id,
            argv,
            cwd: req.cwd.clone(),
            cols: req.cols,
            rows: req.rows,
            path: req.path.clone(),
            resume,
            on_exit: Arc::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.exited(serial);
                }
            }),
        });
        if !spawned {
            self.inner.clear_current(serial);
            return Err(ManagerError::new(format!(
                "spawn-failed: could not start {}",
                first.as_deref().unwrap_or("undefined")
            )));
        }
        Ok(info)
    }

    fn set_current(&self, info: ManagerInfo) {
        let mut state = self.inner.state.lock();
        state.serial += 1;
        let serial = state.serial;
        state.current = Some(Current { serial, info });
    }
}

impl Inner {
    fn clear_current(&self, serial: u64) {
        let mut state = self.state.lock();
        if state
            .current
            .as_ref()
            .is_some_and(|current| current.serial == serial)
        {
            state.current = None;
        }
    }

    fn exited(&self, serial: u64) {
        let mut state = self.state.lock();
        if state
            .current
            .as_ref()
            .is_none_or(|current| current.serial != serial)
        {
            return;
        }
        state.current = None;
        if !state.stopping {
            (self.deps.save_resume)(None);
        }
    }
}

fn no_window() -> ManagerError {
    ManagerError::new(format!(
        "no-window: {PRODUCT_DISPLAY_NAME} could not open the manager workspace"
    ))
}
