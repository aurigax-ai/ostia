#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::fs::{self, File};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use ostia_terminal::shell_commands::{
    CommandsPane, ExecutableIndex, ShellState, command_names, pane_command_names,
    parse_shell_state, path_dirs, read_shell_state,
};
use tempfile::TempDir;

fn file(dir: &Path, name: &str, mode: u32) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    path
}

fn touch_dir(dir: &Path, seconds: u64) {
    File::open(dir)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(seconds))
        .unwrap();
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[tokio::test]
async fn reads_the_path_the_environment_lines_and_the_command_names_after_them() {
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    fs::write(
        &state,
        "/a b:/c\n/p/.venv\nbase\n/k/config\ncd  if\tll \n/h/.zsh_history\n",
    )
    .unwrap();
    assert_eq!(
        read_shell_state(&state).await,
        Some(ShellState {
            path: "/a b:/c".to_owned(),
            virtual_env: Some("/p/.venv".to_owned()),
            conda_env: Some("base".to_owned()),
            kubeconfig: Some("/k/config".to_owned()),
            hist_file: Some("/h/.zsh_history".to_owned()),
            names: strings(&["cd", "if", "ll"]),
        })
    );
}

#[tokio::test]
async fn reads_nothing_from_a_missing_symlinked_oversized_or_malformed_file() {
    let root = TempDir::new().unwrap();
    let dir = root.path();
    assert_eq!(read_shell_state(&dir.join("missing")).await, None);
    let real = dir.join("real");
    fs::write(&real, "/usr/bin\n\n\n\nls\n").unwrap();
    let link = dir.join("link");
    symlink(&real, &link).unwrap();
    assert_eq!(read_shell_state(&link).await, None);
    let big = dir.join("big");
    fs::write(&big, format!("/usr/bin\n{}", "x".repeat(2 * 1024 * 1024))).unwrap();
    assert_eq!(read_shell_state(&big).await, None);
    let no_newline = dir.join("partial");
    fs::write(&no_newline, "/usr/bin").unwrap();
    assert_eq!(read_shell_state(&no_newline).await, None);
}

#[test]
fn reads_empty_environment_lines_as_unset() {
    assert_eq!(
        parse_shell_state("/usr/bin\n\n\n\nls cd\n"),
        Some(ShellState {
            path: "/usr/bin".to_owned(),
            virtual_env: None,
            conda_env: None,
            kubeconfig: None,
            hist_file: None,
            names: strings(&["ls", "cd"]),
        })
    );
}

#[test]
fn refuses_a_file_cut_off_before_the_command_names() {
    assert_eq!(parse_shell_state("/usr/bin\n/p/.venv\nbase"), None);
    assert_eq!(parse_shell_state("/usr/bin\n/p/.venv\nbase\n/k"), None);
}

#[test]
fn keeps_absolute_directories_once_and_drops_relative_or_empty_entries() {
    assert_eq!(
        path_dirs("/usr/bin::.:bin:/usr/bin:/opt/x", ':'),
        strings(&["/usr/bin", "/opt/x"])
    );
}

#[tokio::test]
async fn lists_only_executable_files_from_the_path_directories_never_their_contents() {
    let root = TempDir::new().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    file(&a, "tool", 0o755);
    file(&a, "notes.txt", 0o644);
    fs::create_dir(a.join("subdir")).unwrap();
    let target = file(&b, "real", 0o700);
    symlink(&target, b.join("linked")).unwrap();
    symlink(root.path().join("missing"), b.join("dangling")).unwrap();
    let index = ExecutableIndex::new(':');
    let path = format!(
        "{}:{}:relative:{}",
        text(&a),
        text(&b),
        text(&root.path().join("absent"))
    );
    assert_eq!(
        index.list(&path).await,
        strings(&["linked", "real", "tool"])
    );
}

#[tokio::test]
async fn serves_a_path_from_the_cache_until_one_of_its_directories_changes() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("bin");
    fs::create_dir(&dir).unwrap();
    file(&dir, "first", 0o755);
    let later = file(&dir, "later", 0o644);
    touch_dir(&dir, 1_000);
    let index = ExecutableIndex::new(':');
    assert_eq!(index.list(text(&dir)).await, strings(&["first"]));

    fs::set_permissions(&later, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(index.list(text(&dir)).await, strings(&["first"]));

    file(&dir, "added", 0o755);
    touch_dir(&dir, 2_000);
    assert_eq!(
        index.list(text(&dir)).await,
        strings(&["added", "first", "later"])
    );
}

#[tokio::test]
async fn keeps_a_separate_listing_per_path_string() {
    let root = TempDir::new().unwrap();
    let one = root.path().join("one");
    let two = root.path().join("two");
    fs::create_dir(&one).unwrap();
    fs::create_dir(&two).unwrap();
    file(&one, "alpha", 0o755);
    file(&two, "beta", 0o755);
    let index = ExecutableIndex::new(':');
    assert_eq!(index.list(text(&one)).await, strings(&["alpha"]));
    let both = format!("{}:{}", text(&one), text(&two));
    assert_eq!(index.list(&both).await, strings(&["alpha", "beta"]));
    assert_eq!(index.list(text(&two)).await, strings(&["beta"]));
}

#[tokio::test]
async fn merges_path_executables_with_the_names_the_shell_reported_sorted_and_unique() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("bin");
    fs::create_dir(&dir).unwrap();
    file(&dir, "git", 0o755);
    file(&dir, "echo", 0o755);
    let names = command_names(
        &ExecutableIndex::new(':'),
        text(&dir),
        &strings(&["echo", "cd", "ll"]),
    )
    .await;
    assert_eq!(names, strings(&["cd", "echo", "git", "ll"]));
}

#[tokio::test]
async fn suggestions_come_from_the_panes_own_shell_only_while_it_holds_the_terminal() {
    let root = TempDir::new().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    file(&bin, "git", 0o755);
    let state_file = root.path().join("state");
    fs::write(&state_file, format!("{}\n\n\n\nll\n", text(&bin))).unwrap();
    let pane = |local_prompt: bool| CommandsPane {
        owners: HashSet::from(["7".to_owned()]),
        local_prompt,
        state_file: Some(state_file.clone()),
        spawn_path: "/nowhere".to_owned(),
        rules: None,
    };
    let index = ExecutableIndex::new(':');

    assert_eq!(
        pane_command_names(&index, Some(&pane(true)), "7").await,
        strings(&["git", "ll"])
    );
    assert_eq!(
        pane_command_names(&index, Some(&pane(false)), "7").await,
        Vec::<String>::new()
    );
    assert_eq!(
        pane_command_names(&index, Some(&pane(true)), "8").await,
        Vec::<String>::new()
    );
    assert_eq!(
        pane_command_names(&index, None, "7").await,
        Vec::<String>::new()
    );
}
