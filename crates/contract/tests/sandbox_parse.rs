#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::sandbox::{
    DEFAULT_SWITCHES, SandboxSwitches, WorkspaceSandbox, default_sandbox_globals, resolve_sandbox,
    same_workspace_sandbox,
};
use ostia_contract::sandbox_parse::{
    parse_sandbox_globals, parse_switches, parse_workspace_sandbox,
};
use serde_json::{Map, Value, json};

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn map(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn keeps_the_filesystem_domain_and_socket_lists_and_the_switch_overrides_it_was_given() {
    let parsed = parse_workspace_sandbox(&json!({
        "enabled": true,
        "allowRead": ["~/notes"],
        "allowWrite": ["~/builds"],
        "denyRead": ["~/notes/private"],
        "denyWrite": ["~/builds/release"],
        "domains": ["example.com"],
        "deniedDomains": ["telemetry.example.com"],
        "allowSockets": ["/var/run/tool.sock"],
        "switches": {"unixSockets": false},
    }));
    assert_eq!(
        parsed,
        Some(WorkspaceSandbox {
            enabled: true,
            allow_read: strs(&["~/notes"]),
            allow_write: Some(strs(&["~/builds"])),
            deny_read: Some(strs(&["~/notes/private"])),
            deny_write: Some(strs(&["~/builds/release"])),
            domains: strs(&["example.com"]),
            denied_domains: Some(strs(&["telemetry.example.com"])),
            allow_sockets: Some(strs(&["/var/run/tool.sock"])),
            controls: Map::new(),
            switches: Some(map(json!({"unixSockets": false}))),
            ports: None,
            secrets: None,
            packages: None,
        })
    );
}

#[test]
fn leaves_out_empty_lists_and_switches_so_an_untouched_workspace_equals_an_empty_one() {
    let parsed = parse_workspace_sandbox(&json!({
        "enabled": false,
        "allowWrite": [],
        "denyRead": [],
        "switches": {},
    }))
    .unwrap();
    assert_eq!(parsed, WorkspaceSandbox::empty());
    assert!(same_workspace_sandbox(&parsed, &WorkspaceSandbox::empty()));
}

#[test]
fn refuses_a_list_that_is_not_strings_or_a_switch_that_is_not_a_boolean() {
    assert!(parse_workspace_sandbox(&json!({"enabled": true, "allowWrite": [1]})).is_none());
    assert!(parse_workspace_sandbox(&json!({"enabled": true, "denyRead": "x"})).is_none());
    assert!(
        parse_workspace_sandbox(&json!({"enabled": true, "switches": {"unixSockets": "no"}}))
            .is_none()
    );
}

#[test]
fn keeps_only_the_known_switches_and_drops_anything_else() {
    assert_eq!(
        parse_switches(Some(&json!({"gitConfig": true, "turnOffSandbox": true}))),
        Some(map(json!({"gitConfig": true})))
    );
    assert_eq!(parse_switches(None), Some(Map::new()));
    assert_eq!(parse_switches(Some(&json!([]))), None);
    assert_eq!(parse_switches(Some(&json!({"strictDomains": 1}))), None);
}

#[test]
fn starts_with_no_extra_limits_sockets_allowed_git_config_protected_unlisted_domains_asked() {
    let globals = parse_sandbox_globals(&json!({}));
    assert_eq!(globals.switches, DEFAULT_SWITCHES);
    assert!(globals.allow_write.is_empty());
    assert!(globals.deny_read.is_empty());
    assert!(globals.deny_write.is_empty());
    assert!(globals.denied_domains.is_empty());
    assert!(globals.allow_sockets.is_empty());
}

#[test]
fn falls_back_to_the_default_for_a_switch_of_the_wrong_type_instead_of_dropping_the_rest() {
    let globals = parse_sandbox_globals(&json!({
        "switches": {"unixSockets": "off"},
        "allowWrite": ["~/out"],
    }));
    assert_eq!(globals.switches, DEFAULT_SWITCHES);
    assert_eq!(globals.allow_write, strs(&["~/out"]));
}

#[test]
fn adds_the_workspace_lists_to_the_global_ones_and_lets_a_workspace_switch_override_the_global() {
    let globals = parse_sandbox_globals(&json!({
        "allowWrite": ["~/shared-out"],
        "denyRead": ["~/.cargo/credentials.toml"],
        "deniedDomains": ["telemetry.example.com"],
        "switches": {"unixSockets": false, "strictDomains": true},
    }));
    let resolved = resolve_sandbox(
        &globals,
        &WorkspaceSandbox {
            allow_write: Some(strs(&["~/builds"])),
            deny_read: Some(strs(&["~/notes/private"])),
            deny_write: Some(strs(&["~/builds/release"])),
            denied_domains: Some(strs(&["ads.example.com"])),
            switches: Some(map(json!({"unixSockets": true}))),
            ..WorkspaceSandbox::empty()
        },
        &[],
    );
    assert_eq!(resolved.allow_write, strs(&["~/shared-out", "~/builds"]));
    assert_eq!(
        resolved.deny_read,
        strs(&["~/.cargo/credentials.toml", "~/notes/private"])
    );
    assert_eq!(resolved.deny_write, strs(&["~/builds/release"]));
    assert_eq!(
        resolved.denied_domains,
        strs(&["telemetry.example.com", "ads.example.com"])
    );
    assert_eq!(
        resolved.switches,
        SandboxSwitches {
            unix_sockets: true,
            git_config: false,
            strict_domains: true,
        }
    );
}

#[test]
fn resolves_globals_written_before_these_settings_existed() {
    let resolved = resolve_sandbox(&default_sandbox_globals(), &WorkspaceSandbox::empty(), &[]);
    assert_eq!(resolved.switches, DEFAULT_SWITCHES);
    assert!(resolved.allow_write.is_empty());
    assert!(resolved.allow_sockets.is_empty());
}
