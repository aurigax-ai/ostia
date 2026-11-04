#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use ostia_contract::language_servers::{
    LanguageServerInfo, LanguageServerKind, LanguageServerOverride, LanguageServerOverrideProblem,
    LanguageServerOverrideResult, LanguageServerStatus,
};
use ostia_lsp::language_servers_ipc::{ServerCatalog, choose_server_program};
use ostia_lsp::server_overrides::{ServerOverrides, override_file_problem};
use serde_json::{Value, json};
use tempfile::TempDir;

use LanguageServerOverrideProblem::{
    BadArguments, Missing, NotAbsolute, NotExecutable, NotFile, UnknownServer,
};

struct Setup {
    _dir: TempDir,
    tmp: PathBuf,
    file: PathBuf,
    program: PathBuf,
}

fn setup() -> Setup {
    let dir = TempDir::new().unwrap();
    let tmp = dir.path().canonicalize().unwrap();
    let program = tmp.join("my-ls");
    fs::write(&program, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    Setup {
        file: tmp.join("language-server-programs.json"),
        tmp,
        program,
        _dir: dir,
    }
}

fn path_of(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn chosen(path: &Path, args: &[&str]) -> LanguageServerOverride {
    LanguageServerOverride {
        path: path_of(path),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn choose(
    overrides: &ServerOverrides,
    key: &str,
    raw: Value,
) -> Option<LanguageServerOverrideProblem> {
    overrides.choose(key, &raw).unwrap()
}

fn saved_keys(file: &Path) -> Vec<String> {
    let saved: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
    saved.as_object().unwrap().keys().cloned().collect()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[test]
fn keeps_an_executable_file_with_its_arguments_across_a_restart() {
    let s = setup();
    let overrides = ServerOverrides::new(s.file.clone());
    assert_eq!(
        choose(
            &overrides,
            "ext/ls",
            json!({"path": path_of(&s.program), "args": ["--stdio", "--log=1"]})
        ),
        None
    );
    let expected = chosen(&s.program, &["--stdio", "--log=1"]);
    assert_eq!(overrides.get("ext/ls"), Some(expected.clone()));
    assert_eq!(
        ServerOverrides::new(s.file.clone()).get("ext/ls"),
        Some(expected)
    );
    assert_eq!(choose(&overrides, "ext/ls", Value::Null), None);
    assert_eq!(ServerOverrides::new(s.file.clone()).get("ext/ls"), None);
}

#[test]
fn accepts_a_link_to_an_executable_file() {
    let s = setup();
    let link = s.tmp.join("linked-ls");
    symlink(&s.program, &link).unwrap();
    let overrides = ServerOverrides::new(s.file.clone());
    assert_eq!(
        choose(&overrides, "ext/ls", json!({"path": path_of(&link)})),
        None
    );
    assert_eq!(overrides.get("ext/ls"), Some(chosen(&link, &[])));
}

#[test]
fn refuses_a_relative_path_a_missing_file_a_folder_a_file_that_cannot_run_and_a_shell_string() {
    let s = setup();
    let overrides = ServerOverrides::new(s.file.clone());
    let plain = s.tmp.join("notes.txt");
    fs::write(&plain, "x").unwrap();
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).unwrap();
    fs::create_dir(s.tmp.join("dir")).unwrap();
    let program = path_of(&s.program);
    let rows: Vec<(&str, Value, LanguageServerOverrideProblem)> = vec![
        ("ext/ls", json!({"path": "bin/my-ls"}), NotAbsolute),
        (
            "ext/ls",
            json!({"path": format!("{program}\nrm")}),
            NotAbsolute,
        ),
        ("ext/ls", json!(format!("{program} --stdio")), NotAbsolute),
        (
            "ext/ls",
            json!({"path": path_of(&s.tmp.join("absent"))}),
            Missing,
        ),
        (
            "ext/ls",
            json!({"path": path_of(&s.tmp.join("dir"))}),
            NotFile,
        ),
        ("ext/ls", json!({"path": path_of(&plain)}), NotExecutable),
        (
            "ext/ls",
            json!({"path": program, "args": "--stdio --x"}),
            BadArguments,
        ),
        (
            "ext/ls",
            json!({"path": program, "args": ["ok", 7]}),
            BadArguments,
        ),
        (
            "ext/ls",
            json!({"path": program, "args": ["a\u{0}b"]}),
            BadArguments,
        ),
        ("not-a-key", json!({"path": program}), UnknownServer),
    ];
    for (key, raw, problem) in rows {
        assert_eq!(
            choose(&overrides, key, raw.clone()),
            Some(problem),
            "{key} {raw}"
        );
    }
    assert_eq!(overrides.get("ext/ls"), None);
    assert!(!s.file.exists());
}

#[test]
fn drops_entries_a_hand_edited_file_has_no_right_to_hold() {
    let s = setup();
    let program = path_of(&s.program);
    fs::write(
        &s.file,
        format!(
            r#"{{
  "ext/ls": {{"path": "{program}", "args": ["--stdio"]}},
  "ext/shell": {{"path": "sh -c evil", "args": []}},
  "ext/args": {{"path": "{program}", "args": "--one --two"}},
  "nokey": {{"path": "{program}"}},
  "__proto__": {{"path": "{program}"}}
}}"#
        ),
    )
    .unwrap();
    let overrides = ServerOverrides::new(s.file.clone());
    assert_eq!(
        overrides.get("ext/ls"),
        Some(chosen(&s.program, &["--stdio"]))
    );
    for key in ["ext/shell", "ext/args", "nokey", "__proto__"] {
        assert_eq!(overrides.get(key), None, "{key}");
    }
}

#[test]
fn forgets_every_program_chosen_for_an_extension_that_was_removed() {
    let s = setup();
    let overrides = ServerOverrides::new(s.file.clone());
    for key in ["ext/one", "ext/two", "other/one"] {
        choose(&overrides, key, json!({"path": path_of(&s.program)}));
    }
    overrides.forget_extension("ext").unwrap();
    assert_eq!(saved_keys(&s.file), ["other/one"]);
}

#[test]
fn starts_empty_when_the_file_is_missing_broken_or_not_an_object() {
    let s = setup();
    assert_eq!(ServerOverrides::new(s.file.clone()).get("ext/ls"), None);
    for text in ["{", "[]", "null", "7", "\"ext/ls\""] {
        fs::write(&s.file, text).unwrap();
        assert_eq!(
            ServerOverrides::new(s.file.clone()).get("ext/ls"),
            None,
            "{text}"
        );
    }
}

#[test]
fn keeps_at_most_256_entries_from_a_hand_edited_file_in_file_order() {
    let s = setup();
    let program = path_of(&s.program);
    let mut entries = serde_json::Map::new();
    for index in 0..300 {
        entries.insert(format!("ext/s{index}"), json!({"path": program}));
    }
    fs::write(&s.file, Value::Object(entries).to_string()).unwrap();
    let overrides = ServerOverrides::new(s.file.clone());
    assert!(overrides.get("ext/s255").is_some());
    assert!(overrides.get("ext/s256").is_none());
    assert!(overrides.get("ext/s299").is_none());
}

#[test]
fn writes_nothing_when_a_removal_or_a_forget_changes_nothing() {
    let s = setup();
    let overrides = ServerOverrides::new(s.file.clone());
    assert_eq!(choose(&overrides, "ext/ls", Value::Null), None);
    overrides.forget_extension("ext").unwrap();
    assert!(!s.file.exists());
    choose(&overrides, "ext/ls", json!({"path": path_of(&s.program)}));
    let before = fs::read(&s.file).unwrap();
    overrides.forget_extension("other").unwrap();
    assert_eq!(choose(&overrides, "other/ls", Value::Null), None);
    assert_eq!(fs::read(&s.file).unwrap(), before);
}

#[test]
fn reports_why_a_program_file_is_unusable() {
    let s = setup();
    let plain = s.tmp.join("notes.txt");
    fs::write(&plain, "x").unwrap();
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(override_file_problem(&s.program), None);
    assert_eq!(override_file_problem(&s.tmp.join("absent")), Some(Missing));
    assert_eq!(override_file_problem(&s.tmp), Some(NotFile));
    assert_eq!(override_file_problem(&plain), Some(NotExecutable));
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let s = setup();
    fs::copy(fixture("language-server-programs-before.json"), &s.file).unwrap();
    let overrides = ServerOverrides::new(s.file.clone());
    assert_eq!(
        overrides.get("ext/ls"),
        Some(LanguageServerOverride {
            path: "/bin/sh".to_owned(),
            args: vec!["--stdio".to_owned(), "--log=é".to_owned()],
        })
    );
    overrides.forget_extension("ext").unwrap();
    assert_eq!(
        fs::read(&s.file).unwrap(),
        fs::read(fixture("language-server-programs-after.json")).unwrap()
    );
}

struct Catalog {
    listed: Vec<LanguageServerInfo>,
    refreshed: Cell<u32>,
}

impl ServerCatalog for Catalog {
    fn servers(&self) -> Vec<LanguageServerInfo> {
        self.listed.clone()
    }

    fn refresh(&self) {
        self.refreshed.set(self.refreshed.get() + 1);
    }
}

fn listed(key: &str) -> LanguageServerInfo {
    LanguageServerInfo {
        key: key.to_owned(),
        ext_id: "ext".to_owned(),
        ext_name: "Ext".to_owned(),
        server_id: "ls".to_owned(),
        name: "LS".to_owned(),
        languages: Vec::new(),
        kind: LanguageServerKind::Program,
        command: "ls".to_owned(),
        enabled: true,
        status: LanguageServerStatus::Idle,
        folders: 0,
        program: None,
        requirement: None,
        sandbox_problem: None,
        sandbox_detail: None,
        version: None,
        binary: None,
        managed_copy: None,
        fetchable: None,
        fetch_held: None,
        progress: None,
        failure: None,
        failure_detail: None,
        fetch_command: None,
        override_info: None,
    }
}

fn catalog() -> Catalog {
    Catalog {
        listed: vec![listed("ext/ls")],
        refreshed: Cell::new(0),
    }
}

#[test]
fn refuses_a_server_that_is_not_listed_and_never_stores_it() {
    let s = setup();
    let servers = catalog();
    let stored = Cell::new(0);
    let set_override = |_: &str, _: &Value| {
        stored.set(stored.get() + 1);
        None
    };
    assert_eq!(
        choose_server_program(
            &servers,
            &set_override,
            &json!("ext/other"),
            &json!({"path": path_of(&s.program)})
        ),
        LanguageServerOverrideResult {
            servers: servers.listed.clone(),
            problem: Some(UnknownServer),
        }
    );
    assert_eq!(
        choose_server_program(&servers, &set_override, &json!(7), &Value::Null).problem,
        Some(UnknownServer)
    );
    assert_eq!(stored.get(), 0);
    assert_eq!(servers.refreshed.get(), 0);
}

#[test]
fn stores_a_valid_choice_restarts_what_changed_and_reports_a_refusal_without_refreshing() {
    let s = setup();
    let overrides = ServerOverrides::new(s.file.clone());
    let servers = catalog();
    let set_override = |key: &str, raw: &Value| overrides.choose(key, raw).unwrap();
    assert_eq!(
        choose_server_program(
            &servers,
            &set_override,
            &json!("ext/ls"),
            &json!({"path": path_of(&s.tmp.join("absent"))})
        ),
        LanguageServerOverrideResult {
            servers: servers.listed.clone(),
            problem: Some(Missing),
        }
    );
    assert_eq!(servers.refreshed.get(), 0);
    assert_eq!(
        choose_server_program(
            &servers,
            &set_override,
            &json!("ext/ls"),
            &json!({"path": path_of(&s.program), "args": []})
        ),
        LanguageServerOverrideResult {
            servers: servers.listed.clone(),
            problem: None,
        }
    );
    assert_eq!(servers.refreshed.get(), 1);
    assert_eq!(overrides.get("ext/ls").unwrap().path, path_of(&s.program));
}
