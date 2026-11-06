#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod mcp_oauth_support;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mcp_oauth_support::{MemoryStore, status_with_host};
use ostia_agents::mcp_oauth::{
    CallbackListener, CallbackOptions, CallbackResult, MCP_OAUTH_BROWSER_ENV, McpOAuth,
    McpOAuthBrowser, McpOAuthDeps, McpOAuthRecord, McpOAuthStore, SignInFailure, SignInPages,
    mcp_oauth_browser, open_callback_listener,
};
use ostia_contract::app_env::{EnvSource, env_name};
use ostia_contract::chat_tools::{
    McpAuthState, McpServerSettings, McpSignInError, McpSignInFailure, parse_mcp_server,
};
use ostia_contract::dict::{en, with_default_product_name};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};

fn pages() -> SignInPages {
    let sign_in = &en()["native"]["signIn"];
    SignInPages {
        done: with_default_product_name(sign_in["done"].as_str().unwrap()),
        failed: with_default_product_name(sign_in["failed"].as_str().unwrap()),
    }
}

fn client() -> Client {
    Client::builder()
        .redirect(Policy::none())
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

async fn listen(timeout: Duration) -> CallbackListener {
    open_callback_listener(CallbackOptions {
        state: "expected-state".to_owned(),
        timeout,
        pages: pages(),
        redirect_name: None,
    })
    .await
    .unwrap()
}

async fn listen_default() -> CallbackListener {
    listen(Duration::from_secs(5)).await
}

fn callback(redirect_url: &str, params: &[(&str, &str)]) -> Url {
    let mut url = Url::parse(redirect_url).unwrap();
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }
    url
}

async fn status(request: Url) -> u16 {
    client()
        .get(request)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

fn is_loopback_redirect(url: &str, host: &str) -> bool {
    let Some(rest) = url.strip_prefix(&format!("http://{host}:")) else {
        return false;
    };
    let Some(port) = rest.strip_suffix("/callback") else {
        return false;
    };
    !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
}

#[test]
fn lets_the_fetch_browser_stand_in_only_for_an_unpackaged_app_that_asks_for_it() {
    let name = env_name(MCP_OAUTH_BROWSER_ENV);
    let with = |value: &str| EnvSource::from([(name.clone(), value.to_owned())]);
    assert_eq!(
        mcp_oauth_browser(false, &with("fetch")),
        McpOAuthBrowser::Fetch
    );
    assert_eq!(
        mcp_oauth_browser(true, &with("fetch")),
        McpOAuthBrowser::System
    );
    assert_eq!(
        mcp_oauth_browser(false, &EnvSource::new()),
        McpOAuthBrowser::System
    );
    assert_eq!(
        mcp_oauth_browser(false, &with("1")),
        McpOAuthBrowser::System
    );
    let legacy = EnvSource::from([("PINE_MCP_OAUTH_BROWSER".to_owned(), "fetch".to_owned())]);
    assert_eq!(mcp_oauth_browser(false, &legacy), McpOAuthBrowser::System);
}

#[tokio::test]
async fn answers_to_the_loopback_name_it_was_asked_to_redirect_to_and_to_no_other() {
    let listener = open_callback_listener(CallbackOptions {
        state: "expected-state".to_owned(),
        timeout: Duration::from_secs(5),
        pages: pages(),
        redirect_name: Some("localhost".to_owned()),
    })
    .await
    .unwrap();
    assert!(
        is_loopback_redirect(&listener.redirect_url, "localhost"),
        "{}",
        listener.redirect_url
    );
    let port = Url::parse(&listener.redirect_url).unwrap().port().unwrap();
    let path = "/callback?code=c-1&state=expected-state";
    assert_eq!(
        status_with_host(port, path, &format!("evil.example:{port}")).await,
        Some(404)
    );
    assert_eq!(
        status_with_host(port, path, &format!("localhost:{port}")).await,
        Some(200)
    );
    assert_eq!(
        listener.result().await,
        Ok(CallbackResult {
            code: "c-1".to_owned(),
            issuer: None
        })
    );
    listener.close();
}

#[tokio::test]
async fn listens_on_a_loopback_port_of_its_own_and_hands_over_the_code_sent_with_its_state() {
    let listener = listen_default().await;
    let other = listen_default().await;
    assert!(
        is_loopback_redirect(&listener.redirect_url, "127.0.0.1"),
        "{}",
        listener.redirect_url
    );
    assert_ne!(other.redirect_url, listener.redirect_url);
    let res = client()
        .get(callback(
            &listener.redirect_url,
            &[
                ("code", "c-1"),
                ("state", "expected-state"),
                ("iss", "https://as"),
            ],
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(
        res.headers()["content-security-policy"],
        "default-src 'none'"
    );
    assert_eq!(res.headers()["referrer-policy"], "no-referrer");
    let body = res.text().await.unwrap();
    assert!(body.contains(&pages().done), "{body}");
    assert_eq!(
        listener.result().await,
        Ok(CallbackResult {
            code: "c-1".to_owned(),
            issuer: Some("https://as".to_owned())
        })
    );
    listener.close();
    other.close();
}

#[tokio::test]
async fn refuses_a_wrong_state_path_method_or_host_and_keeps_waiting() {
    let listener = listen_default().await;
    let url = listener.redirect_url.clone();
    let good = [("code", "c-1"), ("state", "expected-state")];
    assert_eq!(
        status(callback(&url, &[("code", "x"), ("state", "nope")])).await,
        400
    );
    assert_eq!(status(callback(&url, &[("code", "x")])).await, 400);
    let other = Url::parse(&url)
        .unwrap()
        .join("/other?code=x&state=expected-state")
        .unwrap();
    assert_eq!(status(other).await, 404);
    let posted = client()
        .request(Method::POST, callback(&url, &good))
        .send()
        .await
        .unwrap();
    assert_eq!(posted.status().as_u16(), 404);
    let via_name = callback(&url.replace("127.0.0.1", "localhost"), &good);
    let named = client().get(via_name).send().await;
    assert!(
        named
            .as_ref()
            .map_or(true, |res| res.status().as_u16() == 404)
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.result())
            .await
            .is_err()
    );
    assert_eq!(status(callback(&url, &good)).await, 200);
    assert_eq!(
        listener.result().await,
        Ok(CallbackResult {
            code: "c-1".to_owned(),
            issuer: None
        })
    );
    listener.close();
}

#[tokio::test]
async fn fails_with_the_reason_the_authorization_server_gave() {
    let listener = listen_default().await;
    let res = client()
        .get(callback(
            &listener.redirect_url,
            &[
                ("state", "expected-state"),
                ("error", "access_denied"),
                ("error_description", "Nope"),
            ],
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    assert_eq!(
        listener.result().await,
        Err(SignInFailure {
            code: McpSignInError::Failed,
            detail: Some("access_denied: Nope".to_owned())
        })
    );
    listener.close();
}

#[tokio::test]
async fn gives_up_after_its_timeout_and_stops_listening_once_closed() {
    let listener = listen(Duration::from_millis(60)).await;
    let timed_out = SignInFailure {
        code: McpSignInError::Timeout,
        detail: None,
    };
    assert_eq!(listener.result().await, Err(timed_out.clone()));
    assert_eq!(listener.result().await, Err(timed_out));
    listener.close();
    assert!(mcp_oauth_support::refuses_connections(&listener.redirect_url).await);

    let closed = listen_default().await;
    closed.close();
    assert_eq!(
        closed.result().await,
        Err(SignInFailure {
            code: McpSignInError::Cancelled,
            detail: None
        })
    );
}

#[tokio::test]
async fn escapes_the_page_text_and_names_the_product_in_the_title() {
    let listener = open_callback_listener(CallbackOptions {
        state: "expected-state".to_owned(),
        timeout: Duration::from_secs(5),
        pages: SignInPages {
            done: "done".to_owned(),
            failed: "<b>\"x\" & 'y'</b>".to_owned(),
        },
        redirect_name: None,
    })
    .await
    .unwrap();
    let res = client()
        .get(callback(&listener.redirect_url, &[("state", "wrong")]))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    assert_eq!(res.headers()["cache-control"], "no-store");
    assert_eq!(res.headers()["content-type"], "text/html; charset=utf-8");
    let body = res.text().await.unwrap();
    assert_eq!(
        body,
        "<!doctype html><meta charset=\"utf-8\"><title>Ostia</title><p>&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;</p>"
    );
    listener.close();
}

#[tokio::test]
async fn fails_without_a_reason_when_the_callback_has_no_code_and_clips_a_long_reason() {
    let listener = listen_default().await;
    let res = client()
        .get(callback(
            &listener.redirect_url,
            &[("state", "expected-state")],
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    assert_eq!(
        listener.result().await,
        Err(SignInFailure {
            code: McpSignInError::Failed,
            detail: Some("no authorization code".to_owned())
        })
    );
    listener.close();

    let listener = listen_default().await;
    let long = format!("a  b\n{}", "z".repeat(400));
    client()
        .get(callback(
            &listener.redirect_url,
            &[
                ("state", "expected-state"),
                ("error", "server_error"),
                ("error_description", &long),
            ],
        ))
        .send()
        .await
        .unwrap();
    let Err(failure) = listener.result().await else {
        panic!("expected a failure");
    };
    let detail = failure.detail.unwrap();
    assert_eq!(detail.chars().count(), 240);
    assert!(detail.starts_with("server_error: a b zzz"), "{detail}");
    listener.close();

    let listener = listen_default().await;
    client()
        .get(callback(
            &listener.redirect_url,
            &[("state", "expected-state"), ("error", "access_denied")],
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(
        listener.result().await,
        Err(SignInFailure {
            code: McpSignInError::Failed,
            detail: Some("access_denied".to_owned())
        })
    );
    listener.close();
}

#[tokio::test]
async fn ignores_a_later_callback_once_the_first_one_settled() {
    let listener = listen_default().await;
    let url = listener.redirect_url.clone();
    assert_eq!(
        status(callback(
            &url,
            &[("code", "first"), ("state", "expected-state")]
        ))
        .await,
        200
    );
    let _ = client()
        .get(callback(
            &url,
            &[("code", "second"), ("state", "expected-state")],
        ))
        .send()
        .await;
    assert_eq!(listener.result().await.unwrap().code, "first".to_owned());
    listener.close();
}

fn http_server(name: &str, url: &str) -> McpServerSettings {
    parse_mcp_server(&json!({
        "name": name,
        "enabled": true,
        "url": url,
        "env": {},
        "secrets": [],
        "disabledTools": [],
    }))
    .unwrap()
}

fn command_server(name: &str) -> McpServerSettings {
    parse_mcp_server(&json!({
        "name": name,
        "enabled": true,
        "command": ["node"],
        "env": {},
        "secrets": [],
        "disabledTools": [],
    }))
    .unwrap()
}

struct Unit {
    oauth: McpOAuth,
    store: Arc<MemoryStore>,
    changes: Arc<AtomicUsize>,
    now: Arc<std::sync::atomic::AtomicI64>,
}

fn unit(store: Arc<MemoryStore>) -> Unit {
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&changes);
    let now = Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
    let clock = Arc::clone(&now);
    let mut deps = McpOAuthDeps::new(
        store.clone() as Arc<dyn McpOAuthStore>,
        |_| true,
        McpOAuthBrowser::System,
        pages,
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
        },
    );
    deps.clock = Arc::new(move || clock.load(Ordering::SeqCst));
    Unit {
        oauth: McpOAuth::new(deps),
        store,
        changes,
        now,
    }
}

fn record(tokens: Option<Value>, expires_at: Option<i64>) -> McpOAuthRecord {
    McpOAuthRecord {
        url: "https://mcp.example/mcp".to_owned(),
        redirect_url: "http://127.0.0.1:1/callback".to_owned(),
        client: json!({"client_id": "client-1"}),
        tokens,
        expires_at,
    }
}

fn tokens(refresh: bool) -> Value {
    let mut value = json!({"access_token": "a", "token_type": "Bearer"});
    if refresh {
        value["refresh_token"] = json!("r");
    }
    value
}

#[test]
fn tells_the_sign_in_state_of_an_http_server_from_the_stored_record() {
    let u = unit(MemoryStore::new());
    let server = http_server("remote", "https://mcp.example/mcp");
    assert_eq!(u.oauth.state(&server, false), None);
    assert_eq!(u.oauth.state(&server, true), Some(McpAuthState::Required));
    assert_eq!(u.oauth.state(&command_server("local"), true), None);

    u.store.set("remote", record(None, None)).unwrap();
    assert_eq!(u.oauth.state(&server, false), Some(McpAuthState::Expired));

    u.store
        .set("remote", record(Some(tokens(false)), None))
        .unwrap();
    assert_eq!(u.oauth.state(&server, false), Some(McpAuthState::SignedIn));

    u.store
        .set("remote", record(Some(tokens(false)), Some(1_000_001)))
        .unwrap();
    assert_eq!(u.oauth.state(&server, false), Some(McpAuthState::SignedIn));
    u.now.store(1_000_001, Ordering::SeqCst);
    assert_eq!(u.oauth.state(&server, false), Some(McpAuthState::Expired));

    u.store
        .set("remote", record(Some(tokens(true)), Some(1_000_001)))
        .unwrap();
    assert_eq!(u.oauth.state(&server, false), Some(McpAuthState::SignedIn));

    let moved = http_server("remote", "https://elsewhere.example/mcp");
    assert_eq!(u.oauth.state(&moved, true), Some(McpAuthState::Required));
    assert!(u.store.stored().as_object().unwrap().is_empty());
}

#[tokio::test]
async fn refuses_a_sign_in_for_an_unknown_server_a_command_server_and_a_store_that_cannot_encrypt()
{
    let headers = BTreeMap::new();
    let u = unit(MemoryStore::new());
    let failure = |error| {
        Err(McpSignInFailure {
            error,
            detail: None,
        })
    };
    assert_eq!(
        u.oauth.sign_in(None, &headers).await,
        failure(McpSignInError::UnknownServer)
    );
    assert_eq!(
        u.oauth
            .sign_in(Some(&command_server("local")), &headers)
            .await,
        failure(McpSignInError::NotHttp)
    );

    let plain = unit(MemoryStore::without_encryption());
    let server = http_server("remote", "https://mcp.example/mcp");
    assert_eq!(
        plain.oauth.sign_in(Some(&server), &headers).await,
        failure(McpSignInError::EncryptionUnavailable)
    );
    assert_eq!(plain.changes.load(Ordering::SeqCst), 0);
}

#[test]
fn signs_out_by_clearing_the_record_and_telling_the_host() {
    let u = unit(MemoryStore::new());
    u.store
        .set("remote", record(Some(tokens(true)), None))
        .unwrap();
    u.store
        .set("other", record(Some(tokens(true)), None))
        .unwrap();
    u.oauth.sign_out("remote");
    assert!(u.store.raw("remote").is_none());
    assert!(u.store.raw("other").is_some());
    assert_eq!(u.changes.load(Ordering::SeqCst), 1);
}

#[test]
fn prunes_the_records_of_servers_that_are_gone_or_moved() {
    let u = unit(MemoryStore::new());
    u.store
        .set("kept", record(Some(tokens(true)), None))
        .unwrap();
    u.store
        .set("moved", record(Some(tokens(true)), None))
        .unwrap();
    u.store
        .set("gone", record(Some(tokens(true)), None))
        .unwrap();
    u.oauth.prune(&[
        http_server("kept", "https://mcp.example/mcp"),
        http_server("moved", "https://elsewhere.example/mcp"),
    ]);
    assert!(u.store.raw("kept").is_some());
    assert!(u.store.raw("moved").is_none());
    assert!(u.store.raw("gone").is_none());
}

#[test]
fn cancel_and_close_all_do_nothing_when_no_sign_in_is_open() {
    let u = unit(MemoryStore::new());
    u.oauth.cancel(&json!("remote"));
    u.oauth.cancel(&json!(7));
    u.oauth.cancel(&Value::Null);
    u.oauth.close_all();
    assert_eq!(u.changes.load(Ordering::SeqCst), 0);
}
