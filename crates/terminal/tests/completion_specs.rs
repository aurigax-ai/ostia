#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;

use ostia_terminal::completion_specs::load_completion_spec;
use tempfile::{TempDir, tempdir};

struct Dirs {
    _guard: TempDir,
    base: PathBuf,
    user: PathBuf,
    ext: PathBuf,
}

fn dirs() -> Dirs {
    let guard = tempdir().unwrap();
    let base = guard.path().to_path_buf();
    let user = base.join("user");
    let ext = base.join("ext");
    fs::create_dir(&user).unwrap();
    fs::create_dir(&ext).unwrap();
    Dirs {
        _guard: guard,
        base,
        user,
        ext,
    }
}

fn spec(description: &str) -> String {
    serde_json::json!({
        "names": ["tool"],
        "description": description,
        "subcommands": [{"names": ["run"]}],
    })
    .to_string()
}

fn description(command: &str, dirs: &[PathBuf]) -> Option<String> {
    load_completion_spec(command, dirs)?.description
}

#[test]
fn prefers_the_user_folder_over_extension_folders() {
    let d = dirs();
    let both = [d.user.clone(), d.ext.clone()];
    fs::write(d.ext.join("tool.json"), spec("from the extension")).unwrap();
    assert_eq!(
        description("tool", &both).as_deref(),
        Some("from the extension")
    );
    fs::write(d.user.join("tool.json"), spec("mine")).unwrap();
    assert_eq!(description("tool", &both).as_deref(), Some("mine"));
}

#[test]
fn refuses_command_names_that_could_leave_the_folder() {
    let d = dirs();
    fs::write(d.base.join("tool.json"), spec("outside")).unwrap();
    for name in ["../tool", "a/b", "", ".hidden", &"x".repeat(65)] {
        assert!(
            load_completion_spec(name, std::slice::from_ref(&d.user)).is_none(),
            "{name:?}"
        );
    }
}

#[test]
fn skips_invalid_oversized_and_symlinked_files_and_falls_through_to_the_next_folder() {
    let d = dirs();
    let both = [d.user.clone(), d.ext.clone()];
    fs::write(d.user.join("tool.json"), r#"{"names": "not-a-list"}"#).unwrap();
    fs::write(d.ext.join("tool.json"), spec("valid")).unwrap();
    assert_eq!(description("tool", &both).as_deref(), Some("valid"));
    fs::write(d.base.join("real.json"), spec("linked")).unwrap();
    symlink(d.base.join("real.json"), d.user.join("linked.json")).unwrap();
    assert!(load_completion_spec("linked", std::slice::from_ref(&d.user)).is_none());
    fs::write(d.user.join("big.json"), " ".repeat(4 * 1024 * 1024 + 1)).unwrap();
    assert!(load_completion_spec("big", std::slice::from_ref(&d.user)).is_none());
}

#[test]
fn rereads_a_spec_after_it_changes() {
    let d = dirs();
    let user = [d.user.clone()];
    fs::write(d.user.join("tool.json"), spec("one")).unwrap();
    assert_eq!(description("tool", &user).as_deref(), Some("one"));
    fs::write(d.user.join("tool.json"), spec("second")).unwrap();
    assert_eq!(description("tool", &user).as_deref(), Some("second"));
}

#[test]
fn tab_completes_subcommands_and_options_with_descriptions_from_the_built_in_specs() {
    let d = dirs();
    let built_in = d.base.join("fig");
    fs::create_dir(&built_in).unwrap();
    for name in ["git.json", "tar.json"] {
        let text = ostia_testkit::fixture_text(&format!("rust/completion-specs/{name}")).unwrap();
        fs::write(built_in.join(name), text).unwrap();
    }
    let both = [d.user.clone(), built_in];
    let git = load_completion_spec("git", &both).unwrap();
    let subcommands: Vec<String> = git
        .subcommands
        .iter()
        .flatten()
        .flat_map(|command| command.names.clone())
        .collect();
    let checking: Vec<&String> = subcommands
        .iter()
        .filter(|name| name.starts_with("chec"))
        .collect();
    assert_eq!(checking, vec!["checkout"]);
    let checkout = git
        .subcommands
        .iter()
        .flatten()
        .find(|command| command.names.iter().any(|name| name == "checkout"))
        .unwrap();
    let force = checkout
        .options
        .iter()
        .flatten()
        .find(|option| option.names.iter().any(|name| name == "--force"))
        .unwrap();
    let words = force.description.as_deref().unwrap().split_whitespace();
    assert!(words.count() >= 2);
    let tar = load_completion_spec("tar", &both).unwrap();
    assert!(tar.options.iter().flatten().any(|option| {
        option
            .names
            .iter()
            .any(|name| name.starts_with("--exclude"))
    }));
}

#[test]
fn skips_a_file_that_is_not_json_and_a_folder_named_like_a_spec() {
    let d = dirs();
    let both = [d.user.clone(), d.ext.clone()];
    fs::write(d.user.join("tool.json"), "{not json").unwrap();
    fs::create_dir(d.ext.join("other.json")).unwrap();
    fs::write(d.ext.join("tool.json"), spec("valid")).unwrap();
    assert_eq!(description("tool", &both).as_deref(), Some("valid"));
    assert!(load_completion_spec("other", &both).is_none());
}

#[test]
fn accepts_a_file_of_exactly_the_size_limit_and_refuses_one_byte_more() {
    let d = dirs();
    let user = [d.user.clone()];
    let body = spec("padded");
    let limit = 4 * 1024 * 1024;
    let at_limit = format!("{body}{}", " ".repeat(limit - body.len()));
    fs::write(d.user.join("exact.json"), &at_limit).unwrap();
    assert_eq!(description("exact", &user).as_deref(), Some("padded"));
    fs::write(d.user.join("over.json"), format!("{at_limit} ")).unwrap();
    assert!(load_completion_spec("over", &user).is_none());
}

#[test]
fn returns_nothing_when_no_folder_has_the_spec_or_no_folder_is_given() {
    let d = dirs();
    assert!(load_completion_spec("tool", &[d.user.clone(), d.ext.clone()]).is_none());
    assert!(load_completion_spec("tool", &[]).is_none());
    assert!(load_completion_spec("tool", &[d.base.join("missing")]).is_none());
}

#[test]
fn accepts_names_with_dots_plus_and_dashes_and_a_length_of_64() {
    let d = dirs();
    let user = [d.user.clone()];
    for name in ["g++", "a.b-c_d", "7z", &format!("a{}", "b".repeat(63))] {
        fs::write(d.user.join(format!("{name}.json")), spec(name)).unwrap();
        assert_eq!(description(name, &user).as_deref(), Some(name), "{name}");
    }
}
