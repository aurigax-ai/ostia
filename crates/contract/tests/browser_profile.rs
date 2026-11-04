#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::browser_profile::{
    BrowserOpener, BrowserProfile, BrowserProfileContext, SHARED_BROWSER_PARTITION,
    browser_partition, browser_profile_for, is_isolated_browser_partition, parse_browser_profile,
};
use serde_json::json;

fn profile_for(opener: BrowserOpener, scratch: bool, sandboxed: bool) -> BrowserProfile {
    browser_profile_for(BrowserProfileContext {
        opener,
        scratch,
        sandboxed,
    })
}

#[test]
fn gives_a_pane_the_human_opens_in_an_ordinary_workspace_the_shared_profile() {
    assert_eq!(
        profile_for(BrowserOpener::Human, false, false),
        BrowserProfile::Shared
    );
}

#[test]
fn keeps_a_pane_an_agent_opens_isolated() {
    assert_eq!(
        profile_for(BrowserOpener::Agent, false, false),
        BrowserProfile::Isolated
    );
}

#[test]
fn keeps_every_pane_of_a_scratch_workspace_isolated_whoever_opens_it() {
    assert_eq!(
        profile_for(BrowserOpener::Human, true, false),
        BrowserProfile::Isolated
    );
    assert_eq!(
        profile_for(BrowserOpener::Agent, true, false),
        BrowserProfile::Isolated
    );
}

#[test]
fn keeps_every_pane_of_a_sandboxed_workspace_isolated_whoever_opens_it() {
    assert_eq!(
        profile_for(BrowserOpener::Human, false, true),
        BrowserProfile::Isolated
    );
    assert_eq!(
        profile_for(BrowserOpener::Agent, false, true),
        BrowserProfile::Isolated
    );
}

#[test]
fn keeps_a_scratch_and_sandboxed_workspace_isolated() {
    assert_eq!(
        profile_for(BrowserOpener::Human, true, true),
        BrowserProfile::Isolated
    );
}

#[test]
fn names_one_persistent_partition_for_the_shared_profile_and_one_in_memory_partition_per_isolated_pane()
 {
    assert_eq!(
        browser_partition(BrowserProfile::Shared, "p1"),
        SHARED_BROWSER_PARTITION
    );
    assert!(SHARED_BROWSER_PARTITION.starts_with("persist:"));
    assert_eq!(
        browser_partition(BrowserProfile::Isolated, "p1"),
        "ostia-browser-p1"
    );
    assert_ne!(
        browser_partition(BrowserProfile::Isolated, "p1"),
        browser_partition(BrowserProfile::Isolated, "p2")
    );
}

#[test]
fn names_the_shared_partition_the_same_for_every_pane() {
    assert_eq!(SHARED_BROWSER_PARTITION, "persist:ostia-browser");
    assert_eq!(
        browser_partition(BrowserProfile::Shared, "p1"),
        browser_partition(BrowserProfile::Shared, "p2")
    );
}

#[test]
fn recognises_only_isolated_pane_partitions_as_isolated() {
    assert!(is_isolated_browser_partition(Some("ostia-browser-p1")));
    assert!(!is_isolated_browser_partition(Some(
        SHARED_BROWSER_PARTITION
    )));
    assert!(!is_isolated_browser_partition(Some(
        "persist:ostia-browser-p1"
    )));
    assert!(!is_isolated_browser_partition(Some("ostia-ext-git")));
    assert!(!is_isolated_browser_partition(None));
}

#[test]
fn recognises_the_isolated_prefix_with_an_empty_pane_id() {
    assert!(is_isolated_browser_partition(Some("ostia-browser-")));
    assert!(!is_isolated_browser_partition(Some("ostia-browser")));
    assert!(!is_isolated_browser_partition(Some("")));
}

#[test]
fn parses_anything_but_shared_as_isolated() {
    assert_eq!(
        parse_browser_profile(&json!("shared")),
        BrowserProfile::Shared
    );
    for raw in [
        json!("isolated"),
        json!(null),
        json!("SHARED"),
        json!(1),
        json!(["shared"]),
        json!({"profile": "shared"}),
        json!(true),
    ] {
        assert_eq!(
            parse_browser_profile(&raw),
            BrowserProfile::Isolated,
            "{raw}"
        );
    }
}
