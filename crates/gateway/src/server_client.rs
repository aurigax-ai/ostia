use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::DateTime;
use ostia_base::js::js_number;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Response, StatusCode, redirect};
use serde_json::Value;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_AFTER_MAX_SECONDS: f64 = 5.0;
const JSON_TYPE: &str = "application/json";
const BYTES_TYPE: &str = "application/octet-stream";

pub type BaseUrl = Arc<dyn Fn() -> Option<String> + Send + Sync>;
pub type Pause = Arc<dyn Fn(Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub type ServerTimeSink = Arc<dyn Fn(i64) + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct ServerError {
    pub status: u16,
    pub code: String,
    pub retry_after: Option<f64>,
    pub server_time: Option<i64>,
}

impl ServerError {
    pub fn new(status: u16, code: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            retry_after: None,
            server_time: None,
        }
    }
}

impl fmt::Display for ServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.status, self.code)
    }
}

impl std::error::Error for ServerError {}

#[derive(Clone, Debug, PartialEq)]
pub struct Answered {
    pub status: u16,
    pub body: Option<Value>,
}

#[derive(Clone, Default)]
pub struct RequestOptions {
    pub body: Option<Value>,
    pub json: Option<String>,
    pub reports_time: bool,
    pub bytes: Option<Vec<u8>>,
    pub token: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub no_rate_limit_retry: bool,
}

impl fmt::Debug for RequestOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestOptions")
            .field("reports_time", &self.reports_time)
            .field("no_rate_limit_retry", &self.no_rate_limit_retry)
            .finish_non_exhaustive()
    }
}

pub struct ServerClientDeps {
    pub base_url: BaseUrl,
    pub timeout: Duration,
    pub pause: Pause,
    pub on_server_time: Option<ServerTimeSink>,
}

#[derive(Clone)]
pub struct ServerClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: Option<reqwest::Client>,
    deps: ServerClientDeps,
}

impl fmt::Debug for ServerClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerClient")
            .finish_non_exhaustive()
    }
}

pub fn sleep_pause() -> Pause {
    Arc::new(
        |wait: Duration| -> Pin<Box<dyn Future<Output = ()> + Send>> {
            Box::pin(tokio::time::sleep(wait))
        },
    )
}

fn unreachable_error() -> ServerError {
    ServerError::new(0, "unreachable")
}

fn retry_after_of(response: &Response) -> Option<f64> {
    let text = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let seconds = js_number(text);
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

fn parse_http_date(text: &str) -> Option<i64> {
    let text = text.trim();
    let clock = text.split_once(',').map_or(text, |(_, rest)| rest.trim());
    DateTime::parse_from_rfc2822(clock)
        .or_else(|_| DateTime::parse_from_rfc3339(text))
        .ok()
        .map(|moment| moment.timestamp_millis())
}

fn server_time_of(response: &Response) -> Option<i64> {
    let text = response.headers().get("date")?.to_str().ok()?;
    parse_http_date(text)
}

async fn failure_of(response: Response) -> ServerError {
    let status = response.status().as_u16();
    let retry_after = retry_after_of(&response);
    let server_time = server_time_of(&response);
    let body = response
        .bytes()
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let code = match body {
        Some(Value::Object(body)) => body
            .get("error")
            .and_then(Value::as_str)
            .map_or_else(|| "failed".to_owned(), str::to_owned),
        _ => "failed".to_owned(),
    };
    ServerError {
        status,
        code,
        retry_after,
        server_time,
    }
}

fn is_redirect(response: &Response) -> bool {
    matches!(
        response.status(),
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn header_pair(name: &str, value: &str) -> Option<(HeaderName, HeaderValue)> {
    Some((
        HeaderName::from_bytes(name.as_bytes()).ok()?,
        HeaderValue::from_str(value).ok()?,
    ))
}

fn headers_of(options: &RequestOptions) -> Option<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static(JSON_TYPE));
    for (name, value) in &options.headers {
        let (name, value) = header_pair(name, value)?;
        headers.insert(name, value);
    }
    if options.body.is_some() || options.json.is_some() {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(JSON_TYPE));
    }
    if options.bytes.is_some() {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(BYTES_TYPE));
    }
    if let Some(token) = options.token.as_deref().filter(|token| !token.is_empty()) {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    Some(headers)
}

fn body_of(options: &RequestOptions) -> Option<Vec<u8>> {
    if let Some(bytes) = &options.bytes {
        return Some(bytes.clone());
    }
    if let Some(json) = &options.json {
        return Some(json.clone().into_bytes());
    }
    options
        .body
        .as_ref()
        .map(|body| body.to_string().into_bytes())
}

impl ServerClient {
    pub fn new(deps: ServerClientDeps) -> Self {
        let http = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .no_proxy()
            .build()
            .ok();
        Self {
            inner: Arc::new(Inner { http, deps }),
        }
    }

    pub fn origin(&self) -> Result<String, ServerError> {
        (self.inner.deps.base_url)()
            .filter(|url| !url.is_empty())
            .ok_or_else(|| ServerError::new(0, "no-server"))
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        options: &RequestOptions,
    ) -> Result<Response, ServerError> {
        let headers = headers_of(options);
        let base = self.origin()?;
        let (Some(http), Some(headers), Ok(method)) = (
            &self.inner.http,
            headers,
            Method::from_bytes(method.as_bytes()),
        ) else {
            return Err(unreachable_error());
        };
        let mut request = http
            .request(method, format!("{base}{path}"))
            .headers(headers)
            .timeout(self.inner.deps.timeout);
        if let Some(body) = body_of(options) {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|_| unreachable_error())?;
        if is_redirect(&response) {
            return Err(unreachable_error());
        }
        Ok(response)
    }

    async fn answer(
        &self,
        method: &str,
        path: &str,
        options: &RequestOptions,
    ) -> Result<Response, ServerError> {
        let mut response = self.send(method, path, options).await?;
        let retry_wait = (response.status() == StatusCode::TOO_MANY_REQUESTS
            && !options.no_rate_limit_retry)
            .then(|| retry_after_of(&response))
            .flatten()
            .filter(|wait| *wait <= RETRY_AFTER_MAX_SECONDS);
        if let Some(wait) = retry_wait {
            (self.inner.deps.pause)(Duration::from_secs_f64(wait)).await;
            response = self.send(method, path, options).await?;
        }
        if !response.status().is_success() {
            return Err(failure_of(response).await);
        }
        let served = options
            .reports_time
            .then(|| server_time_of(&response))
            .flatten();
        if let (Some(served), Some(sink)) = (served, &self.inner.deps.on_server_time) {
            sink(served);
        }
        Ok(response)
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        options: &RequestOptions,
    ) -> Result<Option<Value>, ServerError> {
        self.exchange(method, path, options)
            .await
            .map(|answered| answered.body)
    }

    pub async fn exchange(
        &self,
        method: &str,
        path: &str,
        options: &RequestOptions,
    ) -> Result<Answered, ServerError> {
        let response = self.answer(method, path, options).await?;
        let status = response.status();
        if status == StatusCode::NO_CONTENT {
            return Ok(Answered {
                status: 204,
                body: None,
            });
        }
        let bad_response = || ServerError::new(status.as_u16(), "bad-response");
        let text = response.text().await.map_err(|_| bad_response())?;
        if text.is_empty() {
            return Ok(Answered {
                status: status.as_u16(),
                body: None,
            });
        }
        let body = serde_json::from_str(&text).map_err(|_| bad_response())?;
        Ok(Answered {
            status: status.as_u16(),
            body: Some(body),
        })
    }

    pub async fn request_bytes(
        &self,
        method: &str,
        path: &str,
        options: &RequestOptions,
    ) -> Result<Vec<u8>, ServerError> {
        let response = self.answer(method, path, options).await?;
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(Vec::new());
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|_| unreachable_error())
    }
}
