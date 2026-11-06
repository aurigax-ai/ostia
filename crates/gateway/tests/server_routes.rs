#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fmt::Debug;
use std::future::Future;

use ostia_gateway::device_keys::Registration;
use ostia_gateway::server_client::ServerError;
use ostia_gateway::server_routes::{
    CreateShareBody, DeleteShareAuth, GithubPolled, ServerRoutes, ShareMode, WrapSlot,
};
use serde_json::json;
use support::{Harness, MockServer, Recorded, Reply, harness, headers_of};

fn rate_limited() -> Reply {
    Reply::json(429, &json!({"error": "rate-limited"})).header("Retry-After", "1")
}

fn registration() -> Registration {
    Registration {
        sign_pub: "sp".to_owned(),
        box_pub: "bp".to_owned(),
        proof: "pr".to_owned(),
    }
}

async fn route<T, Fut>(reply: Reply, run: impl FnOnce(ServerRoutes) -> Fut) -> (Recorded, Harness)
where
    T: Debug,
    Fut: Future<Output = Result<T, ServerError>>,
{
    let server = MockServer::start(vec![reply]).await;
    let harness = harness(&server.origin);
    run(ServerRoutes::new(harness.client.clone()))
        .await
        .unwrap();
    (server.only_request(), harness)
}

async fn refused_once<T, Fut>(run: impl FnOnce(ServerRoutes) -> Fut) -> Recorded
where
    T: Debug,
    Fut: Future<Output = Result<T, ServerError>>,
{
    let server = MockServer::start(vec![rate_limited()]).await;
    let harness = harness(&server.origin);
    let error = run(ServerRoutes::new(harness.client.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.status, 429);
    assert!(harness.pauses.lock().is_empty());
    server.only_request()
}

fn signed() -> std::collections::BTreeMap<String, String> {
    headers_of(&[("X-Device-Signature", "sig")])
}

#[tokio::test]
async fn sya_c150_asks_once_to_replace_the_key_with_the_version_read_in_if_match_and_the_signed_headers()
 {
    let seen = refused_once(|routes| async move {
        routes
            .rotate("token", "{\"manifest\":\"m\"}", "3", &signed())
            .await
    })
    .await;
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/sync/rotate");
    assert_eq!(seen.text(), "{\"manifest\":\"m\"}");
    assert_eq!(seen.header("if-match"), Some("3"));
    assert_eq!(seen.header("x-device-signature"), Some("sig"));
    assert_eq!(seen.header("authorization"), Some("Bearer token"));
    assert_eq!(seen.header("content-type"), Some("application/json"));
}

#[tokio::test]
async fn sya_c151_asks_once_to_clean_up_with_the_manifest_version_in_if_match_and_the_signed_headers()
 {
    let seen = refused_once(|routes| async move {
        routes
            .gc("token", "{\"keep\":[\"a\"]}", "4", &signed())
            .await
    })
    .await;
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/sync/gc");
    assert_eq!(seen.text(), "{\"keep\":[\"a\"]}");
    assert_eq!(seen.header("if-match"), Some("4"));
    assert_eq!(seen.header("x-device-signature"), Some("sig"));
}

#[tokio::test]
async fn sya_c152_checks_in_once_without_retrying_a_rate_limit() {
    let seen = refused_once(|routes| async move { routes.heartbeat("token").await }).await;
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/devices/heartbeat");
    assert_eq!(seen.header("authorization"), Some("Bearer token"));
    assert!(seen.body.is_empty());
}

#[tokio::test]
async fn does_not_retry_a_rate_limit_for_the_manifest_push_the_wrap_read_and_the_push_ping() {
    let put = refused_once(|routes| async move {
        routes
            .put_manifest("token", "{\"blob\":\"b\"}", "3", &signed())
            .await
    })
    .await;
    assert_eq!(
        (put.method.as_str(), put.path.as_str()),
        ("PUT", "/v1/sync/manifest")
    );
    assert_eq!(put.header("if-match"), Some("3"));
    assert_eq!(put.header("x-device-signature"), Some("sig"));

    let wrap = refused_once(|routes| async move {
        routes
            .secret_wrap(
                "token",
                WrapSlot::Recovery,
                &headers_of(&[("X-Device-Stamp", "9")]),
            )
            .await
    })
    .await;
    assert_eq!(
        (wrap.method.as_str(), wrap.path.as_str()),
        ("GET", "/v1/sync/wraps/recovery")
    );
    assert_eq!(wrap.header("x-device-stamp"), Some("9"));

    let ping = refused_once(|routes| async move { routes.push_ping("token", "h 1").await }).await;
    assert_eq!(
        (ping.method.as_str(), ping.path.as_str()),
        ("POST", "/v1/push/h%201")
    );
}

#[tokio::test]
async fn retries_a_short_rate_limit_once_for_the_routes_that_did_not_opt_out() {
    let server = MockServer::start(vec![
        rate_limited(),
        Reply::json(200, &json!({"ticket": "t", "expiresAt": 1})),
    ])
    .await;
    let harness = harness(&server.origin);
    ServerRoutes::new(harness.client.clone())
        .push_ticket("token")
        .await
        .unwrap();
    assert_eq!(server.requests().len(), 2);
    assert_eq!(harness.pauses.lock().len(), 1);
}

#[tokio::test]
async fn asks_for_the_server_info_without_a_token() {
    let (seen, _) = route(
        Reply::json(
            200,
            &json!({
                "api": 1,
                "modules": {"relay": true, "publish": false, "sync": true, "push": true},
                "auth": {"invite": true, "github": false},
                "relayDomain": "r.example"
            }),
        ),
        |routes| async move { routes.info().await },
    )
    .await;
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("GET", "/v1/info")
    );
    assert_eq!(seen.header("authorization"), None);
    assert!(seen.body.is_empty());
}

#[tokio::test]
async fn registers_with_an_invite_by_posting_the_code_name_and_registration_and_reports_the_server_time()
 {
    let (seen, harness) = route(
        Reply::json(
            200,
            &json!({"accountId": "a", "deviceId": "d", "provider": "invite"}),
        )
        .header("Date", "Wed, 21 Oct 2026 07:29:00 GMT"),
        |routes| async move {
            routes
                .register_with_invite("code1", "My laptop", &registration())
                .await
        },
    )
    .await;
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("POST", "/v1/auth/invite")
    );
    assert_eq!(
        seen.text(),
        "{\"code\":\"code1\",\"name\":\"My laptop\",\"signPub\":\"sp\",\"boxPub\":\"bp\",\"proof\":\"pr\"}"
    );
    assert_eq!(harness.times.lock().len(), 1);
}

#[tokio::test]
async fn starts_the_github_flow_with_no_body() {
    let (seen, _) = route(
        Reply::json(
            200,
            &json!({
                "flowId": "f",
                "userCode": "ABCD-1234",
                "verificationUri": "https://github.com/login/device",
                "interval": 5,
                "expiresIn": 900
            }),
        ),
        |routes| async move { routes.github_device().await },
    )
    .await;
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("POST", "/v1/auth/github/device")
    );
    assert!(seen.body.is_empty());
    assert_eq!(seen.header("content-type"), None);
}

#[tokio::test]
async fn answers_a_pending_poll_as_it_is_and_marks_a_registered_device_with_its_status() {
    let server = MockServer::start(vec![
        Reply::json(200, &json!({"status": "pending", "interval": 7}))
            .header("Date", "Wed, 21 Oct 2026 07:29:00 GMT"),
        Reply::json(
            200,
            &json!({"accountId": "a", "deviceId": "d", "provider": "github"}),
        ),
    ])
    .await;
    let harness = harness(&server.origin);
    let routes = ServerRoutes::new(harness.client.clone());

    let pending = routes
        .github_poll("flow", "My laptop", &registration())
        .await
        .unwrap();
    assert!(
        matches!(pending, GithubPolled::Pending { interval: 7 }),
        "{pending:?}"
    );
    let registered = routes
        .github_poll("flow", "My laptop", &registration())
        .await
        .unwrap();
    match registered {
        GithubPolled::Registered(device) => {
            assert_eq!(device.account_id, "a");
            assert_eq!(device.device_id, "d");
            assert_eq!(device.provider, "github");
        }
        other => panic!("{other:?}"),
    }

    let seen = server.requests();
    assert_eq!(seen[0].path, "/v1/auth/github/poll");
    assert_eq!(
        seen[0].text(),
        "{\"flowId\":\"flow\",\"name\":\"My laptop\",\"signPub\":\"sp\",\"boxPub\":\"bp\",\"proof\":\"pr\"}"
    );
    assert_eq!(harness.times.lock().len(), 2);
}

#[tokio::test]
async fn posts_the_challenge_and_the_signed_verification_and_reports_the_time_of_the_verification()
{
    let (challenge, harness) = route(
        Reply::json(200, &json!({"nonce": "n"})).header("Date", "Wed, 21 Oct 2026 07:29:00 GMT"),
        |routes| async move { routes.challenge("dev").await },
    )
    .await;
    assert_eq!(challenge.path, "/v1/auth/challenge");
    assert_eq!(challenge.text(), "{\"deviceId\":\"dev\"}");
    assert!(harness.times.lock().is_empty());

    let (verify, harness) = route(
        Reply::json(
            200,
            &json!({"token": "t", "expiresAt": 5, "accountId": "a"}),
        )
        .header("Date", "Wed, 21 Oct 2026 07:29:00 GMT"),
        |routes| async move { routes.verify("dev", "n", "sig").await },
    )
    .await;
    assert_eq!(verify.path, "/v1/auth/verify");
    assert_eq!(
        verify.text(),
        "{\"deviceId\":\"dev\",\"nonce\":\"n\",\"sig\":\"sig\"}"
    );
    assert_eq!(harness.times.lock().len(), 1);
}

#[tokio::test]
async fn ends_a_session_with_delete_and_the_bearer_token() {
    let (seen, _) = route(Reply::empty(204), |routes| async move {
        routes.end_session("token").await
    })
    .await;
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("DELETE", "/v1/auth/session")
    );
    assert_eq!(seen.header("authorization"), Some("Bearer token"));
}

#[tokio::test]
async fn reads_the_manifest_and_a_blob_and_writes_a_blob_as_octet_stream() {
    let (manifest, _) = route(
        Reply::json(
            200,
            &json!({"version": 1, "keyVersion": 1, "blob": "b", "updatedAt": 2}),
        ),
        |routes| async move { routes.manifest("token").await },
    )
    .await;
    assert_eq!(
        (manifest.method.as_str(), manifest.path.as_str()),
        ("GET", "/v1/sync/manifest")
    );

    let server = MockServer::start(vec![Reply::raw(200, &[9, 8, 0, 255])]).await;
    let harness = harness(&server.origin);
    let bytes = ServerRoutes::new(harness.client.clone())
        .blob("token", "blob1")
        .await
        .unwrap();
    assert_eq!(bytes, vec![9, 8, 0, 255]);
    assert_eq!(server.only_request().path, "/v1/sync/blobs/blob1");

    let (put, _) = route(Reply::empty(204), |routes| async move {
        routes.put_blob("token", "blob1", &[1, 2, 3]).await
    })
    .await;
    assert_eq!(
        (put.method.as_str(), put.path.as_str()),
        ("PUT", "/v1/sync/blobs/blob1")
    );
    assert_eq!(put.body, vec![1, 2, 3]);
    assert_eq!(put.header("content-type"), Some("application/octet-stream"));
}

#[tokio::test]
async fn creates_a_share_with_the_body_in_ts_order_and_leaves_out_a_missing_salt() {
    let created = json!({
        "id": "i", "url": "u", "uploadUrl": "/v1/shares/i/upload", "deleteToken": "d", "expiresAt": 3
    });
    let (plain, _) = route(Reply::json(200, &created), |routes| async move {
        routes
            .create_share(
                "token",
                &CreateShareBody {
                    mode: ShareMode::Link,
                    size: 10,
                    expires_in_seconds: 60,
                    salt: None,
                },
            )
            .await
    })
    .await;
    assert_eq!(
        (plain.method.as_str(), plain.path.as_str()),
        ("POST", "/v1/shares")
    );
    assert_eq!(
        plain.text(),
        "{\"mode\":\"link\",\"size\":10,\"expiresInSeconds\":60}"
    );

    let (salted, _) = route(Reply::json(200, &created), |routes| async move {
        routes
            .create_share(
                "token",
                &CreateShareBody {
                    mode: ShareMode::Password,
                    size: 10,
                    expires_in_seconds: 60,
                    salt: Some("s".to_owned()),
                },
            )
            .await
    })
    .await;
    assert_eq!(
        salted.text(),
        "{\"mode\":\"password\",\"size\":10,\"expiresInSeconds\":60,\"salt\":\"s\"}"
    );
}

#[tokio::test]
async fn uploads_to_the_given_path_and_lists_the_shares() {
    let (upload, _) = route(Reply::empty(204), |routes| async move {
        routes
            .upload_share("token", "/v1/shares/i/upload", &[4, 5])
            .await
    })
    .await;
    assert_eq!(
        (upload.method.as_str(), upload.path.as_str()),
        ("PUT", "/v1/shares/i/upload")
    );
    assert_eq!(upload.body, vec![4, 5]);

    let (list, _) = route(
        Reply::json(
            200,
            &json!({"shares": [{
                "id": "i", "url": "u", "mode": "public", "size": 1, "views": 0,
                "createdAt": 1, "expiresAt": 2, "uploaded": true
            }]}),
        ),
        |routes| async move { routes.shares("token").await },
    )
    .await;
    assert_eq!(
        (list.method.as_str(), list.path.as_str()),
        ("GET", "/v1/shares")
    );
}

#[tokio::test]
async fn deletes_a_share_with_the_bearer_token_or_the_delete_token_and_encodes_the_id() {
    let (with_token, _) = route(Reply::empty(204), |routes| async move {
        routes
            .delete_share("a b/c", &DeleteShareAuth::Token("token".to_owned()))
            .await
    })
    .await;
    assert_eq!(
        (with_token.method.as_str(), with_token.path.as_str()),
        ("DELETE", "/v1/shares/a%20b%2Fc")
    );
    assert_eq!(with_token.header("authorization"), Some("Bearer token"));
    assert_eq!(with_token.header("x-delete-token"), None);

    let (with_delete_token, _) = route(Reply::empty(204), |routes| async move {
        routes
            .delete_share("a b/c", &DeleteShareAuth::DeleteToken("dt".to_owned()))
            .await
    })
    .await;
    assert_eq!(with_delete_token.header("x-delete-token"), Some("dt"));
    assert_eq!(with_delete_token.header("authorization"), None);
}

#[tokio::test]
async fn asks_for_a_push_ticket_deletes_a_push_handle_and_asks_for_a_relay_label() {
    let (ticket, _) = route(
        Reply::json(200, &json!({"ticket": "t", "expiresAt": 1})),
        |routes| async move { routes.push_ticket("token").await },
    )
    .await;
    assert_eq!(
        (ticket.method.as_str(), ticket.path.as_str()),
        ("POST", "/v1/push/tickets")
    );

    let (delete, _) = route(Reply::empty(204), |routes| async move {
        routes.push_delete("token", "h/1").await
    })
    .await;
    assert_eq!(
        (delete.method.as_str(), delete.path.as_str()),
        ("DELETE", "/v1/push/h%2F1")
    );

    let (label, _) = route(
        Reply::json(200, &json!({"label": "l", "host": "h", "port": 443})),
        |routes| async move { routes.relay_label("token").await },
    )
    .await;
    assert_eq!(
        (label.method.as_str(), label.path.as_str()),
        ("POST", "/v1/relay/label")
    );
}

#[tokio::test]
async fn reports_a_failure_of_a_route_as_the_server_error_of_the_client() {
    let server =
        MockServer::start(vec![Reply::json(403, &json!({"error": "invalid-invite"}))]).await;
    let harness = harness(&server.origin);
    let error = ServerRoutes::new(harness.client.clone())
        .register_with_invite("bad", "n", &registration())
        .await
        .unwrap_err();
    assert_eq!((error.status, error.code.as_str()), (403, "invalid-invite"));
}
