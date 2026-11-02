#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_browser::browser_storage::{
    BrowserStorageIpc, CookieDetails, ElectronCookie, StorageGuest, clear_storage, list_cookies,
    read_storage, remove_storage, to_storage_cookie, write_storage,
};
use ostia_contract::browser_storage::{
    CookieSameSite, StorageKind, normalize_storage_edit, normalize_storage_removal,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

fn electron_cookie() -> ElectronCookie {
    ElectronCookie {
        name: "sid".to_owned(),
        value: "abc".to_owned(),
        domain: Some("app.test".to_owned()),
        host_only: Some(true),
        path: Some("/".to_owned()),
        secure: Some(true),
        http_only: Some(true),
        session: false,
        expiration_date: Some(2_000_000_000.0),
        same_site: Some(CookieSameSite::Lax),
    }
}

struct FakeGuest {
    scripts: Mutex<Vec<String>>,
    web: Value,
    world_result: Mutex<Option<Result<Value, String>>>,
    cookie_filters: Mutex<Vec<Value>>,
    cookies_set: Mutex<Vec<Value>>,
    cookies_removed: Mutex<Vec<(String, String)>>,
    cookies_cleared: Mutex<usize>,
    cookie_failure: Mutex<Option<String>>,
    cookie_list_failure: Mutex<Option<String>>,
}

impl FakeGuest {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            scripts: Mutex::new(Vec::new()),
            web: json!({"origin": "https://app.test", "local": {"b": "2", "a": "1"}, "session": {}}),
            world_result: Mutex::new(None),
            cookie_filters: Mutex::new(Vec::new()),
            cookies_set: Mutex::new(Vec::new()),
            cookies_removed: Mutex::new(Vec::new()),
            cookies_cleared: Mutex::new(0),
            cookie_failure: Mutex::new(None),
            cookie_list_failure: Mutex::new(None),
        })
    }

    fn scripts(&self) -> Vec<String> {
        self.scripts.lock().clone()
    }

    fn cookie_failure(&self) -> Result<(), String> {
        match self.cookie_failure.lock().clone() {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }
}

impl StorageGuest for FakeGuest {
    async fn cookies(&self, filter: &Value) -> Result<Vec<ElectronCookie>, String> {
        self.cookie_filters.lock().push(filter.clone());
        if let Some(message) = self.cookie_list_failure.lock().clone() {
            return Err(message);
        }
        Ok(vec![electron_cookie()])
    }

    async fn set_cookie(&self, details: CookieDetails) -> Result<(), String> {
        self.cookie_failure()?;
        self.cookies_set
            .lock()
            .push(serde_json::to_value(&details).unwrap());
        Ok(())
    }

    async fn remove_cookie(&self, url: &str, name: &str) -> Result<(), String> {
        self.cookie_failure()?;
        self.cookies_removed
            .lock()
            .push((url.to_owned(), name.to_owned()));
        Ok(())
    }

    async fn clear_cookies(&self) -> Result<(), String> {
        self.cookie_failure()?;
        *self.cookies_cleared.lock() += 1;
        Ok(())
    }

    async fn run_in_browse_world(&self, expression: &str) -> Result<Value, String> {
        self.scripts.lock().push(expression.to_owned());
        if let Some(result) = self.world_result.lock().clone() {
            return result;
        }
        if expression == "storage()" {
            return Ok(self.web.clone());
        }
        Ok(json!({"ok": true}))
    }
}

fn cookie_edit(overrides: Value) -> ostia_contract::browser_storage::StorageEdit {
    let mut cookie = json!({
        "name": "sid", "value": "abc", "domain": "app.test", "path": "/",
        "hostOnly": true, "expires": 2_000_000_000, "httpOnly": true, "secure": true,
        "sameSite": "lax"
    });
    for (key, value) in overrides.as_object().unwrap() {
        cookie[key] = value.clone();
    }
    normalize_storage_edit(&json!({"kind": "cookies", "cookie": cookie})).unwrap()
}

fn web_edit(kind: &str, key: &str, value: &str) -> ostia_contract::browser_storage::StorageEdit {
    normalize_storage_edit(&json!({"kind": kind, "key": key, "value": value})).unwrap()
}

#[test]
fn keeps_the_flags_the_viewer_shows_and_turns_a_session_cookie_expiry_into_null() {
    let cookie = serde_json::to_value(to_storage_cookie(&electron_cookie())).unwrap();
    assert_eq!(cookie["name"], "sid");
    assert_eq!(cookie["value"], "abc");
    assert_eq!(cookie["domain"], "app.test");
    assert_eq!(cookie["path"], "/");
    assert_eq!(cookie["hostOnly"], true);
    assert_eq!(cookie["expires"].as_f64(), Some(2_000_000_000.0));
    assert_eq!(cookie["httpOnly"], true);
    assert_eq!(cookie["secure"], true);
    assert_eq!(cookie["sameSite"], "lax");
    let keys: Vec<&str> = cookie
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "name", "value", "domain", "path", "hostOnly", "expires", "httpOnly", "secure",
            "sameSite"
        ]
    );
    let session = ElectronCookie {
        session: true,
        ..electron_cookie()
    };
    let session = serde_json::to_value(to_storage_cookie(&session)).unwrap();
    assert_eq!(session["expires"], Value::Null);
}

#[test]
fn fills_the_flags_a_cookie_does_not_carry_with_the_safe_defaults() {
    let bare = ElectronCookie {
        name: "n".to_owned(),
        value: "v".to_owned(),
        domain: None,
        host_only: None,
        path: None,
        secure: None,
        http_only: None,
        session: false,
        expiration_date: None,
        same_site: None,
    };
    let cookie = serde_json::to_value(to_storage_cookie(&bare)).unwrap();
    assert_eq!(cookie["domain"], "");
    assert_eq!(cookie["path"], "/");
    assert_eq!(cookie["hostOnly"], false);
    assert_eq!(cookie["expires"], Value::Null);
    assert_eq!(cookie["httpOnly"], false);
    assert_eq!(cookie["secure"], false);
    assert_eq!(cookie["sameSite"], "unspecified");
}

#[tokio::test]
async fn lists_the_cookies_of_the_partition_with_the_filter() {
    let guest = FakeGuest::new();
    let cookies = list_cookies(&*guest, &json!({"name": "sid"}))
        .await
        .unwrap();
    assert_eq!(cookies.len(), 1);
    assert_eq!(*guest.cookie_filters.lock(), [json!({"name": "sid"})]);
}

#[tokio::test]
async fn reads_the_partition_cookies_and_the_page_origin_web_storage_from_the_browse_world() {
    let guest = FakeGuest::new();
    let snapshot = serde_json::to_value(read_storage(&*guest).await.unwrap()).unwrap();
    assert_eq!(*guest.cookie_filters.lock(), [json!({})]);
    assert_eq!(snapshot["origin"], "https://app.test");
    let names: Vec<&Value> = snapshot["cookies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cookie| &cookie["name"])
        .collect();
    assert_eq!(names, [&json!("sid")]);
    assert_eq!(
        snapshot["local"],
        json!([{"key": "a", "value": "1"}, {"key": "b", "value": "2"}])
    );
    assert_eq!(snapshot["session"], json!([]));
    assert_eq!(guest.scripts(), ["storage()"]);
}

#[tokio::test]
async fn fails_the_read_when_the_cookies_cannot_be_listed() {
    let guest = FakeGuest::new();
    *guest.cookie_list_failure.lock() = Some("no jar".to_owned());
    assert_eq!(read_storage(&*guest).await.unwrap_err(), "no jar");
}

#[tokio::test]
async fn fails_the_read_when_the_page_cannot_run_the_script() {
    let guest = FakeGuest::new();
    *guest.world_result.lock() = Some(Err("page gone".to_owned()));
    assert_eq!(read_storage(&*guest).await.unwrap_err(), "page gone");
}

#[tokio::test]
async fn sets_a_host_only_cookie_without_a_domain_so_it_stays_host_only() {
    let guest = FakeGuest::new();
    let edit = cookie_edit(json!({"value": "new"}));
    assert_eq!(write_storage(&*guest, &edit).await, json!({"ok": true}));
    let set = guest.cookies_set.lock().clone();
    assert_eq!(set.len(), 1);
    assert_eq!(set[0]["url"], "https://app.test/");
    assert_eq!(set[0]["name"], "sid");
    assert_eq!(set[0]["value"], "new");
    assert!(set[0].get("domain").is_none());
    assert_eq!(set[0]["path"], "/");
    assert_eq!(set[0]["secure"], true);
    assert_eq!(set[0]["httpOnly"], true);
    assert_eq!(set[0]["sameSite"], "lax");
    assert_eq!(set[0]["expirationDate"].as_f64(), Some(2_000_000_000.0));
}

#[tokio::test]
async fn keeps_the_domain_of_a_domain_cookie() {
    let guest = FakeGuest::new();
    let edit = cookie_edit(json!({"hostOnly": false, "domain": ".app.test"}));
    write_storage(&*guest, &edit).await;
    let set = guest.cookies_set.lock().clone();
    assert_eq!(set[0]["url"], "https://app.test/");
    assert_eq!(set[0]["domain"], ".app.test");
}

#[tokio::test]
async fn sets_a_session_cookie_without_an_expiry() {
    let guest = FakeGuest::new();
    let edit = cookie_edit(json!({"expires": null}));
    write_storage(&*guest, &edit).await;
    assert!(guest.cookies_set.lock()[0].get("expirationDate").is_none());
}

#[tokio::test]
async fn writes_web_storage_through_the_isolated_browse_world() {
    let guest = FakeGuest::new();
    write_storage(&*guest, &web_edit("session", "k", "v")).await;
    assert_eq!(guest.scripts(), [r#"setStorage("session", "k", "v")"#]);
}

#[tokio::test]
async fn reports_a_failure_instead_of_throwing() {
    let guest = FakeGuest::new();
    *guest.cookie_failure.lock() = Some("bad cookie".to_owned());
    assert_eq!(
        write_storage(&*guest, &cookie_edit(json!({}))).await,
        json!({"ok": false, "error": "storage-failed", "message": "bad cookie"})
    );
}

#[tokio::test]
async fn reports_a_web_storage_script_that_cannot_run_as_a_storage_failure() {
    let guest = FakeGuest::new();
    *guest.world_result.lock() = Some(Err("page gone".to_owned()));
    assert_eq!(
        write_storage(&*guest, &web_edit("local", "k", "v")).await,
        json!({"ok": false, "error": "storage-failed", "message": "page gone"})
    );
}

#[tokio::test]
async fn passes_on_what_the_page_answers_to_a_web_storage_write() {
    let guest = FakeGuest::new();
    *guest.world_result.lock() = Some(Ok(json!({"ok": false, "error": "quota"})));
    assert_eq!(
        write_storage(&*guest, &web_edit("local", "k", "v")).await,
        json!({"ok": false, "error": "quota"})
    );
}

#[tokio::test]
async fn removes_a_cookie_by_the_url_it_belongs_to() {
    let guest = FakeGuest::new();
    let removal = normalize_storage_removal(&json!({
        "kind": "cookies",
        "cookie": {"name": "sid", "domain": ".app.test", "path": "/a", "secure": false}
    }))
    .unwrap();
    assert_eq!(remove_storage(&*guest, &removal).await, json!({"ok": true}));
    assert_eq!(
        *guest.cookies_removed.lock(),
        [("http://app.test/a".to_owned(), "sid".to_owned())]
    );
}

#[tokio::test]
async fn removes_and_clears_web_storage_entries() {
    let guest = FakeGuest::new();
    let removal = normalize_storage_removal(&json!({"kind": "local", "key": "a"})).unwrap();
    remove_storage(&*guest, &removal).await;
    clear_storage(&*guest, StorageKind::Session).await;
    assert_eq!(
        guest.scripts(),
        [
            r#"removeStorage("local", "a")"#,
            r#"clearStorage("session")"#
        ]
    );
}

#[tokio::test]
async fn clears_the_pane_partition_cookie_jar() {
    let guest = FakeGuest::new();
    assert_eq!(
        clear_storage(&*guest, StorageKind::Cookies).await,
        json!({"ok": true})
    );
    assert_eq!(*guest.cookies_cleared.lock(), 1);
    assert!(guest.scripts().is_empty());
}

#[tokio::test]
async fn reports_a_failed_removal_or_clear_instead_of_throwing() {
    let guest = FakeGuest::new();
    *guest.cookie_failure.lock() = Some("jar locked".to_owned());
    let removal = normalize_storage_removal(&json!({
        "kind": "cookies",
        "cookie": {"name": "sid", "domain": "app.test", "path": "/", "secure": true}
    }))
    .unwrap();
    let expected = json!({"ok": false, "error": "storage-failed", "message": "jar locked"});
    assert_eq!(remove_storage(&*guest, &removal).await, expected);
    assert_eq!(clear_storage(&*guest, StorageKind::Cookies).await, expected);
}

struct Owned {
    guest: Arc<FakeGuest>,
    lookups: Arc<Mutex<Vec<(String, String)>>>,
    ipc: BrowserStorageIpc<FakeGuest>,
}

fn owned() -> Owned {
    let guest = FakeGuest::new();
    let lookups = Arc::new(Mutex::new(Vec::new()));
    let ipc = BrowserStorageIpc::new({
        let guest = guest.clone();
        let lookups = lookups.clone();
        move |pane_id, window_id| {
            lookups
                .lock()
                .push((pane_id.to_owned(), window_id.to_owned()));
            (pane_id == "p1" && window_id == "7").then(|| guest.clone())
        }
    });
    Owned {
        guest,
        lookups,
        ipc,
    }
}

fn json_of(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

#[tokio::test]
async fn only_serves_panes_the_calling_window_owns() {
    let Owned { ipc, lookups, .. } = owned();
    assert_eq!(
        json_of(ipc.storage_read("p2", "7").await),
        json!({"ok": false, "error": "browser-not-ready"})
    );
    let read = json_of(ipc.storage_read("p1", "7").await);
    assert_eq!(read["ok"], true);
    assert_eq!(read["snapshot"]["origin"], "https://app.test");
    assert_eq!(
        json_of(ipc.storage_read("p1", "8").await),
        json!({"ok": false, "error": "browser-not-ready"})
    );
    assert_eq!(
        *lookups.lock(),
        [
            ("p2".to_owned(), "7".to_owned()),
            ("p1".to_owned(), "7".to_owned()),
            ("p1".to_owned(), "8".to_owned()),
        ]
    );
}

#[tokio::test]
async fn refuses_edits_that_do_not_validate_before_touching_the_page() {
    let Owned { ipc, guest, .. } = owned();
    let before = guest.scripts().len();
    assert_eq!(
        json_of(
            ipc.storage_set(
                "p1",
                "7",
                &json!({"kind": "local", "key": "", "value": "x"})
            )
            .await
        ),
        json!({"ok": false, "error": "invalid-entry"})
    );
    assert_eq!(
        json_of(ipc.storage_clear("p1", "7", &json!("indexeddb")).await),
        json!({"ok": false, "error": "invalid-entry"})
    );
    assert_eq!(
        json_of(
            ipc.storage_remove("p1", "7", &json!({"kind": "local"}))
                .await
        ),
        json!({"ok": false, "error": "invalid-entry"})
    );
    assert_eq!(guest.scripts().len(), before);
    assert!(guest.cookies_set.lock().is_empty());
    assert_eq!(*guest.cookies_cleared.lock(), 0);
}

#[tokio::test]
async fn applies_a_valid_removal() {
    let Owned { ipc, .. } = owned();
    assert_eq!(
        json_of(
            ipc.storage_remove("p1", "7", &json!({"kind": "local", "key": "a"}))
                .await
        ),
        json!({"ok": true})
    );
}

#[tokio::test]
async fn applies_a_valid_edit_and_a_valid_clear() {
    let Owned { ipc, guest, .. } = owned();
    assert_eq!(
        json_of(
            ipc.storage_set(
                "p1",
                "7",
                &json!({"kind": "session", "key": "k", "value": "v"})
            )
            .await
        ),
        json!({"ok": true})
    );
    assert_eq!(
        json_of(ipc.storage_clear("p1", "7", &json!("local")).await),
        json!({"ok": true})
    );
    assert_eq!(
        guest.scripts(),
        [
            r#"setStorage("session", "k", "v")"#,
            r#"clearStorage("local")"#
        ]
    );
}

#[tokio::test]
async fn answers_not_ready_before_it_validates_the_entry() {
    let Owned { ipc, .. } = owned();
    let not_ready = json!({"ok": false, "error": "browser-not-ready"});
    assert_eq!(
        json_of(ipc.storage_set("p2", "7", &json!("garbage")).await),
        not_ready
    );
    assert_eq!(
        json_of(ipc.storage_remove("p2", "7", &json!("garbage")).await),
        not_ready
    );
    assert_eq!(
        json_of(ipc.storage_clear("p2", "7", &json!("garbage")).await),
        not_ready
    );
}

#[tokio::test]
async fn answers_a_write_failure_with_its_message_when_it_has_one_and_its_code_when_not() {
    let Owned { ipc, guest, .. } = owned();
    *guest.cookie_failure.lock() = Some("bad cookie".to_owned());
    let cookie = json!({
        "kind": "cookies",
        "cookie": {"name": "sid", "value": "abc", "domain": "app.test", "path": "/"}
    });
    assert_eq!(
        json_of(ipc.storage_set("p1", "7", &cookie).await),
        json!({"ok": false, "error": "bad cookie"})
    );
    *guest.world_result.lock() = Some(Ok(json!({"ok": false, "error": "quota"})));
    assert_eq!(
        json_of(
            ipc.storage_set(
                "p1",
                "7",
                &json!({"kind": "local", "key": "k", "value": "v"})
            )
            .await
        ),
        json!({"ok": false, "error": "quota"})
    );
}

#[tokio::test]
async fn answers_a_read_failure_with_its_message() {
    let Owned { ipc, guest, .. } = owned();
    *guest.cookie_list_failure.lock() = Some("no jar".to_owned());
    assert_eq!(
        json_of(ipc.storage_read("p1", "7").await),
        json!({"ok": false, "error": "no jar"})
    );
}
