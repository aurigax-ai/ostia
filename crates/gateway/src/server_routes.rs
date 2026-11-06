use std::collections::BTreeMap;
use std::fmt;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::device_keys::Registration;
use crate::server_client::{RequestOptions, ServerClient, ServerError};

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn encode_component(text: &str) -> String {
    utf8_percent_encode(text, URI_COMPONENT).to_string()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    Link,
    Password,
    Public,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WrapSlot {
    Passphrase,
    Recovery,
}

impl WrapSlot {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passphrase => "passphrase",
            Self::Recovery => "recovery",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ServerModules {
    pub relay: bool,
    pub publish: bool,
    pub sync: bool,
    pub push: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ServerAuth {
    pub invite: bool,
    pub github: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLimits {
    pub share_max_bytes: Option<i64>,
    pub allow_public: Option<bool>,
    pub allow_never: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub api: i64,
    pub modules: ServerModules,
    pub auth: ServerAuth,
    pub device_inactive_after_seconds: Option<i64>,
    pub relay_domain: String,
    pub limits: Option<ServerLimits>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCreated {
    pub id: String,
    pub url: String,
    pub upload_url: String,
    pub delete_token: String,
    pub expires_at: i64,
}

impl fmt::Debug for ShareCreated {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShareCreated")
            .field("id", &self.id)
            .field("url", &self.url)
            .field("upload_url", &self.upload_url)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRow {
    pub id: String,
    pub url: String,
    pub mode: ShareMode,
    pub size: i64,
    pub views: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub uploaded: bool,
    pub expired: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ShareList {
    pub shares: Vec<ShareRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareBody {
    pub mode: ShareMode,
    pub size: u64,
    pub expires_in_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistered {
    pub account_id: String,
    pub device_id: String,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubFlow {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: i64,
    pub expires_in: i64,
}

#[derive(Clone, Debug)]
pub enum GithubPolled {
    Pending { interval: i64 },
    Registered(DeviceRegistered),
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGrant {
    pub token: String,
    pub expires_at: i64,
    pub account_id: String,
}

impl fmt::Debug for SessionGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionGrant")
            .field("expires_at", &self.expires_at)
            .field("account_id", &self.account_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestView {
    pub version: i64,
    pub key_version: i64,
    pub blob: String,
    pub updated_at: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTicket {
    pub ticket: String,
    pub expires_at: i64,
}

impl fmt::Debug for PushTicket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PushTicket")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct RelayLabel {
    pub label: String,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestVersion {
    pub version: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotatedVersions {
    pub version: i64,
    pub key_version: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Collected {
    pub deleted: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WrapBlob {
    pub slot: String,
    pub blob: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Nonce {
    pub nonce: String,
}

#[derive(Clone, Debug)]
pub enum DeleteShareAuth {
    Token(String),
    DeleteToken(String),
}

#[derive(Serialize)]
struct InviteBody<'a> {
    code: &'a str,
    name: &'a str,
    #[serde(flatten)]
    registration: &'a Registration,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PollBody<'a> {
    flow_id: &'a str,
    name: &'a str,
    #[serde(flatten)]
    registration: &'a Registration,
}

fn bad_response() -> ServerError {
    ServerError::new(200, "bad-response")
}

fn body_of(body: &impl Serialize) -> Result<Value, ServerError> {
    serde_json::to_value(body).map_err(|_| bad_response())
}

fn decode<T: DeserializeOwned>(answer: Option<Value>) -> Result<T, ServerError> {
    serde_json::from_value(answer.unwrap_or(Value::Null)).map_err(|_| bad_response())
}

fn signed_headers(if_match: &str, signed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::from([("If-Match".to_owned(), if_match.to_owned())]);
    headers.extend(
        signed
            .iter()
            .map(|(name, value)| (name.clone(), value.clone())),
    );
    headers
}

#[derive(Clone, Debug)]
pub struct ServerRoutes {
    client: ServerClient,
}

impl ServerRoutes {
    pub fn new(client: ServerClient) -> Self {
        Self { client }
    }

    async fn fetch<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        options: RequestOptions,
    ) -> Result<T, ServerError> {
        decode(self.client.request(method, path, &options).await?)
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        options: RequestOptions,
    ) -> Result<(), ServerError> {
        self.client.request(method, path, &options).await.map(drop)
    }

    pub async fn info(&self) -> Result<ServerInfo, ServerError> {
        self.fetch("GET", "/v1/info", RequestOptions::default())
            .await
    }

    pub async fn register_with_invite(
        &self,
        code: &str,
        name: &str,
        registration: &Registration,
    ) -> Result<DeviceRegistered, ServerError> {
        let body = body_of(&InviteBody {
            code,
            name,
            registration,
        })?;
        self.fetch(
            "POST",
            "/v1/auth/invite",
            RequestOptions {
                body: Some(body),
                reports_time: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn github_device(&self) -> Result<GithubFlow, ServerError> {
        self.fetch("POST", "/v1/auth/github/device", RequestOptions::default())
            .await
    }

    pub async fn github_poll(
        &self,
        flow_id: &str,
        name: &str,
        registration: &Registration,
    ) -> Result<GithubPolled, ServerError> {
        let body = body_of(&PollBody {
            flow_id,
            name,
            registration,
        })?;
        let answer: Value = self
            .fetch(
                "POST",
                "/v1/auth/github/poll",
                RequestOptions {
                    body: Some(body),
                    reports_time: true,
                    ..Default::default()
                },
            )
            .await?;
        let pending = answer
            .as_object()
            .filter(|fields| fields.get("status").and_then(Value::as_str) == Some("pending"));
        match pending {
            Some(fields) => {
                let interval = fields
                    .get("interval")
                    .and_then(Value::as_i64)
                    .ok_or_else(bad_response)?;
                Ok(GithubPolled::Pending { interval })
            }
            None => decode(Some(answer)).map(GithubPolled::Registered),
        }
    }

    pub async fn challenge(&self, device_id: &str) -> Result<Nonce, ServerError> {
        self.fetch(
            "POST",
            "/v1/auth/challenge",
            RequestOptions {
                body: Some(json!({"deviceId": device_id})),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn verify(
        &self,
        device_id: &str,
        nonce: &str,
        sig: &str,
    ) -> Result<SessionGrant, ServerError> {
        self.fetch(
            "POST",
            "/v1/auth/verify",
            RequestOptions {
                body: Some(json!({"deviceId": device_id, "nonce": nonce, "sig": sig})),
                reports_time: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn end_session(&self, token: &str) -> Result<(), ServerError> {
        self.send(
            "DELETE",
            "/v1/auth/session",
            RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn heartbeat(&self, token: &str) -> Result<(), ServerError> {
        self.send(
            "POST",
            "/v1/devices/heartbeat",
            RequestOptions {
                token: Some(token.to_owned()),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn manifest(&self, token: &str) -> Result<ManifestView, ServerError> {
        self.fetch(
            "GET",
            "/v1/sync/manifest",
            RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn put_manifest(
        &self,
        token: &str,
        json: &str,
        if_match: &str,
        signed: &BTreeMap<String, String>,
    ) -> Result<ManifestVersion, ServerError> {
        self.fetch(
            "PUT",
            "/v1/sync/manifest",
            RequestOptions {
                token: Some(token.to_owned()),
                json: Some(json.to_owned()),
                headers: signed_headers(if_match, signed),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn blob(&self, token: &str, id: &str) -> Result<Vec<u8>, ServerError> {
        self.client
            .request_bytes(
                "GET",
                &format!("/v1/sync/blobs/{id}"),
                &RequestOptions {
                    token: Some(token.to_owned()),
                    ..Default::default()
                },
            )
            .await
    }

    pub async fn put_blob(&self, token: &str, id: &str, bytes: &[u8]) -> Result<(), ServerError> {
        self.send(
            "PUT",
            &format!("/v1/sync/blobs/{id}"),
            RequestOptions {
                token: Some(token.to_owned()),
                bytes: Some(bytes.to_vec()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn secret_wrap(
        &self,
        token: &str,
        slot: WrapSlot,
        headers: &BTreeMap<String, String>,
    ) -> Result<WrapBlob, ServerError> {
        self.fetch(
            "GET",
            &format!("/v1/sync/wraps/{}", slot.as_str()),
            RequestOptions {
                token: Some(token.to_owned()),
                headers: headers.clone(),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn rotate(
        &self,
        token: &str,
        json: &str,
        if_match: &str,
        signed: &BTreeMap<String, String>,
    ) -> Result<RotatedVersions, ServerError> {
        self.fetch(
            "POST",
            "/v1/sync/rotate",
            RequestOptions {
                token: Some(token.to_owned()),
                json: Some(json.to_owned()),
                headers: signed_headers(if_match, signed),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn gc(
        &self,
        token: &str,
        json: &str,
        if_match: &str,
        signed: &BTreeMap<String, String>,
    ) -> Result<Collected, ServerError> {
        self.fetch(
            "POST",
            "/v1/sync/gc",
            RequestOptions {
                token: Some(token.to_owned()),
                json: Some(json.to_owned()),
                headers: signed_headers(if_match, signed),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn create_share(
        &self,
        token: &str,
        body: &CreateShareBody,
    ) -> Result<ShareCreated, ServerError> {
        self.fetch(
            "POST",
            "/v1/shares",
            RequestOptions {
                token: Some(token.to_owned()),
                body: Some(body_of(body)?),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn upload_share(
        &self,
        token: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<(), ServerError> {
        self.send(
            "PUT",
            path,
            RequestOptions {
                token: Some(token.to_owned()),
                bytes: Some(bytes.to_vec()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn shares(&self, token: &str) -> Result<ShareList, ServerError> {
        self.fetch(
            "GET",
            "/v1/shares",
            RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn delete_share(&self, id: &str, auth: &DeleteShareAuth) -> Result<(), ServerError> {
        let options = match auth {
            DeleteShareAuth::Token(token) => RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
            DeleteShareAuth::DeleteToken(delete_token) => RequestOptions {
                headers: BTreeMap::from([("X-Delete-Token".to_owned(), delete_token.clone())]),
                ..Default::default()
            },
        };
        self.send(
            "DELETE",
            &format!("/v1/shares/{}", encode_component(id)),
            options,
        )
        .await
    }

    pub async fn push_ticket(&self, token: &str) -> Result<PushTicket, ServerError> {
        self.fetch(
            "POST",
            "/v1/push/tickets",
            RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn push_ping(&self, token: &str, handle: &str) -> Result<(), ServerError> {
        self.send(
            "POST",
            &format!("/v1/push/{}", encode_component(handle)),
            RequestOptions {
                token: Some(token.to_owned()),
                no_rate_limit_retry: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn push_delete(&self, token: &str, handle: &str) -> Result<(), ServerError> {
        self.send(
            "DELETE",
            &format!("/v1/push/{}", encode_component(handle)),
            RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn relay_label(&self, token: &str) -> Result<RelayLabel, ServerError> {
        self.fetch(
            "POST",
            "/v1/relay/label",
            RequestOptions {
                token: Some(token.to_owned()),
                ..Default::default()
            },
        )
        .await
    }
}
