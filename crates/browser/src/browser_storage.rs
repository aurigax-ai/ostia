use std::future::Future;
use std::sync::Arc;

use ostia_base::js::JsNumber;
use ostia_contract::browser_storage::{
    BrowserStorageRead, BrowserStorageSnapshot, CookieSameSite, StorageCookie, StorageEdit,
    StorageEntry, StorageKind, StorageRemoval, StorageWriteResult, cookie_url, entries_of,
    normalize_storage_edit, normalize_storage_removal,
};
use ostia_rpc::is_falsy;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::browse_world::js_args;

const NOT_AN_OBJECT: &str = "Cannot convert undefined or null to object";

#[derive(Clone, Debug, PartialEq)]
pub struct ElectronCookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub host_only: Option<bool>,
    pub path: Option<String>,
    pub secure: Option<bool>,
    pub http_only: Option<bool>,
    pub session: bool,
    pub expiration_date: Option<f64>,
    pub same_site: Option<CookieSameSite>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieDetails {
    pub url: String,
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: CookieSameSite,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<JsNumber>,
}

pub trait StorageGuest: Send + Sync {
    fn cookies(
        &self,
        filter: &Value,
    ) -> impl Future<Output = Result<Vec<ElectronCookie>, String>> + Send;

    fn set_cookie(&self, details: CookieDetails)
    -> impl Future<Output = Result<(), String>> + Send;

    fn remove_cookie(
        &self,
        url: &str,
        name: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;

    fn clear_cookies(&self) -> impl Future<Output = Result<(), String>> + Send;

    fn run_in_browse_world(
        &self,
        expression: &str,
    ) -> impl Future<Output = Result<Value, String>> + Send;
}

pub fn to_storage_cookie(cookie: &ElectronCookie) -> StorageCookie {
    StorageCookie {
        name: cookie.name.clone(),
        value: cookie.value.clone(),
        domain: cookie.domain.clone().unwrap_or_default(),
        path: cookie.path.clone().unwrap_or_else(|| "/".to_owned()),
        host_only: cookie.host_only == Some(true),
        expires: match cookie.expiration_date {
            Some(date) if !cookie.session => Some(JsNumber(date)),
            _ => None,
        },
        http_only: cookie.http_only == Some(true),
        secure: cookie.secure == Some(true),
        same_site: cookie.same_site.unwrap_or(CookieSameSite::Unspecified),
    }
}

pub async fn list_cookies<G: StorageGuest>(
    guest: &G,
    filter: &Value,
) -> Result<Vec<StorageCookie>, String> {
    let cookies = guest.cookies(filter).await?;
    Ok(cookies.iter().map(to_storage_cookie).collect())
}

pub async fn read_web_storage<G: StorageGuest>(guest: &G) -> Result<Value, String> {
    guest.run_in_browse_world("storage()").await
}

fn entries_from(web: &Value, key: &str) -> Result<Vec<StorageEntry>, String> {
    match web.get(key) {
        None | Some(Value::Null) => Err(NOT_AN_OBJECT.to_owned()),
        Some(Value::Object(record)) => Ok(entries_of(record)),
        Some(_) => Ok(entries_of(&Map::new())),
    }
}

pub async fn read_storage<G: StorageGuest>(guest: &G) -> Result<BrowserStorageSnapshot, String> {
    let (cookies, web) =
        tokio::try_join!(list_cookies(guest, &json!({})), read_web_storage(guest))?;
    Ok(BrowserStorageSnapshot {
        origin: web
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        cookies,
        local: entries_from(&web, "local")?,
        session: entries_from(&web, "session")?,
    })
}

pub async fn write_cookie<G: StorageGuest>(
    guest: &G,
    cookie: &StorageCookie,
) -> Result<(), String> {
    guest
        .set_cookie(CookieDetails {
            url: cookie_url(&cookie.domain, &cookie.path, cookie.secure),
            name: cookie.name.clone(),
            value: cookie.value.clone(),
            domain: (!cookie.host_only).then(|| cookie.domain.clone()),
            path: cookie.path.clone(),
            secure: cookie.secure,
            http_only: cookie.http_only,
            same_site: cookie.same_site,
            expiration_date: cookie.expires,
        })
        .await
}

fn storage_failed(message: &str) -> Value {
    json!({"ok": false, "error": "storage-failed", "message": message})
}

fn settled(result: Result<Value, String>) -> Value {
    result.unwrap_or_else(|message| storage_failed(&message))
}

pub async fn write_storage<G: StorageGuest>(guest: &G, edit: &StorageEdit) -> Value {
    match edit {
        StorageEdit::Cookie(cookie) => settled(
            write_cookie(guest, cookie)
                .await
                .map(|()| json!({"ok": true})),
        ),
        StorageEdit::Entry { kind, key, value } => {
            let args = js_args(&[json!(kind.as_str()), json!(key), json!(value)]);
            settled(
                guest
                    .run_in_browse_world(&format!("setStorage({args})"))
                    .await,
            )
        }
    }
}

pub async fn remove_storage<G: StorageGuest>(guest: &G, removal: &StorageRemoval) -> Value {
    match removal {
        StorageRemoval::Cookie(cookie) => settled(
            guest
                .remove_cookie(
                    &cookie_url(&cookie.domain, &cookie.path, cookie.secure),
                    &cookie.name,
                )
                .await
                .map(|()| json!({"ok": true})),
        ),
        StorageRemoval::Entry { kind, key } => {
            let args = js_args(&[json!(kind.as_str()), json!(key)]);
            settled(
                guest
                    .run_in_browse_world(&format!("removeStorage({args})"))
                    .await,
            )
        }
    }
}

pub async fn clear_storage<G: StorageGuest>(guest: &G, kind: StorageKind) -> Value {
    match kind {
        StorageKind::Cookies => settled(guest.clear_cookies().await.map(|()| json!({"ok": true}))),
        StorageKind::Local | StorageKind::Session => {
            let args = js_args(&[json!(kind.as_str())]);
            settled(
                guest
                    .run_in_browse_world(&format!("clearStorage({args})"))
                    .await,
            )
        }
    }
}

fn as_write_result(outcome: &Value) -> StorageWriteResult {
    if !is_falsy(outcome.get("ok").unwrap_or(&Value::Null)) {
        return StorageWriteResult::Written;
    }
    let detail = outcome
        .get("message")
        .filter(|message| !message.is_null())
        .or_else(|| outcome.get("error"));
    StorageWriteResult::Failed(
        detail
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

fn not_ready() -> StorageWriteResult {
    StorageWriteResult::Failed("browser-not-ready".to_owned())
}

fn invalid_entry() -> StorageWriteResult {
    StorageWriteResult::Failed("invalid-entry".to_owned())
}

type OwnedGuestLookup<G> = Arc<dyn Fn(&str, &str) -> Option<Arc<G>> + Send + Sync>;

pub struct BrowserStorageIpc<G> {
    owned_guest: OwnedGuestLookup<G>,
}

impl<G: StorageGuest + 'static> BrowserStorageIpc<G> {
    pub fn new(owned_guest: impl Fn(&str, &str) -> Option<Arc<G>> + Send + Sync + 'static) -> Self {
        Self {
            owned_guest: Arc::new(owned_guest),
        }
    }

    pub async fn storage_read(&self, pane_id: &str, window_id: &str) -> BrowserStorageRead {
        let Some(guest) = (self.owned_guest)(pane_id, window_id) else {
            return BrowserStorageRead::Failed("browser-not-ready".to_owned());
        };
        match read_storage(&*guest).await {
            Ok(snapshot) => BrowserStorageRead::Snapshot(snapshot),
            Err(error) => BrowserStorageRead::Failed(error),
        }
    }

    pub async fn storage_set(
        &self,
        pane_id: &str,
        window_id: &str,
        raw: &Value,
    ) -> StorageWriteResult {
        let Some(guest) = (self.owned_guest)(pane_id, window_id) else {
            return not_ready();
        };
        let Some(edit) = normalize_storage_edit(raw) else {
            return invalid_entry();
        };
        as_write_result(&write_storage(&*guest, &edit).await)
    }

    pub async fn storage_remove(
        &self,
        pane_id: &str,
        window_id: &str,
        raw: &Value,
    ) -> StorageWriteResult {
        let Some(guest) = (self.owned_guest)(pane_id, window_id) else {
            return not_ready();
        };
        let Some(removal) = normalize_storage_removal(raw) else {
            return invalid_entry();
        };
        as_write_result(&remove_storage(&*guest, &removal).await)
    }

    pub async fn storage_clear(
        &self,
        pane_id: &str,
        window_id: &str,
        kind: &Value,
    ) -> StorageWriteResult {
        let Some(guest) = (self.owned_guest)(pane_id, window_id) else {
            return not_ready();
        };
        let Some(kind) = StorageKind::parse(kind) else {
            return invalid_entry();
        };
        as_write_result(&clear_storage(&*guest, kind).await)
    }
}
