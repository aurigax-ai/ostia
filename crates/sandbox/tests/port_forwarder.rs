#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use common::{
    FakePane, HeldPort, Reply, named_reply, port_free, read_to_end, supervise, tcp_conn, wait_for,
    wait_until,
};
use ostia_base::WorkspaceId;
use ostia_sandbox::port_forwarder::{
    ExposeError, ExposeRefusal, PortForwarder, PortForwarderDeps, SandboxListener, SandboxPane,
};
use parking_lot::Mutex;
use tempfile::TempDir;
use tokio::net::TcpListener;

fn temp() -> TempDir {
    tempfile::Builder::new()
        .prefix("ostia-forward-")
        .tempdir()
        .unwrap()
}

fn ws() -> WorkspaceId {
    WorkspaceId::new("ws")
}

fn listener(port: u16, process: &str) -> SandboxListener {
    SandboxListener {
        port,
        process: Some(process.to_owned()),
        pid: None,
    }
}

fn bare_pane(pid: u32) -> SandboxPane {
    SandboxPane { pid, bridge: None }
}

fn pane_of(fake: &FakePane) -> SandboxPane {
    SandboxPane {
        pid: fake.pid,
        bridge: Some(fake.bridge.clone()),
    }
}

type Changes = Arc<Mutex<Vec<WorkspaceId>>>;

fn setup_with(
    panes: Vec<SandboxPane>,
    listening: HashMap<u32, Vec<SandboxListener>>,
    unix_sockets_off: bool,
    changes: Option<Changes>,
) -> PortForwarder {
    PortForwarder::new(PortForwarderDeps {
        on_change: changes.map(|log| {
            Arc::new(move |workspace: &WorkspaceId| log.lock().push(workspace.clone()))
                as Arc<dyn Fn(&WorkspaceId) + Send + Sync>
        }),
        panes_of: Arc::new(move |workspace: &WorkspaceId| {
            if workspace.as_str() == "ws" {
                panes.clone()
            } else {
                Vec::new()
            }
        }),
        unix_sockets_off: Arc::new(move |_| unix_sockets_off),
        listeners_of: Some(Arc::new(move |pids: &[u32]| {
            pids.iter()
                .map(|pid| listening.get(pid).cloned().unwrap_or_default())
                .collect()
        })),
    })
}

fn setup(
    panes: Vec<SandboxPane>,
    listening: HashMap<u32, Vec<SandboxListener>>,
    unix_sockets_off: bool,
) -> PortForwarder {
    setup_with(panes, listening, unix_sockets_off, None)
}

fn listening_on(rows: Vec<(u32, Vec<SandboxListener>)>) -> HashMap<u32, Vec<SandboxListener>> {
    rows.into_iter().collect()
}

#[tokio::test]
async fn refuses_to_expose_a_port_while_no_sandboxed_terminal_runs_and_binds_nothing() {
    let held = HeldPort::new();
    let forwarder = setup(Vec::new(), HashMap::new(), false);
    assert_eq!(forwarder.refusal(&ws()), Some(ExposeRefusal::NotRunning));
    assert_eq!(
        forwarder.expose(&ws(), held.port).await,
        Err(ExposeError::NotRunning)
    );
    assert!(port_free(held.port));
    assert_eq!(forwarder.exposed(&ws()), Vec::<u16>::new());
}

#[tokio::test]
async fn says_unix_sockets_are_off_when_no_terminal_of_the_sandbox_has_a_bridge_and_the_switch_is_off()
 {
    let held = HeldPort::new();
    let forwarder = setup(
        vec![bare_pane(11)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        true,
    );
    assert_eq!(
        forwarder.refusal(&ws()),
        Some(ExposeRefusal::UnixSocketsOff)
    );
    assert_eq!(
        forwarder.expose(&ws(), held.port).await,
        Err(ExposeError::UnixSocketsOff)
    );
    assert!(port_free(held.port));
}

#[test]
fn waits_for_a_bridge_rather_than_blaming_the_switch_while_unix_sockets_are_on() {
    let forwarder = setup(vec![bare_pane(11)], HashMap::new(), false);
    assert_eq!(forwarder.refusal(&ws()), Some(ExposeRefusal::NotRunning));
}

#[tokio::test]
async fn exposes_through_a_terminal_that_started_with_a_bridge_even_after_the_switch_went_off() {
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        true,
    );
    assert_eq!(forwarder.refusal(&ws()), None);
    assert_eq!(forwarder.expose(&ws(), held.port).await, Ok(held.port));
    assert_eq!(read_to_end(held.port).await, format!("a:{}", held.port));
    forwarder.forget(&ws()).await;
}

#[tokio::test]
async fn sends_a_host_connection_to_the_terminal_whose_sandbox_listens_on_the_port() {
    let dir = temp();
    let held = HeldPort::new();
    let first = FakePane::start(dir.path(), 11, named_reply("first")).await;
    let second = FakePane::start(dir.path(), 22, named_reply("second")).await;
    let forwarder = setup(
        vec![pane_of(&first), pane_of(&second)],
        listening_on(vec![
            (11, vec![listener(held.port + 1, "node")]),
            (22, vec![listener(held.port, "node")]),
        ]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    assert_eq!(
        read_to_end(held.port).await,
        format!("second:{}", held.port)
    );
    assert_eq!(first.asked(), Vec::<u16>::new());
    assert_eq!(second.asked(), vec![held.port]);
    forwarder.forget(&ws()).await;
}

#[tokio::test]
async fn closes_a_host_connection_when_nothing_in_the_sandbox_listens_on_the_exposed_port() {
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port + 1, "node")])]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    assert_eq!(read_to_end(held.port).await, "");
    assert_eq!(pane.asked(), Vec::<u16>::new());
    forwarder.forget(&ws()).await;
}

#[tokio::test]
async fn never_asks_a_terminal_without_a_bridge_even_when_its_sandbox_listens_on_the_port() {
    let dir = temp();
    let held = HeldPort::new();
    let bridged = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![bare_pane(22), pane_of(&bridged)],
        listening_on(vec![(22, vec![listener(held.port, "node")])]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    assert_eq!(read_to_end(held.port).await, "");
    assert_eq!(bridged.asked(), Vec::<u16>::new());
    forwarder.forget(&ws()).await;
}

#[test]
fn lists_the_servers_of_every_terminal_once_by_port() {
    let forwarder = setup(
        vec![bare_pane(11), bare_pane(22)],
        listening_on(vec![
            (11, vec![listener(5173, "node"), listener(3000, "bun")]),
            (22, vec![listener(8000, "python"), listener(3000, "node")]),
        ]),
        false,
    );
    assert_eq!(
        forwarder.listeners(&ws()),
        vec![
            listener(3000, "bun"),
            listener(5173, "node"),
            listener(8000, "python"),
        ]
    );
}

#[tokio::test]
async fn drops_live_connections_and_frees_the_host_port_when_the_port_is_unexposed() {
    let dir = temp();
    let held = HeldPort::new();
    let fake = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let _supervisor = supervise(dir.path(), &fake.bridge).await;
    let forwarder = setup(
        vec![pane_of(&fake)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    let live = tcp_conn(held.port).await;
    forwarder.unexpose(&ws(), held.port).await;
    wait_for(|| live.ended()).await;
    wait_until(|| std::future::ready(port_free(held.port))).await;
}

fn large_reply(bytes: usize) -> Reply {
    Arc::new(move |_| vec![b'x'; bytes])
}

#[tokio::test]
async fn sbx_c45_forwards_host_127_0_0_1_port_to_the_same_port_inside_the_sandbox() {
    let dir = temp();
    let held = HeldPort::new();
    let port = held.port;
    let pane = FakePane::start(
        dir.path(),
        11,
        Arc::new(move |asked| format!("INSIDE-{asked}").into_bytes()),
    )
    .await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(port, "node")])]),
        false,
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(1), tcp_conn_refused(port))
            .await
            .unwrap()
    );
    assert_eq!(forwarder.expose(&ws(), port).await, Ok(port));
    assert_eq!(read_to_end(port).await, format!("INSIDE-{port}"));
    assert_eq!(forwarder.exposed(&ws()), vec![port]);
    forwarder.forget(&ws()).await;
}

async fn tcp_conn_refused(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err()
}

#[tokio::test]
async fn reaches_a_server_in_another_terminal_of_the_workspace_which_has_a_network_namespace_of_its_own()
 {
    let dir = temp();
    let inner = HeldPort::new();
    let other = HeldPort::new();
    let mut ports = [inner.port, other.port];
    ports.sort_unstable();
    let [inner_port, other_port] = ports;
    let reply: Reply = Arc::new(|asked| format!("INSIDE-{asked}").into_bytes());
    let first = FakePane::start(dir.path(), 11, reply.clone()).await;
    let second = FakePane::start(dir.path(), 22, reply).await;
    let forwarder = setup(
        vec![pane_of(&first), pane_of(&second)],
        listening_on(vec![
            (11, vec![listener(inner_port, "node")]),
            (22, vec![listener(other_port, "node")]),
        ]),
        false,
    );
    let ports_listened: Vec<u16> = forwarder.listeners(&ws()).iter().map(|l| l.port).collect();
    assert_eq!(ports_listened, vec![inner_port, other_port]);
    forwarder.expose(&ws(), inner_port).await.unwrap();
    assert_eq!(forwarder.expose(&ws(), other_port).await, Ok(other_port));
    assert_eq!(
        read_to_end(other_port).await,
        format!("INSIDE-{other_port}")
    );
    assert_eq!(
        read_to_end(inner_port).await,
        format!("INSIDE-{inner_port}")
    );
    forwarder.unexpose(&ws(), other_port).await;
    forwarder.forget(&ws()).await;
}

#[tokio::test]
async fn carries_large_responses_on_parallel_connections_whole() {
    const BIG_BODY_BYTES: usize = 2 * 1024 * 1024;
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, large_reply(BIG_BODY_BYTES)).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    let port = held.port;
    let sizes = futures_util::future::join_all((0..8).map(|_| async move {
        let conn = tcp_conn(port).await;
        wait_for(|| conn.ended()).await;
        conn.byte_count()
    }))
    .await;
    assert_eq!(sizes, vec![BIG_BODY_BYTES; 8]);
    forwarder.forget(&ws()).await;
}

#[tokio::test]
async fn sbx_c46_refuses_to_expose_a_port_already_in_use_on_the_host_and_forwards_nothing() {
    let dir = temp();
    let busy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let busy_port = busy.local_addr().unwrap().port();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(busy_port, "node")])]),
        false,
    );
    assert_eq!(
        forwarder.expose(&ws(), busy_port).await,
        Err(ExposeError::PortInUse)
    );
    assert!(!forwarder.exposed(&ws()).contains(&busy_port));
}

#[tokio::test]
async fn sbx_c47_releases_the_host_port_when_the_workspace_closes() {
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    assert!(!port_free(held.port));
    forwarder.forget(&ws()).await;
    assert_eq!(forwarder.exposed(&ws()), Vec::<u16>::new());
    wait_until(|| std::future::ready(port_free(held.port))).await;
}

#[tokio::test]
async fn answers_ok_for_a_port_that_is_already_exposed_and_binds_nothing_new() {
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let changes: Changes = Arc::default();
    let forwarder = setup_with(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        false,
        Some(changes.clone()),
    );
    assert_eq!(forwarder.expose(&ws(), held.port).await, Ok(held.port));
    assert_eq!(forwarder.expose(&ws(), held.port).await, Ok(held.port));
    assert_eq!(forwarder.exposed(&ws()), vec![held.port]);
    assert_eq!(changes.lock().len(), 1);
    forwarder.forget(&ws()).await;
}

#[tokio::test]
async fn tells_the_workspace_when_a_port_is_exposed_and_when_it_is_unexposed() {
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let changes: Changes = Arc::default();
    let forwarder = setup_with(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        false,
        Some(changes.clone()),
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    assert_eq!(*changes.lock(), vec![ws()]);
    forwarder.unexpose(&ws(), held.port).await;
    assert_eq!(*changes.lock(), vec![ws(), ws()]);
    forwarder.unexpose(&ws(), held.port).await;
    assert_eq!(changes.lock().len(), 2);
    assert_eq!(forwarder.exposed(&ws()), Vec::<u16>::new());
}

#[tokio::test]
async fn lists_exposed_ports_in_ascending_order_and_forgets_all_of_them_at_once() {
    let dir = temp();
    let low = HeldPort::new();
    let high = HeldPort::new();
    let mut ports = [low.port, high.port];
    ports.sort_unstable();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(
            11,
            vec![listener(ports[0], "node"), listener(ports[1], "node")],
        )]),
        false,
    );
    forwarder.expose(&ws(), ports[1]).await.unwrap();
    forwarder.expose(&ws(), ports[0]).await.unwrap();
    assert_eq!(forwarder.exposed(&ws()), ports.to_vec());
    forwarder.forget(&ws()).await;
    assert_eq!(forwarder.exposed(&ws()), Vec::<u16>::new());
    for port in ports {
        wait_until(|| std::future::ready(port_free(port))).await;
    }
}

#[tokio::test]
async fn stop_all_releases_the_ports_of_every_workspace() {
    let dir = temp();
    let held = HeldPort::new();
    let pane = FakePane::start(dir.path(), 11, named_reply("a")).await;
    let forwarder = setup(
        vec![pane_of(&pane)],
        listening_on(vec![(11, vec![listener(held.port, "node")])]),
        false,
    );
    forwarder.expose(&ws(), held.port).await.unwrap();
    forwarder.stop_all();
    wait_until(|| std::future::ready(port_free(held.port))).await;
    assert_eq!(forwarder.exposed(&ws()), Vec::<u16>::new());
}

#[test]
fn lists_nothing_for_a_workspace_with_no_terminals() {
    let forwarder = setup(Vec::new(), HashMap::new(), false);
    assert_eq!(forwarder.listeners(&WorkspaceId::new("other")), Vec::new());
    assert_eq!(
        forwarder.exposed(&WorkspaceId::new("other")),
        Vec::<u16>::new()
    );
}
