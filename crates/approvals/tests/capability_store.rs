#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use ostia_approvals::{CapabilityStore, ReachMode};
use ostia_base::ExternalId;
use ostia_base::host::Host;
use ostia_contract::capabilities::Capability;
use ostia_control::CapabilityStore as _;
use ostia_testkit::temp_host;
use serde_json::{Value, json};
use tempfile::TempDir;

fn id(value: &str) -> ExternalId {
    ExternalId::new(value)
}

fn fresh() -> (TempDir, Host, CapabilityStore) {
    let (dir, host) = temp_host().unwrap();
    fs::create_dir_all(host.app_config_dir()).unwrap();
    let store = CapabilityStore::new(&host);
    (dir, host, store)
}

fn settings_path(host: &Host) -> PathBuf {
    host.app_config_dir().join("settings.json")
}

fn write_settings(host: &Host, value: &Value) {
    fs::write(settings_path(host), serde_json::to_string(value).unwrap()).unwrap();
}

fn read_settings(host: &Host) -> Value {
    serde_json::from_str(&fs::read_to_string(settings_path(host)).unwrap()).unwrap()
}

fn stored_grants(host: &Host) -> Value {
    read_settings(host)["capabilities"]["grants"].clone()
}

#[test]
fn init_caps_seeds_the_default_capabilities_and_is_idempotent() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("ext-1"));
    assert!(store.has_cap(&id("ext-1"), Capability::DriveSelf));
    assert!(store.has_cap(&id("ext-1"), Capability::ReadBoard));

    store.grant(&id("ext-1"), Capability::Shell);
    store.init_caps(&id("ext-1"));
    assert!(store.has_cap(&id("ext-1"), Capability::Shell));
}

#[test]
fn grant_adds_an_elevated_cap_and_has_cap_reflects_it() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("ext-2"));
    assert!(!store.has_cap(&id("ext-2"), Capability::Shell));
    store.grant(&id("ext-2"), Capability::Shell);
    assert!(store.has_cap(&id("ext-2"), Capability::Shell));
}

#[test]
fn has_cap_is_false_for_an_ungranted_elevated_cap_and_for_an_unknown_id() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("ext-4"));
    assert!(!store.has_cap(&id("ext-4"), Capability::Shell));
    assert!(!store.has_cap(&id("unknown-id"), Capability::DriveSelf));
}

#[test]
fn drop_identity_clears_all_caps_for_an_identity() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("ext-5"));
    store.grant(&id("ext-5"), Capability::Shell);
    assert!(store.has_cap(&id("ext-5"), Capability::Shell));
    store.drop_identity(&id("ext-5"));
    assert!(!store.has_cap(&id("ext-5"), Capability::Shell));
    assert!(!store.has_cap(&id("ext-5"), Capability::DriveSelf));
}

#[test]
fn grant_on_an_unknown_id_seeds_the_defaults_first() {
    let (_dir, _host, store) = fresh();
    store.grant(&id("fresh"), Capability::Shell);
    assert!(store.has_cap(&id("fresh"), Capability::Shell));
    assert!(store.has_cap(&id("fresh"), Capability::DriveSelf));
}

#[test]
fn set_caps_replaces_the_set_without_the_defaults() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("ext-6"));
    store.set_caps(&id("ext-6"), &[Capability::Browse]);
    assert!(store.has_cap(&id("ext-6"), Capability::Browse));
    assert!(!store.has_cap(&id("ext-6"), Capability::DriveSelf));
}

#[test]
fn revoke_removes_one_cap_and_ignores_an_unknown_id() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("ext-7"));
    store.grant(&id("ext-7"), Capability::Shell);
    store.revoke(&id("ext-7"), Capability::Shell);
    assert!(!store.has_cap(&id("ext-7"), Capability::Shell));
    assert!(store.has_cap(&id("ext-7"), Capability::DriveSelf));
    store.revoke(&id("nobody"), Capability::Shell);
    assert!(!store.has_cap(&id("nobody"), Capability::Shell));
}

#[test]
fn init_caps_seeds_the_standing_grants_from_the_settings_file() {
    let (_dir, host, store) = fresh();
    write_settings(
        &host,
        &json!({"capabilities": {"grants": ["shell", "browse"]}}),
    );
    store.init_caps(&id("ext-8"));
    assert!(store.has_cap(&id("ext-8"), Capability::Shell));
    assert!(store.has_cap(&id("ext-8"), Capability::Browse));
    assert!(store.has_cap(&id("ext-8"), Capability::DriveSelf));
}

#[test]
fn standing_grants_ignore_unknown_names_and_a_grants_value_that_is_not_a_list() {
    let (_dir, host, store) = fresh();
    write_settings(
        &host,
        &json!({"capabilities": {"grants": ["shell", "not-a-cap", 7, null]}}),
    );
    store.init_caps(&id("ext-9"));
    assert!(store.has_cap(&id("ext-9"), Capability::Shell));

    let (_dir2, host2, store2) = fresh();
    write_settings(&host2, &json!({"capabilities": {"grants": "shell"}}));
    store2.init_caps(&id("ext-9"));
    assert!(!store2.has_cap(&id("ext-9"), Capability::Shell));
}

#[test]
fn a_missing_or_unreadable_settings_file_gives_no_standing_grants() {
    let (_dir, host, store) = fresh();
    store.init_caps(&id("ext-10"));
    assert!(!store.has_cap(&id("ext-10"), Capability::Shell));

    let (_dir2, host2, store2) = fresh();
    fs::write(settings_path(&host2), "{ not json").unwrap();
    store2.init_caps(&id("ext-10"));
    assert!(store2.has_cap(&id("ext-10"), Capability::DriveSelf));
    assert!(!store2.has_cap(&id("ext-10"), Capability::Shell));
    drop(host);
}

#[test]
fn standing_grants_are_read_once_until_refresh_capability_settings() {
    let (_dir, host, store) = fresh();
    store.init_caps(&id("first"));
    write_settings(&host, &json!({"capabilities": {"grants": ["shell"]}}));
    store.init_caps(&id("second"));
    assert!(!store.has_cap(&id("second"), Capability::Shell));

    store.refresh_capability_settings();
    store.init_caps(&id("third"));
    assert!(store.has_cap(&id("third"), Capability::Shell));
}

#[test]
fn refresh_capability_settings_adds_new_grants_to_identities_that_follow_settings() {
    let (_dir, host, store) = fresh();
    store.init_caps(&id("follower"));
    store.set_caps(&id("pinned"), &[Capability::DriveSelf]);
    write_settings(&host, &json!({"capabilities": {"grants": ["shell"]}}));
    store.refresh_capability_settings();
    assert!(store.has_cap(&id("follower"), Capability::Shell));
    assert!(!store.has_cap(&id("pinned"), Capability::Shell));
}

#[test]
fn refresh_capability_settings_removes_dropped_grants_but_never_a_default() {
    let (_dir, host, store) = fresh();
    write_settings(
        &host,
        &json!({"capabilities": {"grants": ["shell", "drive-self"]}}),
    );
    store.refresh_capability_settings();
    store.init_caps(&id("follower"));
    assert!(store.has_cap(&id("follower"), Capability::Shell));

    write_settings(&host, &json!({"capabilities": {"grants": []}}));
    store.refresh_capability_settings();
    assert!(!store.has_cap(&id("follower"), Capability::Shell));
    assert!(store.has_cap(&id("follower"), Capability::DriveSelf));
}

#[test]
fn an_identity_stops_following_settings_after_set_caps_or_drop_identity() {
    let (_dir, host, store) = fresh();
    store.init_caps(&id("a"));
    store.set_caps(&id("a"), &[Capability::DriveSelf]);
    store.init_caps(&id("b"));
    store.drop_identity(&id("b"));
    write_settings(&host, &json!({"capabilities": {"grants": ["shell"]}}));
    store.refresh_capability_settings();
    assert!(!store.has_cap(&id("a"), Capability::Shell));
    assert!(!store.has_cap(&id("b"), Capability::Shell));
}

#[test]
fn add_standing_grants_writes_the_settings_file_and_keeps_other_keys() {
    let (_dir, host, store) = fresh();
    write_settings(
        &host,
        &json!({"theme": "dark", "capabilities": {"reach": "group", "grants": ["browse"]}}),
    );
    assert!(store.add_standing_grants(&[Capability::Shell]));
    let settings = read_settings(&host);
    assert_eq!(settings["theme"], json!("dark"));
    assert_eq!(settings["capabilities"]["reach"], json!("group"));
    assert_eq!(
        settings["capabilities"]["grants"],
        json!(["browse", "shell"])
    );
}

#[test]
fn add_standing_grants_writes_pretty_json_with_a_trailing_newline() {
    let (_dir, host, store) = fresh();
    assert!(store.add_standing_grants(&[Capability::Shell]));
    let text = fs::read_to_string(settings_path(&host)).unwrap();
    assert_eq!(
        text,
        "{\n  \"capabilities\": {\n    \"grants\": [\n      \"shell\"\n    ]\n  }\n}\n"
    );
}

#[test]
fn add_standing_grants_creates_the_settings_file_when_it_is_missing() {
    let (_dir, host, store) = fresh();
    assert!(!settings_path(&host).exists());
    assert!(store.add_standing_grants(&[Capability::Browse]));
    assert_eq!(stored_grants(&host), json!(["browse"]));
}

#[test]
fn add_standing_grants_keeps_each_cap_once() {
    let (_dir, host, store) = fresh();
    assert!(store.add_standing_grants(&[Capability::Shell, Capability::Shell]));
    assert!(store.add_standing_grants(&[Capability::Shell, Capability::Browse]));
    assert_eq!(stored_grants(&host), json!(["shell", "browse"]));
}

#[test]
fn add_standing_grants_refuses_an_always_ask_cap_and_writes_nothing() {
    let (_dir, host, store) = fresh();
    for cap in [Capability::Destructive, Capability::Credentials] {
        assert!(
            !store.add_standing_grants(&[Capability::Shell, cap]),
            "{cap:?}"
        );
    }
    assert!(!settings_path(&host).exists());
}

#[test]
fn add_standing_grants_reaches_identities_that_follow_settings() {
    let (_dir, _host, store) = fresh();
    store.init_caps(&id("follower"));
    store.set_caps(&id("pinned"), &[Capability::DriveSelf]);
    assert!(store.add_standing_grants(&[Capability::Shell]));
    assert!(store.has_cap(&id("follower"), Capability::Shell));
    assert!(!store.has_cap(&id("pinned"), Capability::Shell));
}

#[test]
fn add_standing_grants_replaces_a_capabilities_value_that_is_not_an_object() {
    let (_dir, host, store) = fresh();
    write_settings(&host, &json!({"capabilities": "oops"}));
    assert!(store.add_standing_grants(&[Capability::Shell]));
    assert_eq!(
        read_settings(&host)["capabilities"],
        json!({"grants": ["shell"]})
    );
}

#[test]
fn a_write_fails_and_leaves_the_file_alone_when_settings_is_not_an_object_or_not_json() {
    let (_dir, host, store) = fresh();
    for raw in ["[]", "\"text\"", "{ not json"] {
        fs::write(settings_path(&host), raw).unwrap();
        assert!(!store.add_standing_grants(&[Capability::Shell]), "{raw}");
        assert!(!store.remove_standing_grant(Capability::Shell), "{raw}");
        assert!(!store.set_reach_mode(&json!("group")), "{raw}");
        assert_eq!(fs::read_to_string(settings_path(&host)).unwrap(), raw);
    }
}

#[test]
fn a_write_fails_when_the_settings_folder_does_not_exist() {
    let (_dir, host) = temp_host().unwrap();
    let store = CapabilityStore::new(&host);
    assert!(!store.add_standing_grants(&[Capability::Shell]));
    assert!(!store.has_cap(&id("ext"), Capability::Shell));
}

#[test]
fn a_failed_write_does_not_change_the_grants_of_a_follower() {
    let (_dir, host, store) = fresh();
    fs::write(settings_path(&host), "[]").unwrap();
    store.init_caps(&id("follower"));
    assert!(!store.add_standing_grants(&[Capability::Shell]));
    assert!(!store.has_cap(&id("follower"), Capability::Shell));
}

#[test]
fn remove_standing_grant_drops_the_cap_from_the_file_and_from_followers() {
    let (_dir, host, store) = fresh();
    write_settings(
        &host,
        &json!({"capabilities": {"grants": ["shell", "browse"]}}),
    );
    store.refresh_capability_settings();
    store.init_caps(&id("follower"));
    assert!(store.remove_standing_grant(Capability::Shell));
    assert_eq!(stored_grants(&host), json!(["browse"]));
    assert!(!store.has_cap(&id("follower"), Capability::Shell));
    assert!(store.has_cap(&id("follower"), Capability::Browse));
}

#[test]
fn remove_standing_grant_keeps_a_default_cap_on_followers() {
    let (_dir, host, store) = fresh();
    write_settings(
        &host,
        &json!({"capabilities": {"grants": ["drive-self", "shell"]}}),
    );
    store.refresh_capability_settings();
    store.init_caps(&id("follower"));
    assert!(store.remove_standing_grant(Capability::DriveSelf));
    assert_eq!(stored_grants(&host), json!(["shell"]));
    assert!(store.has_cap(&id("follower"), Capability::DriveSelf));
}

#[test]
fn remove_standing_grant_succeeds_when_the_cap_was_never_granted() {
    let (_dir, host, store) = fresh();
    assert!(store.remove_standing_grant(Capability::Shell));
    assert_eq!(stored_grants(&host), json!([]));
}

#[test]
fn load_reach_mode_defaults_to_project() {
    let (_dir, _host, store) = fresh();
    assert_eq!(store.load_reach_mode(), ReachMode::Project);
}

#[test]
fn load_reach_mode_reads_the_settings_file() {
    let (_dir, host, store) = fresh();
    write_settings(&host, &json!({"capabilities": {"reach": "workspace"}}));
    assert_eq!(store.load_reach_mode(), ReachMode::Workspace);
}

#[test]
fn load_reach_mode_falls_back_to_project_for_an_unknown_value() {
    let (_dir, host, store) = fresh();
    for raw in [json!("everything"), json!(3), json!(null)] {
        write_settings(&host, &json!({"capabilities": {"reach": raw}}));
        store.refresh_capability_settings();
        assert_eq!(store.load_reach_mode(), ReachMode::Project, "{raw}");
    }
}

#[test]
fn load_reach_mode_is_read_once_until_refresh_capability_settings() {
    let (_dir, host, store) = fresh();
    assert_eq!(store.load_reach_mode(), ReachMode::Project);
    write_settings(&host, &json!({"capabilities": {"reach": "group"}}));
    assert_eq!(store.load_reach_mode(), ReachMode::Project);
    store.refresh_capability_settings();
    assert_eq!(store.load_reach_mode(), ReachMode::Group);
}

#[test]
fn set_reach_mode_writes_the_file_and_updates_the_cache() {
    let (_dir, host, store) = fresh();
    for (raw, mode) in [
        ("workspace", ReachMode::Workspace),
        ("project", ReachMode::Project),
        ("group", ReachMode::Group),
    ] {
        assert!(store.set_reach_mode(&json!(raw)), "{raw}");
        assert_eq!(store.load_reach_mode(), mode, "{raw}");
        assert_eq!(read_settings(&host)["capabilities"]["reach"], json!(raw));
    }
}

#[test]
fn set_reach_mode_refuses_a_value_that_is_not_a_reach_mode() {
    let (_dir, host, store) = fresh();
    for raw in [json!("everything"), json!(1), json!(null), json!(["group"])] {
        assert!(!store.set_reach_mode(&raw), "{raw}");
    }
    assert!(!settings_path(&host).exists());
    assert_eq!(store.load_reach_mode(), ReachMode::Project);
}

#[test]
fn set_reach_mode_keeps_the_grants_in_the_file() {
    let (_dir, host, store) = fresh();
    write_settings(&host, &json!({"capabilities": {"grants": ["shell"]}}));
    assert!(store.set_reach_mode(&json!("group")));
    assert_eq!(stored_grants(&host), json!(["shell"]));
}

#[test]
fn a_failed_reach_write_keeps_the_cached_mode() {
    let (_dir, host, store) = fresh();
    write_settings(&host, &json!({"capabilities": {"reach": "workspace"}}));
    assert_eq!(store.load_reach_mode(), ReachMode::Workspace);
    fs::write(settings_path(&host), "[]").unwrap();
    assert!(!store.set_reach_mode(&json!("group")));
    assert_eq!(store.load_reach_mode(), ReachMode::Workspace);
}
