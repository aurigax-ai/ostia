#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use ostia_contract::extension_connections::{
    EXTENSION_CONNECTION_VALUE_MAX, EXTENSION_CONNECTIONS_MAX, ExtensionConnectionField,
    ExtensionConnectionFieldType, ExtensionConnectionKind, ExtensionConnectionSecret,
};
use ostia_extensions::extension_connections::{ExtensionConnections, connection_secret_key};
use ostia_extensions::extension_host_deps::ExtensionSecretStore;
use ostia_extensions::extension_secrets::{SecretError, SecretStoreDeps, create_secret_store};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tempfile::TempDir;

fn http_kind() -> ExtensionConnectionKind {
    ExtensionConnectionKind {
        kind: "http".to_owned(),
        title: "HTTP API".to_owned(),
        description: None,
        fields: vec![
            ExtensionConnectionField {
                key: "baseUrl".to_owned(),
                title: "Base URL".to_owned(),
                description: None,
                field_type: ExtensionConnectionFieldType::String,
                enum_values: None,
                default: None,
                required: true,
            },
            ExtensionConnectionField {
                key: "auth".to_owned(),
                title: "Auth".to_owned(),
                description: None,
                field_type: ExtensionConnectionFieldType::Enum,
                enum_values: Some(
                    ["none", "bearer", "header", "basic"]
                        .map(str::to_owned)
                        .to_vec(),
                ),
                default: Some("bearer".to_owned()),
                required: false,
            },
            ExtensionConnectionField {
                key: "header".to_owned(),
                title: "Header".to_owned(),
                description: None,
                field_type: ExtensionConnectionFieldType::String,
                enum_values: None,
                default: None,
                required: false,
            },
        ],
        secrets: vec![ExtensionConnectionSecret {
            key: "secret".to_owned(),
            title: "Token".to_owned(),
            description: None,
        }],
    }
}

fn ftp_kind() -> ExtensionConnectionKind {
    ExtensionConnectionKind {
        kind: "ftp".to_owned(),
        title: "FTP".to_owned(),
        description: None,
        fields: vec![ExtensionConnectionField {
            key: "host".to_owned(),
            title: "Host".to_owned(),
            description: None,
            field_type: ExtensionConnectionFieldType::String,
            enum_values: None,
            default: None,
            required: false,
        }],
        secrets: Vec::new(),
    }
}

fn token() -> String {
    format!("tok-{}", "x".repeat(20))
}

fn encrypted(plain: &str) -> String {
    format!("enc:{}", plain.chars().rev().collect::<String>())
}

fn secret_deps(data: &Arc<Mutex<Value>>, can_encrypt: bool) -> SecretStoreDeps {
    SecretStoreDeps {
        load: Box::new({
            let data = Arc::clone(data);
            move || data.lock().clone()
        }),
        save: Box::new({
            let data = Arc::clone(data);
            move |next: &Value| *data.lock() = next.clone()
        }),
        can_encrypt: Box::new(move || can_encrypt),
        encrypt: Box::new(|plain: &str| encrypted(plain)),
        decrypt: Box::new(|secret: &str| {
            secret
                .strip_prefix("enc:")
                .map(|hidden| hidden.chars().rev().collect::<String>())
        }),
    }
}

struct Setup {
    _dir: TempDir,
    store: ExtensionConnections,
    secrets: Arc<dyn ExtensionSecretStore>,
    path: PathBuf,
    raw: Arc<Mutex<Value>>,
}

fn setup() -> Setup {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extension-connections.json");
    let raw = Arc::new(Mutex::new(json!({})));
    let secrets: Arc<dyn ExtensionSecretStore> =
        Arc::new(create_secret_store(secret_deps(&raw, true)));
    let store = ExtensionConnections::new(path.clone(), {
        let secrets = Arc::clone(&secrets);
        move || Some(Arc::clone(&secrets))
    });
    Setup {
        _dir: dir,
        store,
        secrets,
        path,
        raw,
    }
}

fn without_secrets() -> (TempDir, PathBuf, ExtensionConnections) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extension-connections.json");
    let store = ExtensionConnections::new(path.clone(), || None);
    (dir, path, store)
}

fn as_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn save(store: &ExtensionConnections, req: &Value) -> Value {
    save_for(store, "graphs", req)
}

fn save_for(store: &ExtensionConnections, ext_id: &str, req: &Value) -> Value {
    as_json(&store.save(ext_id, &[http_kind()], req).unwrap())
}

fn kinds() -> Vec<ExtensionConnectionKind> {
    vec![http_kind()]
}

fn ok() -> Value {
    json!({"ok": true})
}

fn refused(error: &str) -> Value {
    json!({"ok": false, "error": error})
}

fn plain(name: &str) -> Value {
    json!({"name": name, "kind": "http", "fields": {"baseUrl": "https://a.test"}})
}

fn stored(path: &PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[test]
fn saves_fields_to_its_file_and_the_secret_encrypted_and_gives_both_only_to_its_extension_by_name()
{
    let Setup {
        store, path, raw, ..
    } = setup();
    let token = token();
    assert_eq!(
        save(
            &store,
            &json!({
                "name": "api",
                "kind": "http",
                "fields": {"baseUrl": "https://api.example.test"},
                "secrets": {"secret": token},
            })
        ),
        ok()
    );
    assert!(!fs::read_to_string(&path).unwrap().contains(&token));
    assert!(!raw.lock().to_string().contains(&token));
    let listed = as_json(&store.list("graphs", &kinds()));
    assert_eq!(
        listed,
        json!([{
            "name": "api",
            "kind": "http",
            "fields": {"baseUrl": "https://api.example.test", "auth": "bearer"},
            "secretsSet": ["secret"],
        }])
    );
    assert!(!listed.to_string().contains(&token));
    assert_eq!(
        as_json(&store.names("graphs", &kinds())),
        json!([{"name": "api", "kind": "http"}])
    );
    assert_eq!(
        as_json(&store.value("graphs", &kinds(), &json!("api"))),
        json!({
            "name": "api",
            "kind": "http",
            "fields": {"baseUrl": "https://api.example.test", "auth": "bearer"},
            "secrets": {"secret": token},
        })
    );
    assert!(store.value("other", &kinds(), &json!("api")).is_none());
    assert!(store.names("other", &kinds()).is_empty());
    assert!(store.value("graphs", &kinds(), &json!("nope")).is_none());
}

#[test]
fn refuses_a_bad_name_an_unknown_kind_field_or_secret_a_bad_enum_value_a_missing_required_field_and_a_long_value()
 {
    let Setup { store, .. } = setup();
    let base = json!({"name": "api", "kind": "http", "fields": {"baseUrl": "https://a.test"}});
    let with = |key: &str, value: Value| {
        let mut changed = base.clone();
        changed[key] = value;
        changed
    };
    let refusals = [
        with("name", json!("Bad Name")),
        with("name", json!("__proto__")),
        with("kind", json!("ftp")),
        with("fields", json!({"baseUrl": "https://a.test", "extra": "x"})),
        with(
            "fields",
            json!({"baseUrl": "https://a.test", "auth": "oauth"}),
        ),
        with("fields", json!({})),
        with("fields", json!({"baseUrl": "x".repeat(2049)})),
        with("secrets", json!({"other": "x"})),
        with("secrets", json!({"secret": "x".repeat(4097)})),
        with("secrets", json!({"secret": ""})),
    ];
    for (index, request) in refusals.iter().enumerate() {
        assert_eq!(save(&store, request)["ok"], json!(false), "row {index}");
    }
    assert_eq!(save(&store, &with("name", json!("ok"))), ok());
    assert_eq!(save(&store, &json!(null))["ok"], json!(false));
}

#[test]
fn refuses_a_secret_or_field_value_with_a_control_character_and_says_so_without_the_value() {
    let Setup { store, .. } = setup();
    let token = token();
    let bad_values = [
        format!("{token}\r\nX-Evil: 1"),
        format!("{token}\n"),
        "a\u{0}b".to_owned(),
        "a\u{7f}b".to_owned(),
        "a\tb".to_owned(),
    ];
    for bad in bad_values {
        let mut secret_request = plain("api");
        secret_request["secrets"] = json!({"secret": bad});
        let result = save(&store, &secret_request);
        assert_eq!(result["ok"], json!(false), "secret {bad:?}");
        assert!(!result.to_string().contains(&token));
        let mut field_request = plain("api");
        field_request["fields"] = json!({"baseUrl": format!("https://a.test/{bad}")});
        assert_eq!(
            save(&store, &field_request)["ok"],
            json!(false),
            "field {bad:?}"
        );
    }
    assert!(store.list("graphs", &kinds()).is_empty());
}

#[test]
fn keeps_an_omitted_secret_clears_a_null_one_and_removing_a_connection_drops_its_secrets() {
    let Setup { store, secrets, .. } = setup();
    let token = token();
    let mut base = plain("api");
    base["secrets"] = json!({"secret": token});
    save(&store, &base);
    save(
        &store,
        &json!({
            "name": "apiary",
            "kind": "http",
            "fields": {"baseUrl": "https://b.test"},
            "secrets": {"secret": "keep"},
        }),
    );
    save(
        &store,
        &json!({"name": "api", "kind": "http", "fields": {"baseUrl": "https://c.test"}}),
    );
    let secrets_of = |name: &str| {
        as_json(&store.value("graphs", &kinds(), &json!(name)).unwrap())["secrets"].clone()
    };
    assert_eq!(secrets_of("api"), json!({"secret": token}));
    save(
        &store,
        &json!({"name": "api", "kind": "http", "fields": {"baseUrl": "https://a.test"}, "secrets": {"secret": null}}),
    );
    assert_eq!(secrets_of("api"), json!({}));
    save(&store, &base);
    assert_eq!(
        as_json(&store.remove("graphs", &json!("api")).unwrap()),
        ok()
    );
    assert_eq!(
        secrets.keys("graphs"),
        [connection_secret_key("apiary", "secret")]
    );
    assert_eq!(
        as_json(&store.remove("graphs", &json!("api")).unwrap()),
        refused("unknown-connection")
    );
    assert_eq!(secrets_of("apiary"), json!({"secret": "keep"}));
}

#[test]
fn holds_at_most_32_connections_per_extension_and_forgets_an_extension_whole() {
    let Setup { store, .. } = setup();
    assert_eq!(EXTENSION_CONNECTIONS_MAX, 32);
    for index in 0..32 {
        assert_eq!(save(&store, &plain(&format!("c{index}"))), ok());
    }
    assert_eq!(save(&store, &plain("c32")), refused("too-many-connections"));
    let mut changed = plain("c0");
    changed["fields"] = json!({"baseUrl": "https://z.test"});
    assert_eq!(save(&store, &changed), ok());
    store.forget("graphs").unwrap();
    assert!(store.names("graphs", &kinds()).is_empty());
}

#[test]
fn hides_a_connection_whose_kind_the_extension_no_longer_declares() {
    let Setup { store, .. } = setup();
    save(&store, &plain("api"));
    assert!(store.names("graphs", &[]).is_empty());
    assert!(store.value("graphs", &[], &json!("api")).is_none());
}

#[test]
fn builds_the_secret_key_from_the_connection_name_and_the_secret_key() {
    assert_eq!(
        connection_secret_key("api", "secret"),
        "@connection/api/secret"
    );
    assert_eq!(connection_secret_key("api", ""), "@connection/api/");
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extension-connections.json");
    fs::copy(fixture("extension-connections-before.json"), &path).unwrap();
    let store = ExtensionConnections::new(path.clone(), || None);
    assert_eq!(store.names("graphs", &kinds()).len(), 11);
    assert_eq!(store.names("other", &kinds()).len(), 1);
    assert_eq!(
        as_json(&store.remove("graphs", &json!("a0")).unwrap()),
        ok()
    );
    assert_eq!(
        as_json(
            &store
                .save(
                    "graphs",
                    &kinds(),
                    &json!({
                        "name": "api",
                        "kind": "http",
                        "fields": {"baseUrl": "https://api.changed.test", "auth": "none"},
                    }),
                )
                .unwrap()
        ),
        ok()
    );
    assert_eq!(
        as_json(&store.remove("other", &json!("solo")).unwrap()),
        ok()
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        fs::read(fixture("extension-connections-after.json")).unwrap()
    );
}

#[test]
fn lists_connections_in_the_locale_order_the_ts_store_gives() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extension-connections.json");
    fs::copy(fixture("extension-connections-before.json"), &path).unwrap();
    let store = ExtensionConnections::new(path, || None);
    let expected: Vec<String> = serde_json::from_str(
        &fs::read_to_string(fixture("extension-connections-order.json")).unwrap(),
    )
    .unwrap();
    let names: Vec<String> = store
        .names("graphs", &kinds())
        .into_iter()
        .map(|info| as_json(&info)["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, expected);
    let listed: Vec<String> = store
        .list("graphs", &kinds())
        .into_iter()
        .map(|entry| as_json(&entry)["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(listed, expected);
}

#[test]
fn skips_stored_entries_that_are_malformed_when_it_reads_the_file() {
    let (_dir, path, store) = without_secrets();
    fs::write(
        &path,
        json!({
            "graphs": {
                "ok": {"kind": "http", "fields": {"baseUrl": "u"}},
                "Bad Name": {"kind": "http", "fields": {}},
                "nofields": {"kind": "http"},
                "badfield": {"kind": "http", "fields": {"baseUrl": 1}},
                "dangerous": {"kind": "http", "fields": {"constructor": "x"}},
                "nokind": {"fields": {}},
                "kindnumber": {"kind": 3, "fields": {}},
                "notrecord": 5,
                "listfields": {"kind": "http", "fields": ["a"]},
            },
            "__proto__": {"ok": {"kind": "http", "fields": {}}},
            "list": [1],
            "text": "x",
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        as_json(&store.names("graphs", &kinds())),
        json!([{"name": "ok", "kind": "http"}])
    );
    assert!(store.names("list", &kinds()).is_empty());
    assert!(store.names("text", &kinds()).is_empty());
    assert!(store.names("__proto__", &kinds()).is_empty());
}

#[test]
fn a_save_rewrites_the_file_without_the_entries_it_skipped_on_reading() {
    let (_dir, path, store) = without_secrets();
    fs::write(
        &path,
        json!({
            "graphs": {
                "ok": {"kind": "http", "fields": {"baseUrl": "u"}},
                "nokind": {"fields": {}},
            },
            "text": "x",
            "emptied": {"Bad Name": {"kind": "http", "fields": {}}},
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(save(&store, &plain("fresh")), ok());
    assert_eq!(
        stored(&path),
        json!({
            "graphs": {
                "ok": {"kind": "http", "fields": {"baseUrl": "u"}},
                "fresh": {"kind": "http", "fields": {"baseUrl": "https://a.test", "auth": "bearer"}},
            },
            "emptied": {},
        })
    );
}

#[test]
fn forgetting_an_extension_rewrites_the_file_only_when_the_extension_is_in_it() {
    let (_dir, path, store) = without_secrets();
    store.forget("graphs").unwrap();
    assert!(!path.exists());
    save(&store, &plain("api"));
    save_for(&store, "other", &plain("keep"));
    store.forget("nobody").unwrap();
    assert_eq!(store.names("graphs", &kinds()).len(), 1);
    store.forget("graphs").unwrap();
    assert!(store.names("graphs", &kinds()).is_empty());
    assert_eq!(store.names("other", &kinds()).len(), 1);
    assert!(stored(&path).get("graphs").is_none());
}

#[test]
fn forgetting_an_extension_leaves_its_secrets_in_the_secret_store() {
    let Setup { store, secrets, .. } = setup();
    let mut request = plain("api");
    request["secrets"] = json!({"secret": "keep"});
    save(&store, &request);
    store.forget("graphs").unwrap();
    assert_eq!(
        secrets.keys("graphs"),
        [connection_secret_key("api", "secret")]
    );
}

#[test]
fn removing_the_last_connection_of_an_extension_drops_the_extension_from_the_file() {
    let (_dir, path, store) = without_secrets();
    save(&store, &plain("api"));
    save_for(&store, "other", &plain("keep"));
    assert_eq!(
        as_json(&store.remove("graphs", &json!("api")).unwrap()),
        ok()
    );
    let file = stored(&path);
    assert!(file.get("graphs").is_none());
    assert!(file["other"].get("keep").is_some());
}

#[test]
fn removing_a_connection_keeps_the_secrets_that_are_not_its_own() {
    let Setup { store, secrets, .. } = setup();
    let mut request = plain("api");
    request["secrets"] = json!({"secret": "mine"});
    save(&store, &request);
    secrets.set("graphs", "apiKey", Some("other")).unwrap();
    secrets
        .set(
            "graphs",
            &connection_secret_key("apiary", "secret"),
            Some("x"),
        )
        .unwrap();
    store.remove("graphs", &json!("api")).unwrap();
    assert_eq!(
        secrets.keys("graphs"),
        [
            connection_secret_key("apiary", "secret"),
            "apiKey".to_owned()
        ]
    );
}

#[test]
fn removing_refuses_a_name_that_is_not_text_and_an_extension_id_that_is_a_prototype_key() {
    let Setup { store, .. } = setup();
    save(&store, &plain("api"));
    for name in [json!(3), json!(null), json!(["api"]), json!({"a": 1})] {
        assert_eq!(
            as_json(&store.remove("graphs", &name).unwrap()),
            refused("invalid-name"),
            "name {name}"
        );
    }
    for ext in ["__proto__", "prototype", "constructor"] {
        assert_eq!(
            as_json(&store.remove(ext, &json!("api")).unwrap()),
            refused("invalid-name"),
            "ext {ext}"
        );
    }
    assert_eq!(
        as_json(&store.remove("graphs", &json!("nope")).unwrap()),
        refused("unknown-connection")
    );
}

#[test]
fn refuses_a_request_that_is_not_an_object_or_comes_for_a_prototype_key() {
    let Setup { store, .. } = setup();
    for request in [json!(null), json!([plain("api")]), json!("api"), json!(3)] {
        assert_eq!(
            save(&store, &request),
            refused("invalid-request"),
            "{request}"
        );
    }
    for ext in ["__proto__", "prototype", "constructor"] {
        assert_eq!(
            save_for(&store, ext, &plain("api")),
            refused("invalid-request"),
            "ext {ext}"
        );
    }
}

#[test]
fn refuses_a_name_that_is_not_a_lowercase_word_of_at_most_40_characters() {
    let Setup { store, .. } = setup();
    let long_ok = format!("a{}", "b".repeat(39));
    let too_long = format!("a{}", "b".repeat(40));
    assert_eq!(save(&store, &plain(&long_ok)), ok());
    for name in [
        json!(too_long),
        json!("1abc"),
        json!("-abc"),
        json!("Abc"),
        json!("a_b"),
        json!("a b"),
        json!(""),
        json!(7),
        json!(null),
    ] {
        let mut request = plain("x");
        request["name"] = name.clone();
        assert_eq!(save(&store, &request), refused("invalid-name"), "{name}");
    }
    let mut missing = plain("x");
    missing.as_object_mut().unwrap().remove("name");
    assert_eq!(save(&store, &missing), refused("invalid-name"));
    let mut dashed = plain("a-1-b");
    dashed["name"] = json!("a-1-b");
    assert_eq!(save(&store, &dashed), ok());
}

#[test]
fn refuses_a_kind_that_is_not_text_or_not_declared() {
    let Setup { store, .. } = setup();
    for kind in [json!(null), json!(3), json!("ftp"), json!("HTTP")] {
        let mut request = plain("api");
        request["kind"] = kind.clone();
        assert_eq!(save(&store, &request), refused("unknown-kind"), "{kind}");
    }
    let mut missing = plain("api");
    missing.as_object_mut().unwrap().remove("kind");
    assert_eq!(save(&store, &missing), refused("unknown-kind"));
}

#[test]
fn refuses_to_change_the_kind_of_a_connection_that_exists() {
    let Setup { store, .. } = setup();
    let both = [http_kind(), ftp_kind()];
    assert_eq!(
        as_json(&store.save("graphs", &both, &plain("api")).unwrap()),
        ok()
    );
    let as_ftp = json!({"name": "api", "kind": "ftp", "fields": {"host": "h"}});
    assert_eq!(
        as_json(&store.save("graphs", &both, &as_ftp).unwrap()),
        refused("kind-changed")
    );
    let renamed = json!({"name": "api2", "kind": "ftp", "fields": {"host": "h"}});
    assert_eq!(
        as_json(&store.save("graphs", &both, &renamed).unwrap()),
        ok()
    );
}

#[test]
fn says_which_field_or_secret_is_wrong_in_the_refusal() {
    let Setup { store, .. } = setup();
    let with = |key: &str, value: Value| {
        let mut changed = plain("api");
        changed[key] = value;
        changed
    };
    let rows = [
        (
            with("fields", json!({"baseUrl": "u", "extra": "x"})),
            "invalid-field: unknown field extra",
        ),
        (
            with("fields", json!({})),
            "invalid-field: baseUrl is required",
        ),
        (
            with("fields", json!({"baseUrl": ""})),
            "invalid-field: baseUrl is required",
        ),
        (
            with("fields", json!({"baseUrl": "u", "header": null})),
            "invalid-field: header must be text of at most 2048 characters",
        ),
        (
            with("fields", json!({"baseUrl": "u", "header": 5})),
            "invalid-field: header must be text of at most 2048 characters",
        ),
        (
            with("fields", json!({"baseUrl": "x".repeat(2049)})),
            "invalid-field: baseUrl must be text of at most 2048 characters",
        ),
        (
            with("fields", json!({"baseUrl": "a\nb"})),
            "invalid-field: baseUrl must not hold a control character",
        ),
        (
            with("fields", json!({"baseUrl": "u", "auth": "oauth"})),
            "invalid-field: auth must be one of none, bearer, header, basic",
        ),
        (
            with("secrets", json!({"other": "x"})),
            "invalid-secret: unknown secret other",
        ),
        (
            with("secrets", json!({"secret": ""})),
            "invalid-secret: secret must be 1-4096 characters",
        ),
        (
            with("secrets", json!({"secret": 5})),
            "invalid-secret: secret must be 1-4096 characters",
        ),
        (
            with("secrets", json!({"secret": "x".repeat(4097)})),
            "invalid-secret: secret must be 1-4096 characters",
        ),
        (
            with("secrets", json!({"secret": "a\nb"})),
            "invalid-secret: secret must not hold a control character such as a line break",
        ),
        (
            with("secrets", json!("text")),
            "invalid-secret: secrets must be an object",
        ),
        (
            with("secrets", json!(null)),
            "invalid-secret: secrets must be an object",
        ),
        (
            with("secrets", json!(["a"])),
            "invalid-secret: secrets must be an object",
        ),
    ];
    for (request, error) in rows {
        assert_eq!(save(&store, &request), refused(error), "{request}");
    }
}

#[test]
fn checks_a_field_before_a_secret_and_writes_nothing_when_either_is_refused() {
    let Setup { store, secrets, .. } = setup();
    let mut both = plain("api");
    both["fields"] = json!({});
    both["secrets"] = json!({"nope": "x"});
    assert_eq!(
        save(&store, &both),
        refused("invalid-field: baseUrl is required")
    );
    let mut secret_only = plain("api");
    secret_only["secrets"] = json!({"secret": "fine", "nope": "x"});
    assert_eq!(
        save(&store, &secret_only),
        refused("invalid-secret: unknown secret nope")
    );
    assert!(secrets.keys("graphs").is_empty());
    assert!(store.names("graphs", &kinds()).is_empty());
}

#[test]
fn counts_the_length_of_a_value_in_utf16_units() {
    let Setup { store, .. } = setup();
    assert_eq!(EXTENSION_CONNECTION_VALUE_MAX, 2048);
    let mut fits = plain("api");
    fits["fields"] = json!({"baseUrl": "😀".repeat(1024)});
    assert_eq!(save(&store, &fits), ok());
    let mut over = plain("api");
    over["fields"] = json!({"baseUrl": "😀".repeat(1025)});
    assert_eq!(
        save(&store, &over),
        refused("invalid-field: baseUrl must be text of at most 2048 characters")
    );
    let mut secret_fits = plain("api");
    secret_fits["secrets"] = json!({"secret": "😀".repeat(2048)});
    assert_eq!(save(&store, &secret_fits), ok());
    let mut secret_over = plain("api");
    secret_over["secrets"] = json!({"secret": "😀".repeat(2049)});
    assert_eq!(
        save(&store, &secret_over),
        refused("invalid-secret: secret must be 1-4096 characters")
    );
}

#[test]
fn applies_a_default_only_when_the_field_is_absent_and_skips_an_empty_optional_field() {
    let (_dir, path, store) = without_secrets();
    save(&store, &plain("absent"));
    let mut empty = plain("empty");
    empty["fields"] = json!({"baseUrl": "https://a.test", "auth": "", "header": ""});
    save(&store, &empty);
    let file = stored(&path);
    assert_eq!(
        file["graphs"]["absent"]["fields"],
        json!({"baseUrl": "https://a.test", "auth": "bearer"})
    );
    assert_eq!(
        file["graphs"]["empty"]["fields"],
        json!({"baseUrl": "https://a.test"})
    );
}

#[test]
fn treats_fields_that_are_not_an_object_as_no_fields() {
    let Setup { store, .. } = setup();
    for fields in [json!("text"), json!(null), json!([1]), json!(7)] {
        let mut request = plain("api");
        request["fields"] = fields.clone();
        assert_eq!(
            save(&store, &request),
            refused("invalid-field: baseUrl is required"),
            "{fields}"
        );
    }
    let mut missing = plain("api");
    missing.as_object_mut().unwrap().remove("fields");
    assert_eq!(
        save(&store, &missing),
        refused("invalid-field: baseUrl is required")
    );
}

#[test]
fn stores_the_fields_in_the_order_the_kind_declares_them() {
    let (_dir, path, store) = without_secrets();
    let mut request = plain("api");
    request["fields"] = json!({"header": "X-Key", "auth": "basic", "baseUrl": "https://a.test"});
    save(&store, &request);
    let text = fs::read_to_string(&path).unwrap();
    let base = text.find("baseUrl").unwrap();
    let auth = text.find("\"auth\"").unwrap();
    let header = text.find("\"header\"").unwrap();
    assert!(base < auth && auth < header, "{text}");
}

#[test]
fn a_secret_write_needs_the_secret_store_but_a_clear_and_a_plain_save_do_not() {
    let (_dir, _path, store) = without_secrets();
    let mut with_secret = plain("api");
    with_secret["secrets"] = json!({"secret": "x"});
    assert_eq!(
        save(&store, &with_secret),
        refused("encryption-unavailable")
    );
    assert!(store.names("graphs", &kinds()).is_empty());
    let mut clearing = plain("api");
    clearing["secrets"] = json!({"secret": null});
    assert_eq!(save(&store, &clearing), ok());
    assert_eq!(store.names("graphs", &kinds()).len(), 1);
    assert_eq!(
        as_json(&store.list("graphs", &kinds())),
        json!([{
            "name": "api",
            "kind": "http",
            "fields": {"baseUrl": "https://a.test", "auth": "bearer"},
            "secretsSet": [],
        }])
    );
    assert_eq!(
        as_json(&store.value("graphs", &kinds(), &json!("api")).unwrap())["secrets"],
        json!({})
    );
    assert_eq!(
        as_json(&store.remove("graphs", &json!("api")).unwrap()),
        ok()
    );
}

struct FailingSecrets {
    fail_on: &'static str,
    error: SecretError,
    set_keys: Mutex<Vec<String>>,
}

impl ExtensionSecretStore for FailingSecrets {
    fn keys(&self, _ext_id: &str) -> Vec<String> {
        Vec::new()
    }

    fn get(&self, _ext_id: &str, _key: &str) -> Option<String> {
        None
    }

    fn set(&self, _ext_id: &str, key: &str, _value: Option<&str>) -> Result<(), SecretError> {
        self.set_keys.lock().push(key.to_owned());
        if key.ends_with(self.fail_on) {
            Err(self.error)
        } else {
            Ok(())
        }
    }
}

#[test]
fn returns_the_refusal_of_the_secret_store_and_does_not_write_the_connection() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extension-connections.json");
    let failing = Arc::new(FailingSecrets {
        fail_on: "secret",
        error: SecretError::InvalidValue,
        set_keys: Mutex::new(Vec::new()),
    });
    let store = ExtensionConnections::new(path.clone(), {
        let failing = Arc::clone(&failing);
        move || Some(Arc::clone(&failing) as Arc<dyn ExtensionSecretStore>)
    });
    let mut request = plain("api");
    request["secrets"] = json!({"secret": "x"});
    assert_eq!(save(&store, &request), refused("invalid-value"));
    assert!(!path.exists());
    assert_eq!(*failing.set_keys.lock(), ["@connection/api/secret"]);
}

#[test]
fn a_secret_store_that_cannot_encrypt_refuses_the_save_with_its_own_code() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extension-connections.json");
    let data = Arc::new(Mutex::new(json!({})));
    let secrets: Arc<dyn ExtensionSecretStore> =
        Arc::new(create_secret_store(secret_deps(&data, false)));
    let store = ExtensionConnections::new(path.clone(), move || Some(Arc::clone(&secrets)));
    let mut request = plain("api");
    request["secrets"] = json!({"secret": "x"});
    assert_eq!(save(&store, &request), refused("encryption-unavailable"));
    assert!(!path.exists());
}

#[test]
fn lists_only_the_secrets_the_kind_declares_that_the_store_holds() {
    let Setup { store, secrets, .. } = setup();
    save(&store, &plain("api"));
    save(&store, &plain("bare"));
    secrets
        .set("graphs", &connection_secret_key("api", "secret"), Some("x"))
        .unwrap();
    secrets
        .set("graphs", &connection_secret_key("api", "stale"), Some("x"))
        .unwrap();
    secrets
        .set("graphs", &connection_secret_key("bare", "other"), Some("x"))
        .unwrap();
    let listed = as_json(&store.list("graphs", &kinds()));
    assert_eq!(listed[0]["secretsSet"], json!(["secret"]));
    assert_eq!(listed[1]["secretsSet"], json!([]));
}

#[test]
fn gives_a_value_only_for_a_name_that_is_text_and_leaves_out_secrets_that_are_not_set() {
    let Setup { store, .. } = setup();
    save(&store, &plain("api"));
    for name in [
        json!(null),
        json!(3),
        json!(["api"]),
        json!({"name": "api"}),
    ] {
        assert!(
            store.value("graphs", &kinds(), &name).is_none(),
            "name {name}"
        );
    }
    let value = as_json(&store.value("graphs", &kinds(), &json!("api")).unwrap());
    assert_eq!(value["secrets"], json!({}));
}

#[test]
fn keeps_the_connections_of_other_extensions_when_it_saves_and_removes() {
    let (_dir, path, store) = without_secrets();
    save_for(&store, "one", &plain("api"));
    save_for(&store, "two", &plain("api"));
    store.remove("one", &json!("api")).unwrap();
    assert_eq!(store.names("two", &kinds()).len(), 1);
    assert_eq!(
        stored(&path),
        json!({"two": {"api": {"kind": "http", "fields": {"baseUrl": "https://a.test", "auth": "bearer"}}}})
    );
}
