#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::Platform;
use ostia_model::platform::{is_linux, is_mac};

#[test]
fn a_darwin_platform_is_mac_and_not_linux() {
    assert!(is_mac(Platform::Darwin));
    assert!(!is_linux(Platform::Darwin));
}

#[test]
fn a_linux_platform_is_linux_and_not_mac() {
    assert!(is_linux(Platform::Linux));
    assert!(!is_mac(Platform::Linux));
}

#[test]
fn the_platform_of_this_build_is_exactly_one_of_mac_and_linux() {
    let current = Platform::current();
    assert_ne!(is_mac(current), is_linux(current));
    assert_eq!(is_mac(current), cfg!(target_os = "macos"));
}
