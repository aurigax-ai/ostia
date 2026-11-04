#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::JsNumber;
use ostia_contract::browser_storage::{
    BrowserStorageRead, BrowserStorageSnapshot, CookieSameSite, STORAGE_VALUE_MAX, StorageCookie,
    StorageEdit, StorageEntry, StorageKind, StorageRemoval, StorageRemovalCookie,
    StorageWriteResult, cookie_url, entries_of, normalize_storage_edit, normalize_storage_removal,
};
use serde_json::{Map, Value, json};

fn cookie() -> Value {
    json!({
        "name": "sid",
        "value": "abc",
        "domain": ".x.test",
        "path": "/",
        "hostOnly": false,
        "expires": 2_000_000_000,
        "httpOnly": true,
        "secure": true,
        "sameSite": "lax",
    })
}

fn cookie_with(field: &str, value: Value) -> Value {
    let mut raw = cookie();
    raw[field] = value;
    raw
}

fn cookie_edit(cookie: Value) -> Option<StorageEdit> {
    normalize_storage_edit(&json!({"kind": "cookies", "cookie": cookie}))
}

fn cookie_removal(cookie: Value) -> Option<StorageRemoval> {
    normalize_storage_removal(&json!({"kind": "cookies", "cookie": cookie}))
}

fn expected_cookie() -> StorageCookie {
    StorageCookie {
        name: "sid".to_owned(),
        value: "abc".to_owned(),
        domain: ".x.test".to_owned(),
        path: "/".to_owned(),
        host_only: false,
        expires: Some(JsNumber(2_000_000_000.0)),
        http_only: true,
        secure: true,
        same_site: CookieSameSite::Lax,
    }
}

fn same_site_of(edit: Option<StorageEdit>) -> CookieSameSite {
    match edit {
        Some(StorageEdit::Cookie(cookie)) => cookie.same_site,
        other => panic!("not a cookie edit: {other:?}"),
    }
}

fn record(entries: &[(&str, &str)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), json!(value)))
        .collect()
}

#[test]
fn accepts_a_web_storage_entry() {
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "local", "key": "k", "value": "v"})),
        Some(StorageEdit::Entry {
            kind: StorageKind::Local,
            key: "k".to_owned(),
            value: "v".to_owned()
        })
    );
}

#[test]
fn accepts_a_cookie_and_keeps_its_flags() {
    assert_eq!(
        cookie_edit(cookie()),
        Some(StorageEdit::Cookie(expected_cookie()))
    );
}

#[test]
fn falls_back_to_an_unspecified_same_site_value_it_does_not_know() {
    assert_eq!(
        same_site_of(cookie_edit(cookie_with("sameSite", json!("weird")))),
        CookieSameSite::Unspecified
    );
}

#[test]
fn refuses_empty_keys_oversized_values_bad_paths_and_unknown_kinds() {
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "local", "key": "", "value": "v"})),
        None
    );
    assert_eq!(
        normalize_storage_edit(&json!({
            "kind": "session",
            "key": "k",
            "value": "x".repeat(STORAGE_VALUE_MAX + 1)
        })),
        None
    );
    assert_eq!(cookie_edit(cookie_with("path", json!("nope"))), None);
    assert_eq!(cookie_edit(cookie_with("domain", json!("."))), None);
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "indexeddb", "key": "k", "value": "v"})),
        None
    );
    assert_eq!(normalize_storage_edit(&Value::Null), None);
}

#[test]
fn keeps_only_what_is_needed_to_find_the_entry() {
    assert_eq!(
        cookie_removal(cookie()),
        Some(StorageRemoval::Cookie(StorageRemovalCookie {
            name: "sid".to_owned(),
            domain: ".x.test".to_owned(),
            path: "/".to_owned(),
            secure: true
        }))
    );
    assert_eq!(
        normalize_storage_removal(&json!({"kind": "session", "key": "k", "value": "ignored"})),
        Some(StorageRemoval::Entry {
            kind: StorageKind::Session,
            key: "k".to_owned()
        })
    );
}

#[test]
fn refuses_a_removal_without_a_key_or_name() {
    assert_eq!(normalize_storage_removal(&json!({"kind": "local"})), None);
    assert_eq!(cookie_removal(cookie_with("name", json!(""))), None);
}

#[test]
fn builds_the_url_a_cookie_belongs_to_from_its_domain_path_and_secure_flag() {
    assert_eq!(cookie_url(".x.test", "/app", true), "https://x.test/app");
    assert_eq!(cookie_url("localhost", "/", false), "http://localhost/");
}

#[test]
fn lists_storage_entries_sorted_by_key() {
    assert_eq!(
        entries_of(&record(&[("b", "2"), ("a", "1")])),
        vec![
            StorageEntry {
                key: "a".to_owned(),
                value: "1".to_owned()
            },
            StorageEntry {
                key: "b".to_owned(),
                value: "2".to_owned()
            },
        ]
    );
}

#[test]
fn sorts_entries_with_the_locale_collation_and_not_by_bytes() {
    let keys: Vec<String> = entries_of(&record(&[("b", "1"), ("A", "2"), ("a", "3"), ("_", "4")]))
        .into_iter()
        .map(|entry| entry.key)
        .collect();
    assert_eq!(keys, ["_", "a", "A", "b"]);
}

#[test]
fn lists_no_entries_for_an_empty_record() {
    assert_eq!(entries_of(&Map::new()), Vec::<StorageEntry>::new());
}

#[test]
fn reads_the_three_storage_kinds_and_nothing_else() {
    assert_eq!(
        StorageKind::parse(&json!("cookies")),
        Some(StorageKind::Cookies)
    );
    assert_eq!(
        StorageKind::parse(&json!("local")),
        Some(StorageKind::Local)
    );
    assert_eq!(
        StorageKind::parse(&json!("session")),
        Some(StorageKind::Session)
    );
    for raw in [
        json!("Cookies"),
        json!("indexeddb"),
        json!(""),
        json!(null),
        json!(1),
        json!(["local"]),
    ] {
        assert_eq!(StorageKind::parse(&raw), None, "{raw}");
    }
}

#[test]
fn accepts_a_cookie_with_no_expiry_or_a_text_expiry_a_number_can_read() {
    let table = [
        (json!(null), Some(None)),
        (json!(0), Some(Some(JsNumber(0.0)))),
        (json!(1.5), Some(Some(JsNumber(1.5)))),
        (json!("123"), Some(Some(JsNumber(123.0)))),
        (json!(" 12 "), Some(Some(JsNumber(12.0)))),
        (json!(""), Some(Some(JsNumber(0.0)))),
        (json!(true), Some(Some(JsNumber(1.0)))),
        (json!("abc"), None),
        (json!("12abc"), None),
        (json!({}), None),
        (json!("Infinity"), None),
    ];
    for (expires, expected) in table {
        let edit = cookie_edit(cookie_with("expires", expires.clone()));
        let want = expected.map(|expires| {
            StorageEdit::Cookie(StorageCookie {
                expires,
                ..expected_cookie()
            })
        });
        assert_eq!(edit, want, "{expires}");
    }
}

#[test]
fn refuses_a_cookie_that_has_no_expires_field() {
    let mut raw = cookie();
    raw.as_object_mut().unwrap().remove("expires");
    assert_eq!(cookie_edit(raw), None);
}

#[test]
fn reads_a_flag_as_set_only_when_it_is_exactly_true() {
    let table = [
        (json!(true), true),
        (json!(false), false),
        (json!(1), false),
        (json!("true"), false),
        (json!(null), false),
    ];
    for (flag, expected) in table {
        let edit = cookie_edit(json!({
            "name": "n", "value": "v", "domain": "x.test", "path": "/", "expires": null,
            "hostOnly": flag, "httpOnly": flag, "secure": flag
        }));
        let Some(StorageEdit::Cookie(cookie)) = edit else {
            panic!("not a cookie: {flag}");
        };
        assert_eq!(
            (cookie.host_only, cookie.http_only, cookie.secure),
            (expected, expected, expected),
            "{flag}"
        );
        assert_eq!(cookie.same_site, CookieSameSite::Unspecified);
    }
}

#[test]
fn reads_each_known_same_site_value() {
    let table = [
        ("unspecified", CookieSameSite::Unspecified),
        ("no_restriction", CookieSameSite::NoRestriction),
        ("lax", CookieSameSite::Lax),
        ("strict", CookieSameSite::Strict),
        ("Lax", CookieSameSite::Unspecified),
        ("none", CookieSameSite::Unspecified),
    ];
    for (name, expected) in table {
        assert_eq!(
            same_site_of(cookie_edit(cookie_with("sameSite", json!(name)))),
            expected,
            "{name}"
        );
    }
    assert_eq!(
        same_site_of(cookie_edit(cookie_with("sameSite", json!(3)))),
        CookieSameSite::Unspecified
    );
}

#[test]
fn counts_the_limits_in_utf16_units_and_accepts_the_exact_limit() {
    assert!(cookie_edit(cookie_with("name", json!("n".repeat(4096)))).is_some());
    assert_eq!(
        cookie_edit(cookie_with("name", json!("n".repeat(4097)))),
        None
    );
    assert!(cookie_edit(cookie_with("name", json!("\u{1F600}".repeat(2048)))).is_some());
    assert_eq!(
        cookie_edit(cookie_with("name", json!("\u{1F600}".repeat(2049)))),
        None
    );
    let host = format!("{}.test", "d".repeat(250));
    assert!(cookie_edit(cookie_with("domain", json!(host.clone()))).is_some());
    assert_eq!(
        cookie_edit(cookie_with("domain", json!(format!("{host}x")))),
        None
    );
    assert!(cookie_edit(cookie_with("value", json!("v".repeat(STORAGE_VALUE_MAX)))).is_some());
    assert_eq!(
        cookie_edit(cookie_with(
            "value",
            json!("v".repeat(STORAGE_VALUE_MAX + 1))
        )),
        None
    );
    assert!(
        normalize_storage_edit(&json!({
            "kind": "local", "key": "k".repeat(4096), "value": "v".repeat(STORAGE_VALUE_MAX)
        }))
        .is_some()
    );
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "local", "key": "k".repeat(4097), "value": "v"})),
        None
    );
}

#[test]
fn accepts_an_empty_value_and_refuses_a_value_that_is_not_text() {
    assert!(cookie_edit(cookie_with("value", json!(""))).is_some());
    assert!(normalize_storage_edit(&json!({"kind": "session", "key": "k", "value": ""})).is_some());
    assert_eq!(cookie_edit(cookie_with("value", json!(1))), None);
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "local", "key": "k", "value": null})),
        None
    );
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "local", "key": "k"})),
        None
    );
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "local", "key": 1, "value": "v"})),
        None
    );
}

#[test]
fn refuses_a_cookie_edit_with_an_empty_name_a_bare_dot_domain_or_a_relative_path() {
    assert_eq!(cookie_edit(cookie_with("name", json!(""))), None);
    assert_eq!(cookie_edit(cookie_with("name", json!(5))), None);
    assert_eq!(cookie_edit(cookie_with("domain", json!(""))), None);
    assert_eq!(cookie_edit(cookie_with("domain", json!(7))), None);
    assert_eq!(cookie_edit(cookie_with("path", json!(""))), None);
    assert!(cookie_edit(cookie_with("domain", json!(".."))).is_some());
    assert!(cookie_edit(cookie_with("path", json!("/a/b"))).is_some());
}

#[test]
fn refuses_a_cookie_edit_that_has_no_cookie_object() {
    assert_eq!(normalize_storage_edit(&json!({"kind": "cookies"})), None);
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "cookies", "cookie": null})),
        None
    );
    assert_eq!(
        normalize_storage_edit(&json!({"kind": "cookies", "cookie": "sid"})),
        None
    );
}

#[test]
fn refuses_a_web_storage_edit_whose_kind_is_missing_or_not_text() {
    assert_eq!(
        normalize_storage_edit(&json!({"key": "k", "value": "v"})),
        None
    );
    assert_eq!(
        normalize_storage_edit(&json!({"kind": 1, "key": "k", "value": "v"})),
        None
    );
    assert_eq!(normalize_storage_edit(&json!("local")), None);
}

#[test]
fn reads_a_web_storage_removal_and_refuses_an_unknown_kind() {
    assert_eq!(
        normalize_storage_removal(&json!({"kind": "local", "key": "k"})),
        Some(StorageRemoval::Entry {
            kind: StorageKind::Local,
            key: "k".to_owned()
        })
    );
    assert_eq!(
        normalize_storage_removal(&json!({"kind": "indexeddb", "key": "k"})),
        None
    );
    assert_eq!(
        normalize_storage_removal(&json!({"kind": "local", "key": ""})),
        None
    );
    assert_eq!(normalize_storage_removal(&Value::Null), None);
    assert_eq!(normalize_storage_removal(&json!({"kind": "cookies"})), None);
}

#[test]
fn refuses_a_cookie_removal_with_a_bad_domain_or_path_and_reads_secure_as_false_unless_true() {
    assert_eq!(cookie_removal(cookie_with("domain", json!("."))), None);
    assert_eq!(cookie_removal(cookie_with("path", json!("nope"))), None);
    assert_eq!(
        cookie_removal(cookie_with("domain", json!("d".repeat(256)))),
        None
    );
    let Some(StorageRemoval::Cookie(removal)) =
        cookie_removal(cookie_with("secure", json!("true")))
    else {
        panic!("not a cookie removal");
    };
    assert!(!removal.secure);
}

#[test]
fn removes_a_cookie_without_checking_its_value_or_expiry() {
    let removal = cookie_removal(json!({
        "name": "sid", "domain": "x.test", "path": "/", "value": 5, "expires": "junk"
    }));
    assert_eq!(
        removal,
        Some(StorageRemoval::Cookie(StorageRemovalCookie {
            name: "sid".to_owned(),
            domain: "x.test".to_owned(),
            path: "/".to_owned(),
            secure: false
        }))
    );
}

#[test]
fn builds_a_cookie_url_with_a_default_path_and_no_leading_dot() {
    assert_eq!(cookie_url("x.test", "", true), "https://x.test/");
    assert_eq!(cookie_url("..x.test", "/", true), "https://.x.test/");
    assert_eq!(cookie_url(".x.test", "/a/b", false), "http://x.test/a/b");
}

#[test]
fn writes_a_read_result_as_ok_with_a_snapshot_or_as_an_error() {
    let snapshot = BrowserStorageSnapshot {
        origin: "https://x.test".to_owned(),
        cookies: vec![expected_cookie()],
        local: vec![StorageEntry {
            key: "k".to_owned(),
            value: "v".to_owned(),
        }],
        session: vec![],
    };
    assert_eq!(
        serde_json::to_string(&BrowserStorageRead::Snapshot(snapshot)).unwrap(),
        r#"{"ok":true,"snapshot":{"origin":"https://x.test","cookies":[{"name":"sid","value":"abc","domain":".x.test","path":"/","hostOnly":false,"expires":2000000000,"httpOnly":true,"secure":true,"sameSite":"lax"}],"local":[{"key":"k","value":"v"}],"session":[]}}"#
    );
    assert_eq!(
        serde_json::to_string(&BrowserStorageRead::Failed("no page".to_owned())).unwrap(),
        r#"{"ok":false,"error":"no page"}"#
    );
}

#[test]
fn writes_a_write_result_as_ok_or_as_an_error() {
    assert_eq!(
        serde_json::to_string(&StorageWriteResult::Written).unwrap(),
        r#"{"ok":true}"#
    );
    assert_eq!(
        serde_json::to_string(&StorageWriteResult::Failed("denied".to_owned())).unwrap(),
        r#"{"ok":false,"error":"denied"}"#
    );
}

#[test]
fn writes_a_session_cookie_expiry_as_null_and_the_same_site_names_as_electron_does() {
    let mut cookie = expected_cookie();
    cookie.expires = None;
    cookie.same_site = CookieSameSite::NoRestriction;
    let written = serde_json::to_value(&cookie).unwrap();
    assert_eq!(written["expires"], Value::Null);
    assert_eq!(written["sameSite"], json!("no_restriction"));
}
