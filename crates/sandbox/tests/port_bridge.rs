#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::{asked_ports, host_pair, open_bridge, supervise, unix_conn, wait_for, wait_until};
use ostia_base::Platform;
use ostia_sandbox::port_bridge::{
    PortBridge, bridges_ports, control_socket_name, data_socket_name, port_bridge_command,
};
use tempfile::TempDir;
use tokio::net::UnixListener;
use tokio::process::Command;

fn temp() -> TempDir {
    tempfile::Builder::new()
        .prefix("ostia-bridge-")
        .tempdir()
        .unwrap()
}

#[test]
fn reads_port_numbers_from_the_control_socket_and_joins_each_to_127_0_0_1_on_that_port_only() {
    assert_eq!(
        port_bridge_command(Path::new("/tmp/ws"), "ab12"),
        [
            "( trap '' INT QUIT TSTP; cd /tmp/ws || exit; exec </dev/null >/dev/null 2>&1;",
            "shell=$$; while kill -0 \"$shell\" 2>/dev/null; do",
            "socat -u UNIX-CONNECT:ports-ab12.sock - | while read -r port; do",
            "case \"$port\" in ''|*[!0-9]*) continue;; esac;",
            "socat UNIX-CONNECT:ports-ab12-\"$port\".sock TCP:127.0.0.1:\"$port\" & done;",
            "sleep 1; done ) &",
        ]
        .join(" ")
    );
}

#[test]
fn quotes_a_folder_that_holds_spaces() {
    assert!(
        port_bridge_command(Path::new("/tmp/my ws"), "ab12").contains("cd '/tmp/my ws' || exit;")
    );
}

#[test]
fn names_the_control_and_data_sockets_by_bridge_id_and_port() {
    assert_eq!(control_socket_name("ab12"), "ports-ab12.sock");
    assert_eq!(data_socket_name("ab12", 4321), "ports-ab12-4321.sock");
    assert_eq!(
        data_socket_name("ab12", "\"$port\""),
        "ports-ab12-\"$port\".sock"
    );
}

#[test]
fn on_a_platform_with_unix_sockets_answers_the_expected_value() {
    let rows = [
        (Platform::Linux, true, true),
        (Platform::Linux, false, false),
        (Platform::Darwin, true, false),
        (Platform::Darwin, false, false),
    ];
    for (platform, unix_sockets, expected) in rows {
        assert_eq!(
            bridges_ports(platform, unix_sockets),
            expected,
            "{platform:?} with unix sockets {unix_sockets}"
        );
    }
}

async fn dialed_by(lines: &[&str]) -> Vec<String> {
    let dir = temp();
    let work = dir.path().join("work");
    let log = dir.path().join("dialed.log");
    fs::create_dir(&work).unwrap();
    fs::write(&log, "").unwrap();
    let quoted: Vec<String> = lines.iter().map(|line| format!("'{line}'")).collect();
    let fake = format!(
        "socat() {{ if [ \"$1\" = -u ]; then printf '%s\\n' {}; else printf '%s\\n' \"$2\" >>'{}'; fi; }};",
        quoted.join(" "),
        log.display()
    );
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "{fake} {} sleep 0.5",
            port_bridge_command(&work, "ab12")
        ))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.wait().await.unwrap();
    tokio::time::sleep(Duration::from_millis(1300)).await;
    fs::read_to_string(&log)
        .unwrap()
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn dials_only_the_lines_that_are_all_digits() {
    assert_eq!(
        dialed_by(&["abc", "", "80;id", "$(id)", "8080", "-1"]).await,
        vec!["TCP:127.0.0.1:8080".to_owned()]
    );
}

#[tokio::test]
async fn dials_every_port_it_is_asked_for() {
    let mut dialed = dialed_by(&["3000", "8080"]).await;
    dialed.sort();
    assert_eq!(
        dialed,
        vec![
            "TCP:127.0.0.1:3000".to_owned(),
            "TCP:127.0.0.1:8080".to_owned()
        ]
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ksh_c59_keeps_retrying_once_a_second_while_its_shell_lives_and_joins_a_bridge_that_comes_back()
 {
    use std::os::unix::fs::DirBuilderExt;

    let dir = temp();
    let work = dir.path().join("away");
    fs::DirBuilder::new().mode(0o700).create(&work).unwrap();
    let mut shell = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "{} sleep 30",
            port_bridge_command(&work, "cafe0001")
        ))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(shell.try_wait().unwrap().is_none());
    let bridge = PortBridge::open(&work, None, Some("cafe0001"))
        .await
        .unwrap()
        .expect("bridge did not open");
    wait_for(|| bridge.connected()).await;
    bridge.close();
    shell.kill().await.unwrap();
}

#[tokio::test]
async fn is_connected_only_while_a_supervisor_holds_its_control_socket() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    assert!(!bridge.connected());
    let control = supervise(dir.path(), &bridge).await;
    control.destroy();
    wait_for(|| !bridge.connected()).await;
    bridge.close();
}

#[tokio::test]
async fn asks_the_supervisor_for_the_port_and_joins_the_client_to_the_connection_it_brings() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let supervisor = supervise(dir.path(), &bridge).await;
    let (client, browser) = host_pair().await;
    bridge.dial(4321, client).await;
    wait_for(|| !asked_ports(&supervisor).is_empty()).await;
    assert_eq!(asked_ports(&supervisor), vec![4321]);
    let mut inside = unix_conn(&dir.path().join(data_socket_name(bridge.id(), 4321))).await;
    let mut browser = browser;
    inside.write("from-inside").await;
    browser.write("from-host").await;
    wait_for(|| browser.text() == "from-inside").await;
    wait_for(|| inside.text() == "from-host").await;
    inside.destroy();
    wait_for(|| browser.ended()).await;
    bridge.close();
}

#[tokio::test]
async fn joins_clients_to_connections_in_the_order_they_asked_per_port() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let supervisor = supervise(dir.path(), &bridge).await;
    let (first_client, first) = host_pair().await;
    let (second_client, second) = host_pair().await;
    let (other_client, other) = host_pair().await;
    bridge.dial(4000, first_client).await;
    bridge.dial(5000, other_client).await;
    bridge.dial(4000, second_client).await;
    wait_for(|| asked_ports(&supervisor).len() == 3).await;
    assert_eq!(asked_ports(&supervisor), vec![4000, 5000, 4000]);
    let id = bridge.id().to_owned();
    let socket = |port: u16| dir.path().join(data_socket_name(&id, port));
    let mut held = Vec::new();
    let mut a = unix_conn(&socket(4000)).await;
    a.write("a").await;
    held.push(a);
    wait_for(|| first.text() == "a").await;
    let mut c = unix_conn(&socket(5000)).await;
    c.write("c").await;
    held.push(c);
    let mut b = unix_conn(&socket(4000)).await;
    b.write("b").await;
    held.push(b);
    wait_for(|| second.text() == "b" && other.text() == "c").await;
    bridge.close();
}

#[tokio::test]
async fn closes_a_connection_to_a_data_socket_that_no_client_is_waiting_on() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let _supervisor = supervise(dir.path(), &bridge).await;
    let (client, browser) = host_pair().await;
    bridge.dial(4321, client).await;
    let path = dir.path().join(data_socket_name(bridge.id(), 4321));
    let mut wanted = unix_conn(&path).await;
    wanted.write("x").await;
    let unasked = unix_conn(&path).await;
    wait_for(|| unasked.ended()).await;
    assert_eq!(unasked.text(), "");
    assert!(!browser.ended());
    bridge.close();
}

#[tokio::test]
async fn closes_the_client_when_no_supervisor_is_connected_and_asks_nothing() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let (client, browser) = host_pair().await;
    bridge.dial(4321, client).await;
    wait_for(|| browser.ended()).await;
    bridge.close();
}

#[tokio::test]
async fn closes_the_client_when_the_supervisor_brings_no_connection_in_time() {
    let dir = temp();
    let bridge = PortBridge::open(dir.path(), Some(Duration::from_millis(50)), None)
        .await
        .unwrap()
        .expect("the bridge did not open");
    let supervisor = supervise(dir.path(), &bridge).await;
    let (client, browser) = host_pair().await;
    bridge.dial(4321, client).await;
    wait_for(|| browser.ended()).await;
    assert_eq!(asked_ports(&supervisor), vec![4321]);
    let late = unix_conn(&dir.path().join(data_socket_name(bridge.id(), 4321))).await;
    wait_for(|| late.ended()).await;
    bridge.close();
}

#[tokio::test]
async fn keeps_the_first_supervisor_and_closes_a_second_control_connection() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let supervisor = supervise(dir.path(), &bridge).await;
    let second = unix_conn(&dir.path().join(control_socket_name(bridge.id()))).await;
    wait_for(|| second.ended()).await;
    let (client, _browser) = host_pair().await;
    bridge.dial(4321, client).await;
    wait_for(|| !asked_ports(&supervisor).is_empty()).await;
    assert_eq!(second.text(), "");
    bridge.close();
}

#[tokio::test]
async fn never_follows_a_link_left_where_its_data_socket_goes() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let _supervisor = supervise(dir.path(), &bridge).await;
    let decoy_path = dir.path().join("decoy.sock");
    let decoy = UnixListener::bind(&decoy_path).unwrap();
    let reached = Arc::new(AtomicBool::new(false));
    let watcher = tokio::spawn({
        let reached = reached.clone();
        async move {
            if decoy.accept().await.is_ok() {
                reached.store(true, Ordering::SeqCst);
            }
        }
    });
    let path = dir.path().join(data_socket_name(bridge.id(), 4321));
    std::os::unix::fs::symlink(&decoy_path, &path).unwrap();
    let (client, _browser) = host_pair().await;
    bridge.dial(4321, client).await;
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
    assert!(!reached.load(Ordering::SeqCst));
    watcher.abort();
    bridge.close();
}

#[tokio::test]
async fn removes_its_sockets_and_drops_every_connection_when_closed() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let supervisor = supervise(dir.path(), &bridge).await;
    let (waiting_client, waiting) = host_pair().await;
    let (joined_client, joined) = host_pair().await;
    bridge.dial(4321, joined_client).await;
    let inside = unix_conn(&dir.path().join(data_socket_name(bridge.id(), 4321))).await;
    bridge.dial(4321, waiting_client).await;
    bridge.close();
    wait_for(|| waiting.ended() && joined.ended() && supervisor.ended() && inside.ended()).await;
    wait_until(|| {
        let empty = fs::read_dir(dir.path()).unwrap().next().is_none();
        std::future::ready(empty)
    })
    .await;
    assert!(!dir.path().join(control_socket_name(bridge.id())).exists());
}

#[tokio::test]
async fn refuses_a_second_dial_after_close_by_closing_the_client() {
    let dir = temp();
    let bridge = open_bridge(dir.path()).await;
    let _supervisor = supervise(dir.path(), &bridge).await;
    bridge.close();
    bridge.close();
    let (client, browser) = host_pair().await;
    bridge.dial(4321, client).await;
    wait_for(|| browser.ended()).await;
}

#[tokio::test]
async fn opens_nothing_when_another_bridge_holds_the_same_control_socket() {
    let dir = temp();
    let first = PortBridge::open(dir.path(), None, Some("cafe0002"))
        .await
        .unwrap();
    assert!(first.is_some());
    let second = PortBridge::open(dir.path(), None, Some("cafe0002"))
        .await
        .unwrap();
    assert!(second.is_none());
}

#[tokio::test]
async fn makes_the_folder_with_owner_only_access_when_it_is_missing() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp();
    let nested = dir.path().join("a").join("b");
    let bridge = PortBridge::open(&nested, None, None)
        .await
        .unwrap()
        .expect("the bridge did not open");
    let mode = fs::metadata(&nested).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    bridge.close();
}

#[tokio::test]
async fn gives_each_bridge_a_new_eight_digit_hex_id_when_none_is_asked_for() {
    let dir = temp();
    let first = open_bridge(dir.path()).await;
    let second = open_bridge(dir.path()).await;
    for bridge in [&first, &second] {
        assert_eq!(bridge.id().len(), 8);
        assert!(
            bridge
                .id()
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert!(bridge.command().contains(&control_socket_name(bridge.id())));
    }
    assert_ne!(first.id(), second.id());
    first.close();
    second.close();
}
