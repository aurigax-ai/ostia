#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use ostia_privacy::ssh_agent::start_ssh_agent;
use tempfile::TempDir;

fn make_key(dir: &Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", ""])
        .arg("-f")
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success());
    path
}

fn listed(socket: &Path) -> String {
    let out = Command::new("ssh-add")
        .arg("-l")
        .env("SSH_AUTH_SOCK", socket)
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap()
}

fn refuses_connections(socket: &Path) -> bool {
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if UnixStream::connect(socket).is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[tokio::test]
async fn starts_an_agent_on_the_socket_and_loads_every_key() {
    let root = TempDir::new().unwrap();
    let first = make_key(root.path(), "first");
    let second = make_key(root.path(), "second");
    let socket = root.path().join("agent.sock");
    let agent = start_ssh_agent(&socket, &[first, second]).await.unwrap();
    assert_eq!(agent.socket, socket);
    let out = listed(&socket);
    agent.stop();
    assert_eq!(out.lines().count(), 2, "{out}");
}

#[tokio::test]
async fn starts_an_agent_with_no_keys() {
    let root = TempDir::new().unwrap();
    let socket = root.path().join("agent.sock");
    let agent = start_ssh_agent(&socket, &[]).await.unwrap();
    assert!(socket.exists());
    agent.stop();
}

#[tokio::test]
async fn stops_the_agent_process_so_the_socket_refuses_connections() {
    let root = TempDir::new().unwrap();
    let socket = root.path().join("agent.sock");
    let agent = start_ssh_agent(&socket, &[]).await.unwrap();
    agent.stop();
    assert!(refuses_connections(&socket));
}

#[tokio::test]
async fn stops_the_agent_and_fails_when_a_key_cannot_be_added() {
    let root = TempDir::new().unwrap();
    let socket = root.path().join("agent.sock");
    let missing = root.path().join("no-such-key");
    let result = start_ssh_agent(&socket, &[missing]).await;
    assert!(result.is_err());
    assert!(refuses_connections(&socket));
}

#[tokio::test]
async fn fails_with_ssh_agent_did_not_start_when_the_socket_never_appears() {
    let root = TempDir::new().unwrap();
    let socket = root.path().join("missing-folder").join("agent.sock");
    let started = Instant::now();
    let error = match start_ssh_agent(&socket, &[]).await {
        Ok(_) => panic!("agent started"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("ssh-agent did not start"),
        "{error}"
    );
    assert!(started.elapsed() < Duration::from_secs(4));
}

fn agent_pid(socket: &Path) -> Option<u32> {
    let needle = socket.to_string_lossy().into_owned();
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .find(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline"))
                .map(|raw| {
                    String::from_utf8_lossy(&raw)
                        .replace('\0', " ")
                        .contains(&needle)
                })
                .unwrap_or(false)
        })
}

async fn gone(pid: u32) -> bool {
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

#[tokio::test]
async fn kills_the_agent_when_the_start_future_is_dropped() {
    let root = TempDir::new().unwrap();
    let socket = root.path().join("agent.sock");
    let started =
        tokio::time::timeout(Duration::from_millis(1), start_ssh_agent(&socket, &[])).await;
    assert!(started.is_err());
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(refuses_connections(&socket));
    assert_eq!(agent_pid(&socket), None);
}

#[tokio::test]
async fn reaps_the_agent_process_on_stop() {
    let root = TempDir::new().unwrap();
    let socket = root.path().join("agent.sock");
    let agent = start_ssh_agent(&socket, &[]).await.unwrap();
    let pid = agent_pid(&socket).unwrap();
    agent.stop();
    assert!(gone(pid).await);
}

#[tokio::test]
async fn replaces_a_stale_socket_path_and_loads_the_keys_into_the_new_agent() {
    let root = TempDir::new().unwrap();
    let key = make_key(root.path(), "key");
    let socket = root.path().join("agent.sock");
    std::fs::write(&socket, "stale").unwrap();
    let agent = start_ssh_agent(&socket, &[key]).await.unwrap();
    let out = listed(&socket);
    agent.stop();
    assert_eq!(out.lines().count(), 1, "{out}");
}
