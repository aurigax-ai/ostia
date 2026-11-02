#![cfg(any(target_os = "linux", target_os = "macos"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ostia_contract::boards_ports::{PortHost, PortsSettings};
use ostia_ports::ListeningPort;
use ostia_ports::service::{PORTS_ITEMS_CHANNEL, PortsService, PortsServiceDeps};
use ostia_ports::sidebar::PaneRef;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const CHILD_ENV: &str = "OSTIA_PORTS_SERVER_CHILD";
const CHILD_TEST: &str = "listening_server_child";
const READY_MARKER: &str = "LISTENING";

#[test]
fn listening_server_child() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    println!(
        "{READY_MARKER} {} {}",
        std::process::id(),
        listener.local_addr().unwrap().port()
    );
    std::thread::sleep(Duration::from_secs(120));
}

fn pane(pane_id: &str, workspace_id: &str, pid: Option<u32>) -> PaneRef {
    PaneRef {
        pane_id: pane_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        kind: "terminal".to_owned(),
        pid: pid.map(|pid| i32::try_from(pid).unwrap()),
    }
}

async fn ready_line(child: &mut Child) -> String {
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = lines.next_line().await.unwrap().unwrap();
        if line.starts_with(READY_MARKER) {
            return line;
        }
    }
}

fn in_terminal(command: &str, cwd: &Path) -> Child {
    let mut script = Command::new("script");
    if cfg!(target_os = "macos") {
        script.args(["-q", "/dev/null", "sh", "-c", command]);
    } else {
        script.args(["-qfec", command, "/dev/null"]);
    }
    script
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

async fn signal(name: &str, target: &str) {
    Command::new("kill")
        .args([name, "--", target])
        .status()
        .await
        .unwrap();
}

async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn listening_ports_show_as_a_plug_in_the_top_bar_that_opens_the_browser_pane_and_an_ssh_login_shows_on_its_pane()
 {
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().canonicalize().unwrap();
    let bin = dir_path.join("bin");
    std::fs::create_dir(&bin).unwrap();
    symlink("/bin/sh", bin.join("ssh")).unwrap();
    std::fs::write(dir_path.join("deploy@build-box"), "sleep 60\n").unwrap();

    let exe = std::env::current_exe().unwrap();
    let process_name = exe.file_name().unwrap().to_string_lossy().into_owned();
    let argument = format!("secret-{}", uuid::Uuid::new_v4());
    let mut shell = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "\"{}\" --exact {CHILD_TEST} --nocapture {argument}; sleep 60",
            exe.display()
        ))
        .env(CHILD_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let shell_pid = shell.id().unwrap();
    let ready = ready_line(&mut shell).await;
    let mut fields = ready.split(' ').skip(1);
    let server_pid: u32 = fields.next().unwrap().parse().unwrap();
    let port: u16 = fields.next().unwrap().parse().unwrap();

    let remote = in_terminal(
        &format!("{} deploy@build-box", bin.join("ssh").display()),
        &dir_path,
    );
    let remote_pid = remote.id();

    let sent: Arc<Mutex<Vec<Value>>> = Arc::default();
    let logged: Arc<Mutex<Vec<String>>> = Arc::default();
    let service = PortsService::new(PortsServiceDeps {
        settings: Box::new(|| PortsSettings {
            interval_seconds: 1,
            port_host: PortHost::Loopback,
            ..PortsSettings::default()
        }),
        list_panes: Box::new(move || {
            Box::pin(async move {
                vec![
                    pane("p-web", "s1", Some(shell_pid)),
                    pane("p-ssh", "s2", remote_pid),
                ]
            })
        }),
        renderer_pane_id: Box::new(|pane_id| Some(pane_id.to_owned())),
        send: Box::new({
            let sent = Arc::clone(&sent);
            move |_window_id, channel, payload| {
                if channel == PORTS_ITEMS_CHANNEL {
                    sent.lock().unwrap().push(payload);
                }
            }
        }),
        scan: None,
        host_pid: None,
        env: BTreeMap::from([("PATH".to_owned(), std::env::var("PATH").unwrap())]),
        log: Some(Box::new({
            let logged = Arc::clone(&logged);
            move |line| logged.lock().unwrap().push(line.to_owned())
        })),
    });

    let last = || sent.lock().unwrap().last().cloned();
    let length_of = |key: &str| {
        last()
            .and_then(|items| items.get(key).and_then(Value::as_array).map(Vec::len))
            .unwrap_or(0)
    };

    service.watch("w1", &["s1", "s2"]);
    wait_for("the plug and the ssh chip", || {
        length_of("workspaceChips") == 1 && length_of("paneChips") == 1
    })
    .await;
    let items = last().unwrap();
    assert_eq!(
        items["workspaceChips"],
        json!([
            {
                "extId": "ports",
                "tone": "neutral",
                "workspaceId": "s1",
                "id": "ports",
                "icon": "plugs",
                "text": "1",
                "items": [
                    {"text": format!(":{port}"), "detail": process_name, "url": format!("http://127.0.0.1:{port}/")},
                ],
            },
        ]),
    );
    assert_eq!(
        items["paneChips"],
        json!([
            {"extId": "ports", "tone": "brand", "paneId": "p-ssh", "id": "ssh", "text": "deploy@build-box"},
        ]),
    );
    let sidebar_texts: Vec<&str> = items["sidebar"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["text"].as_str().unwrap())
        .collect();
    assert_eq!(sidebar_texts, vec!["build-box"]);

    let listed = service.list().await;
    let web = listed.iter().find(|w| w.workspace_id == "s1").unwrap();
    assert_eq!(
        web.ports,
        vec![ListeningPort {
            port,
            name: Some(process_name.clone()),
        }],
    );
    let seen = format!(
        "{:?}{:?}{:?}",
        sent.lock().unwrap(),
        listed,
        logged.lock().unwrap()
    );
    assert!(!seen.contains(&argument));
    assert!(!seen.contains(CHILD_TEST));

    signal("-INT", &server_pid.to_string()).await;
    wait_for("the plug to go away", || length_of("workspaceChips") == 0).await;
    assert!(shell.try_wait().unwrap().is_none());
    let chip_texts: Vec<String> = last().unwrap()["paneChips"]
        .as_array()
        .unwrap()
        .iter()
        .map(|chip| chip["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(chip_texts, vec!["deploy@build-box".to_owned()]);

    service.stop();
    signal("-KILL", &format!("-{shell_pid}")).await;
    drop(remote);
}
