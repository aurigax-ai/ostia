#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use common::{Harness, batch_events, boom, only, settle};
use ostia_diagnostics::app_log::LogFields;
use ostia_diagnostics::privacy_telemetry::{
    TELEMETRY_BATCH_MAX, TELEMETRY_QUEUE_MAX, TELEMETRY_SENT_MAX, TelemetryCategory,
};
use ostia_diagnostics::telemetry_queue::{new_install_id, parse_stored};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};

const INSTALL_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

fn queued(uuid: &str) -> Value {
    json!({"report": {"uuid": uuid, "event": "$exception"}, "attempts": 0})
}

type Lines = Arc<Mutex<Vec<(String, Value)>>>;
type Sink = Arc<dyn Fn(&str, &LogFields) + Send + Sync>;

fn recorded() -> (Lines, Sink) {
    let lines: Lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    (
        lines,
        Arc::new(move |event: &str, fields: &LogFields| {
            sink.lock().push((event.to_owned(), fields.to_json()));
        }),
    )
}

#[test]
fn makes_an_install_id_in_the_uuid_shape() {
    assert!(
        Regex::new("^[0-9a-f-]{36}$")
            .unwrap()
            .is_match(&new_install_id())
    );
    assert_ne!(new_install_id(), new_install_id());
}

#[test]
fn keeps_a_valid_install_id_and_makes_a_new_one_for_a_bad_id() {
    assert_eq!(
        parse_stored(&json!({"installId": INSTALL_ID})).install_id,
        INSTALL_ID
    );
    let uuid_shape = Regex::new("^[0-9a-f-]{36}$").unwrap();
    for raw in [
        json!({"installId": "short"}),
        json!({"installId": 7}),
        json!({}),
        json!(null),
        json!("text"),
    ] {
        let id = parse_stored(&raw).install_id;
        assert!(uuid_shape.is_match(&id), "{raw}");
        assert_ne!(id, INSTALL_ID);
    }
}

#[test]
fn keeps_only_queue_entries_with_a_numeric_attempt_count_an_object_report_and_a_string_uuid() {
    let stored = parse_stored(&json!({
        "installId": INSTALL_ID,
        "queue": [
            queued("a"),
            {"report": null, "attempts": 0},
            {"report": {"event": "$exception"}, "attempts": 0},
            {"report": {"uuid": "b"}, "attempts": "1"},
            {"report": {"uuid": 5}, "attempts": 1},
            "text",
            null,
            queued("c"),
        ],
    }));
    let uuids: Vec<&str> = stored
        .queue
        .iter()
        .map(|entry| entry.report["uuid"].as_str().unwrap())
        .collect();
    assert_eq!(uuids, ["a", "c"]);
}

#[test]
fn keeps_the_last_fifty_queue_entries_and_the_last_twenty_sent_reports() {
    let queue: Vec<Value> = (0..TELEMETRY_QUEUE_MAX + 7)
        .map(|i| queued(&format!("q{i}")))
        .collect();
    let sent: Vec<Value> = (0..TELEMETRY_SENT_MAX + 7)
        .map(|i| json!({"uuid": format!("s{i}")}))
        .collect();
    let stored = parse_stored(&json!({"installId": INSTALL_ID, "queue": queue, "sent": sent}));
    assert_eq!(stored.queue.len(), TELEMETRY_QUEUE_MAX);
    assert_eq!(stored.queue[0].report["uuid"], json!("q7"));
    assert_eq!(stored.sent.len(), TELEMETRY_SENT_MAX);
    assert_eq!(stored.sent[0]["uuid"], json!("s7"));
}

#[test]
fn drops_a_sent_report_without_a_string_uuid() {
    let stored = parse_stored(&json!({
        "installId": INSTALL_ID,
        "sent": [null, {"uuid": 3}, {"event": "usage"}, {"uuid": "ok"}],
    }));
    assert_eq!(stored.sent, [json!({"uuid": "ok"})]);
}

#[test]
fn keeps_the_consent_answer_and_only_the_categories_it_knows() {
    let stored = parse_stored(&json!({
        "installId": INSTALL_ID,
        "asked": true,
        "answeredAt": "2026-10-18T10:00:00.000Z",
        "seen": ["errors", "nope", 3, "terminal"],
    }));
    assert!(stored.asked);
    assert_eq!(
        stored.answered_at.as_deref(),
        Some("2026-10-18T10:00:00.000Z")
    );
    assert_eq!(
        stored.seen,
        [TelemetryCategory::Errors, TelemetryCategory::Terminal]
    );
    let loose = parse_stored(&json!({"installId": INSTALL_ID, "asked": "yes", "answeredAt": 5}));
    assert!(!loose.asked);
    assert_eq!(loose.answered_at, None);
    assert!(loose.seen.is_empty());
}

#[tokio::test]
async fn logs_when_the_file_cannot_be_saved() {
    let mut h = Harness::new(only(&[TelemetryCategory::Errors]));
    let blocker = h.dir.path().join("blocker");
    fs::write(&blocker, "a file, not a folder").unwrap();
    h.file = blocker.join("telemetry.json");
    let (lines, log) = recorded();
    let t = h.create_with(|deps| deps.log = Some(log));
    t.error(boom());
    assert!(
        lines
            .lock()
            .iter()
            .any(|(event, _)| event == "telemetry-unsaved")
    );
    assert_eq!(t.reports().queued.len(), 1);
}

#[tokio::test]
async fn logs_how_many_reports_were_sent_and_marks_them_sent() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let (lines, log) = recorded();
    let t = h.create_with(|deps| deps.log = Some(log));
    t.error(boom());
    t.error(boom());
    t.flush().await;
    assert_eq!(
        *lines.lock(),
        [("telemetry-sent".to_owned(), json!({"reports": 2}))]
    );
    assert_eq!(t.reports().sent.len(), 2);
    assert_eq!(h.file_json()["sent"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn counts_a_failed_attempt_and_logs_it_for_a_refusal_a_redirect_and_no_answer() {
    for status in [Some(500), Some(302), Some(199), None] {
        let h = Harness::new(only(&[TelemetryCategory::Errors]));
        h.respond_with(status);
        let (lines, log) = recorded();
        let t = h.create_with(|deps| deps.log = Some(log));
        t.error(boom());
        t.flush().await;
        assert_eq!(t.reports().queued.len(), 1, "{status:?}");
        assert!(t.reports().sent.is_empty(), "{status:?}");
        assert_eq!(
            h.file_json()["queue"][0]["attempts"],
            json!(1),
            "{status:?}"
        );
        assert_eq!(
            *lines.lock(),
            [("telemetry-send-failed".to_owned(), json!({"reports": 1}))],
            "{status:?}"
        );
    }
}

#[tokio::test]
async fn takes_any_two_hundred_series_status_as_sent() {
    for status in [200, 201, 204, 299] {
        let h = Harness::new(only(&[TelemetryCategory::Errors]));
        h.respond_with(Some(status));
        let t = h.create();
        t.error(boom());
        t.flush().await;
        assert!(t.reports().queued.is_empty(), "{status}");
    }
}

#[tokio::test]
async fn sends_at_most_one_batch_of_twenty_in_a_request_and_keeps_the_rest() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create();
    for _ in 0..TELEMETRY_BATCH_MAX + 5 {
        t.error(boom());
    }
    t.flush().await;
    assert_eq!(h.sent_count(), 1);
    assert_eq!(
        batch_events(&h.sent.lock()[0].body).len(),
        TELEMETRY_BATCH_MAX
    );
    assert_eq!(t.reports().queued.len(), 5);
    assert_eq!(t.reports().sent.len(), TELEMETRY_BATCH_MAX);
}

#[tokio::test(start_paused = true)]
async fn sends_the_rest_when_the_pending_flush_timer_fires_after_a_good_batch() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create();
    for _ in 0..TELEMETRY_BATCH_MAX + 5 {
        t.error(boom());
    }
    t.flush().await;
    tokio::time::sleep(Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(h.sent_count(), 1);
    assert_eq!(t.reports().queued.len(), 5);
    tokio::time::advance(common::FAR).await;
    settle().await;
    assert_eq!(h.sent_count(), 2);
    assert!(t.reports().queued.is_empty());
}

#[tokio::test(start_paused = true)]
async fn sends_a_queued_report_after_the_flush_delay() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create_with(|deps| deps.flush_delay = Duration::from_secs(5));
    t.error(boom());
    tokio::time::advance(Duration::from_millis(4900)).await;
    settle().await;
    assert_eq!(h.sent_count(), 0);
    tokio::time::advance(Duration::from_millis(200)).await;
    settle().await;
    assert_eq!(h.sent_count(), 1);
    assert!(t.reports().queued.is_empty());
}

#[tokio::test(start_paused = true)]
async fn tries_again_after_the_retry_delay_when_a_send_failed() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    h.respond_with(Some(500));
    let t = h.create_with(|deps| deps.retry_delay = Duration::from_secs(60));
    t.error(boom());
    t.flush().await;
    assert_eq!(h.sent_count(), 1);
    tokio::time::advance(Duration::from_secs(59)).await;
    settle().await;
    assert_eq!(h.sent_count(), 1);
    tokio::time::advance(Duration::from_secs(2)).await;
    settle().await;
    assert_eq!(h.sent_count(), 2);
}

#[tokio::test(start_paused = true)]
async fn schedules_no_flush_after_shutdown() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create_with(|deps| deps.flush_delay = Duration::from_secs(5));
    t.shutdown().await;
    t.error(boom());
    tokio::time::advance(Duration::from_secs(30)).await;
    settle().await;
    assert_eq!(h.sent_count(), 0);
    assert_eq!(t.reports().queued.len(), 1);
}
