use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ostia_contract::PRODUCT_DISPLAY_NAME;
use parking_lot::Mutex;
use reqwest::Url;
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, CancelledNotificationParam, ClientCapabilities,
    ClientConfig, ClientRequest, Implementation, ServerResult,
};
use rmcp::service::PeerRequestOptions;
use rmcp::service::{QuitReason, RunningServiceCancellationToken};
use rmcp::transport::auth::AuthClient;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{IntoTransport, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{Peer, RoleClient, ServiceError, ServiceExt};
use serde_json::{Map, Value};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const CLOSED: &str = "The connection closed";
const ABANDONED: &str = "request abandoned by the caller";
const TIMED_OUT: &str = "Request timed out";
const UNAUTHORIZED: &str = "HTTP 401: authorization required";

pub type McpHttpAuth = AuthClient<reqwest::Client>;

pub(crate) struct ConnectFailure {
    pub message: String,
    pub challenge: Option<String>,
    pub unauthorized: bool,
}

impl From<String> for ConnectFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            challenge: None,
            unauthorized: false,
        }
    }
}

fn bare_message(err: ServiceError) -> String {
    match err {
        ServiceError::McpError(error) => error.message.to_string(),
        other => other.to_string(),
    }
}

pub(crate) type ExitCallback = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct ExitWatch {
    exited: bool,
    callback: Option<ExitCallback>,
}

struct Shared {
    closed: CancellationToken,
    watch: Mutex<ExitWatch>,
}

pub(crate) struct StdioSpec {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

pub(crate) struct HttpSpec {
    pub url: Url,
    pub headers: BTreeMap<String, String>,
    pub auth: Option<McpHttpAuth>,
}

pub(crate) struct McpClient {
    shared: Arc<Shared>,
    peer: Peer<RoleClient>,
    stop: Mutex<Option<RunningServiceCancellationToken>>,
    stdio: bool,
}

fn client_config() -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new(PRODUCT_DISPLAY_NAME, env!("CARGO_PKG_VERSION")),
    )
}

fn header_map(
    headers: &BTreeMap<String, String>,
) -> Result<HashMap<HeaderName, HeaderValue>, String> {
    let mut map = HashMap::new();
    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("Invalid header name {key}"))?;
        let mut value =
            HeaderValue::from_str(value).map_err(|_| format!("Invalid value for header {key}"))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(map)
}

impl Shared {
    fn finish(&self, transport_closed: bool) {
        let by_us = self.closed.is_cancelled();
        let callback = {
            let mut watch = self.watch.lock();
            watch.exited = transport_closed && !by_us;
            watch.callback.take()
        };
        if let Some(callback) = callback
            && transport_closed
            && !by_us
        {
            callback();
        }
    }
}

impl McpClient {
    pub(crate) async fn connect_stdio(
        spec: &StdioSpec,
        timeout: Duration,
    ) -> Result<Self, ConnectFailure> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .env_clear()
            .envs(&spec.env)
            .current_dir(&spec.cwd);
        let (transport, _) = TokioChildProcess::builder(command)
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| ConnectFailure::from(format!("{}: {err}", spec.command)))?;
        Self::serve(transport, timeout, true).await
    }

    pub(crate) async fn connect_http(
        spec: HttpSpec,
        timeout: Duration,
    ) -> Result<Self, ConnectFailure> {
        let config = StreamableHttpClientTransportConfig::with_uri(spec.url.as_str())
            .custom_headers(header_map(&spec.headers)?);
        match spec.auth {
            Some(auth) => {
                Self::serve(
                    StreamableHttpClientTransport::with_client(auth, config),
                    timeout,
                    false,
                )
                .await
            }
            None => {
                Self::serve(
                    StreamableHttpClientTransport::from_config(config),
                    timeout,
                    false,
                )
                .await
            }
        }
    }

    async fn serve<T, E, A>(
        transport: T,
        timeout: Duration,
        stdio: bool,
    ) -> Result<Self, ConnectFailure>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let service = tokio::time::timeout(timeout, client_config().serve(transport))
            .await
            .map_err(|_| ConnectFailure::from(TIMED_OUT.to_owned()))?
            .map_err(|err| {
                let unauthorized = err.is_authorization_required();
                ConnectFailure {
                    challenge: err.auth_challenge().map(str::to_owned),
                    message: if unauthorized {
                        UNAUTHORIZED.to_owned()
                    } else {
                        err.to_string()
                    },
                    unauthorized,
                }
            })?;
        let peer = service.peer().clone();
        let stop = service.cancellation_token();
        let shared = Arc::new(Shared {
            closed: CancellationToken::new(),
            watch: Mutex::new(ExitWatch::default()),
        });
        let watcher = Arc::clone(&shared);
        tokio::spawn(async move {
            let reason = service.waiting().await;
            watcher.finish(matches!(reason, Ok(QuitReason::Closed)));
        });
        Ok(Self {
            shared,
            peer,
            stop: Mutex::new(Some(stop)),
            stdio,
        })
    }

    pub(crate) fn is_stdio(&self) -> bool {
        self.stdio
    }

    pub(crate) fn on_exit(&self, callback: ExitCallback) {
        let fire = {
            let mut watch = self.shared.watch.lock();
            if watch.exited {
                true
            } else {
                watch.callback = Some(Arc::clone(&callback));
                false
            }
        };
        if fire {
            callback();
        }
    }

    pub(crate) fn close(&self) {
        self.shared.closed.cancel();
        let stop = self.stop.lock().take();
        if let Some(stop) = stop {
            stop.cancel();
        }
    }

    pub(crate) async fn list_tools(&self, timeout: Duration) -> Result<Vec<Value>, String> {
        let listed = tokio::time::timeout(timeout, self.peer.list_tools(None))
            .await
            .map_err(|_| TIMED_OUT.to_owned())?
            .map_err(bare_message)?;
        let value = serde_json::to_value(&listed).map_err(|err| err.to_string())?;
        Ok(value
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub(crate) async fn call_tool(
        &self,
        name: &str,
        arguments: Map<String, Value>,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        let params = CallToolRequestParams::new(name.to_owned()).with_arguments(arguments);
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
        let handle = self
            .peer
            .send_request_with_option(request, PeerRequestOptions::no_options())
            .await
            .map_err(bare_message)?;
        let id = handle.id.clone();
        let peer = handle.peer.clone();
        let abandoned = tokio::select! {
            biased;
            answer = handle.await_response() => {
                return match answer {
                    Ok(ServerResult::CallToolResult(result)) => {
                        serde_json::to_value(&result).map_err(|err| err.to_string())
                    }
                    Ok(ServerResult::CustomResult(result)) => Ok(result.0),
                    Ok(_) => Err("Unexpected response type".to_owned()),
                    Err(err) => Err(bare_message(err)),
                };
            }
            () = cancel.cancelled() => "cancelled",
            () = self.shared.closed.cancelled() => CLOSED,
            () = tokio::time::sleep(timeout) => TIMED_OUT,
        };
        let notice = CancelledNotificationParam::new(Some(id), Some(ABANDONED.to_owned()));
        tokio::spawn(async move {
            let _ = peer.notify_cancelled(notice).await;
        });
        Err(abandoned.to_owned())
    }
}
