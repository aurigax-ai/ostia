#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod mcp_oauth_support;

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

use mcp_oauth_support::{FakeMcpHttp, MemoryStore, OAUTH_KEY, fake_server_path, node};
use ostia_agents::mcp_host::{McpHost, McpHostDeps, server_secrets};
use ostia_agents::mcp_oauth::{
    McpOAuth, McpOAuthBrowser, McpOAuthDeps, McpOAuthStore, SignInPages,
};
use ostia_base::clock::now_ms;
use ostia_contract::chat_tools::{
    McpAuthState, McpServerSettings, McpServerState, McpServerStatus, McpSignInError,
    McpSignInFailure, McpSignInResult, parse_mcp_server,
};
use ostia_contract::dict::{en, with_default_product_name};
use parking_lot::Mutex;
use reqwest::Url;
use reqwest::redirect::Policy;
use serde_json::json;

type Servers = Arc<Mutex<Vec<McpServerSettings>>>;
type Updates = Arc<Mutex<Vec<Vec<McpServerStatus>>>>;
type Opened = Arc<Mutex<Vec<String>>>;
type HostSlot = Arc<Mutex<Option<McpHost>>>;

fn pages() -> SignInPages {
    let sign_in = &en()["native"]["signIn"];
    SignInPages {
        done: with_default_product_name(sign_in["done"].as_str().unwrap()),
        failed: with_default_product_name(sign_in["failed"].as_str().unwrap()),
    }
}

fn http(url: &str) -> McpServerSettings {
    parse_mcp_server(&json!({
        "name": "remote",
        "enabled": true,
        "url": url,
        "env": {},
        "secrets": [],
        "disabledTools": [],
    }))
    .unwrap()
}

fn command(name: &str, enabled: bool, argv: &[&str]) -> McpServerSettings {
    parse_mcp_server(&json!({
        "name": name,
        "enabled": enabled,
        "command": argv,
        "env": {},
        "secrets": [],
        "disabledTools": [],
    }))
    .unwrap()
}

struct Options {
    browser: McpOAuthBrowser,
    timeout: Option<Duration>,
    browser_opens: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            browser: McpOAuthBrowser::Fetch,
            timeout: None,
            browser_opens: true,
        }
    }
}

struct Rig {
    host: McpHost,
    oauth: McpOAuth,
    store: Arc<MemoryStore>,
    opened: Opened,
    updates: Updates,
    servers: Servers,
    now: Arc<AtomicI64>,
}

impl Rig {
    fn set_servers(&self, next: Vec<McpServerSettings>) {
        *self.servers.lock() = next;
    }

    fn find(&self, name: &str) -> Option<McpServerSettings> {
        self.servers.lock().iter().find(|s| s.name == name).cloned()
    }

    fn sign_in(&self, name: &str) -> impl Future<Output = McpSignInResult> + 'static {
        let oauth = self.oauth.clone();
        let host = self.host.clone();
        let settings = self.find(name);
        async move {
            let headers = settings
                .as_ref()
                .map(|s| server_secrets(s, &|_, _| None))
                .unwrap_or_default();
            let result = oauth.sign_in(settings.as_ref(), &headers).await;
            if result.is_ok()
                && let Some(settings) = settings
            {
                host.reconnect(&settings.name);
            }
            result
        }
    }

    fn sign_out(&self, name: &str) {
        if let Some(settings) = self.find(name) {
            self.oauth.sign_out(&settings.name);
            self.host.reconnect(&settings.name);
        }
    }

    fn close(&self) {
        self.oauth.close_all();
        self.host.close_all();
    }
}

fn setup(servers: Vec<McpServerSettings>, options: Options) -> Rig {
    let servers: Servers = Arc::new(Mutex::new(servers));
    let updates: Updates = Arc::new(Mutex::new(Vec::new()));
    let opened: Opened = Arc::new(Mutex::new(Vec::new()));
    let slot: HostSlot = Arc::new(Mutex::new(None));
    let store = MemoryStore::new();
    let now = Arc::new(AtomicI64::new(now_ms()));

    let seen_urls = Arc::clone(&opened);
    let opens = Arc::new(AtomicBool::new(options.browser_opens));
    let notify = Arc::clone(&slot);
    let clock = Arc::clone(&now);
    let mut oauth_deps = McpOAuthDeps::new(
        store.clone() as Arc<dyn McpOAuthStore>,
        move |url| {
            seen_urls.lock().push(url.to_owned());
            opens.load(Ordering::SeqCst)
        },
        options.browser,
        pages,
        move || {
            let host = notify.lock().clone();
            if let Some(host) = host {
                host.notify();
            }
        },
    );
    oauth_deps.clock = Arc::new(move || clock.load(Ordering::SeqCst));
    oauth_deps.connect_timeout = Duration::from_secs(10);
    if let Some(timeout) = options.timeout {
        oauth_deps.timeout = timeout;
    }
    let oauth = McpOAuth::new(oauth_deps);

    let listed = Arc::clone(&servers);
    let seen = Arc::clone(&updates);
    let mut host_deps = McpHostDeps::new(
        move || listed.lock().clone(),
        |_, _| None,
        move |status| seen.lock().push(status),
    );
    host_deps.set_auth(oauth.clone());
    host_deps.connect_timeout = Duration::from_secs(10);
    let host = McpHost::new(host_deps);
    *slot.lock() = Some(host.clone());
    Rig {
        host,
        oauth,
        store,
        opened,
        updates,
        servers,
        now,
    }
}

async fn wait_for(host: &McpHost, state: McpServerState) -> McpServerStatus {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let status = host.status().into_iter().next();
        if let Some(status) = &status
            && status.state == state
        {
            return status.clone();
        }
        assert!(
            Instant::now() < deadline,
            "timed out; last {:?}",
            status.map(|s| (s.state, s.error, s.auth))
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn failure(error: McpSignInError) -> McpSignInResult {
    Err(McpSignInFailure {
        error,
        detail: None,
    })
}

fn tool_names(status: &McpServerStatus) -> Vec<&str> {
    status.tools.iter().map(|t| t.name.as_str()).collect()
}

fn access_token(rig: &Rig, url: &str) -> Option<String> {
    let record = rig.store.get("remote", url)?;
    Some(record.tokens?["access_token"].as_str()?.to_owned())
}

fn refresh_token(rig: &Rig, url: &str) -> Option<String> {
    let record = rig.store.get("remote", url)?;
    Some(record.tokens?["refresh_token"].as_str()?.to_owned())
}

fn is_base64url(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn query(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn no_redirect_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

#[tokio::test]
async fn marks_a_server_that_answers_401_as_needing_sign_in_without_registering_or_opening_anything()
 {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    rig.host.refresh();
    let failed = wait_for(&rig.host, McpServerState::Error).await;
    assert_eq!(failed.auth, Some(McpAuthState::Required));
    assert!(rig.opened.lock().is_empty());
    server
        .assert_stats(&[("registrations", 0), ("authorizations", 0)])
        .await;
    rig.close();
}

#[tokio::test]
async fn signs_in_stores_the_tokens_encrypted_and_connects_with_them() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(rig.sign_in("remote").await, Ok(()));
    let ready = wait_for(&rig.host, McpServerState::Ready).await;
    assert_eq!(ready.auth, Some(McpAuthState::SignedIn));
    assert_eq!(
        tool_names(&ready),
        vec!["echo", "env", "fail", "slow", "exit"]
    );
    assert_eq!(
        rig.host
            .call(
                &json!("c1"),
                &json!("remote"),
                &json!("echo"),
                &json!({"text": "hi"})
            )
            .await,
        Ok("echo: hi".to_owned())
    );
    server
        .assert_stats(&[
            ("registrations", 1),
            ("authorizations", 1),
            ("exchanges", 1),
        ])
        .await;

    let record = rig.store.get("remote", &server.url).unwrap();
    let tokens = record.tokens.clone().unwrap();
    let access = tokens["access_token"].as_str().unwrap().to_owned();
    assert!(tokens["refresh_token"].is_string());
    assert!(record.expires_at.unwrap() > now_ms());
    assert!(
        record.client["client_id"]
            .as_str()
            .unwrap()
            .starts_with("client-")
    );
    let redirect = Url::parse(&record.redirect_url).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    assert_eq!(redirect.path(), "/callback");
    assert!(redirect.port().is_some());

    let stored = rig.store.stored();
    assert_eq!(
        stored["remote"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec![OAUTH_KEY]
    );
    assert!(!stored.to_string().contains(&access));
    let updates = serde_json::to_string(&*rig.updates.lock()).unwrap();
    assert!(!updates.contains(&access));
    assert!(!updates.contains(record.client["client_id"].as_str().unwrap()));
    assert!(
        rig.updates
            .lock()
            .iter()
            .any(|u| u[0].auth == Some(McpAuthState::SigningIn))
    );
    rig.close();
}

#[tokio::test]
async fn refreshes_an_expired_access_token_in_main_and_keeps_the_server_connected() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(rig.sign_in("remote").await, Ok(()));
    wait_for(&rig.host, McpServerState::Ready).await;
    let access_before = access_token(&rig, &server.url);
    let refresh_before = refresh_token(&rig, &server.url);
    server.control("expire").await;
    assert_eq!(
        rig.host
            .call(
                &json!("c1"),
                &json!("remote"),
                &json!("echo"),
                &json!({"text": "again"})
            )
            .await,
        Ok("echo: again".to_owned())
    );
    assert_ne!(access_token(&rig, &server.url), access_before);
    assert_ne!(refresh_token(&rig, &server.url), refresh_before);
    server
        .assert_stats(&[("refreshes", 1), ("authorizations", 1)])
        .await;
    let status = rig.host.status().remove(0);
    assert_eq!(status.state, McpServerState::Ready);
    assert_eq!(status.auth, Some(McpAuthState::SignedIn));
    rig.close();
}

#[tokio::test]
async fn shows_expired_when_the_refresh_token_is_refused_drops_the_tokens_and_opens_no_browser() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(rig.sign_in("remote").await, Ok(()));
    wait_for(&rig.host, McpServerState::Ready).await;
    server.control("revoke").await;
    assert!(
        rig.host
            .call(
                &json!("c1"),
                &json!("remote"),
                &json!("echo"),
                &json!({"text": "hi"})
            )
            .await
            .is_err()
    );
    let failed = wait_for(&rig.host, McpServerState::Error).await;
    assert_eq!(failed.auth, Some(McpAuthState::Expired));
    assert!(
        rig.store
            .get("remote", &server.url)
            .unwrap()
            .tokens
            .is_none()
    );
    assert!(rig.opened.lock().is_empty());
    server
        .assert_stats(&[("authorizations", 1), ("registrations", 1)])
        .await;

    assert_eq!(rig.sign_in("remote").await, Ok(()));
    let again = wait_for(&rig.host, McpServerState::Ready).await;
    assert_eq!(again.auth, Some(McpAuthState::SignedIn));
    rig.close();
}

#[tokio::test]
async fn shows_expired_once_an_access_token_without_a_refresh_token_is_past_its_expiry() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(rig.sign_in("remote").await, Ok(()));
    let mut record = rig.store.get("remote", &server.url).unwrap();
    record
        .tokens
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("refresh_token");
    rig.store.set("remote", record).unwrap();
    assert_eq!(rig.host.status()[0].auth, Some(McpAuthState::SignedIn));
    rig.now.fetch_add(3601 * 1000, Ordering::SeqCst);
    assert_eq!(rig.host.status()[0].auth, Some(McpAuthState::Expired));
    rig.close();
}

#[tokio::test]
async fn signs_out_by_deleting_the_tokens_and_reconnecting_without_them() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(rig.sign_in("remote").await, Ok(()));
    wait_for(&rig.host, McpServerState::Ready).await;
    rig.sign_out("remote");
    assert_eq!(rig.store.stored(), json!({}));
    let failed = wait_for(&rig.host, McpServerState::Error).await;
    assert_eq!(failed.auth, Some(McpAuthState::Required));
    rig.close();
}

#[tokio::test]
async fn drops_the_tokens_when_the_server_url_changes_or_the_server_is_removed() {
    let server = FakeMcpHttp::start(true).await;
    let other = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(rig.sign_in("remote").await, Ok(()));
    wait_for(&rig.host, McpServerState::Ready).await;
    rig.set_servers(vec![http(&other.url)]);
    rig.host.refresh();
    assert_eq!(rig.store.stored(), json!({}));
    assert_eq!(
        wait_for(&rig.host, McpServerState::Error).await.auth,
        Some(McpAuthState::Required)
    );

    assert_eq!(rig.sign_in("remote").await, Ok(()));
    assert_eq!(
        rig.store
            .stored()
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["remote"]
    );
    rig.set_servers(Vec::new());
    rig.host.refresh();
    assert_eq!(rig.store.stored(), json!({}));
    rig.close();
}

#[tokio::test]
async fn opens_the_authorization_url_in_the_system_browser_and_accepts_only_the_callback_with_its_state()
 {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(
        vec![http(&server.url)],
        Options {
            browser: McpOAuthBrowser::System,
            ..Options::default()
        },
    );
    let pending = tokio::spawn(rig.sign_in("remote"));
    wait_until("the browser to open", || rig.opened.lock().len() == 1).await;
    let authorization = Url::parse(&rig.opened.lock()[0]).unwrap();
    assert_eq!(authorization.origin().ascii_serialization(), server.origin);
    assert_eq!(authorization.path(), "/authorize");
    assert_eq!(
        query(&authorization, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert!(is_base64url(
        &query(&authorization, "code_challenge").unwrap(),
        43
    ));
    assert!(is_base64url(&query(&authorization, "state").unwrap(), 22));
    let redirect = Url::parse(&query(&authorization, "redirect_uri").unwrap()).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    assert_eq!(rig.host.status()[0].auth, Some(McpAuthState::SigningIn));
    assert_eq!(
        rig.sign_in("remote").await,
        failure(McpSignInError::InProgress)
    );

    let client = no_redirect_client();
    let mut forged = redirect.clone();
    forged
        .query_pairs_mut()
        .append_pair("code", "stolen")
        .append_pair("state", "not-the-state");
    assert_eq!(
        client.get(forged).send().await.unwrap().status().as_u16(),
        400
    );
    let elsewhere = redirect.join("/other").unwrap();
    assert_eq!(
        client
            .get(elsewhere)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        404
    );

    let granted = client.get(authorization).send().await.unwrap();
    let location = granted.headers()["location"].to_str().unwrap().to_owned();
    let callback = client.get(location).send().await.unwrap();
    assert_eq!(callback.status().as_u16(), 200);
    assert!(callback.text().await.unwrap().contains("Signed in"));
    assert_eq!(pending.await.unwrap(), Ok(()));
    assert!(mcp_oauth_support::refuses_connections(redirect.as_str()).await);
    rig.close();
}

#[tokio::test]
async fn reports_the_exact_reason_when_the_human_is_refused_at_the_authorization_server() {
    let server = FakeMcpHttp::start(true).await;
    server.control("deny").await;
    let rig = setup(vec![http(&server.url)], Options::default());
    assert_eq!(
        rig.sign_in("remote").await,
        Err(McpSignInFailure {
            error: McpSignInError::Failed,
            detail: Some("access_denied: The fake human said no".to_owned())
        })
    );
    assert_eq!(rig.store.stored(), json!({}));
    rig.close();
}

#[tokio::test]
async fn times_out_and_cancels_without_storing_anything_and_closes_its_listener() {
    let server = FakeMcpHttp::start(true).await;
    let timed = setup(
        vec![http(&server.url)],
        Options {
            browser: McpOAuthBrowser::System,
            timeout: Some(Duration::from_millis(150)),
            ..Options::default()
        },
    );
    assert_eq!(
        timed.sign_in("remote").await,
        failure(McpSignInError::Timeout)
    );
    let authorization = Url::parse(&timed.opened.lock()[0]).unwrap();
    let redirect = query(&authorization, "redirect_uri").unwrap();
    assert!(mcp_oauth_support::refuses_connections(&redirect).await);
    assert_eq!(timed.store.stored(), json!({}));
    timed.close();

    let cancelled = setup(
        vec![http(&server.url)],
        Options {
            browser: McpOAuthBrowser::System,
            ..Options::default()
        },
    );
    let pending = tokio::spawn(cancelled.sign_in("remote"));
    wait_until("the browser to open", || cancelled.opened.lock().len() == 1).await;
    cancelled.oauth.cancel(&json!("remote"));
    assert_eq!(pending.await.unwrap(), failure(McpSignInError::Cancelled));
    assert_eq!(cancelled.store.stored(), json!({}));
    assert_ne!(
        cancelled.host.status()[0].auth,
        Some(McpAuthState::SigningIn)
    );
    cancelled.close();
}

#[tokio::test]
async fn refuses_a_server_that_needs_no_sign_in_a_command_server_and_an_unknown_one() {
    let open = FakeMcpHttp::start(false).await;
    let rig = setup(
        vec![http(&open.url), command("local", true, &["node"])],
        Options::default(),
    );
    assert_eq!(
        rig.sign_in("remote").await,
        failure(McpSignInError::NotNeeded)
    );
    assert_eq!(rig.sign_in("local").await, failure(McpSignInError::NotHttp));
    assert_eq!(
        rig.sign_in("nope").await,
        failure(McpSignInError::UnknownServer)
    );
    rig.close();
}

#[tokio::test]
async fn the_human_adds_the_server_in_settings_signs_in_tests_it_and_a_chat_lists_its_tools() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    rig.host.refresh();
    assert_eq!(
        wait_for(&rig.host, McpServerState::Error).await.auth,
        Some(McpAuthState::Required)
    );
    server
        .assert_stats(&[("registrations", 0), ("authorizations", 0)])
        .await;
    let refused = rig.host.test(&json!("remote")).await;
    assert!(refused.unwrap_err().contains("401"));

    assert_eq!(rig.sign_in("remote").await, Ok(()));
    let ready = wait_for(&rig.host, McpServerState::Ready).await;
    assert_eq!(ready.auth, Some(McpAuthState::SignedIn));
    assert_eq!(ready.tools.len(), 5);
    server
        .assert_stats(&[
            ("registrations", 1),
            ("authorizations", 1),
            ("exchanges", 1),
        ])
        .await;
    assert_eq!(rig.host.test(&json!("remote")).await, Ok(5));

    let stored = rig.store.stored();
    assert_eq!(
        stored["remote"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec![OAUTH_KEY]
    );
    assert!(!stored.to_string().contains("access_token"));
    let settings = format!("{:?}", rig.servers.lock()).to_lowercase();
    assert!(settings.contains(&server.url));
    assert!(!settings.contains("oauth"));
    assert!(!settings.contains("token"));
    assert!(!settings.contains("client-"));

    rig.sign_out("remote");
    assert_eq!(rig.store.stored(), json!({}));
    assert_eq!(
        wait_for(&rig.host, McpServerState::Error).await.auth,
        Some(McpAuthState::Required)
    );
    rig.close();
}

#[tokio::test]
async fn connects_counts_the_tools_and_leaves_the_server_state_alone() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(vec![http(&server.url)], Options::default());
    let refused = rig.host.test(&json!("remote")).await;
    assert!(refused.unwrap_err().contains("401"));
    assert_eq!(rig.host.status()[0].state, McpServerState::Idle);
    server.assert_stats(&[("registrations", 0)]).await;

    assert_eq!(rig.sign_in("remote").await, Ok(()));
    assert_eq!(rig.host.test(&json!("remote")).await, Ok(5));

    let script = fake_server_path().to_string_lossy().into_owned();
    let node = node();
    rig.set_servers(vec![
        command("local", false, &[&node, &script]),
        command("missing", true, &["/nonexistent/ostia-mcp-server"]),
    ]);
    assert_eq!(rig.host.test(&json!("local")).await, Ok(5));
    assert!(rig.host.test(&json!("missing")).await.is_err());
    assert_eq!(
        rig.host.test(&json!("nope")).await,
        Err("unknown-server".to_owned())
    );
    rig.close();
}

#[tokio::test]
async fn fails_with_the_browser_error_and_stores_nothing_when_the_system_browser_cannot_open() {
    let server = FakeMcpHttp::start(true).await;
    let rig = setup(
        vec![http(&server.url)],
        Options {
            browser: McpOAuthBrowser::System,
            browser_opens: false,
            ..Options::default()
        },
    );
    assert_eq!(
        rig.sign_in("remote").await,
        failure(McpSignInError::Browser)
    );
    assert_eq!(rig.opened.lock().len(), 1);
    assert_eq!(rig.store.stored(), json!({}));
    assert_ne!(rig.host.status()[0].auth, Some(McpAuthState::SigningIn));
    rig.close();
}

#[tokio::test]
async fn cancels_an_open_sign_in_when_the_human_signs_out_or_the_server_url_changes() {
    let server = FakeMcpHttp::start(true).await;
    let other = FakeMcpHttp::start(true).await;
    let options = || Options {
        browser: McpOAuthBrowser::System,
        ..Options::default()
    };

    let signed_out = setup(vec![http(&server.url)], options());
    let pending = tokio::spawn(signed_out.sign_in("remote"));
    wait_until("the browser to open", || {
        signed_out.opened.lock().len() == 1
    })
    .await;
    signed_out.sign_out("remote");
    assert_eq!(pending.await.unwrap(), failure(McpSignInError::Cancelled));
    signed_out.close();

    let moved = setup(vec![http(&server.url)], options());
    let pending = tokio::spawn(moved.sign_in("remote"));
    wait_until("the browser to open", || moved.opened.lock().len() == 1).await;
    let next = vec![http(&other.url)];
    moved.oauth.prune(&next);
    assert_eq!(pending.await.unwrap(), failure(McpSignInError::Cancelled));
    moved.close();

    let kept = setup(vec![http(&server.url)], options());
    let pending = tokio::spawn(kept.sign_in("remote"));
    wait_until("the browser to open", || kept.opened.lock().len() == 1).await;
    kept.oauth.prune(&[http(&server.url)]);
    assert!(!pending.is_finished());
    kept.oauth.close_all();
    assert_eq!(pending.await.unwrap(), failure(McpSignInError::Cancelled));
    kept.close();
}
