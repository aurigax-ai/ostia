#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::pending;
use std::time::Duration;

use ostia_extensions::extension_runtime::{
    REQUEST_TIMEOUT_MS, cancelled, fail, normalize_result, with_timeout,
};
use serde_json::{Value, json};
use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;

fn text(value: &Value) -> String {
    value.to_string()
}

#[test]
fn waits_thirty_seconds_for_a_request() {
    assert_eq!(REQUEST_TIMEOUT_MS, 30_000);
}

#[test]
fn fails_with_the_error_and_adds_the_message_only_when_it_is_not_empty() {
    assert_eq!(text(&fail("busy", None)), r#"{"ok":false,"error":"busy"}"#);
    assert_eq!(
        text(&fail("busy", Some("try later"))),
        r#"{"ok":false,"error":"busy","message":"try later"}"#
    );
    assert_eq!(
        text(&fail("busy", Some(""))),
        r#"{"ok":false,"error":"busy"}"#
    );
}

#[test]
fn turns_a_plain_return_value_into_an_ok_result() {
    let rows = [
        (Value::Null, json!({"ok": true})),
        (json!(5), json!({"ok": true, "data": 5})),
        (json!("done"), json!({"ok": true, "data": "done"})),
        (json!(false), json!({"ok": true, "data": false})),
        (json!([1, 2]), json!({"ok": true, "data": [1, 2]})),
        (json!({"rows": 3}), json!({"ok": true, "data": {"rows": 3}})),
        (
            json!({"ok": "yes", "text": "t"}),
            json!({"ok": true, "data": {"ok": "yes", "text": "t"}}),
        ),
        (json!({"ok": 1}), json!({"ok": true, "data": {"ok": 1}})),
    ];
    for (raw, expected) in rows {
        assert_eq!(normalize_result(&raw), expected, "raw {raw}");
    }
}

#[test]
fn keeps_only_text_and_data_of_a_success_and_in_that_order() {
    let rows = [
        (json!({"ok": true}), r#"{"ok":true}"#),
        (
            json!({"ok": true, "text": "hi"}),
            r#"{"ok":true,"text":"hi"}"#,
        ),
        (
            json!({"ok": true, "data": {"a": 1}, "text": "hi"}),
            r#"{"ok":true,"text":"hi","data":{"a":1}}"#,
        ),
        (json!({"ok": true, "text": 7}), r#"{"ok":true}"#),
        (json!({"ok": true, "text": ""}), r#"{"ok":true,"text":""}"#),
        (
            json!({"ok": true, "data": null}),
            r#"{"ok":true,"data":null}"#,
        ),
        (
            json!({"ok": true, "error": "x", "message": "m", "extra": 1}),
            r#"{"ok":true}"#,
        ),
    ];
    for (raw, expected) in rows {
        assert_eq!(text(&normalize_result(&raw)), expected, "raw {raw}");
    }
}

#[test]
fn keeps_the_error_message_and_data_of_a_failure() {
    let rows = [
        (json!({"ok": false}), r#"{"ok":false,"error":"failed"}"#),
        (
            json!({"ok": false, "error": "busy"}),
            r#"{"ok":false,"error":"busy"}"#,
        ),
        (
            json!({"ok": false, "error": 7, "message": "m"}),
            r#"{"ok":false,"error":"failed","message":"m"}"#,
        ),
        (
            json!({"ok": false, "error": "busy", "message": 7}),
            r#"{"ok":false,"error":"busy"}"#,
        ),
        (
            json!({"ok": false, "error": "busy", "message": ""}),
            r#"{"ok":false,"error":"busy"}"#,
        ),
        (
            json!({"data": [1], "ok": false, "error": "busy", "message": "m"}),
            r#"{"ok":false,"error":"busy","message":"m","data":[1]}"#,
        ),
        (
            json!({"ok": false, "error": "busy", "data": null}),
            r#"{"ok":false,"error":"busy","data":null}"#,
        ),
        (
            json!({"ok": false, "text": "ignored", "extra": 1}),
            r#"{"ok":false,"error":"failed"}"#,
        ),
    ];
    for (raw, expected) in rows {
        assert_eq!(text(&normalize_result(&raw)), expected, "raw {raw}");
    }
}

#[tokio::test(start_paused = true)]
async fn returns_the_value_of_a_call_that_finishes_before_the_timeout() {
    let done = with_timeout(async { 7 }, 1000, "request").await;
    assert_eq!(done.unwrap(), 7);
    let slow = with_timeout(
        async {
            tokio::time::sleep(Duration::from_millis(900)).await;
            "late"
        },
        1000,
        "request",
    )
    .await;
    assert_eq!(slow.unwrap(), "late");
}

#[tokio::test(start_paused = true)]
async fn gives_up_with_what_timed_out_when_the_call_never_returns() {
    let start = Instant::now();
    let error = with_timeout(pending::<()>(), 1000, "activate demo")
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "activate demo timed out");
    assert_eq!(start.elapsed(), Duration::from_millis(1000));
}

#[tokio::test(start_paused = true)]
async fn gives_up_when_the_call_finishes_one_tick_after_the_timeout() {
    let late = with_timeout(
        async {
            tokio::time::sleep(Duration::from_millis(1001)).await;
            1
        },
        1000,
        "request",
    )
    .await;
    assert_eq!(late.unwrap_err().to_string(), "request timed out");
}

#[tokio::test(start_paused = true)]
async fn starts_the_timer_at_the_call_and_not_at_the_first_poll() {
    let start = Instant::now();
    let waiting = with_timeout(pending::<()>(), 1000, "request");
    tokio::time::advance(Duration::from_millis(900)).await;
    waiting.await.unwrap_err();
    assert_eq!(start.elapsed(), Duration::from_millis(1000));
}

#[tokio::test(start_paused = true)]
async fn never_resolves_without_a_token() {
    let waiting = timeout(Duration::from_secs(3600), cancelled(None)).await;
    assert!(waiting.is_err());
}

#[tokio::test(start_paused = true)]
async fn resolves_at_once_for_a_token_that_is_already_cancelled() {
    let token = CancellationToken::new();
    token.cancel();
    let start = Instant::now();
    timeout(Duration::from_secs(3600), cancelled(Some(&token)))
        .await
        .unwrap();
    assert_eq!(start.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn resolves_when_the_token_is_cancelled_later() {
    let token = CancellationToken::new();
    let waiting = tokio::spawn({
        let token = token.clone();
        async move { cancelled(Some(&token)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiting.is_finished());
    token.cancel();
    timeout(Duration::from_secs(1), waiting)
        .await
        .unwrap()
        .unwrap();
}
