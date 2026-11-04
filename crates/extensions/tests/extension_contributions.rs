#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use ostia_contract::capabilities::Capability;
use ostia_contract::extensions::ExtensionSettingValues;
use ostia_extensions::extension_contributions::{
    Contributes, ContributionRuntime, ExtensionContributions, ExtensionContributionsHost,
};
use ostia_extensions::extension_store::{ExtensionRecord, ExtensionStore};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;

struct FakeHost {
    runtimes: Vec<ContributionRuntime>,
    inactive: Vec<String>,
    pending: Vec<String>,
    eager: Vec<String>,
    records: HashMap<String, ExtensionRecord>,
    grants: HashMap<String, Vec<Capability>>,
    settings: HashMap<String, ExtensionSettingValues>,
    store: ExtensionStore,
    log: Arc<Mutex<Vec<String>>>,
}

impl ExtensionContributionsHost for FakeHost {
    fn runtimes(&self) -> Vec<ContributionRuntime> {
        self.runtimes.clone()
    }

    fn active(&self, ext_id: &str) -> bool {
        !self.inactive.iter().any(|id| id == ext_id)
    }

    fn pending(&self, ext_id: &str) -> bool {
        self.pending.iter().any(|id| id == ext_id)
    }

    fn record(&self, ext_id: &str) -> ExtensionRecord {
        self.records
            .get(ext_id)
            .cloned()
            .unwrap_or_else(|| record(true, Some(&[]), &[], &[]))
    }

    fn granted(&self, ext_id: &str) -> Vec<Capability> {
        self.grants.get(ext_id).cloned().unwrap_or_default()
    }

    fn setting_values(&self, ext_id: &str) -> ExtensionSettingValues {
        self.settings.get(ext_id).cloned().unwrap_or_default()
    }

    fn eager(&self, ext_id: &str) -> bool {
        self.eager.iter().any(|id| id == ext_id)
    }

    fn start(&self, ext_id: &str) {
        self.log.lock().push(format!("start:{ext_id}"));
    }

    fn changed(&self, ext_id: Option<&str>) {
        self.log
            .lock()
            .push(format!("changed:{}", ext_id.unwrap_or("-")));
    }

    fn store(&self) -> &ExtensionStore {
        &self.store
    }
}

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    log: Arc<Mutex<Vec<String>>>,
}

fn record(
    enabled: bool,
    approved: Option<&[Capability]>,
    approved_kinds: &[&str],
    servers_off: &[&str],
) -> ExtensionRecord {
    ExtensionRecord {
        enabled,
        approved: approved.map(<[Capability]>::to_vec),
        approved_kinds: approved_kinds
            .iter()
            .map(|kind| (*kind).to_owned())
            .collect(),
        servers_off: servers_off.iter().map(|id| (*id).to_owned()).collect(),
    }
}

fn runtime(id: &str, contributes: Contributes) -> ContributionRuntime {
    ContributionRuntime {
        ext_id: id.to_owned(),
        ext_name: format!("Ext {id}"),
        dir: PathBuf::from(format!("/ext/{id}")),
        builtin: false,
        contributes,
    }
}

fn host_of(runtimes: Vec<ContributionRuntime>) -> (FakeHost, Fixture) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extensions.json");
    let log = Arc::new(Mutex::new(Vec::new()));
    let host = FakeHost {
        runtimes,
        inactive: Vec::new(),
        pending: Vec::new(),
        eager: Vec::new(),
        records: HashMap::new(),
        grants: HashMap::new(),
        settings: HashMap::new(),
        store: ExtensionStore::new(path.clone()),
        log: Arc::clone(&log),
    };
    (
        host,
        Fixture {
            _dir: dir,
            path,
            log,
        },
    )
}

fn server_contributes(ids: &[&str]) -> Contributes {
    Contributes {
        language_servers: ids.iter().map(|id| json!({"id": id, "name": id})).collect(),
        ..Contributes::default()
    }
}

fn as_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn lists_the_snippets_of_the_active_extensions_that_contribute_any_and_keeps_an_empty_list() {
    let snippet = json!({"name": "greet", "command": "echo hi"});
    let (mut host, _fixture) = host_of(vec![
        runtime(
            "a",
            Contributes {
                snippets: Some(vec![snippet.clone()]),
                ..Contributes::default()
            },
        ),
        runtime("none", Contributes::default()),
        runtime(
            "empty",
            Contributes {
                snippets: Some(Vec::new()),
                ..Contributes::default()
            },
        ),
        runtime(
            "off",
            Contributes {
                snippets: Some(vec![snippet.clone()]),
                ..Contributes::default()
            },
        ),
    ]);
    host.inactive.push("off".to_owned());
    assert_eq!(
        as_json(&ExtensionContributions::new(host).snippets()),
        json!([
            {"extId": "a", "snippets": [snippet]},
            {"extId": "empty", "snippets": []},
        ])
    );
}

#[test]
fn lists_the_completion_folders_joined_to_the_extension_folder_and_skips_the_rest() {
    let completions = |relative: &str| Contributes {
        completions: Some(relative.to_owned()),
        ..Contributes::default()
    };
    let (mut host, _fixture) = host_of(vec![
        runtime("a", completions("completions")),
        runtime("b", completions("specs/fig")),
        runtime("empty", completions("")),
        runtime("none", Contributes::default()),
        runtime("off", completions("completions")),
    ]);
    host.inactive.push("off".to_owned());
    assert_eq!(
        ExtensionContributions::new(host).completion_dirs(),
        ["/ext/a/completions", "/ext/b/specs/fig"]
    );
}

#[test]
fn joins_a_completion_folder_the_way_node_does() {
    let completions = |relative: &str| Contributes {
        completions: Some(relative.to_owned()),
        ..Contributes::default()
    };
    let (host, _fixture) = host_of(vec![
        runtime("a", completions("./x/../completions/")),
        runtime("b", completions("/absolute")),
        runtime("c", completions("../up")),
    ]);
    assert_eq!(
        ExtensionContributions::new(host).completion_dirs(),
        ["/ext/a/completions/", "/ext/b/absolute", "/ext/up"]
    );
}

#[test]
fn lists_one_source_for_each_language_of_each_active_extension() {
    let (mut host, _fixture) = host_of(vec![
        runtime(
            "a",
            Contributes {
                languages: vec![json!({"id": "x"}), json!({"id": "y"})],
                ..Contributes::default()
            },
        ),
        runtime("none", Contributes::default()),
        runtime(
            "off",
            Contributes {
                languages: vec![json!({"id": "z"})],
                ..Contributes::default()
            },
        ),
        runtime(
            "b",
            Contributes {
                languages: vec![json!({"id": "w"})],
                ..Contributes::default()
            },
        ),
    ]);
    host.inactive.push("off".to_owned());
    assert_eq!(
        as_json(&ExtensionContributions::new(host).languages()),
        json!([
            {"extId": "a", "dir": "/ext/a", "language": {"id": "x"}},
            {"extId": "a", "dir": "/ext/a", "language": {"id": "y"}},
            {"extId": "b", "dir": "/ext/b", "language": {"id": "w"}},
        ])
    );
}

#[test]
fn lists_one_source_for_each_keymap_of_each_active_extension() {
    let (mut host, _fixture) = host_of(vec![
        runtime(
            "a",
            Contributes {
                keymaps: vec![json!({"id": "vim"}), json!({"id": "emacs"})],
                ..Contributes::default()
            },
        ),
        runtime(
            "off",
            Contributes {
                keymaps: vec![json!({"id": "gone"})],
                ..Contributes::default()
            },
        ),
    ]);
    host.inactive.push("off".to_owned());
    assert_eq!(
        as_json(&ExtensionContributions::new(host).keymaps()),
        json!([
            {"extId": "a", "dir": "/ext/a", "keymap": {"id": "vim"}},
            {"extId": "a", "dir": "/ext/a", "keymap": {"id": "emacs"}},
        ])
    );
}

#[test]
fn lists_one_source_for_each_editor_language_of_each_active_extension() {
    let (mut host, _fixture) = host_of(vec![
        runtime(
            "a",
            Contributes {
                editor_languages: vec![json!({"id": "toml"})],
                ..Contributes::default()
            },
        ),
        runtime(
            "off",
            Contributes {
                editor_languages: vec![json!({"id": "gone"})],
                ..Contributes::default()
            },
        ),
        runtime(
            "b",
            Contributes {
                editor_languages: vec![json!({"id": "kdl"}), json!({"id": "nix"})],
                ..Contributes::default()
            },
        ),
    ]);
    host.inactive.push("off".to_owned());
    assert_eq!(
        as_json(&ExtensionContributions::new(host).editor_languages()),
        json!([
            {"extId": "a", "dir": "/ext/a", "language": {"id": "toml"}},
            {"extId": "b", "dir": "/ext/b", "language": {"id": "kdl"}},
            {"extId": "b", "dir": "/ext/b", "language": {"id": "nix"}},
        ])
    );
}

#[test]
fn lists_the_icon_themes_of_the_active_extensions_with_their_folder() {
    let (mut host, _fixture) = host_of(vec![
        runtime(
            "a",
            Contributes {
                icon_themes: vec![json!({"id": "t1"}), json!({"id": "t2"})],
                ..Contributes::default()
            },
        ),
        runtime(
            "off",
            Contributes {
                icon_themes: vec![json!({"id": "t3"})],
                ..Contributes::default()
            },
        ),
    ]);
    host.inactive.push("off".to_owned());
    assert_eq!(
        as_json(&ExtensionContributions::new(host).icon_themes()),
        json!([
            {"dir": "/ext/a", "theme": {"id": "t1"}},
            {"dir": "/ext/a", "theme": {"id": "t2"}},
        ])
    );
}

#[test]
fn lists_the_language_servers_of_every_extension_also_one_that_is_not_active() {
    let (mut host, _fixture) = host_of(vec![
        runtime("a", server_contributes(&["pyright", "ruff"])),
        runtime("off", server_contributes(&["gone"])),
        runtime("none", Contributes::default()),
    ]);
    host.inactive.push("off".to_owned());
    host.grants
        .insert("a".to_owned(), vec![Capability::LanguageServer]);
    host.grants
        .insert("off".to_owned(), vec![Capability::LanguageServer]);
    host.settings.insert(
        "a".to_owned(),
        serde_json::from_value(json!({"python.path": "/usr/bin/python"})).unwrap(),
    );
    let listed = as_json(&ExtensionContributions::new(host).language_servers());
    assert_eq!(
        listed,
        json!([
            {
                "extId": "a",
                "extName": "Ext a",
                "dir": "/ext/a",
                "builtin": false,
                "state": "on",
                "server": {"id": "pyright", "name": "pyright"},
                "settingValues": {"python.path": "/usr/bin/python"},
            },
            {
                "extId": "a",
                "extName": "Ext a",
                "dir": "/ext/a",
                "builtin": false,
                "state": "on",
                "server": {"id": "ruff", "name": "ruff"},
                "settingValues": {"python.path": "/usr/bin/python"},
            },
            {
                "extId": "off",
                "extName": "Ext off",
                "dir": "/ext/off",
                "builtin": false,
                "state": "on",
                "server": {"id": "gone", "name": "gone"},
                "settingValues": {},
            },
        ])
    );
}

#[test]
fn reports_a_builtin_extension_as_builtin() {
    let mut builtin = runtime("a", server_contributes(&["pyright"]));
    builtin.builtin = true;
    let (host, _fixture) = host_of(vec![builtin]);
    let listed = as_json(&ExtensionContributions::new(host).language_servers());
    assert_eq!(listed[0]["builtin"], json!(true));
}

#[test]
fn a_language_server_is_pending_while_the_extension_awaits_approval() {
    let (mut host, _fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.pending.push("a".to_owned());
    host.records
        .insert("a".to_owned(), record(false, None, &[], &["pyright"]));
    let listed = as_json(&ExtensionContributions::new(host).language_servers());
    assert_eq!(listed[0]["state"], json!("pending"));
}

#[test]
fn a_language_server_is_off_when_the_extension_is_disabled_before_the_grant_is_checked() {
    let (mut host, _fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.records
        .insert("a".to_owned(), record(false, Some(&[]), &[], &[]));
    let listed = as_json(&ExtensionContributions::new(host).language_servers());
    assert_eq!(listed[0]["state"], json!("off"));
}

#[test]
fn a_language_server_is_pending_until_the_language_server_capability_is_granted() {
    let (mut host, _fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.grants
        .insert("a".to_owned(), vec![Capability::Notify, Capability::Shell]);
    host.records
        .insert("a".to_owned(), record(true, Some(&[]), &[], &["pyright"]));
    let listed = as_json(&ExtensionContributions::new(host).language_servers());
    assert_eq!(listed[0]["state"], json!("pending"));
}

#[test]
fn a_language_server_is_off_when_the_record_turned_it_off_and_on_when_it_did_not() {
    let (mut host, _fixture) =
        host_of(vec![runtime("a", server_contributes(&["pyright", "ruff"]))]);
    host.grants
        .insert("a".to_owned(), vec![Capability::LanguageServer]);
    host.records.insert(
        "a".to_owned(),
        record(true, Some(&[]), &[], &["ruff", "other"]),
    );
    let listed = as_json(&ExtensionContributions::new(host).language_servers());
    assert_eq!(listed[0]["state"], json!("on"));
    assert_eq!(listed[1]["state"], json!("off"));
}

#[test]
fn does_nothing_for_an_unknown_extension_a_pending_one_or_a_server_it_does_not_declare() {
    let (mut host, fixture) = host_of(vec![
        runtime("a", server_contributes(&["pyright"])),
        runtime("waiting", server_contributes(&["pyright"])),
    ]);
    host.pending.push("waiting".to_owned());
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("nobody", "pyright", false)
        .unwrap();
    contributions
        .set_language_server_enabled("waiting", "pyright", false)
        .unwrap();
    contributions
        .set_language_server_enabled("a", "ruff", false)
        .unwrap();
    assert!(fixture.log.lock().is_empty());
    assert!(!fixture.path.exists());
}

#[test]
fn turning_a_server_off_records_it_and_keeps_the_rest_of_the_record() {
    let (mut host, fixture) = host_of(vec![runtime("a", server_contributes(&["pyright", "ruff"]))]);
    host.records.insert(
        "a".to_owned(),
        record(
            true,
            Some(&[Capability::LanguageServer]),
            &["kind:one"],
            &["ruff"],
        ),
    );
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "pyright", false)
        .unwrap();
    let after = store.get("a").unwrap();
    assert_eq!(
        after,
        record(
            true,
            Some(&[Capability::LanguageServer]),
            &["kind:one"],
            &["ruff", "pyright"],
        )
    );
    assert_eq!(*fixture.log.lock(), ["changed:a"]);
}

#[test]
fn turning_a_server_off_does_not_switch_the_extension_off_or_on() {
    let (mut host, fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.records
        .insert("a".to_owned(), record(false, Some(&[]), &[], &[]));
    host.eager.push("a".to_owned());
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "pyright", false)
        .unwrap();
    let after = store.get("a").unwrap();
    assert!(!after.enabled);
    assert_eq!(after.servers_off, ["pyright"]);
    assert_eq!(*fixture.log.lock(), ["changed:a"]);
}

#[test]
fn turning_a_server_on_removes_it_from_the_list_and_drops_an_empty_list_from_the_file() {
    let (mut host, fixture) = host_of(vec![runtime("a", server_contributes(&["pyright", "ruff"]))]);
    host.records
        .insert("a".to_owned(), record(true, Some(&[]), &[], &["pyright"]));
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "pyright", true)
        .unwrap();
    let after = store.get("a").unwrap();
    assert!(after.servers_off.is_empty());
    let file: Value = serde_json::from_str(&fs::read_to_string(&fixture.path).unwrap()).unwrap();
    assert!(file["a"].get("serversOff").is_none(), "{file}");
    assert_eq!(*fixture.log.lock(), ["changed:a"]);
}

#[test]
fn turning_a_server_on_keeps_the_other_servers_that_are_off() {
    let (mut host, _fixture) = host_of(vec![runtime(
        "a",
        server_contributes(&["pyright", "ruff", "taplo"]),
    )]);
    host.records.insert(
        "a".to_owned(),
        record(true, Some(&[]), &[], &["pyright", "ruff", "taplo"]),
    );
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "ruff", true)
        .unwrap();
    let after = store.get("a").unwrap();
    assert_eq!(after.servers_off, ["pyright", "taplo"]);
}

#[test]
fn turning_a_server_off_twice_lists_it_once() {
    let (mut host, _fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.records
        .insert("a".to_owned(), record(true, Some(&[]), &[], &["pyright"]));
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "pyright", false)
        .unwrap();
    let after = store.get("a").unwrap();
    assert_eq!(after.servers_off, ["pyright"]);
}

#[test]
fn a_stored_duplicate_in_the_off_list_is_written_once() {
    let (mut host, _fixture) =
        host_of(vec![runtime("a", server_contributes(&["pyright", "ruff"]))]);
    host.records.insert(
        "a".to_owned(),
        record(true, Some(&[]), &[], &["pyright", "pyright"]),
    );
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "ruff", false)
        .unwrap();
    let after = store.get("a").unwrap();
    assert_eq!(after.servers_off, ["pyright", "ruff"]);
}

#[test]
fn an_extension_that_was_never_approved_gets_an_empty_approval_list() {
    let (mut host, _fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.records
        .insert("a".to_owned(), record(true, None, &[], &[]));
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "pyright", false)
        .unwrap();
    let after = store.get("a").unwrap();
    assert_eq!(after.approved, Some(Vec::new()));
}

#[test]
fn turning_a_server_on_enables_a_disabled_extension_and_starts_it_when_it_starts_eagerly() {
    let (mut host, fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    host.records
        .insert("a".to_owned(), record(false, Some(&[]), &[], &["pyright"]));
    host.eager.push("a".to_owned());
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("a", "pyright", true)
        .unwrap();
    assert!(store.get("a").unwrap().enabled);
    assert_eq!(*fixture.log.lock(), ["start:a", "changed:a"]);
}

#[test]
fn turning_a_server_on_does_not_start_an_extension_that_is_not_eager_or_was_already_enabled() {
    let (mut host, fixture) = host_of(vec![
        runtime("lazy", server_contributes(&["pyright"])),
        runtime("running", server_contributes(&["pyright"])),
    ]);
    host.records.insert(
        "lazy".to_owned(),
        record(false, Some(&[]), &[], &["pyright"]),
    );
    host.records.insert(
        "running".to_owned(),
        record(true, Some(&[]), &[], &["pyright"]),
    );
    host.eager.push("running".to_owned());
    let store = host.store.clone();
    let contributions = ExtensionContributions::new(host);
    contributions
        .set_language_server_enabled("lazy", "pyright", true)
        .unwrap();
    contributions
        .set_language_server_enabled("running", "pyright", true)
        .unwrap();
    assert!(store.get("lazy").unwrap().enabled);
    assert_eq!(*fixture.log.lock(), ["changed:lazy", "changed:running"]);
}

#[test]
fn reports_a_store_failure_and_neither_starts_the_extension_nor_announces_the_change() {
    let (mut host, fixture) = host_of(vec![runtime("a", server_contributes(&["pyright"]))]);
    let blocked = TempDir::new().unwrap();
    host.store = ExtensionStore::new(blocked.path().to_path_buf());
    host.records
        .insert("a".to_owned(), record(false, Some(&[]), &[], &["pyright"]));
    host.eager.push("a".to_owned());
    let contributions = ExtensionContributions::new(host);
    assert!(
        contributions
            .set_language_server_enabled("a", "pyright", true)
            .is_err()
    );
    assert!(fixture.log.lock().is_empty());
}

#[test]
fn lists_the_agent_plugins_of_active_extensions_that_hold_the_agent_plugin_capability() {
    let plugin = |skills: Vec<Value>, hooks: Vec<Value>| Contributes {
        agent_skills: skills,
        agent_hooks: hooks,
        ..Contributes::default()
    };
    let (mut host, _fixture) = host_of(vec![
        runtime(
            "both",
            plugin(vec![json!({"name": "s"})], vec![json!({"event": "stop"})]),
        ),
        runtime("skills", plugin(vec![json!({"name": "s2"})], Vec::new())),
        runtime("hooks", plugin(Vec::new(), vec![json!({"event": "start"})])),
        runtime("empty", plugin(Vec::new(), Vec::new())),
        runtime("denied", plugin(vec![json!({"name": "s3"})], Vec::new())),
        runtime("off", plugin(vec![json!({"name": "s4"})], Vec::new())),
    ]);
    host.inactive.push("off".to_owned());
    for id in ["both", "skills", "hooks", "empty", "off"] {
        host.grants
            .insert(id.to_owned(), vec![Capability::AgentPlugin]);
    }
    host.grants
        .insert("denied".to_owned(), vec![Capability::Notify]);
    assert_eq!(
        as_json(&ExtensionContributions::new(host).agent_plugins()),
        json!([
            {
                "extId": "both",
                "builtin": false,
                "dir": "/ext/both",
                "skills": [{"name": "s"}],
                "hooks": [{"event": "stop"}],
            },
            {
                "extId": "skills",
                "builtin": false,
                "dir": "/ext/skills",
                "skills": [{"name": "s2"}],
                "hooks": [],
            },
            {
                "extId": "hooks",
                "builtin": false,
                "dir": "/ext/hooks",
                "skills": [],
                "hooks": [{"event": "start"}],
            },
        ])
    );
}
