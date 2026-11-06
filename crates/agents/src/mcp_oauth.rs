mod authorize;
mod callback;
mod credentials;
mod page;
mod record;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use ostia_base::clock::{Clock, system_clock};
use ostia_contract::app_env::{EnvSource, read_env};
use ostia_contract::chat_tools::{
    McpAuthState, McpServerSettings, McpSignInError, McpSignInFailure, McpSignInResult,
};
use parking_lot::Mutex;
use reqwest::Url;
use reqwest::redirect::Policy;
use rmcp::transport::auth::{AuthClient, AuthorizationManager, OAuthClientConfig};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub use callback::{
    CallbackListener, CallbackOptions, CallbackResult, SignInFailure, SignInPages,
    open_callback_listener,
};
pub use record::{McpOAuthRecord, McpOAuthStore};

use crate::mcp_client::{HttpSpec, McpClient, McpHttpAuth};
use crate::mcp_host::{McpAuthSource, McpHttpAuthFuture};
use credentials::{ChangeFn, RecordCredentials, expires_in_of, expiry_after, has_refresh_token};
use page::clip;

const MCP_OAUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MCP_OAUTH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const MCP_OAUTH_BROWSER_ENV: &str = "MCP_OAUTH_BROWSER";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpOAuthBrowser {
    System,
    Fetch,
}

pub fn mcp_oauth_browser(is_packaged: bool, env: &EnvSource) -> McpOAuthBrowser {
    if !is_packaged && read_env(MCP_OAUTH_BROWSER_ENV, env).as_deref() == Some("fetch") {
        McpOAuthBrowser::Fetch
    } else {
        McpOAuthBrowser::System
    }
}

type OpenExternal = Arc<dyn Fn(&str) -> bool + Send + Sync>;
type PagesFn = Arc<dyn Fn() -> SignInPages + Send + Sync>;

#[derive(Clone)]
pub struct McpOAuthDeps {
    store: Arc<dyn McpOAuthStore>,
    open_external: OpenExternal,
    browser: McpOAuthBrowser,
    pages: PagesFn,
    on_change: ChangeFn,
    pub clock: Clock,
    pub timeout: Duration,
    pub connect_timeout: Duration,
}

impl McpOAuthDeps {
    pub fn new(
        store: Arc<dyn McpOAuthStore>,
        open_external: impl Fn(&str) -> bool + Send + Sync + 'static,
        browser: McpOAuthBrowser,
        pages: impl Fn() -> SignInPages + Send + Sync + 'static,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            store,
            open_external: Arc::new(open_external),
            browser,
            pages: Arc::new(pages),
            on_change: Arc::new(on_change),
            clock: system_clock(),
            timeout: MCP_OAUTH_TIMEOUT,
            connect_timeout: MCP_OAUTH_CONNECT_TIMEOUT,
        }
    }
}

#[derive(Clone)]
struct Flow {
    url: String,
    stop: CancellationToken,
}

struct Shared {
    deps: McpOAuthDeps,
    flows: Mutex<HashMap<String, Flow>>,
}

#[derive(Clone)]
pub struct McpOAuth {
    shared: Arc<Shared>,
}

struct FlowGuard<'a> {
    oauth: &'a McpOAuth,
    name: &'a str,
    listener: Option<CallbackListener>,
}

impl Drop for FlowGuard<'_> {
    fn drop(&mut self) {
        if let Some(listener) = self.listener.take() {
            listener.close();
        }
        self.oauth.shared.flows.lock().remove(self.name);
        (self.oauth.shared.deps.on_change)();
    }
}

fn refused(error: McpSignInError) -> McpSignInResult {
    Err(McpSignInFailure {
        error,
        detail: None,
    })
}

fn failed(reason: &str) -> SignInFailure {
    SignInFailure::with_detail(McpSignInError::Failed, clip(reason))
}

fn client_of(granted: &authorize::Granted) -> Value {
    match &granted.client_secret {
        Some(secret) => json!({ "client_id": granted.client_id, "client_secret": secret }),
        None => json!({ "client_id": granted.client_id }),
    }
}

fn url_of(server: &McpServerSettings) -> Option<&str> {
    server.url.as_deref().filter(|url| !url.is_empty())
}

impl McpOAuth {
    pub fn new(deps: McpOAuthDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                deps,
                flows: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn deps(&self) -> &McpOAuthDeps {
        &self.shared.deps
    }

    pub fn state(&self, server: &McpServerSettings, unauthorized: bool) -> Option<McpAuthState> {
        let url = url_of(server)?;
        if self.shared.flows.lock().contains_key(&server.name) {
            return Some(McpAuthState::SigningIn);
        }
        let Some(record) = self.deps().store.get(&server.name, url) else {
            return unauthorized.then_some(McpAuthState::Required);
        };
        let Some(tokens) = &record.tokens else {
            return Some(McpAuthState::Expired);
        };
        let lapsed = record
            .expires_at
            .is_some_and(|expires_at| expires_at <= (self.deps().clock)())
            && !has_refresh_token(tokens);
        Some(if lapsed {
            McpAuthState::Expired
        } else {
            McpAuthState::SignedIn
        })
    }

    async fn http_auth_for(
        &self,
        server: &McpServerSettings,
    ) -> Result<Option<McpHttpAuth>, String> {
        let Some(url) = url_of(server) else {
            return Ok(None);
        };
        let deps = self.deps();
        let Some(record) = deps.store.get(&server.name, url) else {
            return Ok(None);
        };
        if record.tokens.is_none() {
            return Ok(None);
        }
        let mut manager = AuthorizationManager::new(url)
            .await
            .map_err(|err| err.to_string())?;
        manager.set_credential_store(RecordCredentials {
            name: server.name.clone(),
            url: url.to_owned(),
            store: Arc::clone(&deps.store),
            clock: Arc::clone(&deps.clock),
            on_change: Arc::clone(&deps.on_change),
        });
        let restored = manager
            .initialize_from_store()
            .await
            .map_err(|err| err.to_string())?;
        if !restored {
            return Ok(None);
        }
        let client_id = record.client.get("client_id").and_then(Value::as_str);
        let secret = record.client.get("client_secret").and_then(Value::as_str);
        if let Some((client_id, secret)) = client_id.zip(secret.filter(|secret| !secret.is_empty()))
        {
            manager
                .configure_client(
                    OAuthClientConfig::new(client_id, record.redirect_url.clone())
                        .with_client_secret(secret),
                )
                .map_err(|err| err.to_string())?;
        }
        Ok(Some(AuthClient::new(reqwest_rmcp::Client::new(), manager)))
    }

    pub async fn sign_in(
        &self,
        server: Option<&McpServerSettings>,
        headers: &BTreeMap<String, String>,
    ) -> McpSignInResult {
        let Some(server) = server else {
            return refused(McpSignInError::UnknownServer);
        };
        let Some(url) = url_of(server) else {
            return refused(McpSignInError::NotHttp);
        };
        let flow = Flow {
            url: url.to_owned(),
            stop: CancellationToken::new(),
        };
        {
            let mut flows = self.shared.flows.lock();
            if flows.contains_key(&server.name) {
                return refused(McpSignInError::InProgress);
            }
            if !self.deps().store.can_store() {
                return refused(McpSignInError::EncryptionUnavailable);
            }
            flows.insert(server.name.clone(), flow.clone());
        }
        (self.deps().on_change)();
        let mut guard = FlowGuard {
            oauth: self,
            name: &server.name,
            listener: None,
        };
        let opened = open_callback_listener(CallbackOptions {
            state: String::new(),
            timeout: self.deps().timeout,
            pages: (self.deps().pages)(),
            redirect_name: None,
        })
        .await;
        let outcome = match opened {
            Ok(listener) => {
                let listener = guard.listener.insert(listener);
                self.run(&flow, server, url, headers, listener).await
            }
            Err(err) => Err(failed(&err.to_string())),
        };
        let cancelled = flow.stop.is_cancelled();
        drop(guard);
        if cancelled && outcome.is_err() {
            return refused(McpSignInError::Cancelled);
        }
        outcome.map_err(|failure| McpSignInFailure {
            error: failure.code,
            detail: failure.detail,
        })
    }

    async fn run(
        &self,
        flow: &Flow,
        server: &McpServerSettings,
        url: &str,
        headers: &BTreeMap<String, String>,
        listener: &CallbackListener,
    ) -> Result<(), SignInFailure> {
        let redirect_url = listener.redirect_url.clone();
        let steps = async {
            let challenge = self.challenge(url, headers).await?;
            let authorization = authorize::begin(url, challenge.as_deref(), &redirect_url)
                .await
                .map_err(|reason| failed(&reason))?;
            listener.expect_state(&authorization.state);
            self.open_authorization(&authorization.url).await?;
            let callback = listener.result().await?;
            let granted = authorization
                .complete(&callback.code, callback.issuer.as_deref())
                .await
                .map_err(|reason| failed(&reason))?;
            let expires_at =
                expires_in_of(&granted.tokens).map(|ttl| expiry_after(&self.deps().clock, ttl));
            let record = McpOAuthRecord {
                url: url.to_owned(),
                redirect_url: redirect_url.clone(),
                client: client_of(&granted),
                tokens: Some(granted.tokens),
                expires_at,
            };
            let _flows = self.shared.flows.lock();
            if flow.stop.is_cancelled() {
                return Err(SignInFailure::new(McpSignInError::Cancelled));
            }
            self.deps()
                .store
                .set(&server.name, record)
                .map_err(|reason| SignInFailure::with_detail(McpSignInError::Failed, reason))
        };
        tokio::select! {
            biased;
            () = flow.stop.cancelled() => Err(SignInFailure::new(McpSignInError::Cancelled)),
            result = steps => result,
        }
    }

    async fn challenge(
        &self,
        url: &str,
        headers: &BTreeMap<String, String>,
    ) -> Result<Option<String>, SignInFailure> {
        let target = Url::parse(url).map_err(|err| failed(&format!("Invalid URL: {err}")))?;
        let spec = HttpSpec {
            url: target,
            headers: headers.clone(),
            auth: None,
        };
        match McpClient::connect_http(spec, self.deps().connect_timeout).await {
            Ok(client) => {
                client.close();
                Err(SignInFailure::new(McpSignInError::NotNeeded))
            }
            Err(failure) if failure.unauthorized || failure.challenge.is_some() => {
                Ok(failure.challenge)
            }
            Err(failure) => Err(failed(&failure.message)),
        }
    }

    async fn open_authorization(&self, url: &Url) -> Result<(), SignInFailure> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(SignInFailure::with_detail(
                McpSignInError::Browser,
                clip(&format!("{}:", url.scheme())),
            ));
        }
        match self.deps().browser {
            McpOAuthBrowser::Fetch => follow_with_fetch(url).await,
            McpOAuthBrowser::System => {
                if (self.deps().open_external)(url.as_str()) {
                    Ok(())
                } else {
                    Err(SignInFailure::new(McpSignInError::Browser))
                }
            }
        }
    }

    pub fn cancel(&self, name: &Value) {
        let Some(name) = name.as_str() else {
            return;
        };
        let flow = self.shared.flows.lock().get(name).cloned();
        if let Some(flow) = flow {
            flow.stop.cancel();
        }
    }

    pub fn sign_out(&self, name: &str) {
        {
            let flows = self.shared.flows.lock();
            if let Some(flow) = flows.get(name) {
                flow.stop.cancel();
            }
            self.deps().store.clear(name);
        }
        (self.deps().on_change)();
    }

    pub fn prune(&self, servers: &[McpServerSettings]) {
        let moved: Vec<Flow> = {
            let flows = self.shared.flows.lock();
            flows
                .iter()
                .filter(|(name, flow)| {
                    servers
                        .iter()
                        .find(|server| &server.name == *name)
                        .and_then(|server| server.url.as_deref())
                        != Some(flow.url.as_str())
                })
                .map(|(_, flow)| flow.clone())
                .collect()
        };
        for flow in moved {
            flow.stop.cancel();
        }
        self.deps().store.prune(servers);
    }

    pub fn close_all(&self) {
        let flows: Vec<Flow> = self.shared.flows.lock().values().cloned().collect();
        for flow in flows {
            flow.stop.cancel();
        }
    }
}

async fn follow_with_fetch(url: &Url) -> Result<(), SignInFailure> {
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|err| failed(&err.to_string()))?;
    let first = client
        .get(url.clone())
        .send()
        .await
        .map_err(|err| failed(&err.to_string()))?;
    let status = first.status();
    let location = first
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .filter(|location| !location.is_empty());
    let Some(location) = location.filter(|_| status.is_redirection()) else {
        return Err(SignInFailure::with_detail(
            McpSignInError::Browser,
            format!("HTTP {}", status.as_u16()),
        ));
    };
    let next = url.join(location).map_err(|err| failed(&err.to_string()))?;
    client
        .get(next)
        .send()
        .await
        .map_err(|err| failed(&err.to_string()))?;
    Ok(())
}

impl McpAuthSource for McpOAuth {
    fn state(&self, server: &McpServerSettings, unauthorized: bool) -> Option<McpAuthState> {
        McpOAuth::state(self, server, unauthorized)
    }

    fn prune(&self, servers: &[McpServerSettings]) {
        McpOAuth::prune(self, servers);
    }

    fn http_auth(&self, server: &McpServerSettings) -> McpHttpAuthFuture {
        let oauth = self.clone();
        let server = server.clone();
        Box::pin(async move { oauth.http_auth_for(&server).await })
    }
}
