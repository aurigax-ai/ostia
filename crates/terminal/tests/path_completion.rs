#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use ostia_base::Host;
use ostia_sandbox::visibility::SandboxReadRules;
use ostia_terminal::path_completion::{
    COMPLETION_ENTRIES_MAX, CompletionEntry, CompletionPane, completion_paths,
};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const OWNER: &str = "7";
const PANE: &str = "pane-1";

fn runs_as_root() -> bool {
    rustix::process::getuid().is_root()
}

fn pane(over: impl FnOnce(&mut CompletionPane)) -> impl Fn(&str) -> Option<CompletionPane> {
    let mut pane = CompletionPane {
        owners: HashSet::from([OWNER.to_owned()]),
        local_prompt: true,
        rules: None,
    };
    over(&mut pane);
    move |pane_id| (pane_id == PANE).then(|| pane.clone())
}

fn plain() -> impl Fn(&str) -> Option<CompletionPane> {
    pane(|_| {})
}

fn entry(name: &str, dir: bool) -> CompletionEntry {
    CompletionEntry {
        name: name.to_owned(),
        dir,
    }
}

fn root() -> (TempDir, PathBuf) {
    let guard = tempdir().unwrap();
    let path = fs::canonicalize(guard.path()).unwrap();
    (guard, path)
}

fn touch(path: &Path) {
    fs::write(path, "").unwrap();
}

async fn list(
    lookup: &impl Fn(&str) -> Option<CompletionPane>,
    sender: &str,
    pane_id: Value,
    dir: Value,
) -> Vec<CompletionEntry> {
    completion_paths(&Host::current(), lookup, sender, &pane_id, &dir).await
}

async fn list_dir(
    lookup: &impl Fn(&str) -> Option<CompletionPane>,
    dir: &Path,
) -> Vec<CompletionEntry> {
    list(lookup, OWNER, json!(PANE), json!(dir.to_str().unwrap())).await
}

#[tokio::test]
async fn lists_the_names_of_slash_with_their_kinds_a_folder_outside_every_file_root() {
    let entries = list(&plain(), OWNER, json!(PANE), json!("/")).await;
    let mut names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    names.sort();
    let mut expected: Vec<String> = fs::read_dir("/")
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    expected.sort();
    assert_eq!(names, expected);
    assert_eq!(
        entries.iter().find(|e| e.name == "usr"),
        Some(&entry("usr", true))
    );
    for e in &entries {
        let keys: Vec<String> = serde_json::to_value(e)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(sorted, ["dir", "name"], "{}", e.name);
    }
}

#[tokio::test]
async fn marks_files_folders_and_links_by_what_the_shell_would_complete_them_to() {
    let (_guard, root) = root();
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("file.txt"), "never returned").unwrap();
    symlink(root.join("folder"), root.join("to-folder")).unwrap();
    symlink(root.join("file.txt"), root.join("to-file")).unwrap();
    symlink(root.join("gone"), root.join("dangling")).unwrap();
    assert_eq!(
        list_dir(&plain(), &root).await,
        vec![
            entry("folder", true),
            entry("to-folder", true),
            entry("dangling", false),
            entry("file.txt", false),
            entry("to-file", false),
        ]
    );
}

#[tokio::test]
async fn refuses_a_pane_the_sender_does_not_own_an_unknown_pane_and_a_busy_pane() {
    let (_guard, root) = root();
    touch(&root.join("a"));
    let dir = json!(root.to_str().unwrap());
    assert_eq!(list(&plain(), "8", json!(PANE), dir.clone()).await, []);
    assert_eq!(
        list(&plain(), OWNER, json!("pane-2"), dir.clone()).await,
        []
    );
    let busy = pane(|p| p.local_prompt = false);
    assert_eq!(list(&busy, OWNER, json!(PANE), dir.clone()).await, []);
    assert_eq!(
        list(&plain(), OWNER, json!(PANE), dir).await,
        vec![entry("a", false)]
    );
}

#[tokio::test]
async fn refuses_what_is_not_a_local_folder_path() {
    let (_guard, root) = root();
    touch(&root.join("a"));
    let nul = format!("{}\0", root.display());
    let file = root.join("a");
    let cases = [
        json!(null),
        json!(7),
        json!(""),
        json!("remote://x/home"),
        json!(nul),
        json!(file.to_str().unwrap()),
    ];
    for dir in cases {
        assert_eq!(
            list(&plain(), OWNER, json!(PANE), dir.clone()).await,
            [],
            "{dir}"
        );
    }
    assert_eq!(
        list(&plain(), OWNER, json!(5), json!(root.to_str().unwrap())).await,
        []
    );
}

#[tokio::test]
async fn caps_a_large_folder() {
    let (_guard, root) = root();
    for i in 0..COMPLETION_ENTRIES_MAX + 25 {
        touch(&root.join(format!("f{i}")));
    }
    assert_eq!(
        list_dir(&plain(), &root).await.len(),
        COMPLETION_ENTRIES_MAX
    );
}

#[tokio::test]
async fn offers_a_sandboxed_pane_only_what_its_policy_lets_the_shell_read() {
    let (_guard, root) = root();
    let work = root.join("home").join("work");
    fs::create_dir_all(work.join("src")).unwrap();
    fs::create_dir(root.join("home").join(".ssh")).unwrap();
    touch(&root.join("home/.ssh/id_ed25519"));
    touch(&root.join("home/notes.txt"));
    fs::create_dir(root.join("open")).unwrap();
    touch(&root.join("open/readme"));
    touch(&root.join("open/secret"));
    symlink(root.join("home/.ssh"), work.join("keys")).unwrap();
    symlink(work.join("src"), work.join("code")).unwrap();
    let rules = SandboxReadRules {
        deny_read: vec![
            root.join("home").to_str().unwrap().to_owned(),
            root.join("open/secret").to_str().unwrap().to_owned(),
        ],
        allow_read: vec![work.to_str().unwrap().to_owned()],
    };
    let sandboxed = pane(|p| p.rules = Some(rules));
    assert_eq!(
        list_dir(&sandboxed, &root.join("home")).await,
        vec![entry("work", true)]
    );
    assert_eq!(list_dir(&sandboxed, &root.join("home/.ssh")).await, []);
    assert_eq!(list_dir(&sandboxed, &work.join("keys")).await, []);
    assert_eq!(
        list_dir(&sandboxed, &root.join("open")).await,
        vec![entry("readme", false)]
    );
    assert_eq!(
        list_dir(&sandboxed, &work).await,
        vec![
            entry("code", true),
            entry("src", true),
            entry("keys", false)
        ]
    );
}

#[tokio::test]
async fn returns_nothing_for_a_folder_that_cannot_be_read() {
    if runs_as_root() {
        return;
    }
    let (_guard, root) = root();
    let locked = root.join("locked");
    fs::create_dir(&locked).unwrap();
    touch(&locked.join("inside"));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = list_dir(&plain(), &locked).await;
    let missing = list_dir(&plain(), &root.join("missing")).await;
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(unreadable, []);
    assert_eq!(missing, []);
}

#[tokio::test]
async fn expands_a_leading_tilde_against_the_host_home() {
    let (_guard, root) = root();
    fs::create_dir_all(root.join("home")).unwrap();
    touch(&root.join("home/in-home"));
    let host = Host {
        home: root.join("home"),
        cwd: root.clone(),
        ..Host::current()
    };
    let entries = completion_paths(&host, &plain(), OWNER, &json!(PANE), &json!("~")).await;
    assert_eq!(entries, vec![entry("in-home", false)]);
}

#[tokio::test]
async fn resolves_a_relative_folder_against_the_host_folder() {
    let (_guard, root) = root();
    fs::create_dir_all(root.join("sub")).unwrap();
    touch(&root.join("sub/in-sub"));
    let host = Host {
        cwd: root.clone(),
        ..Host::current()
    };
    let entries = completion_paths(&host, &plain(), OWNER, &json!(PANE), &json!("sub")).await;
    assert_eq!(entries, vec![entry("in-sub", false)]);
}

#[tokio::test]
async fn hides_a_sandboxed_folder_that_resolves_through_a_link_to_a_denied_place() {
    let (_guard, root) = root();
    fs::create_dir_all(root.join("secret")).unwrap();
    fs::create_dir_all(root.join("work")).unwrap();
    touch(&root.join("secret/token"));
    symlink(root.join("secret"), root.join("work/door")).unwrap();
    let rules = SandboxReadRules {
        deny_read: vec![root.join("secret").to_str().unwrap().to_owned()],
        allow_read: vec![root.join("work").to_str().unwrap().to_owned()],
    };
    let sandboxed = pane(|p| p.rules = Some(rules));
    assert_eq!(list_dir(&sandboxed, &root.join("work/door")).await, []);
}

#[tokio::test]
async fn gives_a_sandboxed_pane_nothing_for_a_folder_that_does_not_exist() {
    let (_guard, root) = root();
    let rules = SandboxReadRules {
        deny_read: Vec::new(),
        allow_read: Vec::new(),
    };
    let sandboxed = pane(|p| p.rules = Some(rules));
    assert_eq!(list_dir(&sandboxed, &root.join("missing")).await, []);
}
