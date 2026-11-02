#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::keymap::{
    KEYMAP_LABEL_MAX, KEYMAP_PLATFORMS, KeymapPlatform, is_keymap_platform, keymap_offered,
    keymap_ref,
};
use serde_json::{Value, json};

#[test]
fn lists_darwin_and_linux_as_the_keymap_platforms() {
    assert_eq!(
        KEYMAP_PLATFORMS,
        [KeymapPlatform::Darwin, KeymapPlatform::Linux]
    );
    assert_eq!(KEYMAP_LABEL_MAX, 40);
}

#[test]
fn joins_the_extension_id_and_the_keymap_id_with_a_slash() {
    assert_eq!(keymap_ref("vim", "normal"), "vim/normal");
}

#[test]
fn knows_a_keymap_platform_only_by_its_exact_name() {
    assert!(is_keymap_platform(&json!("darwin")));
    assert!(is_keymap_platform(&json!("linux")));
    let bad = [
        json!("win32"),
        json!("Darwin"),
        json!(""),
        json!(1),
        json!(["darwin"]),
        Value::Null,
    ];
    for value in bad {
        assert!(!is_keymap_platform(&value), "{value}");
    }
}

#[test]
fn offers_a_keymap_with_no_platform_everywhere() {
    assert!(keymap_offered(None, "darwin"));
    assert!(keymap_offered(None, "linux"));
    assert!(keymap_offered(None, "win32"));
}

#[test]
fn offers_a_keymap_with_a_platform_only_on_that_platform() {
    assert!(keymap_offered(Some(KeymapPlatform::Darwin), "darwin"));
    assert!(!keymap_offered(Some(KeymapPlatform::Darwin), "linux"));
    assert!(!keymap_offered(Some(KeymapPlatform::Linux), "darwin"));
    assert!(!keymap_offered(Some(KeymapPlatform::Linux), "win32"));
}

#[test]
fn writes_a_platform_in_lower_case() {
    assert_eq!(
        serde_json::to_value(KeymapPlatform::Darwin).unwrap(),
        json!("darwin")
    );
    assert_eq!(
        serde_json::to_value(KeymapPlatform::Linux).unwrap(),
        json!("linux")
    );
}
