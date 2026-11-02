#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::sandbox::{
    BrowserControl, DEFAULT_ALLOW_READ, DEFAULT_ALLOWED_DOMAINS, DEFAULT_CONTROLS,
    DEFAULT_SWITCHES, DomainCheck, PACKAGE_DEFAULTS, PORTS_POLICIES, PackageSettings, PortsPolicy,
    SANDBOX_LIST_MAX, SANDBOX_PATH_KINDS, SANDBOX_PATH_MAX, SANDBOX_SWITCHES, SandboxMergeRefusal,
    SandboxSwitches, WorkspaceSandbox, check_domain_pattern, check_expose_port, check_package_key,
    default_sandbox_globals, host_matches, resolve_packages, resolve_sandbox,
    same_workspace_sandbox, sandbox_merge_refusal,
};
use serde_json::{Map, Value, json};

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn map(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn with_packages(packages: Value) -> WorkspaceSandbox {
    WorkspaceSandbox {
        packages: Some(packages),
        ..WorkspaceSandbox::empty()
    }
}

fn globals_with_packages(packages: PackageSettings) -> ostia_contract::sandbox::SandboxGlobals {
    ostia_contract::sandbox::SandboxGlobals {
        packages,
        ..default_sandbox_globals()
    }
}

fn refusal(input: &str) -> Option<String> {
    match check_domain_pattern(input) {
        DomainCheck::Refused(reason) => Some(reason.to_owned()),
        DomainCheck::Valid(_) => None,
    }
}

#[test]
fn starts_a_workspace_off_with_empty_lists_and_no_overrides() {
    let empty = WorkspaceSandbox::empty();
    assert!(!empty.enabled);
    assert!(empty.allow_read.is_empty());
    assert!(empty.domains.is_empty());
    assert!(empty.controls.is_empty());
    assert_eq!(
        serde_json::to_value(&empty).unwrap(),
        json!({"enabled": false, "allowRead": [], "domains": [], "controls": {}})
    );
}

#[test]
fn keeps_the_constant_limits_names_and_defaults_of_the_ts_module() {
    assert_eq!(SANDBOX_LIST_MAX, 200);
    assert_eq!(SANDBOX_PATH_MAX, 1024);
    assert_eq!(
        SANDBOX_PATH_KINDS,
        [
            "allowRead",
            "allowWrite",
            "denyRead",
            "denyWrite",
            "allowSockets"
        ]
    );
    assert_eq!(
        SANDBOX_SWITCHES,
        ["unixSockets", "gitConfig", "strictDomains"]
    );
    assert_eq!(PORTS_POLICIES, ["ask", "allow", "deny"]);
    assert_eq!(
        DEFAULT_SWITCHES,
        SandboxSwitches {
            unix_sockets: true,
            git_config: false,
            strict_domains: false,
        }
    );
    assert!(!DEFAULT_CONTROLS.all_workspaces);
    assert_eq!(DEFAULT_CONTROLS.browser, BrowserControl::Allowlist);
    assert_eq!(
        PACKAGE_DEFAULTS,
        PackageSettings {
            malware: true,
            cooldown_days: 2,
            deny_list: Vec::new(),
            allow_only: None,
        }
    );
    assert_eq!(DEFAULT_ALLOW_READ.len(), 22);
    assert_eq!(DEFAULT_ALLOW_READ[0], "~/.zshrc");
    assert_eq!(DEFAULT_ALLOW_READ[21], "~/.config/starship.toml");
    assert_eq!(DEFAULT_ALLOWED_DOMAINS.len(), 13);
    assert_eq!(DEFAULT_ALLOWED_DOMAINS[0], "api.anthropic.com");
    assert_eq!(DEFAULT_ALLOWED_DOMAINS[12], "sum.golang.org");
}

#[test]
fn builds_the_default_globals_from_the_default_lists_and_asks_about_ports() {
    let globals = default_sandbox_globals();
    assert_eq!(globals.allow_read, DEFAULT_ALLOW_READ.to_vec());
    assert_eq!(globals.allowed_domains, DEFAULT_ALLOWED_DOMAINS.to_vec());
    assert_eq!(globals.controls, DEFAULT_CONTROLS);
    assert_eq!(globals.ports_policy, PortsPolicy::Ask);
    assert_eq!(globals.switches, DEFAULT_SWITCHES);
    assert_eq!(globals.packages, PACKAGE_DEFAULTS);
}

#[test]
fn counts_two_workspaces_as_the_same_when_their_lists_differ_only_in_order() {
    let a = WorkspaceSandbox {
        enabled: true,
        allow_read: strs(&["~/a", "~/b"]),
        domains: strs(&["x.com", "y.com"]),
        ..WorkspaceSandbox::empty()
    };
    let b = WorkspaceSandbox {
        enabled: true,
        allow_read: strs(&["~/b", "~/a"]),
        domains: strs(&["y.com", "x.com"]),
        ..WorkspaceSandbox::empty()
    };
    assert!(same_workspace_sandbox(&a, &b));
}

#[test]
fn counts_two_workspaces_as_different_when_a_list_or_a_switch_differs() {
    let base = WorkspaceSandbox {
        enabled: true,
        allow_read: strs(&["~/a"]),
        ..WorkspaceSandbox::empty()
    };
    let more = WorkspaceSandbox {
        allow_read: strs(&["~/a", "~/b"]),
        ..base.clone()
    };
    let switched = WorkspaceSandbox {
        switches: Some(map(json!({"gitConfig": true}))),
        ..base.clone()
    };
    let unset = WorkspaceSandbox {
        allow_write: Some(Vec::new()),
        ..base.clone()
    };
    assert!(!same_workspace_sandbox(&base, &more));
    assert!(!same_workspace_sandbox(&base, &switched));
    assert!(!same_workspace_sandbox(&base, &unset));
}

#[test]
fn refuses_to_merge_a_sandboxed_workspace_with_an_unsandboxed_one_and_two_that_differ() {
    let off = WorkspaceSandbox::empty();
    let on = WorkspaceSandbox {
        enabled: true,
        ..WorkspaceSandbox::empty()
    };
    let other = WorkspaceSandbox {
        enabled: true,
        domains: strs(&["example.com"]),
        ..WorkspaceSandbox::empty()
    };
    assert_eq!(
        sandbox_merge_refusal(&off, &on),
        Some(SandboxMergeRefusal::Mixed)
    );
    assert_eq!(
        sandbox_merge_refusal(&on, &off),
        Some(SandboxMergeRefusal::Mixed)
    );
    assert_eq!(
        sandbox_merge_refusal(&on, &other),
        Some(SandboxMergeRefusal::Differs)
    );
    assert_eq!(sandbox_merge_refusal(&on, &on.clone()), None);
}

#[test]
fn lets_two_unsandboxed_workspaces_merge_whatever_their_lists_hold() {
    let off = WorkspaceSandbox::empty();
    let listed = WorkspaceSandbox {
        allow_read: strs(&["~/a"]),
        domains: strs(&["example.com"]),
        ..WorkspaceSandbox::empty()
    };
    assert_eq!(sandbox_merge_refusal(&off, &listed), None);
}

#[test]
fn joins_global_workspace_and_session_domains_in_that_order_without_repeats() {
    let globals = ostia_contract::sandbox::SandboxGlobals {
        allowed_domains: strs(&["a.com", "b.com"]),
        allow_read: strs(&["~/one", "~/two"]),
        ..default_sandbox_globals()
    };
    let workspace = WorkspaceSandbox {
        allow_read: strs(&["~/two", "~/three"]),
        domains: strs(&["b.com", "c.com"]),
        ..WorkspaceSandbox::empty()
    };
    let resolved = resolve_sandbox(&globals, &workspace, &strs(&["c.com", "d.com"]));
    assert_eq!(
        resolved.domains,
        strs(&["a.com", "b.com", "c.com", "d.com"])
    );
    assert_eq!(resolved.allow_read, strs(&["~/one", "~/two", "~/three"]));
}

#[test]
fn takes_the_workspace_ports_policy_before_the_global_one() {
    let globals = ostia_contract::sandbox::SandboxGlobals {
        ports_policy: PortsPolicy::Deny,
        ..default_sandbox_globals()
    };
    let own = WorkspaceSandbox {
        ports: Some("allow".to_owned()),
        ..WorkspaceSandbox::empty()
    };
    assert_eq!(
        resolve_sandbox(&globals, &own, &[]).ports_policy,
        PortsPolicy::Allow
    );
    assert_eq!(
        resolve_sandbox(&globals, &WorkspaceSandbox::empty(), &[]).ports_policy,
        PortsPolicy::Deny
    );
}

#[test]
fn lets_a_workspace_control_override_the_global_one_and_keeps_the_other() {
    let globals = ostia_contract::sandbox::SandboxGlobals {
        controls: ostia_contract::sandbox::SandboxControls {
            all_workspaces: true,
            browser: BrowserControl::Allowlist,
        },
        ..default_sandbox_globals()
    };
    let own = WorkspaceSandbox {
        controls: map(json!({"browser": "unrestricted"})),
        ..WorkspaceSandbox::empty()
    };
    let resolved = resolve_sandbox(&globals, &own, &[]);
    assert!(resolved.controls.all_workspaces);
    assert_eq!(resolved.controls.browser, BrowserControl::Unrestricted);
}

#[test]
fn accepts_a_plain_domain_trims_and_lowercases_it() {
    for (input, domain) in [
        ("example.com", "example.com"),
        ("  Example.COM  ", "example.com"),
        ("\u{feff}example.com\u{feff}", "example.com"),
        ("*.example.com", "*.example.com"),
        ("a.b.example.com", "a.b.example.com"),
        ("example.com:8080", "example.com:8080"),
        ("example.com:00080", "example.com:00080"),
        ("example.com:65535", "example.com:65535"),
        ("api-1.example.com", "api-1.example.com"),
    ] {
        assert_eq!(
            check_domain_pattern(input),
            DomainCheck::Valid(domain.to_owned()),
            "{input}"
        );
    }
}

#[test]
fn refuses_a_domain_pattern_with_the_reason_for_each_kind() {
    for (input, reason) in [
        ("", "empty"),
        ("   ", "empty"),
        ("*", "wildcard-all"),
        ("*:443", "wildcard-all"),
        ("localhost", "localhost"),
        ("LOCALHOST", "localhost"),
        ("app.localhost", "localhost"),
        ("*.localhost", "localhost"),
        ("127.0.0.1", "ip-literal"),
        ("10.0.0.1:8080", "ip-literal"),
        ("123", "ip-literal"),
        ("1.2", "ip-literal"),
        ("[::1]", "ip-literal"),
        ("[::1]:80", "ip-literal"),
        ("a::b", "ip-literal"),
        ("localhost:80", "invalid"),
        ("example", "invalid"),
        ("*.com", "invalid"),
        ("a_b.com", "invalid"),
        ("-a.example.com", "invalid"),
        ("a-.example.com", "invalid"),
        ("a..example.com", "invalid"),
        ("example.com.", "invalid"),
        ("example.com:", "invalid"),
        ("example.com:123456", "invalid"),
        ("example.com/path", "invalid"),
        ("exa mple.com", "invalid"),
        ("\u{661}.\u{662}", "invalid"),
        ("\u{85}example.com", "invalid"),
        ("example.com:0", "invalid-port"),
        ("example.com:00000", "invalid-port"),
        ("example.com:65536", "invalid-port"),
        ("example.com:99999", "invalid-port"),
    ] {
        assert_eq!(refusal(input).as_deref(), Some(reason), "{input:?}");
    }
}

#[test]
fn accepts_a_label_of_63_characters_and_refuses_one_of_64() {
    let ok = "a".repeat(63);
    let long = "a".repeat(64);
    assert_eq!(
        check_domain_pattern(&format!("{ok}.com")),
        DomainCheck::Valid(format!("{ok}.com"))
    );
    assert_eq!(refusal(&format!("{long}.com")).as_deref(), Some("invalid"));
}

#[test]
fn accepts_an_exposed_port_from_1024_to_65535_and_nothing_else() {
    for (input, port) in [
        ("1024", Some(1024)),
        ("65535", Some(65535)),
        ("3000", Some(3000)),
        (" 8080 ", Some(8080)),
        ("01024", Some(1024)),
        ("1023", None),
        ("80", None),
        ("0", None),
        ("65536", None),
        ("123456", None),
        ("", None),
        ("abc", None),
        ("80a", None),
        ("+8080", None),
        ("-8080", None),
        ("8080.5", None),
        ("1e3", None),
        ("0x1F90", None),
        ("\u{668}\u{660}\u{668}\u{660}", None),
    ] {
        assert_eq!(check_expose_port(input), port, "{input:?}");
    }
    assert_eq!(check_expose_port(&3000.to_string()), Some(3000));
}

#[test]
fn matches_a_host_exactly_without_regard_to_case() {
    let patterns = strs(&["example.com", "Other.Org"]);
    assert!(host_matches("example.com", 443, &patterns));
    assert!(host_matches("EXAMPLE.com", 443, &patterns));
    assert!(host_matches("other.org", 80, &patterns));
    assert!(!host_matches("www.example.com", 443, &patterns));
    assert!(!host_matches("example.com.evil.org", 443, &patterns));
    assert!(!host_matches("example.com", 443, &[]));
}

#[test]
fn matches_a_wildcard_pattern_against_subdomains_but_not_the_bare_domain() {
    let patterns = strs(&["*.github.com"]);
    assert!(host_matches("api.github.com", 443, &patterns));
    assert!(host_matches("a.b.github.com", 443, &patterns));
    assert!(!host_matches("github.com", 443, &patterns));
    assert!(!host_matches("evilgithub.com", 443, &patterns));
    assert!(!host_matches("github.com.evil.org", 443, &patterns));
}

#[test]
fn matches_a_pattern_with_a_port_only_on_that_port() {
    let patterns = strs(&["example.com:8080", "*.dev.test:3000"]);
    assert!(host_matches("example.com", 8080, &patterns));
    assert!(!host_matches("example.com", 443, &patterns));
    assert!(host_matches("api.dev.test", 3000, &patterns));
    assert!(!host_matches("api.dev.test", 3001, &patterns));
    assert!(host_matches("example.com", 443, &strs(&["example.com"])));
}

#[test]
fn accepts_a_package_key_with_a_known_ecosystem_and_a_name() {
    for key in [
        "npm:left-pad",
        "npm:a@1.0.0",
        "PyPI:requests",
        "crates.io:serde",
        "Go:github.com/x/y",
        "npm:x",
    ] {
        assert!(check_package_key(key), "{key}");
    }
}

#[test]
fn refuses_a_package_key_with_an_unknown_ecosystem_an_empty_name_or_white_space() {
    for key in [
        "",
        "npm:",
        "npm",
        "pypi:requests",
        "cargo:serde",
        "crates:serde",
        "crates-io:serde",
        "go:x",
        "npm:@scope/pkg",
        "npm:@a",
        "npm: left-pad",
        "npm:a b",
        "npm:a\n",
        "npm:a\tb",
        "npm:a\u{feff}b",
        "npm:a\u{a0}b",
        "npm:a\u{2028}b",
        " npm:a",
        "npm:a ",
    ] {
        assert!(!check_package_key(key), "{key:?}");
    }
    assert!(check_package_key("npm:a\u{85}b"));
}

#[test]
fn uses_the_global_package_settings_when_the_workspace_sets_none() {
    let globals = globals_with_packages(PackageSettings {
        malware: false,
        cooldown_days: 7,
        deny_list: strs(&["npm:bad"]),
        allow_only: Some(strs(&["npm:good"])),
    });
    let resolved = resolve_packages(&globals, &WorkspaceSandbox::empty());
    assert!(!resolved.malware);
    assert_eq!(resolved.cooldown_days, 7);
    assert_eq!(resolved.deny_list, strs(&["npm:bad"]));
    assert_eq!(resolved.allow_only, Some(strs(&["npm:good"])));
    assert!(resolved.allowances.is_empty());
}

#[test]
fn uses_the_default_package_settings_when_the_globals_hold_none() {
    let resolved = resolve_packages(&default_sandbox_globals(), &WorkspaceSandbox::empty());
    assert!(resolved.malware);
    assert_eq!(resolved.cooldown_days, 2);
    assert!(resolved.deny_list.is_empty());
    assert_eq!(resolved.allow_only, None);
}

#[test]
fn lets_a_workspace_package_setting_win_also_when_it_is_false_or_zero() {
    let resolved = resolve_packages(
        &default_sandbox_globals(),
        &with_packages(json!({"malware": false, "cooldownDays": 0})),
    );
    assert!(!resolved.malware);
    assert_eq!(resolved.cooldown_days, 0);
}

#[test]
fn joins_the_global_and_workspace_deny_lists_without_repeats() {
    let globals = globals_with_packages(PackageSettings {
        deny_list: strs(&["npm:a", "npm:b"]),
        ..PACKAGE_DEFAULTS
    });
    let resolved = resolve_packages(
        &globals,
        &with_packages(json!({"denyList": ["npm:b", "npm:c"]})),
    );
    assert_eq!(resolved.deny_list, strs(&["npm:a", "npm:b", "npm:c"]));
}

#[test]
fn lets_a_workspace_allow_only_list_replace_the_global_one_and_null_clears_it() {
    let globals = globals_with_packages(PackageSettings {
        allow_only: Some(strs(&["npm:global"])),
        ..PACKAGE_DEFAULTS
    });
    let replaced = resolve_packages(&globals, &with_packages(json!({"allowOnly": ["npm:own"]})));
    let cleared = resolve_packages(&globals, &with_packages(json!({"allowOnly": null})));
    let kept = resolve_packages(&globals, &with_packages(json!({"malware": true})));
    assert_eq!(replaced.allow_only, Some(strs(&["npm:own"])));
    assert_eq!(cleared.allow_only, None);
    assert_eq!(kept.allow_only, Some(strs(&["npm:global"])));
}

#[test]
fn passes_the_workspace_allowances_through_and_defaults_them_to_none() {
    let resolved = resolve_packages(
        &default_sandbox_globals(),
        &with_packages(json!({"allowances": ["npm:left-pad", "PyPI:requests"]})),
    );
    assert_eq!(
        resolved.allowances,
        strs(&["npm:left-pad", "PyPI:requests"])
    );
    assert!(
        resolve_packages(&default_sandbox_globals(), &WorkspaceSandbox::empty())
            .allowances
            .is_empty()
    );
}
