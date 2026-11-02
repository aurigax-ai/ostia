#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use common::{
    Harness, all_categories, batch_events, boom, exception_value, facts, has_prefix, only,
    properties, settle,
};
use ostia_base::clock::Clock;
use ostia_base::host::{Host, Platform};
use ostia_base::{PaneId, WindowId};
use ostia_contract::build_info::TelemetryStamp;
use ostia_diagnostics::app_log::{AppLog, LogFields};
use ostia_diagnostics::diagnostics::{Diagnostics, DiagnosticsDeps, RecoveryReason};
use ostia_diagnostics::privacy_telemetry::{
    ErrorInput, ErrorSource, TELEMETRY_BATCH_MAX, TELEMETRY_QUEUE_MAX, TELEMETRY_SEND_ATTEMPTS,
    TelemetryCategory, TelemetryEndpoint, TelemetrySettings,
};
use ostia_diagnostics::telemetry::{
    RegisterTelemetryDeps, Telemetry, install_context, read_telemetry_settings, register_telemetry,
    telemetry_endpoint,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const URL_ENV: &str = "OSTIA_TELEMETRY_URL";

fn env_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

fn paused_clock() -> Clock {
    let start = tokio::time::Instant::now();
    Arc::new(move || 1_000_000 + i64::try_from(start.elapsed().as_millis()).unwrap())
}

fn github_token() -> String {
    common::fake("githubClassic")
}

#[test]
fn uses_the_build_stamp_from_release_yml_and_nothing_without_one() {
    let stamp = TelemetryStamp {
        key: "phc_release".to_owned(),
        host: "https://us.i.posthog.com".to_owned(),
    };
    assert_eq!(
        telemetry_endpoint(true, &env_of(&[]), Some(&stamp)),
        Some(TelemetryEndpoint {
            url: "https://us.i.posthog.com/batch/".to_owned(),
            api_key: "phc_release".to_owned(),
        })
    );
    assert_eq!(telemetry_endpoint(true, &env_of(&[]), None), None);
    assert_eq!(telemetry_endpoint(false, &env_of(&[]), None), None);
}

#[test]
fn honours_the_url_override_only_when_unpackaged() {
    let stamp = TelemetryStamp {
        key: "phc_release".to_owned(),
        host: "https://us.i.posthog.com".to_owned(),
    };
    let env = env_of(&[(URL_ENV, "http://phc_e2e@127.0.0.1:1")]);
    assert_eq!(
        telemetry_endpoint(false, &env, Some(&stamp)),
        Some(TelemetryEndpoint {
            url: "http://127.0.0.1:1/batch/".to_owned(),
            api_key: "phc_e2e".to_owned(),
        })
    );
    assert_eq!(
        telemetry_endpoint(true, &env, Some(&stamp))
            .unwrap()
            .api_key,
        "phc_release"
    );
    assert_eq!(telemetry_endpoint(true, &env, None), None);
}

#[test]
fn reads_privacy_telemetry_from_the_settings_file_and_is_off_for_anything_else() {
    assert_eq!(
        read_telemetry_settings(&json!({"privacy": {"telemetry": {"errors": true}}})),
        only(&[TelemetryCategory::Errors])
    );
    assert_eq!(
        read_telemetry_settings(&Value::Null),
        TelemetrySettings::default()
    );
    assert_eq!(
        read_telemetry_settings(&json!({"privacy": "x"})),
        TelemetrySettings::default()
    );
}

#[tokio::test]
async fn sends_nothing_while_every_category_is_off() {
    let h = Harness::new(TelemetrySettings::default());
    let t = h.create();
    t.error(boom());
    t.count("features", "command", Some("pane.split"));
    t.count("agents", "bus_message", None);
    t.flush().await;
    t.shutdown().await;
    assert_eq!(h.sent_count(), 0);
    let reports = t.reports();
    assert!(reports.queued.is_empty());
    assert!(reports.sent.is_empty());
}

#[tokio::test]
async fn queues_an_error_report_and_sends_it_as_one_capture_batch_with_the_project_key() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create();
    t.error(ErrorInput {
        message: format!("token {} in /home/ann/x", github_token()),
        stack: Some("Error: boom\n    at f (/home/ann/x.js:1:2)".to_owned()),
        ..boom()
    });
    assert_eq!(t.reports().queued.len(), 1);
    t.flush().await;
    let sent = h.sent.lock();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].url, "https://us.i.posthog.com/batch/");
    assert_eq!(sent[0].headers["Content-Type"], "application/json");
    assert_eq!(sent[0].headers["User-Agent"], "ostia/1.0.0");
    assert!(!sent[0].body.contains("ghp_"));
    assert!(!sent[0].body.contains("/home/ann"));
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body["api_key"], json!("phc_test"));
    let event = batch_events(&sent[0].body).remove(0);
    assert_eq!(event["event"], json!("$exception"));
    assert_eq!(event["distinct_id"], json!(t.state().install_id));
    assert_eq!(event["properties"]["$process_person_profile"], json!(false));
    assert!(event["properties"].get("$ip").is_none());
    assert_eq!(exception_value(&event), "token [redacted] in <path>");
    assert_eq!(event["properties"]["channel"], json!("source"));
    let reports = t.reports();
    assert!(reports.queued.is_empty());
    assert_eq!(reports.sent, [event]);
}

#[tokio::test]
async fn carries_only_the_enabled_categories_in_the_usage_event_namespaced() {
    let h = Harness::new(only(&[
        TelemetryCategory::Usage,
        TelemetryCategory::Terminal,
    ]));
    let now = Arc::new(AtomicI64::new(1_000_000));
    let clock_now = now.clone();
    let t = h.create_with(|deps| deps.now = Arc::new(move || clock_now.load(Ordering::SeqCst)));
    t.count("features", "command", Some("pane.split"));
    t.count("agents", "bus_message", None);
    t.count("terminal", "shell", Some("zsh"));
    t.count("terminal", "wake", None);
    now.fetch_add(31 * 60_000, Ordering::SeqCst);
    t.shutdown().await;
    assert_eq!(h.sent_count(), 1);
    let event = batch_events(&h.sent.lock()[0].body).remove(0);
    assert_eq!(event["event"], json!("usage"));
    let props = properties(&event);
    assert_eq!(props["usage.app_starts"], json!(1));
    assert_eq!(props["usage.session_minutes"], json!(31));
    assert_eq!(props["usage.windows"], json!("1"));
    assert_eq!(props["usage.workspaces"], json!("2-3"));
    assert_eq!(props["usage.restore"], json!("ok"));
    assert_eq!(props["terminal.gpu"], json!("on"));
    assert_eq!(props["terminal.shell.zsh"], json!(1));
    assert_eq!(props["terminal.wake"], json!(1));
    assert!(!has_prefix(&event, "features."));
    assert!(!has_prefix(&event, "agents."));
    assert!(!has_prefix(&event, "extensions."));
    assert!(props.get("$exception_list").is_none());
}

#[tokio::test(start_paused = true)]
async fn reports_the_app_start_once_per_launch_not_again_on_the_next_interval() {
    let h = Harness::new(only(&[TelemetryCategory::Usage]));
    let t = h.create_with(|deps| {
        deps.endpoint = None;
        deps.now = paused_clock();
        deps.usage_interval = Duration::from_secs(60);
    });
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    let queued = t.reports().queued;
    assert_eq!(queued.len(), 2);
    assert_eq!(properties(&queued[0])["usage.app_starts"], json!(1));
    assert!(properties(&queued[1]).get("usage.app_starts").is_none());
    assert_eq!(properties(&queued[1])["usage.session_minutes"], json!(1));
}

#[tokio::test]
async fn counts_only_for_a_category_that_is_on_and_only_known_keys_and_ids() {
    let h = Harness::new(only(&[
        TelemetryCategory::Features,
        TelemetryCategory::Extensions,
        TelemetryCategory::Agents,
    ]));
    let t = h.create();
    t.count("features", "command", Some("pane.split"));
    t.count("features", "command", Some("pane.split"));
    t.count("features", "command", Some("bad id with spaces"));
    t.count("features", "nope", Some("x"));
    t.count("features", "command", None);
    t.count("terminal", "wake", None);
    t.count("agents", "session", Some("claude"));
    t.count("agents", "bus_message", Some("extra"));
    t.count("nope", "x", None);
    t.shutdown().await;
    let event = batch_events(&h.sent.lock()[0].body).remove(0);
    let props = properties(&event);
    assert_eq!(props["features.command.pane.split"], json!(2));
    assert_eq!(props["agents.session.claude"], json!(1));
    assert_eq!(props["extensions.installed"], json!(["trellis"]));
    assert_eq!(props["extensions.enabled"], json!(["trellis"]));
    assert!(props.get("agents.bus_message").is_none());
    assert!(!has_prefix(&event, "terminal."));
    assert!(!props.keys().any(|key| key.contains("nope")));
    assert!(!props.keys().any(|key| key.contains("bad id")));
}

#[tokio::test]
async fn persists_the_queue_and_the_install_id_in_a_0600_file_and_reloads_them() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create_with(|deps| deps.endpoint = None);
    t.error(boom());
    let id = t.state().install_id;
    assert_eq!(
        fs::metadata(&h.file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let again = h.create();
    assert_eq!(again.state().install_id, id);
    assert_eq!(again.reports().queued.len(), 1);
    again.flush().await;
    assert_eq!(h.sent_count(), 1);
}

#[tokio::test]
async fn caps_the_queue_and_drops_a_report_after_the_retry_cap() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    h.respond_with(Some(500));
    let t = h.create_with(|deps| deps.endpoint = None);
    for _ in 0..TELEMETRY_QUEUE_MAX + 5 {
        t.error(boom());
    }
    assert_eq!(t.reports().queued.len(), TELEMETRY_QUEUE_MAX);
    let failing = h.create();
    for _ in 0..TELEMETRY_SEND_ATTEMPTS {
        failing.flush().await;
    }
    assert_eq!(h.sent_count(), TELEMETRY_SEND_ATTEMPTS);
    let kept = TELEMETRY_QUEUE_MAX - TELEMETRY_BATCH_MAX;
    assert_eq!(failing.reports().queued.len(), kept);
    assert_eq!(h.file_json()["queue"].as_array().unwrap().len(), kept);
}

#[tokio::test(start_paused = true)]
async fn drops_queued_reports_of_a_category_that_turned_off_keeping_the_rest_of_a_usage_event() {
    let h = Harness::new(only(&[
        TelemetryCategory::Errors,
        TelemetryCategory::Usage,
        TelemetryCategory::Agents,
    ]));
    let t = h.create_with(|deps| {
        deps.endpoint = None;
        deps.now = paused_clock();
        deps.usage_interval = Duration::from_secs(60);
    });
    t.error(boom());
    t.count("agents", "bus_message", None);
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    let events = |t: &Telemetry| -> Vec<String> {
        t.reports()
            .queued
            .iter()
            .map(|report| report["event"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(events(&t), ["$exception", "usage"]);
    h.set_settings(only(&[TelemetryCategory::Usage, TelemetryCategory::Agents]));
    t.settings_changed();
    assert_eq!(events(&t), ["usage"]);
    h.set_settings(only(&[TelemetryCategory::Agents]));
    t.settings_changed();
    let usage = t.reports().queued.remove(0);
    assert_eq!(properties(&usage)["agents.bus_message"], json!(1));
    assert!(properties(&usage).get("usage.app_starts").is_none());
    h.set_settings(TelemetrySettings::default());
    t.settings_changed();
    assert!(t.reports().queued.is_empty());
}

#[tokio::test]
async fn reset_gives_a_new_install_id_and_forgets_every_report() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create();
    t.error(boom());
    t.flush().await;
    let before = t.state().install_id;
    let after = t.reset_install_id();
    assert_ne!(after, before);
    assert_eq!(t.state().install_id, after);
    let reports = t.reports();
    assert!(reports.queued.is_empty());
    assert!(reports.sent.is_empty());
}

#[tokio::test]
async fn remembers_the_consent_answer_and_marks_a_category_added_later_as_new_never_re_asking() {
    let h = Harness::new(TelemetrySettings::default());
    let t = h.create();
    assert!(!t.state().asked);
    assert!(t.state().new_categories.is_empty());
    t.consented();
    let mut file = h.file_json();
    assert_eq!(file["asked"], json!(true));
    assert!(file["answeredAt"].is_string());
    let seen: Vec<Value> = file["seen"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|category| category.as_str() != Some("terminal"))
        .cloned()
        .collect();
    file["seen"] = Value::Array(seen);
    fs::write(&h.file, file.to_string()).unwrap();
    let later = h.create();
    assert!(later.state().asked);
    assert_eq!(later.state().new_categories, [TelemetryCategory::Terminal]);
    assert!(
        !read_telemetry_settings(&json!({"privacy": {"telemetry": {"errors": true}}}))
            .get(TelemetryCategory::Terminal)
    );
    later.categories_seen();
    assert!(h.create().state().new_categories.is_empty());
}

#[tokio::test]
async fn drops_a_corrupt_queue_entry_instead_of_failing_every_flush() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create();
    t.error(boom());
    let mut file = h.file_json();
    let queue = file["queue"].as_array_mut().unwrap();
    queue.push(json!({"report": null, "attempts": 0}));
    queue.push(json!({"report": {"event": "$exception"}, "attempts": 0}));
    file["sent"] = json!([null]);
    fs::write(&h.file, file.to_string()).unwrap();
    let again = h.create();
    let reports = again.reports();
    assert_eq!(reports.queued, t.reports().queued);
    assert!(reports.sent.is_empty());
    again.flush().await;
    again.shutdown().await;
    assert_eq!(h.sent_count(), 1);
    assert!(again.reports().queued.is_empty());
}

#[tokio::test]
async fn reports_whether_a_build_has_an_endpoint() {
    let h = Harness::new(TelemetrySettings::default());
    assert!(h.create().state().available);
    assert!(!h.create_with(|deps| deps.endpoint = None).state().available);
}

#[tokio::test]
async fn never_contacts_the_network_without_an_endpoint() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create_with(|deps| deps.endpoint = None);
    t.error(boom());
    t.flush().await;
    t.shutdown().await;
    assert_eq!(h.sent_count(), 0);
    assert_eq!(t.reports().queued.len(), 1);
}

struct Received {
    path: String,
    body: String,
}

async fn serve() -> (String, Arc<Mutex<Vec<Received>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let received = Arc::new(Mutex::new(Vec::new()));
    let seen = received.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, length) = loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&data).into_owned();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (end + 4, length);
                    }
                };
                while data.len() < head_end + length {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
                let path = head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                let body = String::from_utf8_lossy(&data[head_end..]).into_owned();
                seen.lock().push(Received { path, body });
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .ok();
                stream.shutdown().await.ok();
            });
        }
    });
    (format!("http://phc_e2e@127.0.0.1:{port}"), received)
}

struct Silent;

impl AppLog for Silent {
    fn info(&self, _event: &str, _fields: &LogFields) {}

    fn warn(&self, _event: &str, _fields: &LogFields) {}

    fn error(&self, _event: &str, _fields: &LogFields) {}
}

struct Launch {
    telemetry: Telemetry,
    diagnostics: Diagnostics,
}

fn host_with(url: &str, dir: &TempDir) -> Host {
    Host {
        env: env_of(&[(URL_ENV, url)]),
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        platform: Platform::current(),
    }
}

fn launch(url: &str, dir: &TempDir, settings: &Arc<Mutex<Value>>) -> Launch {
    let read = settings.clone();
    let telemetry = register_telemetry(RegisterTelemetryDeps {
        file: dir.path().join("telemetry.json"),
        version: "1.0.0".to_owned(),
        stamp: None,
        read_settings: Arc::new(move || read.lock().clone()),
        locale: Arc::new(|| Some("en".to_owned())),
        session: Arc::new(facts),
        log: None,
        packaged: false,
        host: host_with(url, dir),
    });
    let diagnostics = Diagnostics::new(DiagnosticsDeps {
        log: Arc::new(Silent),
        telemetry: Arc::new(telemetry.clone()),
        version: "1.0.0".to_owned(),
        log_dir: dir.path().to_path_buf(),
        test_hooks: true,
        packaged: false,
        now: Arc::new(|| 0),
        start_recovery: Arc::new(|_window: &WindowId, _reason: RecoveryReason| {}),
        finish_recovery: Arc::new(|_window: &WindowId, _live: &HashSet<PaneId>| {}),
        open_path: Arc::new(|_path: &Path| Box::pin(async { String::new() })),
    });
    Launch {
        telemetry,
        diagnostics,
    }
}

fn crash_renderer(diagnostics: &Diagnostics, dir: &TempDir) {
    diagnostics.handle_report(
        &WindowId::new("1"),
        &json!({
            "kind": "render",
            "message": "test crash requested by the E2E hook",
            "stack": format!(
                "Error: test crash requested by the E2E hook\n    at CrashTestHook (/home/runner/ostia/out/renderer/index.js:1:2)\n    at render ({}/renderer.js:3:4)",
                dir.path().display()
            ),
        }),
    );
}

fn tele_settings(on: &[TelemetryCategory]) -> Arc<Mutex<Value>> {
    let map: serde_json::Map<String, Value> = all_categories()
        .iter()
        .map(|category| (category.as_str().to_owned(), json!(on.contains(category))))
        .collect();
    Arc::new(Mutex::new(
        json!({"privacy": {"telemetry": Value::Object(map)}}),
    ))
}

fn set_tele_settings(settings: &Arc<Mutex<Value>>, on: &[TelemetryCategory]) {
    let map: serde_json::Map<String, Value> = all_categories()
        .iter()
        .map(|category| (category.as_str().to_owned(), json!(on.contains(category))))
        .collect();
    *settings.lock() = json!({"privacy": {"telemetry": Value::Object(map)}});
}

#[tokio::test]
async fn posts_the_batch_to_the_ingest_host() {
    let (url, received) = serve().await;
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let env = env_of(&[(URL_ENV, &url)]);
    let t = Telemetry::new({
        let mut deps = h.deps();
        deps.endpoint = telemetry_endpoint(false, &env, None);
        deps.transport = ostia_diagnostics::telemetry_queue::http_transport();
        deps
    });
    t.error(boom());
    t.flush().await;
    let received = received.lock();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].path, "/batch/");
    let body: Value = serde_json::from_str(&received[0].body).unwrap();
    assert_eq!(body["api_key"], json!("phc_e2e"));
    assert_eq!(exception_value(&batch_events(&received[0].body)[0]), "boom");
}

#[tokio::test]
async fn sharing_only_errors_sends_an_exception_and_a_usage_event_without_other_categories_and_off_stops_it()
 {
    let (url, received) = serve().await;
    let settings = tele_settings(&[TelemetryCategory::Errors]);
    let dir = TempDir::new().unwrap();
    let first = launch(&url, &dir, &settings);
    crash_renderer(&first.diagnostics, &dir);
    first.telemetry.flush().await;
    {
        let received = received.lock();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].path, "/batch/");
        let body: Value = serde_json::from_str(&received[0].body).unwrap();
        assert_eq!(body["api_key"], json!("phc_e2e"));
        let report = batch_events(&received[0].body).remove(0);
        assert_eq!(report["event"], json!("$exception"));
        assert_eq!(report["properties"]["source"], json!("render-error"));
        assert_eq!(
            report["properties"]["$process_person_profile"],
            json!(false)
        );
        assert_eq!(report["properties"]["channel"], json!("source"));
        assert!(exception_value(&report).contains("test crash requested by the E2E hook"));
        let dir_text = dir.path().display().to_string();
        assert!(!received[0].body.contains(&dir_text));
        assert!(!received[0].body.contains("/home/"));
        assert!(
            regex::Regex::new("^[0-9a-f-]{36}$")
                .unwrap()
                .is_match(report["distinct_id"].as_str().unwrap())
        );
    }
    let sent: Vec<String> = first
        .telemetry
        .reports()
        .sent
        .iter()
        .map(|report| report["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(sent, ["$exception"]);
    first.telemetry.shutdown().await;
    let usage_count = |received: &Arc<Mutex<Vec<Received>>>| {
        received
            .lock()
            .iter()
            .flat_map(|r| batch_events(&r.body))
            .filter(|event| event["event"] == json!("usage"))
            .count()
    };
    assert_eq!(usage_count(&received), 0);

    let second = launch(&url, &dir, &settings);
    set_tele_settings(
        &settings,
        &[TelemetryCategory::Errors, TelemetryCategory::Usage],
    );
    second.telemetry.settings_changed();
    second.telemetry.shutdown().await;
    let usage: Vec<Value> = received
        .lock()
        .iter()
        .flat_map(|r| batch_events(&r.body))
        .filter(|event| event["event"] == json!("usage"))
        .collect();
    assert_eq!(usage.len(), 1);
    assert_eq!(properties(&usage[0])["usage.app_starts"], json!(1));
    assert!(!has_prefix(&usage[0], "features."));
    assert!(!has_prefix(&usage[0], "agents."));
    assert!(!has_prefix(&usage[0], "terminal."));
    assert!(
        !usage[0]
            .to_string()
            .contains(&dir.path().display().to_string())
    );
}

#[tokio::test]
async fn turning_errors_off_afterwards_sends_nothing_more() {
    let (url, received) = serve().await;
    let settings = tele_settings(&[TelemetryCategory::Errors]);
    let dir = TempDir::new().unwrap();
    let launched = launch(&url, &dir, &settings);
    set_tele_settings(&settings, &[]);
    launched.telemetry.settings_changed();
    crash_renderer(&launched.diagnostics, &dir);
    launched.telemetry.flush().await;
    launched.telemetry.shutdown().await;
    assert!(received.lock().is_empty());
}

#[tokio::test]
async fn answers_state_consent_reset_and_reports_and_validates_counts() {
    let dir = TempDir::new().unwrap();
    let settings = Arc::new(Mutex::new(
        json!({"privacy": {"telemetry": {"features": true}}}),
    ));
    let read = settings.clone();
    let t = register_telemetry(RegisterTelemetryDeps {
        file: dir.path().join("telemetry.json"),
        version: "1.0.0".to_owned(),
        stamp: None,
        read_settings: Arc::new(move || read.lock().clone()),
        locale: Arc::new(|| Some("en".to_owned())),
        session: Arc::new(facts),
        log: None,
        packaged: false,
        host: Host {
            env: BTreeMap::new(),
            home: dir.path().join("home"),
            cwd: dir.path().to_path_buf(),
            platform: Platform::current(),
        },
    });
    let state = t.state();
    assert!(!state.available);
    t.count("features", "command", Some("pane.split"));
    t.consented();
    assert!(t.state().asked);
    t.categories_seen();
    let next = t.reset_install_id();
    assert_ne!(next, state.install_id);
    let reports = t.reports();
    assert!(reports.queued.is_empty());
    assert!(reports.sent.is_empty());
    t.shutdown().await;
}

#[test]
fn describes_the_install_with_the_version_the_locale_and_the_channel() {
    let packaged = install_context("1.0.0", "en", true);
    assert_eq!(packaged.app_version, "1.0.0");
    assert_eq!(packaged.channel, "packaged");
    assert_eq!(packaged.electron_version, "");
    assert_eq!(install_context("1.0.0", "en", false).channel, "source");
}

#[test]
fn falls_back_to_en_for_a_locale_that_is_not_a_safe_word() {
    assert_eq!(install_context("1.0.0", "zh-Hant", false).locale, "zh-Hant");
    assert_eq!(
        install_context("1.0.0", "not a locale!", false).locale,
        "en"
    );
    assert_eq!(install_context("1.0.0", "", false).locale, "en");
}

#[test]
fn keeps_the_error_source_names_the_ui_and_the_log_agree_on() {
    let names: Vec<&str> = [
        ErrorSource::MainException,
        ErrorSource::MainRejection,
        ErrorSource::RendererGone,
        ErrorSource::RendererError,
        ErrorSource::RendererRejection,
        ErrorSource::RenderError,
        ErrorSource::SurfaceError,
        ErrorSource::ExtensionCrashed,
    ]
    .iter()
    .map(ErrorSource::as_str)
    .collect();
    assert_eq!(
        names,
        [
            "main-exception",
            "main-rejection",
            "renderer-gone",
            "renderer-error",
            "renderer-rejection",
            "render-error",
            "surface-error",
            "extension-crashed",
        ]
    );
}

fn fixture(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[tokio::test]
async fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    fs::copy(fixture("telemetry-before.json"), &h.file).unwrap();
    let t = h.create_with(|deps| {
        deps.endpoint = None;
        deps.now = Arc::new(|| 1_792_317_600_000);
    });
    let before: Value =
        serde_json::from_str(&fs::read_to_string(fixture("telemetry-before.json")).unwrap())
            .unwrap();
    assert_eq!(t.state().install_id, "0f8fad5b-d9cb-469f-a165-70867728950e");
    assert_eq!(t.reports().queued, [before["queue"][0]["report"].clone()]);
    t.consented();
    assert_eq!(
        fs::read(&h.file).unwrap(),
        fs::read(fixture("telemetry-after.json")).unwrap()
    );
}
