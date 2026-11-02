use std::fmt;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use reqwest::header::{CONTENT_LENGTH, LOCATION};
use reqwest::redirect::Policy;
use reqwest::{Client, Response, StatusCode, Url};
use sha2::{Digest, Sha256};

use crate::js::js_number;

const DOWNLOAD_MAX_REDIRECTS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadFailure {
    HostNotAllowed,
    RedirectRefused,
    HttpError,
    TooLarge,
}

impl DownloadFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HostNotAllowed => "host-not-allowed",
            Self::RedirectRefused => "redirect-refused",
            Self::HttpError => "http-error",
            Self::TooLarge => "too-large",
        }
    }
}

impl fmt::Display for DownloadFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("{message}")]
    Failed {
        reason: DownloadFailure,
        message: String,
    },
    #[error("invalid url: {0}")]
    InvalidUrl(String),
    #[error("{0}")]
    Network(#[from] reqwest::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl DownloadError {
    pub fn reason(&self) -> Option<DownloadFailure> {
        match self {
            Self::Failed { reason, .. } => Some(*reason),
            Self::InvalidUrl(_) | Self::Network(_) | Self::Io(_) => None,
        }
    }

    fn failed(reason: DownloadFailure, detail: &str) -> Self {
        let message = if detail.is_empty() {
            reason.to_string()
        } else {
            format!("{reason}: {detail}")
        };
        Self::Failed { reason, message }
    }
}

pub fn is_allowed_hop(url: &str, hosts: &[&str], test_base: Option<&str>) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    if let Some(base) = crate::js::non_empty(test_base) {
        return Url::parse(base).is_ok_and(|base| url.origin() == base.origin());
    }
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|host| hosts.contains(&host))
}

#[derive(Clone)]
pub struct DownloadRequest {
    pub url: String,
    pub allowed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub user_agent: String,
}

#[derive(Clone)]
pub struct DownloadTarget {
    pub file: PathBuf,
    pub exclusive: bool,
    pub max_bytes: u64,
    pub on_progress: Arc<dyn Fn(u64, u64) + Send + Sync>,
}

#[derive(Debug)]
pub struct DownloadResponse {
    response: Response,
}

fn hostname(url: &Url) -> &str {
    url.host_str().unwrap_or("")
}

pub async fn follow_allowed(request: &DownloadRequest) -> Result<DownloadResponse, DownloadError> {
    let mut url =
        Url::parse(&request.url).map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
    if !(request.allowed)(url.as_str()) {
        return Err(DownloadError::failed(
            DownloadFailure::HostNotAllowed,
            hostname(&url),
        ));
    }
    let client = Client::builder().redirect(Policy::none()).build()?;
    let mut hop = 0;
    loop {
        let response = client
            .get(url.clone())
            .header(reqwest::header::USER_AGENT, &request.user_agent)
            .send()
            .await?;
        let status = response.status();
        if !status.is_redirection() {
            if status == StatusCode::OK {
                return Ok(DownloadResponse { response });
            }
            return Err(DownloadError::failed(
                DownloadFailure::HttpError,
                &status.as_u16().to_string(),
            ));
        }
        let location = response
            .headers()
            .get(LOCATION)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
            .filter(|value| !value.is_empty());
        drop(response);
        let Some(location) = location else {
            return Err(DownloadError::failed(DownloadFailure::RedirectRefused, ""));
        };
        if hop >= DOWNLOAD_MAX_REDIRECTS {
            return Err(DownloadError::failed(DownloadFailure::RedirectRefused, ""));
        }
        let next = url
            .join(&location)
            .map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
        if !(request.allowed)(next.as_str()) {
            return Err(DownloadError::failed(
                DownloadFailure::RedirectRefused,
                hostname(&next),
            ));
        }
        url = next;
        hop += 1;
    }
}

impl DownloadResponse {
    pub async fn read_capped(mut self, max_bytes: u64) -> Option<String> {
        let mut body: Vec<u8> = Vec::new();
        let mut size: u64 = 0;
        loop {
            let chunk = self.response.chunk().await.ok()?;
            let Some(chunk) = chunk else {
                return Some(String::from_utf8_lossy(&body).into_owned());
            };
            size += chunk.len() as u64;
            if size > max_bytes {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
    }
}

pub async fn download_checked(
    request: &DownloadRequest,
    target: &DownloadTarget,
) -> Result<String, DownloadError> {
    let mut response = follow_allowed(request).await?.response;
    let announced = response.headers().get(CONTENT_LENGTH).map_or(0.0, |value| {
        js_number(&String::from_utf8_lossy(value.as_bytes()))
    });
    if announced > target.max_bytes as f64 {
        return Err(DownloadError::failed(DownloadFailure::TooLarge, ""));
    }
    let total = announced as u64;
    let mut options = OpenOptions::new();
    options.write(true).mode(0o600);
    if target.exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    let mut file = options.open(&target.file)?;
    let mut hash = Sha256::new();
    let mut received: u64 = 0;
    while let Some(chunk) = response.chunk().await? {
        received += chunk.len() as u64;
        if received > target.max_bytes {
            return Err(DownloadError::failed(DownloadFailure::TooLarge, ""));
        }
        hash.update(&chunk);
        (target.on_progress)(received, total);
        file.write_all(&chunk)?;
    }
    file.flush()?;
    Ok(hex::encode(hash.finalize()))
}
