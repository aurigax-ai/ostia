#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use ostia_sandbox::path_checks::{
    SandboxEditError, SandboxPathEnv, check_sandbox_path, check_sandbox_paths,
};
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    home: PathBuf,
    data_dir: PathBuf,
    runtime_dir: PathBuf,
    agent_dir: PathBuf,
    work_dir: PathBuf,
    env: SandboxPathEnv,
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn fixture() -> Fixture {
    let dir = TempDir::new().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let home = root.join("home");
    let data_dir = home.join(".local/share/ostia");
    let runtime_dir = root.join("run");
    let agent_dir = runtime_dir.join("keyring");
    let work_dir = home.join("proj");
    for folder in [
        home.join("notes"),
        home.join("builds"),
        home.join(".claude/hooks"),
        work_dir.join(".git"),
        data_dir.clone(),
        agent_dir.clone(),
        data_dir.join("..cache"),
        runtime_dir.join("..sock"),
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    fs::write(home.join(".claude/settings.json"), "{}").unwrap();
    fs::write(work_dir.join(".git/config"), "").unwrap();
    fs::write(home.join("weird[1].txt"), "").unwrap();
    symlink(&data_dir, home.join("data-link")).unwrap();
    symlink(&agent_dir, home.join("agent-link")).unwrap();
    let env = SandboxPathEnv {
        home: text(&home),
        data_dirs: vec![text(&data_dir)],
        protected_dirs: vec![text(&runtime_dir), text(&agent_dir)],
        protected_files: vec![
            text(&home.join(".claude/settings.json")),
            text(&home.join(".claude/hooks")),
            text(&work_dir.join(".git/config")),
        ],
    };
    Fixture {
        _dir: dir,
        root,
        home,
        data_dir,
        runtime_dir,
        agent_dir,
        work_dir,
        env,
    }
}

fn check(f: &Fixture, kind: &str, input: &str) -> Result<String, &'static str> {
    check_sandbox_path(kind, input, &f.env).map_err(|reason| reason.as_str())
}

fn ok(path: &str) -> Result<String, &'static str> {
    Ok(path.to_owned())
}

#[test]
fn sbx_c26_refuses_the_root_the_home_dir_the_data_dir_relative_and_missing_paths_with_a_reason() {
    let f = fixture();
    assert_eq!(check(&f, "allowRead", "/"), Err("too-broad"));
    assert_eq!(check(&f, "allowRead", "~"), Err("too-broad"));
    assert_eq!(
        check(&f, "allowRead", &format!("{}/", text(&f.home))),
        Err("too-broad")
    );
    assert_eq!(
        check(&f, "allowRead", &text(&f.data_dir)),
        Err("ostia-data")
    );
    assert_eq!(
        check(&f, "allowRead", &text(&f.data_dir.join("vault.json"))),
        Err("ostia-data")
    );
    assert_eq!(check(&f, "allowRead", "notes"), Err("not-absolute"));
    assert_eq!(check(&f, "allowRead", "~/missing"), Err("missing"));
    assert_eq!(check(&f, "allowRead", "~/notes"), ok("~/notes"));
    let notes = text(&f.home.join("notes"));
    assert_eq!(check(&f, "allowRead", &notes), Ok(notes.clone()));
}

#[test]
fn refuses_a_folder_above_the_home_folder_or_above_the_data_folder_as_readable_or_writable() {
    let f = fixture();
    let root = text(&f.root);
    assert_eq!(check(&f, "allowRead", &root), Err("too-broad"));
    assert_eq!(check(&f, "allowWrite", &root), Err("too-broad"));
    assert_eq!(check(&f, "allowWrite", "~/.local/share"), Err("ostia-data"));
}

#[test]
fn refuses_to_open_the_runtime_folder_an_agent_socket_folder_or_anything_inside_or_above_them() {
    let f = fixture();
    for kind in ["allowRead", "allowWrite", "allowSockets"] {
        assert_eq!(
            check(&f, kind, &text(&f.runtime_dir)),
            Err("protected"),
            "{kind} runtime"
        );
        assert_eq!(
            check(&f, kind, &text(&f.agent_dir)),
            Err("protected"),
            "{kind} agent"
        );
    }
}

#[test]
fn refuses_a_folder_inside_a_closed_folder_whose_name_starts_with_two_dots() {
    let f = fixture();
    assert_eq!(
        check(&f, "allowWrite", &text(&f.data_dir.join("..cache"))),
        Err("ostia-data")
    );
    assert_eq!(
        check(&f, "allowRead", &text(&f.runtime_dir.join("..sock"))),
        Err("protected")
    );
}

#[test]
fn follows_a_symlink_before_deciding_so_a_link_into_a_closed_folder_is_refused_too() {
    let f = fixture();
    assert_eq!(check(&f, "allowRead", "~/data-link"), Err("ostia-data"));
    assert_eq!(check(&f, "allowWrite", "~/agent-link"), Err("protected"));
}

#[test]
fn refuses_a_writable_path_that_is_a_protected_agent_or_git_file_but_accepts_an_ordinary_folder() {
    let f = fixture();
    assert_eq!(
        check(&f, "allowWrite", "~/.claude/settings.json"),
        Err("protected")
    );
    assert_eq!(check(&f, "allowWrite", "~/.claude/hooks"), Err("protected"));
    assert_eq!(
        check(&f, "allowWrite", &text(&f.work_dir.join(".git/config"))),
        Err("protected")
    );
    assert_eq!(check(&f, "allowWrite", "~/builds/"), ok("~/builds"));
}

#[test]
fn accepts_hiding_or_write_protecting_any_existing_path_except_the_root_since_that_only_narrows_access()
 {
    let f = fixture();
    assert_eq!(check(&f, "denyRead", "/"), Err("too-broad"));
    assert_eq!(check(&f, "denyWrite", "/"), Err("too-broad"));
    assert_eq!(check(&f, "denyRead", "~/notes"), ok("~/notes"));
    let agent = text(&f.agent_dir);
    assert_eq!(check(&f, "denyRead", &agent), Ok(agent.clone()));
    let work = text(&f.work_dir);
    assert_eq!(check(&f, "denyWrite", &work), Ok(work.clone()));
    assert_eq!(check(&f, "denyRead", "~/nothing-here"), Err("missing"));
}

#[test]
fn refuses_pattern_characters_which_the_sandbox_runtime_would_read_as_a_glob() {
    let f = fixture();
    assert_eq!(check(&f, "denyRead", "~/weird[1].txt"), Err("pattern"));
    assert_eq!(check(&f, "allowWrite", "~/builds/*"), Err("pattern"));
}

#[test]
fn refuses_a_path_longer_than_the_cap() {
    let f = fixture();
    assert_eq!(
        check(&f, "denyRead", &format!("/{}", "a".repeat(1100))),
        Err("too-long")
    );
}

#[test]
fn returns_every_accepted_path_in_order_or_every_refusal_with_its_value() {
    let f = fixture();
    assert_eq!(
        check_sandbox_paths("allowWrite", &["~/builds", "~/notes/"], &f.env),
        Ok(vec!["~/builds".to_owned(), "~/notes".to_owned()])
    );
    let runtime = text(&f.runtime_dir);
    assert_eq!(
        check_sandbox_paths("allowWrite", &["~/builds", "rel", &runtime], &f.env),
        Err(vec![
            SandboxEditError {
                value: "rel".to_owned(),
                reason: "not-absolute".to_owned()
            },
            SandboxEditError {
                value: runtime,
                reason: "protected".to_owned()
            },
        ])
    );
}

#[test]
fn counts_the_cap_in_utf16_units_so_an_emoji_counts_twice() {
    let f = fixture();
    let at_cap = format!("/{}a", "\u{1F600}".repeat(511));
    let over_cap = format!("/{}", "\u{1F600}".repeat(512));
    assert_eq!(check(&f, "denyRead", &at_cap), Err("missing"));
    assert_eq!(check(&f, "denyRead", &over_cap), Err("too-long"));
    let ascii_at_cap = format!("/{}", "a".repeat(1023));
    let ascii_over_cap = format!("/{}", "a".repeat(1024));
    assert_eq!(check(&f, "denyRead", &ascii_at_cap), Err("missing"));
    assert_eq!(check(&f, "denyRead", &ascii_over_cap), Err("too-long"));
}

#[test]
fn trims_the_input_with_the_js_space_set_and_returns_the_trimmed_text() {
    let f = fixture();
    assert_eq!(check(&f, "allowRead", "  ~/notes  "), ok("~/notes"));
    assert_eq!(
        check(&f, "allowRead", "\u{feff}~/notes\u{feff}"),
        ok("~/notes")
    );
    assert_eq!(check(&f, "allowRead", "   "), Err("not-absolute"));
}

#[test]
fn judges_the_normalised_path_but_returns_the_text_as_typed() {
    let f = fixture();
    assert_eq!(
        check(&f, "allowRead", "~/notes/../builds"),
        ok("~/notes/../builds")
    );
    assert_eq!(check(&f, "allowRead", "~/notes/../../.."), Err("too-broad"));
    assert_eq!(check(&f, "allowRead", "~/notes/../missing"), Err("missing"));
    assert_eq!(check(&f, "allowRead", "~/builds///"), ok("~/builds"));
}

#[test]
fn refuses_the_home_folder_and_the_data_folder_as_a_socket_folder_too() {
    let f = fixture();
    assert_eq!(check(&f, "allowSockets", "~"), Err("too-broad"));
    assert_eq!(
        check(&f, "allowSockets", &text(&f.data_dir)),
        Err("ostia-data")
    );
}

#[test]
fn lets_a_protected_file_be_read_and_hidden_but_not_opened_for_writing() {
    let f = fixture();
    assert_eq!(
        check(&f, "allowRead", "~/.claude/settings.json"),
        ok("~/.claude/settings.json")
    );
    assert_eq!(
        check(&f, "denyWrite", "~/.claude/settings.json"),
        ok("~/.claude/settings.json")
    );
    assert_eq!(check(&f, "allowWrite", "~/.claude"), ok("~/.claude"));
    assert_eq!(
        check(&f, "allowWrite", "~/.claude/settings.json"),
        Err("protected")
    );
}

#[test]
fn reports_not_absolute_before_a_pattern_and_a_pattern_before_missing() {
    let f = fixture();
    assert_eq!(check(&f, "allowRead", "rel/*"), Err("not-absolute"));
    assert_eq!(check(&f, "allowRead", "~/missing/*"), Err("pattern"));
}

#[test]
fn gives_every_reason_the_name_the_ts_code_uses() {
    let f = fixture();
    let reasons = [
        ("allowRead", "notes", "not-absolute"),
        ("allowRead", "~/builds/{a,b}", "pattern"),
        ("allowRead", "/", "too-broad"),
        ("allowRead", "~/missing", "missing"),
    ];
    for (kind, input, name) in reasons {
        assert_eq!(check(&f, kind, input), Err(name), "{input}");
    }
}
