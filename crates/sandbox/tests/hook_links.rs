#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use ostia_sandbox::hook_links::hook_link_targets;
use tempfile::TempDir;

struct Home {
    _dir: TempDir,
    home: PathBuf,
    tools: PathBuf,
    hooks: PathBuf,
}

fn home() -> Home {
    let dir = TempDir::new().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let home = root.join("home");
    let tools = home.join("tools/hooks");
    let hooks = home.join(".claude/hooks");
    let data = home.join(".local/share/ostia");
    for folder in [&tools, &hooks, &data, &tools.join("sub")] {
        fs::create_dir_all(folder).unwrap();
    }
    fs::write(tools.join("remind.sh"), "#!/bin/sh\necho HOOK-RAN\n").unwrap();
    fs::write(tools.join("sibling.txt"), "SIBLING-SECRET").unwrap();
    fs::write(tools.join("sub/inner.txt"), "INNER-SECRET").unwrap();
    fs::write(data.join("vault.json"), "VAULT-SECRET").unwrap();
    symlink(tools.join("remind.sh"), hooks.join("remind.sh")).unwrap();
    symlink(tools.join("sub"), hooks.join("dir-link")).unwrap();
    symlink(data.join("vault.json"), hooks.join("vault-link")).unwrap();
    symlink(tools.join("missing.sh"), hooks.join("dangling")).unwrap();
    fs::write(hooks.join("plain.sh"), "#!/bin/sh\necho PLAIN\n").unwrap();
    Home {
        _dir: dir,
        home,
        tools,
        hooks,
    }
}

fn sorted(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.sort();
    paths
}

#[test]
fn lists_only_regular_targets() {
    let h = home();
    let targets = hook_link_targets(&h.home);
    assert!(targets.contains(&h.tools.join("remind.sh")), "{targets:?}");
    assert!(
        targets.contains(&h.home.join(".local/share/ostia/vault.json")),
        "{targets:?}"
    );
    assert!(!targets.contains(&h.tools.join("sub")), "{targets:?}");
    assert_eq!(targets.len(), 2, "{targets:?}");
}

#[test]
fn returns_nothing_when_the_hooks_folder_is_missing() {
    let dir = TempDir::new().unwrap();
    assert!(hook_link_targets(dir.path()).is_empty());
    fs::create_dir_all(dir.path().join(".claude")).unwrap();
    assert!(hook_link_targets(dir.path()).is_empty());
}

#[test]
fn returns_nothing_when_the_hooks_path_is_a_file() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join(".claude")).unwrap();
    fs::write(dir.path().join(".claude/hooks"), "x").unwrap();
    assert!(hook_link_targets(dir.path()).is_empty());
}

#[test]
fn lists_a_target_once_when_two_links_point_at_it() {
    let h = home();
    symlink(h.tools.join("remind.sh"), h.hooks.join("again.sh")).unwrap();
    let targets = hook_link_targets(&h.home);
    assert_eq!(
        targets
            .iter()
            .filter(|path| **path == h.tools.join("remind.sh"))
            .count(),
        1,
        "{targets:?}"
    );
    assert_eq!(targets.len(), 2, "{targets:?}");
}

#[test]
fn follows_a_chain_of_links_to_the_real_file() {
    let h = home();
    let middle = h.tools.join("middle.sh");
    symlink(h.tools.join("remind.sh"), &middle).unwrap();
    symlink(&middle, h.hooks.join("chain.sh")).unwrap();
    let targets = hook_link_targets(&h.home);
    assert!(targets.contains(&h.tools.join("remind.sh")), "{targets:?}");
    assert!(!targets.contains(&middle), "{targets:?}");
}

#[test]
fn skips_a_plain_file_a_folder_link_and_a_dangling_link() {
    let h = home();
    for name in ["remind.sh", "vault-link"] {
        fs::remove_file(h.hooks.join(name)).unwrap();
    }
    assert!(hook_link_targets(&h.home).is_empty());
}

#[test]
fn lists_the_target_of_a_link_to_a_file_through_a_folder_link() {
    let h = home();
    let folder_link: &Path = &h.home.join("via");
    symlink(&h.tools, folder_link).unwrap();
    symlink(folder_link.join("sibling.txt"), h.hooks.join("sibling")).unwrap();
    let targets = sorted(hook_link_targets(&h.home));
    assert!(
        targets.contains(&h.tools.join("sibling.txt")),
        "{targets:?}"
    );
}
