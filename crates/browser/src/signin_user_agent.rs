use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ostia_base::js::{js_number, js_number_text};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::watch;
use url::Url;

use crate::browser_user_agent::browser_user_agent;

pub const ELECTRON_AGENT_HOSTS: [&str; 2] = ["accounts.google.com", "accounts.youtube.com"];

const GREASE_CHARS: [&str; 11] = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS: [&str; 3] = ["8", "99", "24"];
const MAX_RESTARTS: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserAgentBrand {
    pub brand: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAgentMetadata {
    pub brands: Vec<UserAgentBrand>,
    pub full_version_list: Vec<UserAgentBrand>,
    pub full_version: String,
    pub platform: String,
    pub platform_version: String,
    pub architecture: String,
    pub model: String,
    pub mobile: bool,
    pub bitness: String,
    pub wow64: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceAgent {
    pub user_agent: String,
    pub metadata: UserAgentMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserAgents {
    pub electron: String,
    pub rewritten: String,
    pub metadata: UserAgentMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentHost {
    pub chrome_version: String,
    pub platform: String,
    pub system_version: String,
    pub arch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeforeSendDetails {
    pub url: String,
    pub web_contents_id: Option<u32>,
    pub request_headers: Vec<(String, String)>,
}

pub type BeforeSendHeaders = Arc<dyn Fn(&BeforeSendDetails) -> Vec<(String, String)> + Send + Sync>;

pub trait AgentSession: Send + Sync {
    fn id(&self) -> u32;
    fn user_agent(&self) -> String;
    fn set_user_agent(&self, user_agent: &str);
    fn on_before_send_headers(&self, listener: BeforeSendHeaders);
}

pub type CommandFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

pub trait AgentGuest: Send + Sync {
    fn id(&self) -> u32;
    fn debugger_attached(&self) -> bool;
    fn send_command(&self, method: &str, params: Value) -> CommandFuture;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationDetails {
    pub url: String,
    pub is_main_frame: bool,
    pub is_same_document: bool,
}

fn parse_int_or_zero(part: &str) -> String {
    let trimmed = part.trim_start();
    let (negative, rest) = match trimmed.strip_prefix('-') {
        Some(after) => (true, after),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = rest
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(rest.len());
    let value: f64 = rest[..end].parse().unwrap_or(0.0);
    if value == 0.0 {
        return "0".to_owned();
    }
    js_number_text(if negative { -value } else { value })
}

fn platform_version(system_version: &str) -> String {
    let mut parts: Vec<String> = system_version
        .split('.')
        .take(3)
        .map(parse_int_or_zero)
        .collect();
    while parts.len() < 3 {
        parts.push("0".to_owned());
    }
    parts.join(".")
}

fn grease_index(seed: f64, offset: f64, modulus: f64) -> Option<usize> {
    let index = (seed + offset) % modulus;
    (index >= 0.0 && index.fract() == 0.0).then_some(index as usize)
}

pub fn electron_agent_metadata(host: &AgentHost) -> UserAgentMetadata {
    let major = host.chrome_version.split('.').next().unwrap_or("");
    let seed = js_number(major);
    let first = grease_index(seed, 0.0, 11.0).and_then(|index| GREASE_CHARS.get(index));
    let second = grease_index(seed, 1.0, 11.0).and_then(|index| GREASE_CHARS.get(index));
    let version = grease_index(seed, 0.0, 3.0).and_then(|index| GREASE_VERSIONS.get(index));
    let grease = UserAgentBrand {
        brand: format!(
            "Not{}A{}Brand",
            first.unwrap_or(&"undefined"),
            second.unwrap_or(&"undefined")
        ),
        version: (*version.unwrap_or(&"undefined")).to_owned(),
    };
    let platform = match host.platform.as_str() {
        "darwin" => "macOS",
        "win32" => "Windows",
        _ => "Linux",
    };
    let full_grease = UserAgentBrand {
        brand: grease.brand.clone(),
        version: format!("{}.0.0.0", grease.version),
    };
    UserAgentMetadata {
        brands: vec![
            grease,
            UserAgentBrand {
                brand: "Chromium".to_owned(),
                version: major.to_owned(),
            },
        ],
        full_version_list: vec![
            full_grease,
            UserAgentBrand {
                brand: "Chromium".to_owned(),
                version: host.chrome_version.clone(),
            },
        ],
        full_version: host.chrome_version.clone(),
        platform: platform.to_owned(),
        platform_version: platform_version(&host.system_version),
        architecture: if matches!(host.arch.as_str(), "arm64" | "arm") {
            "arm"
        } else {
            "x86"
        }
        .to_owned(),
        model: String::new(),
        mobile: false,
        bitness: if matches!(host.arch.as_str(), "ia32" | "arm") {
            "32"
        } else {
            "64"
        }
        .to_owned(),
        wow64: false,
    }
}

pub fn browser_agents(default_agent: &str, app_name: &str, host: &AgentHost) -> BrowserAgents {
    BrowserAgents {
        electron: default_agent.to_owned(),
        rewritten: browser_user_agent(default_agent, app_name),
        metadata: electron_agent_metadata(host),
    }
}

pub fn wants_electron_agent(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .is_some_and(|host| ELECTRON_AGENT_HOSTS.contains(&host.as_str()))
}

fn agent_for<'a>(url: &str, agents: &'a BrowserAgents) -> &'a str {
    if wants_electron_agent(url) {
        &agents.electron
    } else {
        &agents.rewritten
    }
}

#[derive(Clone)]
pub struct RestartWait(watch::Receiver<bool>);

impl RestartWait {
    pub async fn wait(mut self) {
        let _ = self.0.wait_for(|done| *done).await;
    }
}

struct AgentChange {
    id: u64,
    done: watch::Receiver<bool>,
    redirected_to: Option<String>,
}

#[derive(Clone)]
enum CurrentAgent {
    Page(String),
    Device(Arc<DeviceAgent>),
}

impl CurrentAgent {
    fn same_as(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Page(left), Self::Page(right)) => left == right,
            (Self::Device(left), Self::Device(right)) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }
}

struct Followed {
    guest: Arc<dyn AgentGuest>,
    agents: BrowserAgents,
    position: Mutex<Position>,
}

struct Position {
    url: Option<String>,
    current: Option<CurrentAgent>,
}

#[derive(Default)]
struct State {
    device_agents: HashMap<u32, Arc<DeviceAgent>>,
    followers: HashMap<u32, Arc<Followed>>,
    applying: HashMap<u32, AgentChange>,
    restarts: HashMap<u32, u32>,
    next_change: u64,
}

impl State {
    fn pending_restart(&self, guest_id: u32, url: &str, method: &str) -> bool {
        self.applying
            .get(&guest_id)
            .is_some_and(|change| change.redirected_to.as_deref() == Some(url))
            && method == "GET"
            && self.restarts.get(&guest_id).copied().unwrap_or(0) < MAX_RESTARTS
    }
}

#[derive(Clone, Default)]
pub struct SigninAgents {
    sessions: Arc<Mutex<HashMap<u32, BrowserAgents>>>,
    state: Arc<Mutex<State>>,
}

impl SigninAgents {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending_restart(&self, guest_id: u32, url: &str, method: &str) -> bool {
        self.state.lock().pending_restart(guest_id, url, method)
    }

    pub fn restart_after_agent(
        &self,
        guest_id: u32,
        url: &str,
        method: &str,
    ) -> Option<RestartWait> {
        let mut state = self.state.lock();
        if !state.pending_restart(guest_id, url, method) {
            return None;
        }
        let change = state.applying.get_mut(&guest_id)?;
        change.redirected_to = None;
        let done = change.done.clone();
        *state.restarts.entry(guest_id).or_insert(0) += 1;
        Some(RestartWait(done))
    }

    pub fn set_device_agent(&self, guest_id: u32, agent: Option<DeviceAgent>) {
        let follower = {
            let mut state = self.state.lock();
            match agent {
                Some(agent) => {
                    state.device_agents.insert(guest_id, Arc::new(agent));
                }
                None => {
                    state.device_agents.remove(&guest_id);
                }
            }
            state.followers.get(&guest_id).cloned()
        };
        if let Some(follower) = follower {
            self.apply(&follower);
        }
    }

    pub fn use_browser_agents(
        &self,
        session: Arc<dyn AgentSession>,
        app_name: &str,
        host: &AgentHost,
    ) -> BrowserAgents {
        let mut sessions = self.sessions.lock();
        if let Some(known) = sessions.get(&session.id()) {
            return known.clone();
        }
        let agents = browser_agents(&session.user_agent(), app_name, host);
        sessions.insert(session.id(), agents.clone());
        session.set_user_agent(&agents.rewritten);
        let service = self.clone();
        let for_requests = agents.clone();
        session.on_before_send_headers(Arc::new(move |details| {
            let mut headers: Vec<(String, String)> = details
                .request_headers
                .iter()
                .filter(|(name, _)| !name.eq_ignore_ascii_case("user-agent"))
                .cloned()
                .collect();
            let device = details
                .web_contents_id
                .and_then(|id| service.state.lock().device_agents.get(&id).cloned());
            let user_agent = match device {
                Some(device) => device.user_agent.clone(),
                None => agent_for(&details.url, &for_requests).to_owned(),
            };
            headers.push(("User-Agent".to_owned(), user_agent));
            headers
        }));
        agents
    }

    pub fn follow_agent_by_host(
        &self,
        guest: Arc<dyn AgentGuest>,
        agents: &BrowserAgents,
        start_url: Option<&str>,
    ) {
        let guest_id = guest.id();
        let follower = {
            let mut state = self.state.lock();
            if state.followers.contains_key(&guest_id) || !guest.debugger_attached() {
                return;
            }
            let follower = Arc::new(Followed {
                guest,
                agents: agents.clone(),
                position: Mutex::new(Position {
                    url: start_url.map(str::to_owned),
                    current: None,
                }),
            });
            state.followers.insert(guest_id, follower.clone());
            follower
        };
        self.apply(&follower);
    }

    pub fn did_start_navigation(&self, guest_id: u32, details: &NavigationDetails) {
        if details.is_main_frame && !details.is_same_document {
            self.follow(guest_id, &details.url);
        }
    }

    pub fn did_redirect_navigation(&self, guest_id: u32, details: &NavigationDetails) {
        if !details.is_main_frame || !self.follow(guest_id, &details.url) {
            return;
        }
        if let Some(change) = self.state.lock().applying.get_mut(&guest_id) {
            change.redirected_to = Some(details.url.clone());
        }
    }

    pub fn did_finish_load(&self, guest_id: u32) {
        self.state.lock().restarts.remove(&guest_id);
    }

    pub fn guest_destroyed(&self, guest_id: u32) {
        let mut state = self.state.lock();
        state.restarts.remove(&guest_id);
        state.followers.remove(&guest_id);
        state.device_agents.remove(&guest_id);
        state.applying.remove(&guest_id);
    }

    fn follow(&self, guest_id: u32, url: &str) -> bool {
        let follower = self.state.lock().followers.get(&guest_id).cloned();
        let Some(follower) = follower else {
            return false;
        };
        follower.position.lock().url = Some(url.to_owned());
        self.apply(&follower)
    }

    fn apply(&self, follower: &Followed) -> bool {
        let guest_id = follower.guest.id();
        let mut position = follower.position.lock();
        let device = self.state.lock().device_agents.get(&guest_id).cloned();
        let next = match device {
            Some(device) => CurrentAgent::Device(device),
            None => CurrentAgent::Page(match &position.url {
                Some(url) => agent_for(url, &follower.agents).to_owned(),
                None => follower.agents.rewritten.clone(),
            }),
        };
        if position
            .current
            .as_ref()
            .is_some_and(|current| current.same_as(&next))
        {
            return false;
        }
        let (user_agent, metadata) = match &next {
            CurrentAgent::Page(agent) => (agent.clone(), &follower.agents.metadata),
            CurrentAgent::Device(device) => (device.user_agent.clone(), &device.metadata),
        };
        let params = json!({
            "userAgent": user_agent,
            "userAgentMetadata": serde_json::to_value(metadata).unwrap_or(Value::Null),
        });
        self.override_agent(guest_id, follower.guest.as_ref(), params);
        position.current = Some(next);
        true
    }

    fn override_agent(&self, guest_id: u32, guest: &dyn AgentGuest, params: Value) {
        let command = guest.send_command("Emulation.setUserAgentOverride", params);
        let (finished, done) = watch::channel(false);
        let change = {
            let mut state = self.state.lock();
            state.next_change += 1;
            let id = state.next_change;
            state.applying.insert(
                guest_id,
                AgentChange {
                    id,
                    done,
                    redirected_to: None,
                },
            );
            id
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _ = command.await;
            {
                let mut state = service.state.lock();
                if state.applying.get(&guest_id).map(|current| current.id) == Some(change) {
                    state.applying.remove(&guest_id);
                }
            }
            let _ = finished.send(true);
        });
    }
}
