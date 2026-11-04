#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::clock::Clock;
use ostia_gateway::devices::{
    DEFAULT_PHONE_CAPS, Device, DeviceStore, RegisterDeviceInput, RegisteredDevice, is_push_handle,
    is_push_platform, push_of,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const FIXED_NOW: i64 = 1_700_000_000_000;
const FIXED_ISO: &str = "2023-11-14T22:13:20.000Z";

fn file_in() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("gateway-devices.json");
    (dir, file)
}

fn fixed(now: i64) -> Clock {
    Arc::new(move || now)
}

fn input(name: &str, pubkey: &str) -> RegisterDeviceInput {
    RegisterDeviceInput {
        name: name.to_owned(),
        pubkey: pubkey.to_owned(),
        install_id: None,
    }
}

fn with_install(name: &str, pubkey: &str, install_id: &str) -> RegisterDeviceInput {
    RegisterDeviceInput {
        install_id: Some(install_id.to_owned()),
        ..input(name, pubkey)
    }
}

fn register(store: &DeviceStore, name: &str, pubkey: &str) -> RegisteredDevice {
    store.register_device(input(name, pubkey)).unwrap()
}

fn cap(store: &DeviceStore, device_id: &str, cap: &str, granted: bool) -> Value {
    cap_value(store, device_id, &json!(cap), granted)
}

fn cap_value(store: &DeviceStore, device_id: &str, cap: &Value, granted: bool) -> Value {
    serde_json::to_value(store.set_device_cap(device_id, cap, granted).unwrap()).unwrap()
}

fn caps_of(store: &DeviceStore, device_id: &str) -> Vec<String> {
    store.get(device_id).unwrap().caps
}

fn push_json(store: &DeviceStore, device_id: &str) -> Value {
    serde_json::to_value(push_of(&store.get(device_id).unwrap())).unwrap()
}

fn stored_push(store: &DeviceStore, device_id: &str) -> Value {
    serde_json::to_value(store.get(device_id).unwrap()).unwrap()["push"].clone()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[test]
fn register_device_mints_a_device_id_and_opaque_token_and_seeds_default_phone_caps() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "iPhone 15", "BASE64-SPKI");
    assert!(res.device_id.starts_with("dev_"));
    assert!(hex64(&res.token), "{}", res.token);
    assert_eq!(res.caps, DEFAULT_PHONE_CAPS);
}

#[test]
fn register_device_mints_distinct_device_ids_and_tokens_on_repeated_calls() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let a = register(&store, "A", "pkA");
    let b = register(&store, "B", "pkB");
    assert_ne!(a.device_id, b.device_id);
    assert_ne!(a.token, b.token);
}

#[test]
fn verify_token_resolves_a_registered_device_by_its_bearer_token() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "iPhone 15", "BASE64-SPKI");
    let device = store.verify_token(&res.token).unwrap();
    assert_eq!(device.device_id, res.device_id);
    assert_eq!(device.name, "iPhone 15");
}

#[test]
fn verify_token_returns_none_for_an_unknown_token() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    register(&store, "iPhone 15", "BASE64-SPKI");
    assert!(store.verify_token("not-a-real-token").is_none());
}

#[test]
fn verify_token_refuses_a_prefix_a_longer_token_and_an_empty_one() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "iPhone 15", "BASE64-SPKI");
    assert!(store.verify_token(&res.token[..63]).is_none());
    assert!(store.verify_token(&format!("{}0", res.token)).is_none());
    assert!(store.verify_token(&res.token.to_uppercase()).is_none());
    assert!(store.verify_token("").is_none());
    assert!(store.verify_token(&res.token).is_some());
}

#[test]
fn list_returns_every_registered_device() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    register(&store, "A", "pkA");
    register(&store, "B", "pkB");
    let mut names: Vec<String> = store.list().into_iter().map(|d| d.name).collect();
    names.sort();
    assert_eq!(names, ["A", "B"]);
}

#[test]
fn lists_devices_in_the_order_they_were_registered() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    for name in ["C", "A", "D", "B"] {
        register(&store, name, "pk");
    }
    let names =
        |store: &DeviceStore| -> Vec<String> { store.list().into_iter().map(|d| d.name).collect() };
    assert_eq!(names(&store), ["C", "A", "D", "B"]);
    assert_eq!(names(&DeviceStore::new(file)), ["C", "A", "D", "B"]);
}

#[test]
fn revoke_deletes_a_device_and_its_token_stops_verifying() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "iPhone 15", "BASE64-SPKI");
    assert!(store.revoke(&res.device_id).unwrap());
    assert!(store.verify_token(&res.token).is_none());
}

#[test]
fn revoke_returns_false_for_an_unknown_device_id() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    assert!(!store.revoke("dev_does-not-exist").unwrap());
}

#[test]
fn set_device_cap_grants_input_and_persists_it_so_a_later_lookup_sees_the_raised_caps() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Phone", "pk");
    assert_eq!(
        cap(&store, &res.device_id, "input", true),
        json!({"ok": true, "caps": ["read", "notify", "input"]})
    );
    assert!(
        store
            .verify_token(&res.token)
            .unwrap()
            .caps
            .contains(&"input".to_owned())
    );
    assert!(caps_of(&store, &res.device_id).contains(&"input".to_owned()));
}

#[test]
fn set_device_cap_keeps_respond_in_the_canonical_order_read_notify_respond_command_input_destructive()
 {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Phone", "pk");
    cap(&store, &res.device_id, "input", true);
    cap(&store, &res.device_id, "command", true);
    assert_eq!(
        cap(&store, &res.device_id, "respond", true),
        json!({"ok": true, "caps": ["read", "notify", "respond", "command", "input"]})
    );
}

#[test]
fn set_device_cap_revokes_a_granted_cap() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Phone", "pk");
    cap(&store, &res.device_id, "command", true);
    assert_eq!(
        cap(&store, &res.device_id, "command", false),
        json!({"ok": true, "caps": ["read", "notify"]})
    );
}

#[test]
fn set_device_cap_refuses_to_grant_or_strip_a_base_cap_or_an_unknown_cap() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Phone", "pk");
    for name in [
        json!("read"),
        json!("notify"),
        json!("gateway"),
        json!("all-workspaces"),
        json!(42),
    ] {
        for granted in [false, true] {
            assert_eq!(
                cap_value(&store, &res.device_id, &name, granted),
                json!({"ok": false, "error": "invalid-cap"}),
                "{name} {granted}"
            );
        }
    }
    assert_eq!(caps_of(&store, &res.device_id), DEFAULT_PHONE_CAPS);
}

#[test]
fn set_device_cap_refuses_destructive_until_command_is_granted() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Phone", "pk");
    assert_eq!(
        cap(&store, &res.device_id, "destructive", true),
        json!({"ok": false, "error": "requires-command"})
    );
    cap(&store, &res.device_id, "command", true);
    assert_eq!(
        cap(&store, &res.device_id, "destructive", true),
        json!({"ok": true, "caps": ["read", "notify", "command", "destructive"]})
    );
}

#[test]
fn set_device_cap_drops_destructive_when_command_is_revoked() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Phone", "pk");
    cap(&store, &res.device_id, "command", true);
    cap(&store, &res.device_id, "destructive", true);
    cap(&store, &res.device_id, "command", false);
    assert_eq!(caps_of(&store, &res.device_id), ["read", "notify"]);
}

#[test]
fn set_device_cap_drops_caps_a_stored_device_holds_that_ostia_no_longer_knows() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    let res = register(&store, "Phone", "pk");
    let mut stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    stored[&res.device_id]["caps"] =
        json!(["read", "board.read", "notify", "board.write", "input"]);
    fs::write(&file, stored.to_string()).unwrap();
    assert_eq!(caps_of(&store, &res.device_id), ["read", "notify", "input"]);
    assert_eq!(
        store.verify_token(&res.token).unwrap().caps,
        ["read", "notify", "input"]
    );
}

#[test]
fn set_device_cap_is_not_found_for_an_unknown_device() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    assert_eq!(
        cap(&store, "dev_nope", "input", true),
        json!({"ok": false, "error": "not-found"})
    );
}

#[test]
fn set_device_cap_checks_the_cap_before_it_looks_for_the_device() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    assert_eq!(
        cap(&store, "dev_nope", "read", true),
        json!({"ok": false, "error": "invalid-cap"})
    );
}

#[test]
fn set_device_cap_is_idempotent_and_orders_caps_a_stored_device_holds_out_of_order() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    let res = register(&store, "Phone", "pk");
    cap(&store, &res.device_id, "input", true);
    assert_eq!(
        cap(&store, &res.device_id, "input", true),
        json!({"ok": true, "caps": ["read", "notify", "input"]})
    );
    assert_eq!(
        cap(&store, &res.device_id, "command", false),
        json!({"ok": true, "caps": ["read", "notify", "input"]})
    );
    let mut stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    stored[&res.device_id]["caps"] = json!(["input", "read", "read", "command", "notify"]);
    fs::write(&file, stored.to_string()).unwrap();
    assert_eq!(
        caps_of(&store, &res.device_id),
        ["read", "notify", "command", "input"]
    );
    stored[&res.device_id]["caps"] = json!("read");
    fs::write(&file, stored.to_string()).unwrap();
    assert!(caps_of(&store, &res.device_id).is_empty());
}

#[test]
fn pid_c7_updates_a_device_name_from_the_phone_trimmed_and_keeps_the_old_one_for_a_bad_name() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Pixel", "pk");
    assert!(
        store
            .set_device_name(&res.device_id, &json!("  Desk phone  "))
            .unwrap()
    );
    assert_eq!(store.get(&res.device_id).unwrap().name, "Desk phone");
    let bad = [
        json!("   "),
        json!(7),
        json!("a\nb"),
        json!("a\u{202E}b"),
        json!("a\u{200B}b"),
        json!("a\u{2028}b"),
        json!("a\u{0}b"),
        json!("\u{feff}ab"),
        json!("a\u{200D}b"),
        json!(null),
        json!(["x"]),
    ];
    for name in bad {
        assert!(
            !store.set_device_name(&res.device_id, &name).unwrap(),
            "{name}"
        );
    }
    assert!(!store.set_device_name("dev_missing", &json!("x")).unwrap());
    assert_eq!(store.get(&res.device_id).unwrap().name, "Desk phone");
}

#[test]
fn set_device_name_trims_the_javascript_whitespace_set_and_accepts_the_same_name_again() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Pixel", "pk");
    assert!(
        store
            .set_device_name(&res.device_id, &json!("\u{a0}\u{3000}Desk\u{a0}"))
            .unwrap()
    );
    assert_eq!(store.get(&res.device_id).unwrap().name, "Desk");
    assert!(
        store
            .set_device_name(&res.device_id, &json!("Desk"))
            .unwrap()
    );
    assert_eq!(store.get(&res.device_id).unwrap().name, "Desk");
}

#[test]
fn pid_c8_cuts_a_long_name_at_64_characters_without_splitting_an_emoji() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let long = register(&store, &"a".repeat(200), "pk");
    assert_eq!(store.get(&long.device_id).unwrap().name.chars().count(), 64);
    let emoji = register(&store, &"\u{1F600}".repeat(70), "pk");
    assert_eq!(
        store.get(&emoji.device_id).unwrap().name,
        "\u{1F600}".repeat(64)
    );
}

#[test]
fn cuts_a_long_name_at_64_grapheme_clusters_and_trims_what_the_cut_leaves() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let marks = register(&store, &"e\u{301}".repeat(70), "pk");
    assert_eq!(
        store.get(&marks.device_id).unwrap().name,
        "e\u{301}".repeat(64)
    );
    let spaced = register(&store, &format!("{} b", "a".repeat(63)), "pk");
    assert_eq!(store.get(&spaced.device_id).unwrap().name, "a".repeat(63));
}

#[test]
fn names_a_device_phone_when_the_name_is_empty_or_unsafe() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    for name in ["", "   ", "a\nb", "a\u{200D}b", "a\u{202E}b"] {
        let res = register(&store, name, "pk");
        assert_eq!(store.get(&res.device_id).unwrap().name, "Phone", "{name:?}");
    }
}

#[test]
fn pid_c9_replaces_every_row_of_one_install_identity_and_revokes_their_tokens() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let install = "i".repeat(20);
    let old = store
        .register_device(with_install("Pixel", "pk1", &install))
        .unwrap();
    cap(&store, &old.device_id, "input", true);
    let next = store
        .register_device(with_install("Pixel", "pk2", &install))
        .unwrap();
    assert_eq!(
        caps_of(&store, &next.device_id),
        ["read", "notify", "input"]
    );
    assert_eq!(next.replaced, std::slice::from_ref(&old.device_id));
    let ids: Vec<String> = store.list().into_iter().map(|d| d.device_id).collect();
    assert_eq!(ids, [next.device_id]);
    assert!(store.verify_token(&old.token).is_none());
}

#[test]
fn replaces_several_rows_of_one_install_and_takes_the_caps_of_the_first() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    let install = "j".repeat(20);
    let first = store
        .register_device(with_install("One", "pk1", &install))
        .unwrap();
    cap(&store, &first.device_id, "respond", true);
    let mut stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let mut twin = stored[&first.device_id].clone();
    twin["deviceId"] = json!("dev_twin");
    twin["token"] = json!("f".repeat(64));
    twin["caps"] = json!(["read", "notify", "input"]);
    stored["dev_twin"] = twin;
    fs::write(&file, stored.to_string()).unwrap();
    let next = store
        .register_device(with_install("Two", "pk2", &install))
        .unwrap();
    assert_eq!(
        next.replaced,
        [first.device_id.clone(), "dev_twin".to_owned()]
    );
    assert_eq!(next.caps, ["read", "notify", "respond"]);
    assert_eq!(store.list().len(), 1);
}

#[test]
fn keeps_devices_of_another_install_and_devices_with_no_install() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let a = store
        .register_device(with_install("A", "pk", &"a".repeat(20)))
        .unwrap();
    let plain = register(&store, "Plain", "pk");
    let b = store
        .register_device(with_install("B", "pk", &"b".repeat(20)))
        .unwrap();
    assert!(b.replaced.is_empty());
    assert!(b.replaced_handles.is_empty());
    let again = register(&store, "Plain", "pk");
    assert!(again.replaced.is_empty());
    assert_eq!(store.list().len(), 4);
    assert!(store.get(&a.device_id).is_some() && store.get(&plain.device_id).is_some());
}

#[test]
fn finds_a_device_by_its_install_id() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = store
        .register_device(with_install("A", "pk", &"a".repeat(20)))
        .unwrap();
    register(&store, "Plain", "pk");
    assert_eq!(
        store
            .device_by_install_id(Some(&"a".repeat(20)))
            .unwrap()
            .device_id,
        res.device_id
    );
    assert!(store.device_by_install_id(Some("unknown")).is_none());
    assert!(store.device_by_install_id(Some("")).is_none());
    assert!(store.device_by_install_id(None).is_none());
}

#[test]
fn psh_c50_keeps_push_off_by_default_and_stores_the_switch_handle_and_platform_in_the_secure_store()
{
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    let res = register(&store, "Pixel", "pk");
    assert_eq!(push_json(&store, &res.device_id), json!({"enabled": false}));
    let handle = "h".repeat(26);
    assert!(
        store
            .set_device_push(
                &res.device_id,
                &json!({"enabled": true, "handle": handle, "platform": "fcm"})
            )
            .unwrap()
    );
    assert_eq!(
        stored_push(&store, &res.device_id),
        json!({"enabled": true, "handle": handle, "platform": "fcm"})
    );
    assert!(
        !store
            .set_device_push("dev_missing", &json!({"enabled": true}))
            .unwrap()
    );
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn psh_c51_drops_the_handle_when_the_switch_goes_off_and_refuses_a_malformed_handle_or_platform() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Pixel", "pk");
    let id = &res.device_id;
    let handle = "h".repeat(26);
    store
        .set_device_push(
            id,
            &json!({"enabled": true, "handle": handle, "platform": "apns"}),
        )
        .unwrap();
    store
        .set_device_push(id, &json!({"enabled": false}))
        .unwrap();
    assert_eq!(push_json(&store, id), json!({"enabled": false}));
    store
        .set_device_push(
            id,
            &json!({"enabled": true, "handle": "bad handle!", "platform": "fcm"}),
        )
        .unwrap();
    assert_eq!(push_json(&store, id), json!({"enabled": true}));
    store
        .set_device_push(
            id,
            &json!({"enabled": true, "handle": handle, "platform": "sms"}),
        )
        .unwrap();
    assert_eq!(push_json(&store, id), json!({"enabled": true}));
}

#[test]
fn psh_c52_does_not_carry_the_switch_or_the_handle_over_to_the_device_an_approval_replaces() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let install = "p".repeat(20);
    let old = store
        .register_device(with_install("Pixel", "pk1", &install))
        .unwrap();
    let handle = "h".repeat(26);
    store
        .set_device_push(
            &old.device_id,
            &json!({"enabled": true, "handle": handle, "platform": "fcm"}),
        )
        .unwrap();
    let next = store
        .register_device(with_install("Pixel", "pk2", &install))
        .unwrap();
    assert_eq!(next.replaced_handles, [handle]);
    assert_eq!(
        push_json(&store, &next.device_id),
        json!({"enabled": false})
    );
}

#[test]
fn set_device_push_keeps_nothing_for_a_switch_that_is_not_true_and_nothing_but_valid_parts() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Pixel", "pk");
    let id = &res.device_id;
    let handle = "h".repeat(26);
    for raw in [
        json!({"enabled": "true", "handle": handle, "platform": "fcm"}),
        json!({"enabled": 1}),
        json!({"handle": handle, "platform": "fcm"}),
        json!(null),
        json!("x"),
        json!([]),
    ] {
        assert!(store.set_device_push(id, &raw).unwrap());
        assert_eq!(stored_push(&store, id), Value::Null, "{raw}");
    }
    store
        .set_device_push(id, &json!({"enabled": true, "handle": handle}))
        .unwrap();
    assert_eq!(stored_push(&store, id), json!({"enabled": true}));
    store
        .set_device_push(id, &json!({"enabled": true, "platform": "fcm"}))
        .unwrap();
    assert_eq!(stored_push(&store, id), json!({"enabled": true}));
    store
        .set_device_push(
            id,
            &json!({"enabled": true, "handle": 7, "platform": "fcm", "extra": 1}),
        )
        .unwrap();
    assert_eq!(stored_push(&store, id), json!({"enabled": true}));
}

#[test]
fn accepts_a_push_handle_of_16_to_128_url_safe_characters_and_refuses_the_rest() {
    let accepted = [
        "h".repeat(16),
        "h".repeat(128),
        "A-b_C-d_E-f_G-h_".to_owned(),
        "0123456789abcdef".to_owned(),
    ];
    for handle in accepted {
        assert!(is_push_handle(&handle), "{handle}");
    }
    let refused = [
        String::new(),
        "h".repeat(15),
        "h".repeat(129),
        format!("{}\n", "h".repeat(16)),
        format!("{} ", "h".repeat(16)),
        "\u{e9}".repeat(16),
        "\u{663}".repeat(16),
        format!("{}.", "h".repeat(16)),
        format!("{}/", "h".repeat(16)),
    ];
    for handle in refused {
        assert!(!is_push_handle(&handle), "{handle:?}");
    }
}

#[test]
fn accepts_only_the_fcm_and_apns_push_platforms() {
    assert!(is_push_platform("fcm"));
    assert!(is_push_platform("apns"));
    for platform in ["", "FCM", "Apns", "sms", "fcm ", "web"] {
        assert!(!is_push_platform(platform), "{platform:?}");
    }
}

#[test]
fn touch_device_stamps_the_last_seen_time_and_ignores_an_unknown_device() {
    let (_dir, file) = file_in();
    let store = DeviceStore::with_clock(file.clone(), fixed(FIXED_NOW));
    let res = register(&store, "Pixel", "pk");
    assert!(store.get(&res.device_id).unwrap().last_seen_at.is_none());
    store.touch_device(&res.device_id).unwrap();
    assert_eq!(
        store.get(&res.device_id).unwrap().last_seen_at.as_deref(),
        Some(FIXED_ISO)
    );
    let before = fs::read(&file).unwrap();
    store.touch_device("dev_missing").unwrap();
    assert_eq!(fs::read(&file).unwrap(), before);
}

#[test]
fn stamps_the_creation_time_as_an_iso_string_with_milliseconds() {
    let (_dir, file) = file_in();
    let store = DeviceStore::with_clock(file, fixed(FIXED_NOW + 7));
    let res = register(&store, "Pixel", "pk");
    assert_eq!(
        store.get(&res.device_id).unwrap().created_at,
        "2023-11-14T22:13:20.007Z"
    );
}

#[test]
fn keeps_the_store_private_to_the_owner_and_in_the_shape_the_app_reads_back() {
    let (_dir, file) = file_in();
    let store = DeviceStore::with_clock(file.clone(), fixed(FIXED_NOW));
    let res = store
        .register_device(with_install("Pixel", "pk", &"i".repeat(20)))
        .unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let device = &stored[&res.device_id];
    let keys: Vec<&String> = device.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "deviceId",
            "name",
            "pubkey",
            "token",
            "caps",
            "createdAt",
            "installId"
        ]
    );
    assert_eq!(device["token"], json!(res.token));
    assert_eq!(device["createdAt"], json!(FIXED_ISO));
}

#[test]
fn starts_empty_when_the_file_is_missing_or_holds_no_json() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    assert!(store.list().is_empty());
    assert!(store.get("dev_x").is_none());
    fs::write(&file, "not json {").unwrap();
    assert!(store.list().is_empty());
    let res = register(&store, "Pixel", "pk");
    assert_eq!(store.list().len(), 1);
    assert!(store.get(&res.device_id).is_some());
}

#[test]
fn finds_no_device_whose_id_is_a_name_every_object_has() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file.clone());
    for id in [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
    ] {
        assert!(store.get(id).is_none(), "{id}");
        assert!(!store.revoke(id).unwrap(), "{id}");
        assert!(!store.set_device_name(id, &json!("x")).unwrap(), "{id}");
        assert!(
            !store
                .set_device_push(id, &json!({"enabled": true}))
                .unwrap(),
            "{id}"
        );
        store.touch_device(id).unwrap();
        assert_eq!(
            cap(&store, id, "input", true),
            json!({"ok": false, "error": "not-found"}),
            "{id}"
        );
    }
    assert!(!file.exists());
}

#[test]
fn never_shows_a_token_in_debug_output() {
    let (_dir, file) = file_in();
    let store = DeviceStore::new(file);
    let res = register(&store, "Pixel", "pk");
    let device: Device = store.get(&res.device_id).unwrap();
    assert!(!format!("{device:?}").contains(&res.token));
    assert!(!format!("{res:?}").contains(&res.token));
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let (_dir, file) = file_in();
    fs::copy(fixture("gateway-devices-before.json"), &file).unwrap();
    let before: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let id_of = |name: &str| -> String {
        before
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, device)| device["name"] == name)
            .map(|(id, _)| id.clone())
            .unwrap()
    };
    let push_on =
        |platform: &str| json!({"enabled": true, "handle": "h".repeat(26), "platform": platform});
    let store = DeviceStore::with_clock(file.clone(), fixed(FIXED_NOW));
    assert_eq!(store.list().len(), 5);
    assert_eq!(caps_of(&store, &id_of("Old")), ["read", "notify", "input"]);
    assert_eq!(push_json(&store, &id_of("Plain")), json!({"enabled": true}));
    store
        .set_device_push(&id_of("Desk"), &push_on("fcm"))
        .unwrap();
    store.touch_device(&id_of("Pixel")).unwrap();
    store
        .set_device_push(&id_of("Tab"), &json!({"enabled": false}))
        .unwrap();
    store
        .set_device_push(&id_of("Tab"), &push_on("apns"))
        .unwrap();
    store
        .set_device_name(&id_of("Plain"), &json!("  Renamed  "))
        .unwrap();
    store
        .set_device_cap(&id_of("Old"), &json!("command"), true)
        .unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("gateway-devices-after.json")).unwrap()
    );
}

#[test]
fn lists_an_entry_that_has_no_token_and_never_lets_it_authenticate() {
    let (_dir, file) = file_in();
    fs::write(
        &file,
        r#"{"dev_a":{"deviceId":"dev_a","name":"x","caps":[]}}"#,
    )
    .unwrap();
    let store = DeviceStore::new(file);
    let listed = store.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].device_id, "dev_a");
    assert_eq!(listed[0].token, None);
    assert!(store.get("dev_a").is_some());
    assert!(store.verify_token("").is_none());
}
