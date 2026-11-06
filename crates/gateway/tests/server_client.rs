#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::Duration;

use chrono::{TimeZone, Utc};
use ostia_gateway::server_client::{RequestOptions, ServerClient, ServerError};
use serde_json::{Value, json};
use support::{MockServer, Reply, dead_origin, harness, harness_with_timeout, no_server_client};

fn served_at(hour: u32, minute: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 10, 21, hour, minute, 0)
        .unwrap()
        .timestamp_millis()
}

fn date_header(clock: &str) -> String {
    format!("Wed, 21 Oct 2026 {clock} GMT")
}

fn rate_limited(retry_after: &str) -> Reply {
    Reply::json(429, &json!({"error": "rate-limited"})).header("Retry-After", retry_after)
}

async fn failure(client: &ServerClient, path: &str, options: &RequestOptions) -> ServerError {
    client.request("GET", path, options).await.unwrap_err()
}

#[tokio::test]
async fn ssy_c166_reports_the_server_time_only_for_answers_that_ask_for_it_and_puts_it_on_a_failure()
 {
    let server = MockServer::start(vec![
        Reply::json(200, &json!({})).header("Date", &date_header("07:28:00")),
        Reply::json(200, &json!({})).header("Date", &date_header("07:29:00")),
        Reply::json(403, &json!({"error": "x"})).header("Date", &date_header("07:30:00")),
    ])
    .await;
    let harness = harness(&server.origin);
    let asks = RequestOptions {
        reports_time: true,
        ..Default::default()
    };
    harness
        .client
        .request("GET", "/v1/a", &RequestOptions::default())
        .await
        .unwrap();
    harness.client.request("GET", "/v1/b", &asks).await.unwrap();
    let error = failure(&harness.client, "/v1/c", &asks).await;
    assert_eq!(error.server_time, Some(served_at(7, 30)));
    assert_eq!(*harness.times.lock(), vec![served_at(7, 29)]);
}

#[tokio::test]
async fn sva_c12_sends_json_with_the_bearer_token_and_parses_the_answer() {
    let server = MockServer::start(vec![Reply::json(200, &json!({"ok": 1}))]).await;
    let harness = harness(&server.origin);
    let answer = harness
        .client
        .request(
            "POST",
            "/v1/x",
            &RequestOptions {
                body: Some(json!({"a": 1})),
                token: Some("t0".to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(answer, Some(json!({"ok": 1})));
    let seen = server.only_request();
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/x");
    assert_eq!(seen.text(), "{\"a\":1}");
    assert_eq!(seen.header("authorization"), Some("Bearer t0"));
    assert_eq!(seen.header("content-type"), Some("application/json"));
    assert_eq!(seen.header("accept"), Some("application/json"));
}

#[tokio::test]
async fn sva_c12_refuses_to_follow_a_redirect() {
    let server = MockServer::start(vec![
        Reply::empty(302).header("Location", "http://127.0.0.1:1/elsewhere"),
    ])
    .await;
    let harness = harness(&server.origin);
    let error = failure(&harness.client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!((error.status, error.code.as_str()), (0, "unreachable"));
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn sva_c13_answers_nothing_for_204() {
    let server = MockServer::start(vec![Reply::empty(204)]).await;
    let harness = harness(&server.origin);
    let answer = harness
        .client
        .request("DELETE", "/v1/x", &RequestOptions::default())
        .await
        .unwrap();
    assert_eq!(answer, None);
}

#[tokio::test]
async fn sva_c14_maps_an_error_body_to_a_server_error_with_status_and_code() {
    let server =
        MockServer::start(vec![Reply::json(403, &json!({"error": "invalid-invite"}))]).await;
    let harness = harness(&server.origin);
    let error = harness
        .client
        .request("POST", "/v1/x", &RequestOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.status, 403);
    assert_eq!(error.code, "invalid-invite");
    assert_eq!(error.to_string(), "403 invalid-invite");
}

#[tokio::test]
async fn sva_c15_maps_a_network_failure_to_status_0_unreachable() {
    let harness = harness(&dead_origin().await);
    let error = failure(&harness.client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!(error.status, 0);
    assert_eq!(error.code, "unreachable");
    assert_eq!(error.retry_after, None);
    assert_eq!(error.server_time, None);
}

#[tokio::test]
async fn sva_c16_waits_retry_after_once_for_a_short_429_and_retries() {
    let server = MockServer::start(vec![
        rate_limited("2"),
        Reply::json(200, &json!({"ok": true})),
    ])
    .await;
    let harness = harness(&server.origin);
    let answer = harness
        .client
        .request("GET", "/v1/x", &RequestOptions::default())
        .await
        .unwrap();
    assert_eq!(answer, Some(json!({"ok": true})));
    assert_eq!(*harness.pauses.lock(), vec![Duration::from_millis(2000)]);
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn sva_c17_reports_a_long_or_repeated_429_with_its_retry_after() {
    let long_server = MockServer::start(vec![rate_limited("60")]).await;
    let long = harness(&long_server.origin);
    let error = failure(&long.client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!(error.status, 429);
    assert_eq!(error.retry_after, Some(60.0));
    assert!(long.pauses.lock().is_empty());
    assert_eq!(long_server.requests().len(), 1);

    let twice_server = MockServer::start(vec![rate_limited("1")]).await;
    let repeated = harness(&twice_server.origin);
    let error = failure(&repeated.client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!(error.status, 429);
    assert_eq!(twice_server.requests().len(), 2);
}

#[tokio::test]
async fn sva_c18_has_no_server_to_ask_until_an_address_is_set() {
    let client = no_server_client();
    let error = failure(&client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!((error.status, error.code.as_str()), (0, "no-server"));
    assert_eq!(client.origin().unwrap_err().code, "no-server");
}

#[tokio::test]
async fn psh_c61_sends_nothing_twice_for_a_request_that_opted_out_of_the_429_retry_and_an_empty_ping_has_no_content_type()
 {
    let server = MockServer::start(vec![rate_limited("1")]).await;
    let harness = harness(&server.origin);
    let error = harness
        .client
        .request(
            "POST",
            "/v1/push/h",
            &RequestOptions {
                token: Some("t".to_owned()),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.status, 429);
    assert_eq!(error.retry_after, Some(1.0));
    assert_eq!(server.requests().len(), 1);
    assert!(harness.pauses.lock().is_empty());
    let seen = server.only_request();
    assert!(seen.body.is_empty());
    assert_eq!(seen.header("content-type"), None);
}

#[tokio::test]
async fn reports_unreachable_when_the_server_does_not_answer_within_the_timeout() {
    let server = MockServer::start(vec![Reply::hanging()]).await;
    let harness = harness_with_timeout(&server.origin, Duration::from_millis(150));
    let started = std::time::Instant::now();
    let error = failure(&harness.client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!((error.status, error.code.as_str()), (0, "unreachable"));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn sends_a_raw_json_string_or_bytes_with_their_content_types_and_bytes_win() {
    let server = MockServer::start(vec![Reply::empty(204)]).await;
    let harness = harness(&server.origin);
    let client = &harness.client;
    client
        .request(
            "PUT",
            "/v1/json",
            &RequestOptions {
                json: Some("{ \"raw\" : 1 }".to_owned()),
                body: Some(json!({"ignored": true})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    client
        .request(
            "PUT",
            "/v1/bytes",
            &RequestOptions {
                bytes: Some(vec![0, 255, 7]),
                json: Some("{}".to_owned()),
                body: Some(json!({})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    client
        .request(
            "POST",
            "/v1/null",
            &RequestOptions {
                body: Some(Value::Null),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let seen = server.requests();
    assert_eq!(seen[0].text(), "{ \"raw\" : 1 }");
    assert_eq!(seen[0].header("content-type"), Some("application/json"));
    assert_eq!(seen[1].body, vec![0, 255, 7]);
    assert_eq!(
        seen[1].header("content-type"),
        Some("application/octet-stream")
    );
    assert_eq!(seen[2].text(), "null");
    assert_eq!(seen[2].header("content-type"), Some("application/json"));
}

#[tokio::test]
async fn adds_the_caller_headers_and_no_authorization_for_an_empty_token() {
    let server = MockServer::start(vec![Reply::empty(204)]).await;
    let harness = harness(&server.origin);
    harness
        .client
        .request(
            "GET",
            "/v1/x",
            &RequestOptions {
                token: Some(String::new()),
                headers: support::headers_of(&[("If-Match", "3"), ("X-Device-Signature", "sig")]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let seen = server.only_request();
    assert_eq!(seen.header("if-match"), Some("3"));
    assert_eq!(seen.header("x-device-signature"), Some("sig"));
    assert_eq!(seen.header("authorization"), None);
}

#[tokio::test]
async fn returns_the_raw_bytes_of_an_answer_that_asked_for_bytes() {
    let server = MockServer::start(vec![Reply::raw(200, &[0, 1, 2, 255])]).await;
    let harness = harness(&server.origin);
    let bytes = harness
        .client
        .request_bytes("GET", "/v1/sync/blobs/b", &RequestOptions::default())
        .await
        .unwrap();
    assert_eq!(bytes, vec![0, 1, 2, 255]);
}

#[tokio::test]
async fn answers_nothing_for_an_empty_body_and_bad_response_for_text_that_is_not_json() {
    let server = MockServer::start(vec![Reply::raw(200, b""), Reply::raw(200, b"<html>")]).await;
    let harness = harness(&server.origin);
    let empty = harness
        .client
        .request("GET", "/v1/a", &RequestOptions::default())
        .await
        .unwrap();
    assert_eq!(empty, None);
    let error = failure(&harness.client, "/v1/b", &RequestOptions::default()).await;
    assert_eq!((error.status, error.code.as_str()), (200, "bad-response"));
}

#[tokio::test]
async fn names_a_failure_without_a_usable_body_failed_and_ignores_a_retry_after_that_is_not_positive()
 {
    let server = MockServer::start(vec![
        Reply::raw(500, b"<html>"),
        Reply::json(500, &json!({"error": 5})),
        Reply::json(503, &json!([1])),
        Reply::json(429, &json!({"error": "rate-limited"})).header("Retry-After", "0"),
        Reply::json(429, &json!({"error": "rate-limited"})).header("Retry-After", "-3"),
        Reply::json(429, &json!({"error": "rate-limited"})).header("Retry-After", "soon"),
        Reply::json(429, &json!({"error": "rate-limited"})).header("Retry-After", "1.5"),
    ])
    .await;
    let harness = harness(&server.origin);
    let options = RequestOptions::default();
    for (path, status) in [("/v1/a", 500), ("/v1/b", 500), ("/v1/c", 503)] {
        let error = failure(&harness.client, path, &options).await;
        assert_eq!(error.code, "failed", "{path}");
        assert_eq!(error.status, status, "{path}");
        assert_eq!(error.retry_after, None, "{path}");
    }
    for path in ["/v1/d", "/v1/e", "/v1/f"] {
        let error = failure(&harness.client, path, &options).await;
        assert_eq!(error.status, 429, "{path}");
        assert_eq!(error.retry_after, None, "{path}");
    }
    assert!(harness.pauses.lock().is_empty());
    let error = failure(&harness.client, "/v1/g", &options).await;
    assert_eq!(error.retry_after, Some(1.5));
    assert_eq!(*harness.pauses.lock(), vec![Duration::from_millis(1500)]);
}

#[tokio::test]
async fn retries_a_429_once_and_reports_the_failure_of_the_second_try() {
    let server = MockServer::start(vec![
        rate_limited("1"),
        Reply::json(500, &json!({"error": "boom"})),
    ])
    .await;
    let harness = harness(&server.origin);
    let error = failure(&harness.client, "/v1/x", &RequestOptions::default()).await;
    assert_eq!((error.status, error.code.as_str()), (500, "boom"));
    assert_eq!(server.requests().len(), 2);
}
