#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_diagnostics::agent_journal::{AgentCall, AgentCaller, AgentJournal, JournalIncidents};
use ostia_diagnostics::app_log::{AppLog, AppLogOptions, FileAppLog, LogFields, format_entry};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;

#[derive(Default)]
struct Recorder {
    lines: Mutex<Vec<(String, String, LogFields)>>,
}

impl Recorder {
    fn level(&self, level: &str) -> Vec<(String, LogFields)> {
        self.lines
            .lock()
            .iter()
            .filter(|(seen, _, _)| seen == level)
            .map(|(_, event, fields)| (event.clone(), fields.clone()))
            .collect()
    }
}

impl AppLog for Recorder {
    fn info(&self, event: &str, fields: &LogFields) {
        self.lines
            .lock()
            .push(("info".into(), event.into(), fields.clone()));
    }

    fn warn(&self, event: &str, fields: &LogFields) {
        self.lines
            .lock()
            .push(("warn".into(), event.into(), fields.clone()));
    }

    fn error(&self, event: &str, fields: &LogFields) {
        self.lines
            .lock()
            .push(("error".into(), event.into(), fields.clone()));
    }
}

#[derive(Default)]
struct Incidents {
    mails: Mutex<Vec<(String, String, f64)>>,
    wakes: Mutex<Vec<(String, String, f64)>>,
    hooks: Mutex<Vec<(String, bool, Option<String>)>>,
}

impl JournalIncidents for Incidents {
    fn mail(&self, pane_id: &str, code: &str, age_ms: f64) {
        self.mails
            .lock()
            .push((pane_id.into(), code.into(), age_ms));
    }

    fn wake(&self, pane_id: &str, code: &str, ms: f64) {
        self.wakes.lock().push((pane_id.into(), code.into(), ms));
    }

    fn hook(&self, pane_id: &str, ok: bool, code: Option<&str>) {
        self.hooks
            .lock()
            .push((pane_id.into(), ok, code.map(str::to_owned)));
    }
}

fn fields(value: Value) -> LogFields {
    LogFields::try_from(value).unwrap()
}

fn call(method: &str, caller: AgentCaller, ms: f64, bytes: u64, code: Option<&str>) -> AgentCall {
    AgentCall {
        method: method.to_owned(),
        caller,
        ms,
        bytes,
        code: code.map(str::to_owned),
    }
}

fn journal() -> (AgentJournal, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    (AgentJournal::new(recorder.clone(), None), recorder)
}

fn secrets() -> Vec<String> {
    let mut out: Vec<String> = common::fake_secrets()
        .into_iter()
        .map(|(_, value)| value)
        .collect();
    out.extend(common::harmless_samples());
    out
}

fn read_all(dir: &TempDir) -> String {
    let mut names: Vec<PathBuf> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    names.sort();
    names
        .iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn records_an_ok_call_as_an_info_line_with_its_size_and_time() {
    let (journal, log) = journal();
    journal.call(call("pane.status", AgentCaller::Pane, 12.4, 480, None));
    assert_eq!(
        log.level("info"),
        [(
            "call".to_owned(),
            fields(json!({
                "method": "pane.status",
                "caller": "pane",
                "outcome": "ok",
                "ms": 12,
                "bytes": 480,
            }))
        )]
    );
    assert!(log.level("warn").is_empty());
}

#[test]
fn records_an_error_with_its_code_only_and_a_read_back_mismatch_as_its_own_outcome() {
    let (journal, log) = journal();
    journal.call(call(
        "pane.read",
        AgentCaller::Script,
        1.0,
        0,
        Some("unknown-pane: p-77"),
    ));
    journal.call(call(
        "pane.input",
        AgentCaller::Pane,
        1.0,
        0,
        Some("not-submitted: p-77 …"),
    ));
    let seen: Vec<(Value, Value)> = log
        .level("warn")
        .iter()
        .map(|(_, fields)| (fields["outcome"].clone(), fields["code"].clone()))
        .collect();
    assert_eq!(
        seen,
        [
            (json!("error"), json!("unknown-pane")),
            (json!("readback-mismatch"), json!("not-submitted")),
        ]
    );
}

#[test]
fn flags_an_answer_over_its_verb_budget_on_a_warn_line() {
    let (journal, log) = journal();
    journal.call(call("pane.list", AgentCaller::Extension, 1.0, 90_000, None));
    let warned = log.level("warn");
    assert_eq!(warned.len(), 1);
    assert_eq!(warned[0].0, "over-budget");
    assert_eq!(warned[0].1["over"], json!("bytes"));
    assert_eq!(warned[0].1["outcome"], json!("ok"));
}

#[test]
fn names_a_method_it_does_not_know_as_other_so_a_caller_cannot_write_its_own_text() {
    let (journal, log) = journal();
    journal.call(call(
        &format!("x {}", common::fake("openaiLegacy")),
        AgentCaller::Pane,
        1.0,
        1,
        None,
    ));
    assert_eq!(log.level("info")[0].1["method"], json!("other"));
}

#[test]
fn records_a_failed_mail_by_its_reason_and_age_a_lease_timeout_and_a_wake_that_was_not_ready() {
    let (journal, log) = journal();
    journal.mail("expired:hibernated", 86_400_000.4, None);
    journal.lease_timeout(120_000.0, None);
    journal.wake_not_ready(121_000.0, &[]);
    assert_eq!(
        log.level("warn"),
        [
            (
                "mail-failed".to_owned(),
                fields(json!({"code": "expired:hibernated", "age": 86_400_000}))
            ),
            (
                "mail-lease".to_owned(),
                fields(json!({"code": "lease-timeout", "age": 120_000}))
            ),
            (
                "wake".to_owned(),
                fields(json!({"code": "wake-not-ready", "ms": 121_000}))
            ),
        ]
    );
}

#[test]
fn writes_a_0600_file_that_holds_no_parameter_text_id_or_secret_whatever_the_caller_sent() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("journal.log");
    let journal = AgentJournal::new(
        Arc::new(FileAppLog::create(
            file.clone(),
            AppLogOptions {
                max_bytes: Some(4096),
                keep: Some(2),
            },
        )),
        None,
    );
    let secrets = secrets();
    for secret in &secrets {
        journal.call(call(
            "bus.send",
            AgentCaller::Pane,
            5.0,
            100,
            Some(&format!("denied: {secret}")),
        ));
        journal.call(call(secret, AgentCaller::Script, 5.0, 100, Some(secret)));
    }
    assert!(fs::metadata(&file).unwrap().len() > 0);
    let text = read_all(&dir);
    for secret in &secrets {
        assert!(!text.contains(secret.as_str()), "{secret} is in the log");
    }
    assert!(text.contains("method=bus.send"));
    assert!(text.contains("code=denied"));
    assert_eq!(mode_of(&file), 0o600);
}

#[test]
fn rotates_by_size_and_keeps_every_file_0600() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("rotating.log");
    let journal = AgentJournal::new(
        Arc::new(FileAppLog::create(
            file,
            AppLogOptions {
                max_bytes: Some(1024),
                keep: Some(2),
            },
        )),
        None,
    );
    for i in 0..60 {
        journal.call(call(
            "pane.read",
            AgentCaller::Pane,
            f64::from(i),
            1000,
            None,
        ));
    }
    let rotating: Vec<PathBuf> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("rotating")
        })
        .collect();
    assert_eq!(rotating.len(), 2);
    for path in rotating {
        assert_eq!(mode_of(&path), 0o600, "{}", path.display());
    }
}

#[test]
fn shows_what_one_line_looks_like() {
    assert_eq!(
        format_entry(
            "call",
            &fields(
                json!({"method": "pane.read", "caller": "pane", "outcome": "ok", "ms": 3, "bytes": 20})
            )
        ),
        "call method=pane.read caller=pane outcome=ok ms=3 bytes=20"
    );
}

#[test]
fn hands_the_pane_to_the_timeline_and_keeps_it_out_of_the_log_line() {
    let log = Arc::new(Recorder::default());
    let incidents = Arc::new(Incidents::default());
    let journal = AgentJournal::new(log.clone(), Some(incidents.clone()));
    journal.mail("agent-refused: it said no", 1500.0, Some("pane-ext-1"));
    journal.wake_not_ready(
        90_000.0,
        &["pane-ext-1".to_owned(), "pane-ext-2".to_owned()],
    );
    assert_eq!(
        *incidents.mails.lock(),
        [("pane-ext-1".to_owned(), "agent-refused".to_owned(), 1500.0)]
    );
    assert_eq!(incidents.wakes.lock().len(), 2);
    journal.hook("pane-ext-1", "prompt-submit");
    assert_eq!(
        *incidents.hooks.lock(),
        [(
            "pane-ext-1".to_owned(),
            true,
            Some("prompt-submit".to_owned())
        )]
    );
    let written = format!("{:?}", log.lines.lock());
    assert!(!written.contains("pane-ext"));
}

#[test]
fn hands_an_undelivered_mail_and_a_lease_timeout_to_the_timeline_by_code() {
    let log = Arc::new(Recorder::default());
    let incidents = Arc::new(Incidents::default());
    let journal = AgentJournal::new(log, Some(incidents.clone()));
    journal.undelivered("pane-ext-1", "hooks-off");
    journal.lease_timeout(120_000.0, Some("pane-ext-1"));
    journal.lease_timeout(120_000.0, None);
    assert_eq!(
        *incidents.mails.lock(),
        [
            (
                "pane-ext-1".to_owned(),
                "undelivered-hooks-off".to_owned(),
                0.0
            ),
            (
                "pane-ext-1".to_owned(),
                "lease-timeout".to_owned(),
                120_000.0
            ),
        ]
    );
}
