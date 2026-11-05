use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use ostia_base::WorkspaceId;
use ostia_base::js::{is_js_space, js_trim};
use ostia_base::procfs::{ProcEntry, children_of, parse_proc_stat, process_tree};
use parking_lot::Mutex;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::port_bridge::PortBridge;

const LISTEN: &str = "0A";
const RUNTIME_BRIDGE_PORTS: [u16; 2] = [1080, 3128];
const RUNTIME_BRIDGE_PROCESS: &str = "socat";
const LOOPBACK_OR_ANY: [&str; 4] = [
    "0100007F",
    "00000000",
    "00000000000000000000000000000000",
    "00000000000000000000000001000000",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxListener {
    pub port: u16,
    pub process: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExposeRefusal {
    NotRunning,
    UnixSocketsOff,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExposeError {
    NotRunning,
    UnixSocketsOff,
    PortInUse,
}

impl From<ExposeRefusal> for ExposeError {
    fn from(refusal: ExposeRefusal) -> Self {
        match refusal {
            ExposeRefusal::NotRunning => Self::NotRunning,
            ExposeRefusal::UnixSocketsOff => Self::UnixSocketsOff,
        }
    }
}

pub type ExposeResult = Result<u16, ExposeError>;

#[derive(Clone)]
pub struct SandboxPane {
    pub pid: u32,
    pub bridge: Option<PortBridge>,
}

pub type ChangeHandler = Arc<dyn Fn(&WorkspaceId) + Send + Sync>;
pub type PanesOf = Arc<dyn Fn(&WorkspaceId) -> Vec<SandboxPane> + Send + Sync>;
pub type UnixSocketsOff = Arc<dyn Fn(&WorkspaceId) -> bool + Send + Sync>;
pub type ListenersOf = Arc<dyn Fn(&[u32]) -> Vec<Vec<SandboxListener>> + Send + Sync>;

#[derive(Clone)]
pub struct PortForwarderDeps {
    pub on_change: Option<ChangeHandler>,
    pub panes_of: PanesOf,
    pub unix_sockets_off: UnixSocketsOff,
    pub listeners_of: Option<ListenersOf>,
}

fn net_namespace(pid: &str) -> Option<String> {
    fs::read_link(format!("/proc/{pid}/ns/net"))
        .ok()
        .map(|target| target.to_string_lossy().into_owned())
}

fn children_map() -> HashMap<i32, Vec<i32>> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return HashMap::new();
    };
    let procs: Vec<ProcEntry> = entries
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let text = fs::read_to_string(format!("/proc/{name}/stat")).ok()?;
            parse_proc_stat(&text)
        })
        .collect();
    children_of(&procs)
}

fn namespace_pid(tree: &[i32]) -> Option<i32> {
    let own = net_namespace("self");
    tree.iter().copied().find(|pid| {
        let namespace = net_namespace(&pid.to_string());
        namespace.is_some() && namespace != own
    })
}

fn listening_inodes(pid: i32) -> Vec<(String, u16)> {
    let mut out: Vec<(String, u16)> = Vec::new();
    for file in ["tcp", "tcp6"] {
        let Ok(text) = fs::read_to_string(format!("/proc/{pid}/net/{file}")) else {
            continue;
        };
        for line in text.split('\n').skip(1) {
            let columns: Vec<&str> = js_trim(line)
                .split(is_js_space)
                .filter(|column| !column.is_empty())
                .collect();
            if columns.len() < 10 || columns[3] != LISTEN {
                continue;
            }
            let mut local = columns[1].split(':');
            let (Some(address), Some(port_hex)) = (local.next(), local.next()) else {
                continue;
            };
            if !LOOPBACK_OR_ANY.contains(&address) {
                continue;
            }
            let Ok(port) = u16::from_str_radix(port_hex, 16) else {
                continue;
            };
            match out.iter_mut().find(|(inode, _)| inode == columns[9]) {
                Some(existing) => existing.1 = port,
                None => out.push((columns[9].to_owned(), port)),
            }
        }
    }
    out
}

fn owner_in(pid: i32, target: &str) -> Option<(i32, String)> {
    for fd in fs::read_dir(format!("/proc/{pid}/fd")).ok()? {
        let fd = fd.ok()?.file_name();
        let link = fs::read_link(Path::new(&format!("/proc/{pid}/fd")).join(fd)).ok()?;
        if link.to_string_lossy() == target {
            let comm = fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
            return Some((pid, js_trim(&comm).to_owned()));
        }
    }
    None
}

fn process_of_inode(pids: &[i32], inode: &str) -> Option<(i32, String)> {
    let target = format!("socket:[{inode}]");
    pids.iter().find_map(|pid| owner_in(*pid, &target))
}

fn listeners_in(tree: &[i32]) -> Vec<SandboxListener> {
    let Some(pid) = namespace_pid(tree) else {
        return Vec::new();
    };
    let mut seen: Vec<SandboxListener> = Vec::new();
    for (inode, port) in listening_inodes(pid) {
        if seen.iter().any(|listener| listener.port == port) {
            continue;
        }
        let owner = process_of_inode(tree, &inode);
        let is_runtime_bridge = owner
            .as_ref()
            .is_some_and(|(_, name)| name == RUNTIME_BRIDGE_PROCESS);
        if RUNTIME_BRIDGE_PORTS.contains(&port) && is_runtime_bridge {
            continue;
        }
        seen.push(match owner {
            Some((owner_pid, name)) => SandboxListener {
                port,
                process: Some(name),
                pid: u32::try_from(owner_pid).ok(),
            },
            None => SandboxListener {
                port,
                process: None,
                pid: None,
            },
        });
    }
    seen
}

pub fn pane_listeners(pids: &[u32]) -> Vec<Vec<SandboxListener>> {
    let children = children_map();
    pids.iter()
        .map(|pid| match i32::try_from(*pid) {
            Ok(root) => listeners_in(&process_tree(root, &children)),
            Err(_) => Vec::new(),
        })
        .collect()
}

struct Exposure {
    cancel: CancellationToken,
    accepting: JoinHandle<()>,
}

impl Exposure {
    async fn close(self) {
        let _ = self.accepting.await;
    }
}

#[derive(Clone)]
pub struct PortForwarder {
    deps: PortForwarderDeps,
    listeners_of: ListenersOf,
    exposures: Arc<Mutex<HashMap<WorkspaceId, HashMap<u16, Exposure>>>>,
}

impl PortForwarder {
    pub fn new(deps: PortForwarderDeps) -> Self {
        let listeners_of = deps
            .listeners_of
            .clone()
            .unwrap_or_else(|| Arc::new(pane_listeners));
        Self {
            deps,
            listeners_of,
            exposures: Arc::default(),
        }
    }

    pub fn listeners(&self, workspace_id: &WorkspaceId) -> Vec<SandboxListener> {
        let pids: Vec<u32> = (self.deps.panes_of)(workspace_id)
            .iter()
            .map(|pane| pane.pid)
            .collect();
        let mut seen: Vec<SandboxListener> = Vec::new();
        for listener in (self.listeners_of)(&pids).into_iter().flatten() {
            if !seen.iter().any(|known| known.port == listener.port) {
                seen.push(listener);
            }
        }
        seen.sort_by_key(|listener| listener.port);
        seen
    }

    pub fn exposed(&self, workspace_id: &WorkspaceId) -> Vec<u16> {
        let mut ports: Vec<u16> = self
            .exposures
            .lock()
            .get(workspace_id)
            .map(|by_port| by_port.keys().copied().collect())
            .unwrap_or_default();
        ports.sort_unstable();
        ports
    }

    pub fn refusal(&self, workspace_id: &WorkspaceId) -> Option<ExposeRefusal> {
        let panes = (self.deps.panes_of)(workspace_id);
        if panes
            .iter()
            .any(|pane| pane.bridge.as_ref().is_some_and(PortBridge::connected))
        {
            return None;
        }
        if !panes.is_empty() && (self.deps.unix_sockets_off)(workspace_id) {
            Some(ExposeRefusal::UnixSocketsOff)
        } else {
            Some(ExposeRefusal::NotRunning)
        }
    }

    pub async fn expose(&self, workspace_id: &WorkspaceId, port: u16) -> ExposeResult {
        if self
            .exposures
            .lock()
            .get(workspace_id)
            .is_some_and(|by_port| by_port.contains_key(&port))
        {
            return Ok(port);
        }
        if let Some(refusal) = self.refusal(workspace_id) {
            return Err(refusal.into());
        }
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|_| ExposeError::PortInUse)?;
        let cancel = CancellationToken::new();
        let accepting = tokio::spawn(accept_loop(
            self.clone(),
            workspace_id.clone(),
            port,
            listener,
            cancel.clone(),
        ));
        self.exposures
            .lock()
            .entry(workspace_id.clone())
            .or_default()
            .insert(port, Exposure { cancel, accepting });
        self.changed(workspace_id);
        Ok(port)
    }

    pub async fn unexpose(&self, workspace_id: &WorkspaceId, port: u16) {
        let exposure = self
            .exposures
            .lock()
            .get_mut(workspace_id)
            .and_then(|by_port| by_port.remove(&port));
        let Some(exposure) = exposure else {
            return;
        };
        self.changed(workspace_id);
        exposure.cancel.cancel();
        exposure.close().await;
    }

    pub async fn forget(&self, workspace_id: &WorkspaceId) {
        let closing = self.detach(workspace_id);
        futures_util::future::join_all(closing.into_iter().map(Exposure::close)).await;
    }

    pub fn stop_all(&self) {
        let workspaces: Vec<WorkspaceId> = self.exposures.lock().keys().cloned().collect();
        for workspace_id in workspaces {
            self.detach(&workspace_id);
        }
    }

    fn detach(&self, workspace_id: &WorkspaceId) -> Vec<Exposure> {
        let Some(by_port) = self.exposures.lock().remove(workspace_id) else {
            return Vec::new();
        };
        let mut ordered: Vec<(u16, Exposure)> = by_port.into_iter().collect();
        ordered.sort_by_key(|(port, _)| *port);
        ordered
            .into_iter()
            .map(|(_, exposure)| {
                self.changed(workspace_id);
                exposure.cancel.cancel();
                exposure
            })
            .collect()
    }

    fn changed(&self, workspace_id: &WorkspaceId) {
        if let Some(on_change) = &self.deps.on_change {
            on_change(workspace_id);
        }
    }

    fn serving_bridge(&self, workspace_id: &WorkspaceId, port: u16) -> Option<PortBridge> {
        let panes: Vec<SandboxPane> = (self.deps.panes_of)(workspace_id)
            .into_iter()
            .filter(|pane| pane.bridge.as_ref().is_some_and(PortBridge::connected))
            .collect();
        let pids: Vec<u32> = panes.iter().map(|pane| pane.pid).collect();
        let listening = (self.listeners_of)(&pids);
        panes
            .into_iter()
            .zip(listening)
            .find(|(_, listeners)| listeners.iter().any(|listener| listener.port == port))
            .and_then(|(pane, _)| pane.bridge)
    }
}

async fn accept_loop(
    forwarder: PortForwarder,
    workspace_id: WorkspaceId,
    port: u16,
    listener: TcpListener,
    cancel: CancellationToken,
) {
    loop {
        let socket = tokio::select! {
            () = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => socket,
                Err(_) => continue,
            },
        };
        tokio::spawn(bridge_connection(
            forwarder.clone(),
            workspace_id.clone(),
            port,
            socket,
            cancel.child_token(),
        ));
    }
}

async fn bridge_connection(
    forwarder: PortForwarder,
    workspace_id: WorkspaceId,
    port: u16,
    socket: TcpStream,
    cancel: CancellationToken,
) {
    let lookup = tokio::task::spawn_blocking({
        let workspace_id = workspace_id.clone();
        move || forwarder.serving_bridge(&workspace_id, port)
    });
    let bridge = tokio::select! {
        () = cancel.cancelled() => return,
        found = lookup => found.ok().flatten(),
    };
    if let Some(bridge) = bridge {
        bridge.dial_until(port, socket, &cancel).await;
    }
}
