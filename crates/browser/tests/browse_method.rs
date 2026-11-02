#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_browser::browse_method::{
    CommandTarget, MAX_TIMEOUT_MS, ScratchPaths, clamp_timeout, command_target, fail, num_of,
    safe_out_path, str_of, wait_for, write_out,
};
use ostia_control::identity::{IdentityKind, PaneIdentity};
use ostia_diagnostics::app_log::{AppLog, LogFields};
use ostia_diagnostics::error_report::{ErrorSink, Thrown};
use ostia_testkit::temp_host;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::time::{Duration, Instant};

#[derive(Default)]
struct Warnings {
    seen: Mutex<Vec<(String, LogFields)>>,
}

impl AppLog for Warnings {
    fn info(&self, _event: &str, _fields: &LogFields) {}

    fn warn(&self, event: &str, fields: &LogFields) {
        self.seen.lock().push((event.to_owned(), fields.clone()));
    }

    fn error(&self, _event: &str, _fields: &LogFields) {}
}

fn sink() -> (ErrorSink, Arc<Warnings>) {
    let warnings = Arc::new(Warnings::default());
    let sink = ErrorSink::default();
    sink.set(Some(warnings.clone()));
    (sink, warnings)
}

fn thrown(name: &str) -> Thrown {
    Thrown::Error {
        name: name.to_owned(),
        code: None,
    }
}

#[test]
fn builds_a_failure_with_the_message_only_when_there_is_one() {
    assert_eq!(
        fail("timeout", None),
        json!({"ok": false, "error": "timeout"})
    );
    assert_eq!(
        fail("timeout", Some("page is slow")),
        json!({"ok": false, "error": "timeout", "message": "page is slow"})
    );
    assert_eq!(
        fail("timeout", Some("")),
        json!({"ok": false, "error": "timeout"})
    );
}

#[test]
fn keeps_the_order_ok_error_message_in_a_failure() {
    let text = fail("x", Some("why")).to_string();
    assert_eq!(text, r#"{"ok":false,"error":"x","message":"why"}"#);
}

#[test]
fn reads_a_parameter_as_text_only_when_it_is_a_string() {
    assert_eq!(str_of(&json!("a")), Some("a"));
    assert_eq!(str_of(&json!("")), Some(""));
    for value in [json!(1), json!(true), Value::Null, json!([]), json!({})] {
        assert_eq!(str_of(&value), None, "{value}");
    }
}

#[test]
fn reads_a_parameter_as_a_number_only_when_it_is_a_finite_number() {
    assert_eq!(num_of(&json!(5)), Some(5.0));
    assert_eq!(num_of(&json!(-1.5)), Some(-1.5));
    assert_eq!(num_of(&json!(0)), Some(0.0));
    for value in [json!("5"), json!(true), Value::Null, json!([5]), json!({})] {
        assert_eq!(num_of(&value), None, "{value}");
    }
}

#[test]
fn uses_25_seconds_when_the_timeout_is_missing_or_not_a_number() {
    for value in [Value::Null, json!("500"), json!(true), json!({})] {
        assert_eq!(clamp_timeout(&value), 25_000.0, "{value}");
    }
}

#[test]
fn keeps_a_timeout_inside_the_range_and_clamps_the_rest() {
    assert_eq!(clamp_timeout(&json!(500)), 500.0);
    assert_eq!(clamp_timeout(&json!(0)), 0.0);
    assert_eq!(clamp_timeout(&json!(1.5)), 1.5);
    assert_eq!(clamp_timeout(&json!(-10)), 0.0);
    assert_eq!(clamp_timeout(&json!(120_000)), 120_000.0);
    assert_eq!(clamp_timeout(&json!(999_999)), 120_000.0);
    assert_eq!(MAX_TIMEOUT_MS, 120_000.0);
}

#[test]
fn takes_the_command_target_from_the_pane_identity() {
    let identity = PaneIdentity {
        kind: IdentityKind::Pane,
        external_id: ExternalId::new("x1"),
        token: "secret".to_owned(),
        window_id: WindowId::new("w1"),
        workspace_id: WorkspaceId::new("ws1"),
        pane_id: PaneId::new("p1"),
        ext_id: None,
        manager: false,
    };
    assert_eq!(
        command_target(&identity),
        CommandTarget {
            window_id: Some(WindowId::new("w1")),
            workspace_id: WorkspaceId::new("ws1"),
            pane_id: Some(PaneId::new("p1")),
        }
    );
}

#[tokio::test(start_paused = true)]
async fn waits_for_nothing_when_the_check_passes_at_once() {
    let (errors, warnings) = sink();
    let start = Instant::now();
    let ok = wait_for(|| async { Ok(true) }, 2000.0, &errors).await;
    assert!(ok);
    assert_eq!(start.elapsed(), Duration::ZERO);
    assert!(warnings.seen.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn polls_every_100_milliseconds_until_the_check_passes() {
    let (errors, _warnings) = sink();
    let calls = AtomicUsize::new(0);
    let start = Instant::now();
    let ok = wait_for(
        || {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Ok(call >= 3) }
        },
        2000.0,
        &errors,
    )
    .await;
    assert!(ok);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(start.elapsed(), Duration::from_millis(200));
}

#[tokio::test(start_paused = true)]
async fn gives_up_with_false_after_the_deadline_and_reports_nothing_when_no_check_failed() {
    let (errors, warnings) = sink();
    let start = Instant::now();
    let ok = wait_for(|| async { Ok(false) }, 350.0, &errors).await;
    assert!(!ok);
    assert!(start.elapsed() >= Duration::from_millis(350));
    assert!(start.elapsed() <= Duration::from_millis(450));
    assert!(warnings.seen.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn runs_the_check_once_when_the_timeout_is_zero() {
    let (errors, _warnings) = sink();
    let calls = AtomicUsize::new(0);
    let ok = wait_for(
        || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(false) }
        },
        0.0,
        &errors,
    )
    .await;
    assert!(!ok);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn keeps_polling_through_a_failing_check_and_reports_nothing_once_it_passes() {
    let (errors, warnings) = sink();
    let calls = AtomicUsize::new(0);
    let ok = wait_for(
        || {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                if call < 3 {
                    Err(thrown("Error"))
                } else {
                    Ok(true)
                }
            }
        },
        2000.0,
        &errors,
    )
    .await;
    assert!(ok);
    assert!(warnings.seen.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn reports_the_last_failure_once_when_the_wait_times_out() {
    let (errors, warnings) = sink();
    let calls = AtomicUsize::new(0);
    let ok = wait_for(
        || {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                Err(if call == 1 {
                    thrown("TypeError")
                } else {
                    thrown("ReferenceError")
                })
            }
        },
        250.0,
        &errors,
    )
    .await;
    assert!(!ok);
    let seen = warnings.seen.lock();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "unexpected-error");
    assert_eq!(
        seen[0].1.to_json(),
        json!({"scope": "browseWait", "name": "ReferenceError"})
    );
}

#[tokio::test(start_paused = true)]
async fn reports_a_failure_at_the_deadline_also_when_later_checks_return_false() {
    let (errors, warnings) = sink();
    let calls = AtomicUsize::new(0);
    let ok = wait_for(
        || {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                if call == 1 {
                    Err(thrown("Error"))
                } else {
                    Ok(false)
                }
            }
        },
        250.0,
        &errors,
    )
    .await;
    assert!(!ok);
    let seen = warnings.seen.lock();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].1.to_json(),
        json!({"scope": "browseWait", "name": "Error"})
    );
}

#[tokio::test(start_paused = true)]
async fn reports_the_failure_and_gives_up_when_the_timeout_is_zero() {
    let (errors, warnings) = sink();
    let ok = wait_for(|| async { Err(thrown("ReferenceError")) }, 0.0, &errors).await;
    assert!(!ok);
    assert_eq!(warnings.seen.lock().len(), 1);
}

fn roots(list: &[&str]) -> Vec<String> {
    list.iter().map(|root| (*root).to_owned()).collect()
}

#[test]
fn accepts_a_screenshot_path_inside_one_of_the_roots() {
    let (_dir, host) = temp_host().unwrap();
    let root = host.home.join("shots");
    let inside = root.join("a.png");
    let configured = roots(&[root.to_str().unwrap()]);
    assert_eq!(
        safe_out_path(&configured, inside.to_str().unwrap(), &host),
        Some(inside)
    );
}

#[test]
fn refuses_a_screenshot_path_outside_every_root_or_when_there_is_no_root() {
    let (_dir, host) = temp_host().unwrap();
    let root = host.home.join("shots");
    let configured = roots(&[root.to_str().unwrap()]);
    let outside = host.home.join("other/a.png");
    assert_eq!(
        safe_out_path(&configured, outside.to_str().unwrap(), &host),
        None
    );
    assert_eq!(
        safe_out_path(&[], root.join("a.png").to_str().unwrap(), &host),
        None
    );
}

#[test]
fn refuses_a_screenshot_path_that_climbs_out_of_the_root() {
    let (_dir, host) = temp_host().unwrap();
    let root = host.home.join("shots");
    let configured = roots(&[root.to_str().unwrap()]);
    let climbing = format!("{}/../secret.png", root.display());
    assert_eq!(safe_out_path(&configured, &climbing, &host), None);
}

#[test]
fn expands_home_and_resolves_a_relative_path_before_it_checks_the_roots() {
    let (_dir, host) = temp_host().unwrap();
    let configured = roots(&["~/shots", "out"]);
    assert_eq!(
        safe_out_path(&configured, "~/shots/a.png", &host),
        Some(host.home.join("shots/a.png"))
    );
    assert_eq!(
        safe_out_path(&configured, "out/b.png", &host),
        Some(host.cwd.join("out/b.png"))
    );
}

#[test]
fn makes_scratch_paths_in_the_private_screens_folder_with_a_running_number() {
    let (_dir, host) = temp_host().unwrap();
    let paths = ScratchPaths::new(host, Arc::new(|| 1000));
    let first = paths.path("shot", "png").unwrap();
    let second = paths.path("shot", "png").unwrap();
    let third = paths.path("clip", "webm").unwrap();
    assert_eq!(first.file_name().unwrap(), "shot-1000-1.png");
    assert_eq!(second.file_name().unwrap(), "shot-1000-2.png");
    assert_eq!(third.file_name().unwrap(), "clip-1000-3.webm");
    let folder = first.parent().unwrap();
    assert!(
        folder
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("ostia-screens-")
    );
    assert_eq!(second.parent().unwrap(), folder);
    assert_eq!(third.parent().unwrap(), folder);
}

#[test]
fn creates_the_scratch_folder_private_to_the_user() {
    let (_dir, host) = temp_host().unwrap();
    let paths = ScratchPaths::new(host, Arc::new(|| 5));
    let path = paths.path("shot", "png").unwrap();
    let mode = std::fs::metadata(path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0);
}

#[test]
fn counts_scratch_paths_for_each_service_apart() {
    let (_dir, host) = temp_host().unwrap();
    let one = ScratchPaths::new(host.clone(), Arc::new(|| 1));
    let two = ScratchPaths::new(host, Arc::new(|| 1));
    assert_eq!(
        one.path("a", "png").unwrap().file_name().unwrap(),
        "a-1-1.png"
    );
    assert_eq!(
        two.path("a", "png").unwrap().file_name().unwrap(),
        "a-1-1.png"
    );
}

#[test]
fn writes_the_file_and_makes_the_missing_folders() {
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("a/b/c.png");
    write_out(&path, b"bytes").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"bytes");
}

#[test]
fn replaces_the_content_of_a_file_that_exists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.txt");
    write_out(&path, b"long first text").unwrap();
    write_out(&path, b"short").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"short");
}

#[test]
fn fails_when_a_part_of_the_folder_path_is_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    std::fs::write(&blocker, b"x").unwrap();
    assert!(write_out(&blocker.join("sub/c.png"), b"x").is_err());
}
