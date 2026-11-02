#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ostia_sandbox::sandbox_tmp::{KeptTmp, SandboxTmpDeps, SandboxTmpDirs};
use ostia_testkit::fixture_text;
use serde_json::Value;
use tempfile::TempDir;

const PID: i32 = 4242;

fn dirs(tmp_root: &Path, kept: Option<KeptTmp>) -> SandboxTmpDirs {
    SandboxTmpDirs::new(SandboxTmpDeps {
        tmp_root: tmp_root.to_path_buf(),
        pid: PID,
        kept,
    })
}

fn kept_on(root: &Path) -> KeptTmp {
    KeptTmp::new(root.to_path_buf(), || true)
}

fn short(path: &Path) -> String {
    path.file_name().unwrap().to_str().unwrap().to_owned()
}

fn make(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("file"), "x").unwrap();
}

#[test]
fn puts_a_workspace_tmp_folder_under_the_pid_folder_with_the_same_names_as_ts() {
    let rows: Vec<Value> =
        serde_json::from_str(&fixture_text("rust/sandbox-tmp-paths.json").unwrap()).unwrap();
    let tmp = dirs(Path::new("/t"), None);
    assert_eq!(rows.len(), 2);
    for row in rows {
        let id = row["id"].as_str().unwrap();
        let expected = |key: &str| PathBuf::from(row[key].as_str().unwrap());
        assert_eq!(tmp.tmp_dir(id), expected("tmpDir"), "{id} tmpDir");
        assert_eq!(
            tmp.plugins_dir(id),
            expected("pluginsDir"),
            "{id} pluginsDir"
        );
        assert_eq!(
            tmp.plugins_data(id),
            expected("pluginsData"),
            "{id} pluginsData"
        );
        assert_eq!(
            tmp.ssh_agent_socket(id),
            expected("sshAgentSocket"),
            "{id} sshAgentSocket"
        );
    }
}

#[test]
fn gives_one_workspace_one_folder_and_two_workspaces_two_folders() {
    let tmp = dirs(Path::new("/t"), None);
    assert_eq!(tmp.tmp_dir("a"), tmp.tmp_dir("a"));
    assert_ne!(tmp.tmp_dir("a"), tmp.tmp_dir("b"));
    assert_eq!(short(&tmp.tmp_dir("a")).len(), 10);
}

#[test]
fn uses_the_kept_tmp_root_while_kept_shells_are_enabled() {
    let kept_root = Path::new("/k");
    let tmp = dirs(Path::new("/t"), Some(kept_on(kept_root)));
    assert!(tmp.tmp_dir("ws-1").starts_with(kept_root));
    assert_eq!(short(&tmp.tmp_dir("ws-1")), "769446044a");
    assert_eq!(
        tmp.plugins_dir("ws-1"),
        PathBuf::from("/k/769446044a-plugins")
    );
}

#[test]
fn keeps_the_folder_it_chose_when_kept_shells_are_switched_off_later() {
    let enabled = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&enabled);
    let kept = KeptTmp::new(PathBuf::from("/k"), move || flag.load(Ordering::SeqCst));
    let tmp = dirs(Path::new("/t"), Some(kept));
    let first = tmp.tmp_dir("ws-1");
    enabled.store(false, Ordering::SeqCst);
    assert_eq!(tmp.tmp_dir("ws-1"), first);
    assert_eq!(
        tmp.tmp_dir("ws-2"),
        PathBuf::from(format!("/t/{PID}/{}", short(&tmp.tmp_dir("ws-2"))))
    );
}

#[test]
fn uses_the_instance_folder_when_kept_shells_are_disabled() {
    let kept = KeptTmp::new(PathBuf::from("/k"), || false);
    let tmp = dirs(Path::new("/t"), Some(kept));
    assert!(tmp.tmp_dir("ws-1").starts_with("/t/4242"));
}

#[test]
fn adopts_the_folder_of_a_kept_host_for_one_workspace() {
    let tmp = dirs(Path::new("/t"), None);
    tmp.adopt_kept_tmp("ws-1", PathBuf::from("/k/old"));
    assert_eq!(tmp.tmp_dir("ws-1"), PathBuf::from("/k/old"));
    assert_eq!(tmp.plugins_dir("ws-1"), PathBuf::from("/k/old-plugins"));
    assert_eq!(
        tmp.plugins_data("ws-1"),
        PathBuf::from("/k/old/plugin-data")
    );
    assert_eq!(tmp.ssh_agent_socket("ws-1"), PathBuf::from("/k/old/a.sock"));
    assert_ne!(tmp.tmp_dir("ws-2"), PathBuf::from("/k/old"));
}

#[test]
fn removes_the_tmp_and_plugins_folders_of_one_workspace_and_forgets_the_choice() {
    let root = TempDir::new().unwrap();
    let tmp = dirs(root.path(), None);
    let chosen = tmp.tmp_dir("ws-1");
    let plugins = tmp.plugins_dir("ws-1");
    let other = tmp.tmp_dir("ws-2");
    make(&chosen);
    make(&plugins);
    make(&other);
    tmp.remove("ws-1").unwrap();
    assert!(!chosen.exists());
    assert!(!plugins.exists());
    assert!(other.exists());
    tmp.adopt_kept_tmp("ws-1", PathBuf::from("/elsewhere"));
    tmp.remove("ws-1").unwrap();
    assert_eq!(tmp.tmp_dir("ws-1"), chosen);
}

#[test]
fn removes_a_workspace_that_has_no_folder_without_an_error() {
    let root = TempDir::new().unwrap();
    dirs(root.path(), None).remove("never-made").unwrap();
}

#[test]
fn clears_the_instance_folder_and_the_kept_folder_unless_told_to_keep_it() {
    let root = TempDir::new().unwrap();
    let kept_root = root.path().join("kept");
    let tmp = dirs(&root.path().join("tmp"), Some(kept_on(&kept_root)));
    let instance = root.path().join("tmp").join(PID.to_string());
    make(&instance.join("x"));
    make(&kept_root.join("y"));
    tmp.clear_tmp(false).unwrap();
    assert!(!instance.exists());
    assert!(kept_root.join("y").exists());
    make(&instance.join("x"));
    tmp.clear_tmp(true).unwrap();
    assert!(!instance.exists());
    assert!(!kept_root.exists());
}

#[test]
fn clears_the_kept_folder_by_default_and_ignores_missing_folders() {
    let root = TempDir::new().unwrap();
    let kept_root = root.path().join("kept");
    let tmp = dirs(&root.path().join("tmp"), Some(kept_on(&kept_root)));
    tmp.clear_tmp(true).unwrap();
    make(&kept_root.join("y"));
    tmp.clear_tmp(true).unwrap();
    assert!(!kept_root.exists());
}

#[test]
fn leaves_a_kept_folder_alone_when_there_is_no_kept_root() {
    let root = TempDir::new().unwrap();
    let other = root.path().join("other");
    make(&other);
    let tmp = dirs(&root.path().join("tmp"), None);
    tmp.clear_tmp(true).unwrap();
    assert!(other.exists());
}

#[test]
fn sweeps_the_kept_folders_of_no_live_workspace_and_lists_what_it_removed() {
    let root = TempDir::new().unwrap();
    let kept_root = root.path().join("kept");
    let tmp = dirs(&root.path().join("tmp"), Some(kept_on(&kept_root)));
    let live = tmp.tmp_dir("live");
    let live_plugins = tmp.plugins_dir("live");
    let stale = kept_root.join("deadbeef00");
    let stale_plugins = kept_root.join("deadbeef00-plugins");
    for dir in [&live, &live_plugins, &stale, &stale_plugins] {
        make(dir);
    }
    let mut removed = tmp.sweep_kept_tmp(&["live"]).unwrap();
    removed.sort();
    assert_eq!(removed, vec![stale.clone(), stale_plugins.clone()]);
    assert!(live.exists());
    assert!(live_plugins.exists());
    assert!(!stale.exists());
    assert!(!stale_plugins.exists());
}

#[test]
fn sweeps_every_kept_folder_when_no_workspace_is_live() {
    let root = TempDir::new().unwrap();
    let kept_root = root.path().join("kept");
    let tmp = dirs(&root.path().join("tmp"), Some(kept_on(&kept_root)));
    make(&kept_root.join("one"));
    make(&kept_root.join("two"));
    let removed = tmp.sweep_kept_tmp(&[]).unwrap();
    assert_eq!(removed.len(), 2);
    assert!(kept_root.exists());
    assert_eq!(fs::read_dir(&kept_root).unwrap().count(), 0);
}

#[test]
fn sweeps_no_kept_folder_without_a_kept_root_or_when_the_root_is_missing() {
    let root = TempDir::new().unwrap();
    let without = dirs(&root.path().join("tmp"), None);
    assert!(without.sweep_kept_tmp(&["a"]).unwrap().is_empty());
    let missing = dirs(
        &root.path().join("tmp"),
        Some(kept_on(&root.path().join("no-such-root"))),
    );
    assert!(missing.sweep_kept_tmp(&["a"]).unwrap().is_empty());
}

#[test]
fn removes_the_folder_of_a_live_workspace_when_kept_shells_are_off_and_its_folder_is_elsewhere() {
    let root = TempDir::new().unwrap();
    let kept_root = root.path().join("kept");
    let kept = KeptTmp::new(kept_root.clone(), || false);
    let tmp = dirs(&root.path().join("tmp"), Some(kept));
    make(&kept_root.join("abc"));
    let removed = tmp.sweep_kept_tmp(&["live"]).unwrap();
    assert_eq!(removed, vec![kept_root.join("abc")]);
}

#[test]
fn sweeps_the_numbered_folders_of_dead_processes_and_keeps_its_own_and_the_living() {
    let root = TempDir::new().unwrap();
    let tmp = dirs(root.path(), None);
    for name in ["100", "200", "4242", "300"] {
        make(&root.path().join(name));
    }
    let mut removed = tmp.sweep_tmp(|pid| pid == 200).unwrap();
    removed.sort();
    assert_eq!(
        removed,
        vec![root.path().join("100"), root.path().join("300")]
    );
    assert!(root.path().join("200").exists());
    assert!(root.path().join("4242").exists());
    assert!(!root.path().join("100").exists());
}

#[test]
fn leaves_folders_whose_names_are_not_only_digits() {
    let root = TempDir::new().unwrap();
    let tmp = dirs(root.path(), None);
    for name in ["12a", "a12", "-5", "1.5", "keep", " 7", "\u{663}"] {
        make(&root.path().join(name));
    }
    assert!(tmp.sweep_tmp(|_| false).unwrap().is_empty());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 7);
}

#[test]
fn sweeps_nothing_when_the_tmp_root_is_missing() {
    let root = TempDir::new().unwrap();
    let tmp = dirs(&root.path().join("no-such-root"), None);
    assert!(tmp.sweep_tmp(|_| false).unwrap().is_empty());
}

#[test]
fn asks_the_process_table_for_a_folder_named_by_a_pid() {
    let root = TempDir::new().unwrap();
    let tmp = dirs(root.path(), None);
    let own = root.path().join(std::process::id().to_string());
    let dead = root.path().join("2000000000");
    make(&own);
    make(&dead);
    let removed = tmp.sweep_tmp(ostia_base::process::is_running).unwrap();
    assert_eq!(removed, vec![dead]);
    assert!(own.exists());
}
