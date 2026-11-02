#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_extensions::extension_host_deps::ExtensionSecretStore;
use ostia_extensions::extension_secrets::{SecretError, SecretStoreDeps, create_secret_store};
use parking_lot::Mutex;
use serde_json::{Value, json};

struct Fake {
    data: Arc<Mutex<Value>>,
    saves: Arc<AtomicUsize>,
    store: Box<dyn ExtensionSecretStore>,
}

fn encrypted(plain: &str) -> String {
    format!("enc:{plain}")
}

fn fake(can_encrypt: bool) -> Fake {
    let data = Arc::new(Mutex::new(json!({})));
    let saves = Arc::new(AtomicUsize::new(0));
    let deps = SecretStoreDeps {
        load: Box::new({
            let data = Arc::clone(&data);
            move || data.lock().clone()
        }),
        save: Box::new({
            let data = Arc::clone(&data);
            let saves = Arc::clone(&saves);
            move |next: &Value| {
                *data.lock() = next.clone();
                saves.fetch_add(1, Ordering::SeqCst);
            }
        }),
        can_encrypt: Box::new(move || can_encrypt),
        encrypt: Box::new(|plain: &str| encrypted(plain)),
        decrypt: Box::new(|secret: &str| secret.strip_prefix("enc:").map(str::to_owned)),
    };
    Fake {
        data,
        saves,
        store: Box::new(create_secret_store(deps)),
    }
}

#[test]
fn stores_only_the_encrypted_form_and_returns_the_plain_value_to_the_owner() {
    let fake = fake(true);
    fake.store
        .set("assistant", "apiKey", Some("sk-live-1"))
        .unwrap();
    assert!(!fake.data.lock().to_string().contains("sk-live-1"));
    assert_eq!(
        fake.store.get("assistant", "apiKey"),
        Some("sk-live-1".to_owned())
    );
    assert_eq!(fake.store.get("other", "apiKey"), None);
    assert_eq!(fake.store.keys("assistant"), ["apiKey"]);
}

#[test]
fn clears_a_key_and_drops_an_extension_with_no_secrets_left() {
    let fake = fake(true);
    fake.store.set("assistant", "apiKey", Some("k")).unwrap();
    fake.store.set("assistant", "apiKey", None).unwrap();
    assert_eq!(fake.store.keys("assistant"), Vec::<String>::new());
    assert_eq!(*fake.data.lock(), json!({}));
}

#[test]
fn refuses_to_store_when_encryption_is_unavailable() {
    let fake = fake(false);
    let refused = fake
        .store
        .set("assistant", "apiKey", Some("k"))
        .unwrap_err();
    assert_eq!(refused, SecretError::EncryptionUnavailable);
    assert_eq!(refused.code(), "encryption-unavailable");
    assert_eq!(*fake.data.lock(), json!({}));
    assert_eq!(fake.saves.load(Ordering::SeqCst), 0);
}

#[test]
fn refuses_empty_or_oversized_values_and_prototype_keys() {
    let fake = fake(true);
    let empty = fake.store.set("assistant", "apiKey", Some("")).unwrap_err();
    assert_eq!(empty.code(), "invalid-value");
    let huge = "k".repeat(5000);
    let oversized = fake
        .store
        .set("assistant", "apiKey", Some(&huge))
        .unwrap_err();
    assert_eq!(oversized.code(), "invalid-value");
    let proto = fake
        .store
        .set("__proto__", "apiKey", Some("k"))
        .unwrap_err();
    assert_eq!(proto.code(), "invalid-key");
    assert_eq!(fake.saves.load(Ordering::SeqCst), 0);
}

#[test]
fn ignores_garbage_in_the_stored_file() {
    let fake = fake(true);
    *fake.data.lock() = json!({"assistant": {"apiKey": 42, "ok": encrypted("v")}});
    assert_eq!(fake.store.keys("assistant"), ["ok"]);
    assert_eq!(fake.store.get("assistant", "apiKey"), None);
    assert_eq!(fake.store.get("assistant", "ok"), Some("v".to_owned()));
}

#[test]
fn accepts_a_value_of_4096_utf16_units_and_refuses_one_unit_more() {
    let fake = fake(true);
    let rows = [
        ("a".repeat(4096), true),
        ("a".repeat(4097), false),
        ("😀".repeat(2048), true),
        ("😀".repeat(2049), false),
        ("é".repeat(4096), true),
    ];
    for (value, accepted) in rows {
        let result = fake.store.set("assistant", "apiKey", Some(&value));
        assert_eq!(
            result.is_ok(),
            accepted,
            "{} units",
            value.encode_utf16().count()
        );
    }
}

#[test]
fn checks_the_key_then_the_value_then_encryption() {
    let fake = fake(false);
    let rows = [
        ("__proto__", "k", Some("v"), "invalid-key"),
        ("a", "prototype", Some("v"), "invalid-key"),
        ("constructor", "k", None, "invalid-key"),
        ("a", "constructor", None, "invalid-key"),
        ("a", "k", Some(""), "invalid-value"),
        ("a", "k", Some("v"), "encryption-unavailable"),
    ];
    for (ext, key, value, code) in rows {
        let refused = fake.store.set(ext, key, value).unwrap_err();
        assert_eq!(refused.code(), code, "set {ext} {key} {value:?}");
    }
    assert_eq!(fake.saves.load(Ordering::SeqCst), 0);
}

#[test]
fn clears_a_key_without_encryption_and_saves_even_when_the_key_was_not_there() {
    let fake = fake(false);
    *fake.data.lock() = json!({"assistant": {"a": encrypted("1"), "b": encrypted("2")}});
    fake.store.set("assistant", "a", None).unwrap();
    assert_eq!(
        *fake.data.lock(),
        json!({"assistant": {"b": encrypted("2")}})
    );
    fake.store.set("assistant", "missing", None).unwrap();
    fake.store.set("nobody", "missing", None).unwrap();
    assert_eq!(
        *fake.data.lock(),
        json!({"assistant": {"b": encrypted("2")}})
    );
    assert_eq!(fake.saves.load(Ordering::SeqCst), 3);
}

#[test]
fn returns_no_value_when_encryption_is_unavailable_or_decrypting_fails() {
    let unavailable = fake(false);
    *unavailable.data.lock() = json!({"assistant": {"apiKey": encrypted("v")}});
    assert_eq!(unavailable.store.get("assistant", "apiKey"), None);
    assert_eq!(unavailable.store.keys("assistant"), ["apiKey"]);
    let broken = fake(true);
    *broken.data.lock() = json!({"assistant": {"apiKey": "not-encrypted-by-us"}});
    assert_eq!(broken.store.get("assistant", "apiKey"), None);
}

#[test]
fn lists_keys_in_sorted_order_and_keeps_extensions_apart() {
    let fake = fake(true);
    fake.store.set("assistant", "zeta", Some("1")).unwrap();
    fake.store.set("assistant", "alpha", Some("2")).unwrap();
    fake.store.set("graphs", "token", Some("3")).unwrap();
    assert_eq!(fake.store.keys("assistant"), ["alpha", "zeta"]);
    assert_eq!(fake.store.keys("graphs"), ["token"]);
    fake.store.set("assistant", "alpha", Some("4")).unwrap();
    assert_eq!(fake.store.get("assistant", "alpha"), Some("4".to_owned()));
    assert_eq!(fake.store.get("graphs", "token"), Some("3".to_owned()));
    assert_eq!(fake.store.keys("nobody"), Vec::<String>::new());
}

#[test]
fn drops_prototype_named_extensions_and_keys_from_the_stored_file() {
    let fake = fake(true);
    *fake.data.lock() = json!({
        "__proto__": {"k": encrypted("1")},
        "prototype": {"k": encrypted("2")},
        "assistant": {"constructor": encrypted("3"), "keep": encrypted("4")},
        "scalar": 5,
        "nothing": null
    });
    assert_eq!(fake.store.keys("__proto__"), Vec::<String>::new());
    assert_eq!(fake.store.keys("prototype"), Vec::<String>::new());
    assert_eq!(fake.store.keys("assistant"), ["keep"]);
    assert_eq!(fake.store.keys("scalar"), Vec::<String>::new());
    fake.store.set("assistant", "more", Some("5")).unwrap();
    let saved = fake.data.lock().clone();
    assert_eq!(
        saved,
        json!({"assistant": {"keep": encrypted("4"), "more": encrypted("5")}})
    );
}

#[test]
fn treats_a_list_of_strings_under_an_extension_as_keyed_by_position_like_ts_does() {
    let fake = fake(true);
    *fake.data.lock() = json!({"assistant": [encrypted("a"), 7, encrypted("c")]});
    assert_eq!(fake.store.keys("assistant"), ["0", "2"]);
    assert_eq!(fake.store.get("assistant", "2"), Some("c".to_owned()));
}

#[test]
fn reads_the_file_again_on_every_call() {
    let fake = fake(true);
    fake.store.set("assistant", "apiKey", Some("one")).unwrap();
    *fake.data.lock() = json!({"assistant": {"apiKey": encrypted("two")}});
    assert_eq!(
        fake.store.get("assistant", "apiKey"),
        Some("two".to_owned())
    );
    *fake.data.lock() = json!([]);
    assert_eq!(fake.store.keys("assistant"), Vec::<String>::new());
}
