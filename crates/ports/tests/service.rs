#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ostia_contract::boards_ports::{PortHost, PortsSettings};
use ostia_ports::service::{PORTS_ITEMS_CHANNEL, PortsService, PortsServiceDeps, WorkspacePorts};
use ostia_ports::sidebar::PaneRef;
use ostia_ports::ssh::SshLogin;
use ostia_ports::{ListeningPort, TreeInfo};
use serde_json::{Value, json};

type Sent = Arc<Mutex<Vec<(String, String, Value)>>>;
type ScanCalls = Arc<Mutex<Vec<(Vec<i32>, i32)>>>;

struct Fixture {
    settings: Arc<Mutex<PortsSettings>>,
    sent: Sent,
    scan_calls: ScanCalls,
    list_calls: Arc<AtomicUsize>,
    service: PortsService,
}

fn pane(pane_id: &str, workspace_id: &str, pid: i32) -> PaneRef {
    PaneRef {
        pane_id: pane_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        kind: "terminal".to_owned(),
        pid: Some(pid),
    }
}

fn trees() -> HashMap<i32, TreeInfo> {
    HashMap::from([
        (
            10,
            TreeInfo {
                ports: vec![
                    ListeningPort {
                        port: 3000,
                        name: Some("node".to_owned()),
                    },
                    ListeningPort {
                        port: 5173,
                        name: None,
                    },
                ],
                ssh: None,
            },
        ),
        (
            20,
            TreeInfo {
                ports: vec![],
                ssh: Some(SshLogin {
                    user: Some("deploy".to_owned()),
                    host: "box".to_owned(),
                }),
            },
        ),
    ])
}

fn fixture() -> Fixture {
    fixture_with(|external| Some(external.replace("ext-", "pane-")))
}

fn fixture_with(renderer: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Fixture {
    let settings = Arc::new(Mutex::new(PortsSettings::default()));
    let sent: Sent = Arc::default();
    let scan_calls: ScanCalls = Arc::default();
    let list_calls = Arc::new(AtomicUsize::new(0));
    let service = PortsService::new(PortsServiceDeps {
        settings: Box::new({
            let settings = Arc::clone(&settings);
            move || settings.lock().unwrap().clone()
        }),
        list_panes: Box::new({
            let list_calls = Arc::clone(&list_calls);
            move || {
                list_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { vec![pane("ext-a", "one", 10), pane("ext-b", "two", 20)] })
            }
        }),
        renderer_pane_id: Box::new(renderer),
        send: Box::new({
            let sent = Arc::clone(&sent);
            move |window_id, channel, payload| {
                sent.lock()
                    .unwrap()
                    .push((window_id.to_owned(), channel.to_owned(), payload));
            }
        }),
        scan: Some(Box::new({
            let scan_calls = Arc::clone(&scan_calls);
            move |roots, host_pid| {
                scan_calls.lock().unwrap().push((roots.clone(), host_pid));
                let found: HashMap<i32, TreeInfo> = trees()
                    .into_iter()
                    .filter(|(pid, _)| roots.contains(pid))
                    .collect();
                Box::pin(async move { found })
            }
        })),
        host_pid: Some(1),
        env: BTreeMap::new(),
        log: None,
    });
    Fixture {
        settings,
        sent,
        scan_calls,
        list_calls,
        service,
    }
}

impl Fixture {
    fn items(&self, window_id: &str) -> Option<Value> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .rfind(|(window, channel, _)| window == window_id && channel == PORTS_ITEMS_CHANNEL)
            .map(|(_, _, payload)| payload.clone())
    }

    fn scans(&self) -> usize {
        self.scan_calls.lock().unwrap().len()
    }

    fn change_settings(&self, change: impl FnOnce(&mut PortsSettings)) {
        change(&mut self.settings.lock().unwrap());
        self.service.settings_changed();
    }
}

async fn settle(ms: u64) {
    if ms > 0 {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn scans_nothing_and_arms_no_timer_while_no_window_shows_a_ports_item() {
    let f = fixture();
    f.service.activity("command.started");
    f.service.set_focused(false);
    f.service.set_focused(true);
    f.service.settings_changed();
    settle(60_000).await;
    assert!(!f.service.polling());
    assert!(!f.service.pending());
    assert_eq!(f.list_calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.scans(), 0);
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn scans_only_the_terminals_of_the_workspaces_shown_and_sends_the_plug_with_a_link_per_port()
{
    let f = fixture();
    f.service.watch("w1", &["one"]);
    settle(0).await;
    assert_eq!(f.scan_calls.lock().unwrap().last(), Some(&(vec![10], 1)));
    assert_eq!(
        f.items("w1"),
        Some(json!({
            "sidebar": [],
            "paneChips": [],
            "workspaceChips": [
                {
                    "extId": "ports",
                    "tone": "neutral",
                    "workspaceId": "one",
                    "id": "ports",
                    "icon": "plugs",
                    "text": "2",
                    "items": [
                        {"text": ":3000", "detail": "node", "url": "http://localhost:3000/"},
                        {"text": ":5173", "url": "http://localhost:5173/"},
                    ],
                },
            ],
        })),
    );
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn shows_a_foreground_ssh_login_on_its_pane_by_renderer_pane_id_and_in_the_sidebar() {
    let f = fixture();
    f.service.watch("w1", &["two"]);
    settle(0).await;
    let items = f.items("w1").unwrap();
    assert_eq!(
        items["paneChips"],
        json!([
            {"extId": "ports", "paneId": "pane-b", "id": "ssh", "text": "deploy@box", "tone": "brand"},
        ]),
    );
    assert_eq!(
        items["sidebar"],
        json!([
            {
                "extId": "ports",
                "tone": "neutral",
                "workspaceId": "two",
                "key": "ssh",
                "text": "box",
                "badge": "SSH",
                "kind": "live",
            },
        ]),
    );
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn shows_no_pane_chip_for_an_empty_renderer_pane_id() {
    let f = fixture_with(|_| Some(String::new()));
    f.service.watch("w1", &["two"]);
    settle(0).await;
    let items = f.items("w1").unwrap();
    assert_eq!(items["paneChips"], json!([]));
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn opens_ports_on_127_0_0_1_when_the_human_chose_that_host() {
    let f = fixture();
    f.change_settings(|settings| settings.port_host = PortHost::Loopback);
    f.service.watch("w1", &["one"]);
    settle(0).await;
    let items = f.items("w1").unwrap();
    assert_eq!(
        items.pointer("/workspaceChips/0/items/0/url"),
        Some(&json!("http://127.0.0.1:3000/")),
    );
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn polls_while_focused_and_stops_once_the_last_window_stops_showing_ports() {
    let f = fixture();
    f.service.watch("w1", &["one"]);
    settle(0).await;
    let first = f.scans();
    let interval_ms = u64::from(f.settings.lock().unwrap().interval_seconds) * 1000;
    settle(interval_ms).await;
    assert_eq!(f.scans(), first + 1);
    f.service.set_focused(false);
    settle(60_000).await;
    assert_eq!(f.scans(), first + 1);
    f.service.set_focused(true);
    settle(0).await;
    f.service.watch("w1", &[]);
    assert!(!f.service.polling());
    assert!(!f.service.pending());
    assert_eq!(
        f.items("w1"),
        Some(json!({"sidebar": [], "paneChips": [], "workspaceChips": []})),
    );
    let last = f.scans();
    settle(60_000).await;
    assert_eq!(f.scans(), last);
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn stops_when_the_human_turns_ports_off() {
    let f = fixture();
    f.service.watch("w1", &["one"]);
    settle(0).await;
    f.change_settings(|settings| settings.enabled = false);
    assert!(!f.service.polling());
    assert_eq!(f.items("w1").unwrap()["workspaceChips"], json!([]));
    f.service.stop();
}

#[tokio::test(start_paused = true)]
async fn lists_every_workspace_for_a_one_off_read_without_starting_to_poll() {
    let f = fixture();
    assert_eq!(
        f.service.list().await,
        vec![
            WorkspacePorts {
                workspace_id: "one".to_owned(),
                ports: vec![
                    ListeningPort {
                        port: 3000,
                        name: Some("node".to_owned()),
                    },
                    ListeningPort {
                        port: 5173,
                        name: None,
                    },
                ],
                ssh: vec![],
            },
            WorkspacePorts {
                workspace_id: "two".to_owned(),
                ports: vec![],
                ssh: vec!["box".to_owned()],
            },
        ],
    );
    assert!(!f.service.polling());
    assert!(!f.service.pending());
    f.service.stop();
}
