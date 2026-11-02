#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::{PaneId, WindowId};
use ostia_diagnostics::app_log::{AppLog, LogFields};
use ostia_diagnostics::diagnostics::{
    ChildProcessGone, Diagnostics, DiagnosticsDeps, ErrorTelemetry, MainError, RecoveryReason,
    WindowContents,
};
use ostia_diagnostics::privacy_telemetry::{ErrorInput, ErrorSource};
use ostia_terminal::pty_reaper::{
    OrphanCheck, OrphanVerdict, RecoveredPty, RecoveryBook, orphan_verdict, plan_recovery,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;

type Seen = (ErrorSource, String, String, Option<String>);
type Finished = (WindowId, HashSet<PaneId>);

const WINDOW: &str = "7";

#[derive(Default)]
struct Recorder {
    lines: Mutex<Vec<(String, String, Value)>>,
}

impl Recorder {
    fn push(&self, level: &str, event: &str, fields: &LogFields) {
        self.lines
            .lock()
            .push((level.into(), event.into(), fields.to_json()));
    }

    fn at(&self, level: &str) -> Vec<(String, Value)> {
        self.lines
            .lock()
            .iter()
            .filter(|(seen, _, _)| seen == level)
            .map(|(_, event, fields)| (event.clone(), fields.clone()))
            .collect()
    }

    fn events(&self) -> Vec<String> {
        self.lines
            .lock()
            .iter()
            .map(|(_, event, _)| event.clone())
            .collect()
    }
}

impl AppLog for Recorder {
    fn info(&self, event: &str, fields: &LogFields) {
        self.push("info", event, fields);
    }

    fn warn(&self, event: &str, fields: &LogFields) {
        self.push("warn", event, fields);
    }

    fn error(&self, event: &str, fields: &LogFields) {
        self.push("error", event, fields);
    }
}

#[derive(Default)]
struct Reports {
    seen: Mutex<Vec<Seen>>,
}

impl ErrorTelemetry for Reports {
    fn error(&self, input: ErrorInput) {
        self.seen
            .lock()
            .push((input.source, input.name, input.message, input.stack));
    }
}

struct FakeContents {
    id: &'static str,
    destroyed: bool,
    calls: Arc<Mutex<Vec<String>>>,
}

impl WindowContents for FakeContents {
    fn window_id(&self) -> WindowId {
        WindowId::new(self.id)
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn reload(&self) {
        self.calls.lock().push("reload".to_owned());
    }

    fn toggle_devtools(&self) {
        self.calls.lock().push("devtools".to_owned());
    }
}

struct FakePty {
    owners: usize,
    killed: bool,
}

struct Setup {
    calls: Arc<Mutex<Vec<String>>>,
    started: Arc<Mutex<Vec<(WindowId, RecoveryReason)>>>,
    finished: Arc<Mutex<Vec<Finished>>>,
    ptys: Arc<Mutex<HashMap<PaneId, FakePty>>>,
    book: Arc<Mutex<RecoveryBook>>,
    diagnostics: Diagnostics,
    log: Arc<Recorder>,
    reports: Arc<Reports>,
    now: Arc<AtomicI64>,
    opened: Arc<Mutex<Vec<PathBuf>>>,
}

fn setup_with(
    open_result: &'static str,
    log_dir: PathBuf,
    test_hooks: bool,
    packaged: bool,
) -> Setup {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(Mutex::new(Vec::new()));
    let opened = Arc::new(Mutex::new(Vec::new()));
    let now = Arc::new(AtomicI64::new(0));
    let book = Arc::new(Mutex::new(RecoveryBook::new(Arc::new(|| 0))));
    let ptys = Arc::new(Mutex::new(HashMap::from([
        (
            PaneId::new("shown"),
            FakePty {
                owners: 1,
                killed: false,
            },
        ),
        (
            PaneId::new("closed"),
            FakePty {
                owners: 1,
                killed: false,
            },
        ),
    ])));
    let log = Arc::new(Recorder::default());
    let reports = Arc::new(Reports::default());
    let clock_now = now.clone();
    let diagnostics = Diagnostics::new(DiagnosticsDeps {
        log: log.clone(),
        telemetry: reports.clone(),
        version: "1.0.0".to_owned(),
        log_dir,
        test_hooks,
        packaged,
        now: Arc::new(move || clock_now.load(Ordering::SeqCst)),
        start_recovery: {
            let calls = calls.clone();
            let started = started.clone();
            let book = book.clone();
            Arc::new(move |window: &WindowId, reason: RecoveryReason| {
                calls.lock().push(format!("recovery:{}", reason.as_str()));
                started.lock().push((window.clone(), reason));
                book.lock().start(window);
            })
        },
        finish_recovery: {
            let finished = finished.clone();
            let book = book.clone();
            let ptys = ptys.clone();
            Arc::new(move |window: &WindowId, live: &HashSet<PaneId>| {
                finished.lock().push((window.clone(), live.clone()));
                if !book.lock().end(window) {
                    return;
                }
                let mut ptys = ptys.lock();
                let window_ptys: Vec<RecoveredPty> = ptys
                    .iter()
                    .map(|(pane_id, pty)| RecoveredPty {
                        pane_id: pane_id.clone(),
                        owners: pty.owners,
                    })
                    .collect();
                for pane_id in plan_recovery(&window_ptys, live).reap {
                    if let Some(pty) = ptys.get_mut(&pane_id) {
                        pty.killed = true;
                    }
                }
            })
        },
        open_path: {
            let opened = opened.clone();
            Arc::new(move |path: &Path| {
                opened.lock().push(path.to_path_buf());
                Box::pin(async move { open_result.to_owned() })
            })
        },
    });
    Setup {
        calls,
        started,
        finished,
        ptys,
        book,
        diagnostics,
        log,
        reports,
        now,
        opened,
    }
}

fn setup() -> Setup {
    setup_with("", PathBuf::new(), false, false)
}

impl Setup {
    fn contents(&self, destroyed: bool) -> FakeContents {
        FakeContents {
            id: WINDOW,
            destroyed,
            calls: self.calls.clone(),
        }
    }

    fn detach_all(&self) {
        for pty in self.ptys.lock().values_mut() {
            pty.owners = 0;
        }
    }

    fn grace_check(&self, pane_id: &str) -> OrphanVerdict {
        let owners = self.ptys.lock()[&PaneId::new(pane_id)].owners;
        orphan_verdict(&OrphanCheck {
            current: true,
            owners,
            moving: false,
            held: false,
            recovering: self.book.lock().is_recovering(Some(&WindowId::new(WINDOW))),
        })
    }

    fn killed(&self, pane_id: &str) -> bool {
        self.ptys.lock()[&PaneId::new(pane_id)].killed
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().clone()
    }
}

fn render_report() -> Value {
    json!({"kind": "render", "message": "boom", "stack": "Error: boom\n    at x (a.js:1:2)"})
}

fn window() -> WindowId {
    WindowId::new(WINDOW)
}

#[test]
fn starts_recovery_for_the_window_before_reloading_it() {
    let s = setup();
    s.diagnostics.reload_window(&s.contents(false));
    assert_eq!(*s.started.lock(), [(window(), RecoveryReason::Reload)]);
    assert_eq!(s.calls(), ["recovery:reload", "reload"]);
}

#[test]
fn does_nothing_for_a_destroyed_window() {
    let s = setup();
    s.diagnostics.reload_window(&s.contents(true));
    assert!(s.started.lock().is_empty());
    assert!(s.calls().is_empty());
}

#[test]
fn keeps_every_pty_through_a_reload_and_reaps_only_the_panes_the_window_no_longer_shows() {
    let s = setup();
    s.diagnostics.reload_window(&s.contents(false));
    s.detach_all();
    assert_eq!(s.grace_check("shown"), OrphanVerdict::Wait);
    assert_eq!(s.grace_check("closed"), OrphanVerdict::Wait);
    assert!(!s.killed("shown") && !s.killed("closed"));

    s.diagnostics.handle_ready(&window(), &json!(["shown"]));
    assert!(!s.killed("shown"));
    assert!(s.killed("closed"));
}

#[test]
fn would_reap_detached_ptys_after_the_grace_if_the_reload_skipped_recovery() {
    let s = setup();
    s.detach_all();
    assert_eq!(s.grace_check("shown"), OrphanVerdict::Reap);
}

#[test]
fn ignores_a_ready_message_that_is_not_a_list_of_pane_ids() {
    let s = setup();
    s.diagnostics.handle_ready(&window(), &json!("shown"));
    s.diagnostics.handle_ready(&window(), &json!(["shown", 3]));
    assert!(s.finished.lock().is_empty());
}

#[test]
fn logs_the_app_start_with_the_version_and_whether_the_build_is_packaged() {
    let s = setup_with("", PathBuf::new(), false, true);
    let started = s.log.at("info");
    assert_eq!(started[0].0, "app-start");
    assert_eq!(started[0].1["version"], json!("1.0.0"));
    assert_eq!(started[0].1["packaged"], json!(true));
}

#[test]
fn logs_a_renderer_report_and_sends_it_to_telemetry_with_the_source_of_its_kind() {
    let s = setup();
    s.diagnostics.handle_report(&window(), &render_report());
    let errors = s.log.at("error");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, "renderer-error");
    assert_eq!(errors[0].1["window"], json!(WINDOW));
    assert_eq!(errors[0].1["kind"], json!("render"));
    assert_eq!(errors[0].1["message"], json!("boom"));
    assert_eq!(
        *s.reports.seen.lock(),
        [(
            ErrorSource::RenderError,
            "Error".to_owned(),
            "boom".to_owned(),
            Some("Error: boom\n    at x (a.js:1:2)".to_owned())
        )]
    );
}

#[test]
fn maps_every_renderer_kind_to_its_telemetry_source() {
    let s = setup();
    for (kind, source) in [
        ("error", ErrorSource::RendererError),
        ("rejection", ErrorSource::RendererRejection),
        ("render", ErrorSource::RenderError),
        ("surface", ErrorSource::SurfaceError),
    ] {
        s.diagnostics
            .handle_report(&window(), &json!({"kind": kind, "message": "m"}));
        assert_eq!(s.reports.seen.lock().last().unwrap().0, source, "{kind}");
    }
}

#[test]
fn starts_recovery_for_a_render_report_but_not_for_the_other_kinds() {
    let s = setup();
    s.diagnostics
        .handle_report(&window(), &json!({"kind": "error", "message": "m"}));
    assert!(s.started.lock().is_empty());
    s.diagnostics.handle_report(&window(), &render_report());
    assert_eq!(*s.started.lock(), [(window(), RecoveryReason::RenderError)]);
}

#[test]
fn ignores_a_report_that_does_not_pass_the_checks() {
    let s = setup();
    s.diagnostics
        .handle_report(&window(), &json!({"kind": "shell", "message": "m"}));
    s.diagnostics.handle_report(&window(), &json!("error"));
    assert!(s.started.lock().is_empty());
    assert!(s.reports.seen.lock().is_empty());
    assert!(s.log.at("error").is_empty());
}

#[test]
fn drops_reports_over_twenty_a_minute_and_says_how_many_it_dropped_when_the_next_minute_starts() {
    let s = setup();
    for _ in 0..22 {
        s.diagnostics.handle_report(&window(), &render_report());
    }
    assert_eq!(s.log.at("error").len(), 20);
    assert_eq!(s.reports.seen.lock().len(), 20);
    assert_eq!(s.started.lock().len(), 22);
    s.now.store(60_000, Ordering::SeqCst);
    s.diagnostics.handle_report(&window(), &render_report());
    assert_eq!(
        s.log.at("warn"),
        [(
            "renderer-reports-suppressed".to_owned(),
            json!({"window": WINDOW, "suppressed": 2})
        )]
    );
    assert_eq!(s.log.at("error").len(), 21);
}

#[test]
fn writes_a_main_exception_to_the_log_and_to_telemetry() {
    let s = setup();
    s.diagnostics.main_uncaught_exception(&MainError {
        name: "TypeError".to_owned(),
        message: "x is not a function".to_owned(),
        stack: Some("TypeError: x\n    at f (a.js:1:2)".to_owned()),
    });
    let errors = s.log.at("error");
    assert_eq!(errors[0].0, "main-uncaught-exception");
    assert_eq!(errors[0].1["message"], json!("x is not a function"));
    assert_eq!(
        s.reports.seen.lock()[0],
        (
            ErrorSource::MainException,
            "TypeError".to_owned(),
            "x is not a function".to_owned(),
            Some("TypeError: x\n    at f (a.js:1:2)".to_owned())
        )
    );
}

#[test]
fn writes_a_main_rejection_to_the_log_and_to_telemetry() {
    let s = setup();
    s.diagnostics.main_unhandled_rejection(&MainError {
        name: "Error".to_owned(),
        message: "refused".to_owned(),
        stack: None,
    });
    assert_eq!(s.log.at("error")[0].0, "main-unhandled-rejection");
    assert_eq!(s.reports.seen.lock()[0].0, ErrorSource::MainRejection);
}

#[test]
fn logs_a_child_process_that_is_gone_and_a_guest_process_but_not_a_window_process() {
    let s = setup();
    s.diagnostics.child_process_gone(&ChildProcessGone {
        kind: "GPU".to_owned(),
        reason: "crashed".to_owned(),
        exit_code: 139,
        name: Some("GPU Process".to_owned()),
        service_name: None,
    });
    s.diagnostics.guest_process_gone("window", "crashed", 1);
    s.diagnostics.guest_process_gone("webview", "oom", 9);
    let warned = s.log.at("warn");
    assert_eq!(warned.len(), 2);
    assert_eq!(warned[0].0, "child-process-gone");
    assert_eq!(warned[0].1["type"], json!("GPU"));
    assert_eq!(warned[0].1["reason"], json!("crashed"));
    assert_eq!(warned[0].1["exitCode"], json!(139));
    assert_eq!(warned[0].1["name"], json!("GPU Process"));
    assert_eq!(warned[1].0, "guest-process-gone");
    assert_eq!(
        warned[1].1,
        json!({"type": "webview", "reason": "oom", "exitCode": 9})
    );
}

#[test]
fn logs_the_devtools_toggle_and_toggles_a_live_window_only() {
    let s = setup();
    s.diagnostics.toggle_devtools(&s.contents(true));
    assert!(s.calls().is_empty());
    s.diagnostics.toggle_devtools(&s.contents(false));
    assert_eq!(s.calls(), ["devtools"]);
    assert_eq!(
        s.log.at("info").last().unwrap(),
        &("devtools-toggled".to_owned(), json!({"window": WINDOW}))
    );
}

#[tokio::test]
async fn creates_the_log_folder_and_answers_whether_the_system_opened_it() {
    let dir = TempDir::new().unwrap();
    let logs = dir.path().join("a").join("logs");
    let opened = setup_with("", logs.clone(), false, false);
    assert!(opened.diagnostics.open_log_folder().await.unwrap());
    assert!(logs.is_dir());
    assert_eq!(*opened.opened.lock(), std::slice::from_ref(&logs));
    let refused = setup_with("no handler", logs, false, false);
    assert!(!refused.diagnostics.open_log_folder().await.unwrap());
}

#[test]
fn tells_the_renderer_whether_the_test_hooks_are_on() {
    assert!(!setup().diagnostics.test_hooks());
    assert!(
        setup_with("", PathBuf::new(), true, false)
            .diagnostics
            .test_hooks()
    );
}

#[test]
fn reloads_after_a_crash_but_not_after_a_clean_exit() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    let contents = s.contents(false);
    watch.render_process_gone("clean-exit", 0, false, &contents);
    assert_eq!(s.log.at("error")[0].0, "render-process-gone");
    assert!(s.reports.seen.lock().is_empty());
    assert!(s.started.lock().is_empty());
    assert!(s.calls().is_empty());

    watch.render_process_gone("crashed", 139, false, &contents);
    assert_eq!(
        *s.reports.seen.lock(),
        [(
            ErrorSource::RendererGone,
            "RendererGone".to_owned(),
            "crashed (139)".to_owned(),
            None
        )]
    );
    assert_eq!(
        *s.started.lock(),
        [(window(), RecoveryReason::RendererGone)]
    );
    assert_eq!(s.calls(), ["recovery:renderer-gone", "reload"]);
}

#[test]
fn does_nothing_more_for_a_crash_of_a_destroyed_window() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    watch.render_process_gone("crashed", 139, true, &s.contents(true));
    assert_eq!(s.log.at("error").len(), 1);
    assert!(s.reports.seen.lock().is_empty());
    assert!(s.calls().is_empty());
}

#[test]
fn stops_reloading_a_window_that_crashes_more_than_three_times_a_minute() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    let contents = s.contents(false);
    for _ in 0..4 {
        watch.render_process_gone("crashed", 139, false, &contents);
    }
    let reloads = s.calls().iter().filter(|call| *call == "reload").count();
    assert_eq!(reloads, 3);
    assert_eq!(s.started.lock().len(), 4);
    assert_eq!(s.reports.seen.lock().len(), 4);
    let errors = s.log.at("error");
    assert_eq!(
        errors.last().unwrap(),
        &(
            "renderer-reload-skipped".to_owned(),
            json!({"window": WINDOW, "reason": "crash-loop"})
        )
    );
    s.now.store(60_000, Ordering::SeqCst);
    watch.render_process_gone("crashed", 139, false, &contents);
    assert_eq!(s.calls().iter().filter(|call| *call == "reload").count(), 4);
}

#[test]
fn starts_recovery_for_a_navigation_after_the_first_load_only() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    watch.did_start_navigation(true, false);
    assert!(s.started.lock().is_empty());
    watch.did_finish_load();
    watch.did_start_navigation(false, false);
    watch.did_start_navigation(true, true);
    assert!(s.started.lock().is_empty());
    watch.did_start_navigation(true, false);
    assert_eq!(*s.started.lock(), [(window(), RecoveryReason::Reload)]);
    assert_eq!(
        s.log.at("info").last().unwrap(),
        &("window-reload".to_owned(), json!({"window": WINDOW}))
    );
}

#[test]
fn logs_a_console_error_with_the_file_name_and_line_and_skips_other_levels() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    watch.console_message("warning", "careful", "/out/renderer/index-abc.js", 3);
    assert!(s.log.at("error").is_empty());
    watch.console_message("error", "boom", "/out/renderer/index-abc.js", 12);
    watch.console_message("error", "bare", "", 0);
    let errors = s.log.at("error");
    assert_eq!(
        errors[0],
        (
            "renderer-console-error".to_owned(),
            json!({"window": WINDOW, "message": "boom", "source": "index-abc.js:12"})
        )
    );
    assert_eq!(errors[1].1["message"], json!("bare"));
    assert!(errors[1].1.get("source").is_none_or(Value::is_null));
}

#[test]
fn logs_a_failed_load_and_a_window_that_stops_and_starts_answering() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    watch.did_fail_load(-105, "ERR_NAME_NOT_RESOLVED", true);
    watch.unresponsive();
    watch.responsive();
    assert_eq!(
        s.log.at("warn"),
        [
            (
                "did-fail-load".to_owned(),
                json!({"window": WINDOW, "code": -105, "description": "ERR_NAME_NOT_RESOLVED", "mainFrame": true})
            ),
            ("window-unresponsive".to_owned(), json!({"window": WINDOW})),
        ]
    );
    assert!(s.log.events().contains(&"window-responsive".to_owned()));
}

#[test]
fn gives_a_closed_window_a_fresh_report_allowance() {
    let s = setup();
    let watch = s.diagnostics.watch_window(&window());
    for _ in 0..21 {
        s.diagnostics.handle_report(&window(), &render_report());
    }
    assert_eq!(s.log.at("error").len(), 20);
    watch.closed();
    s.diagnostics.handle_report(&window(), &render_report());
    assert_eq!(s.log.at("error").len(), 21);
    assert!(s.log.at("warn").is_empty());
}
