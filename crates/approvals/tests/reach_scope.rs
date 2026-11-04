#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};

use ostia_approvals::reach_scope::{
    AgentProvenance, ScopeGroup, ScopeWorkspace, project_key, same_reach_scope, unconfirmed_members,
};
use ostia_contract::reach::ReachMode;
use ostia_contract::sandbox::WorkspaceSandbox;
use tempfile::TempDir;

struct Tree {
    _dir: TempDir,
    home: PathBuf,
    terminal: PathBuf,
    terminal_workers: PathBuf,
    other: PathBuf,
    plain: PathBuf,
}

impl Tree {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let home = fs::canonicalize(dir.path()).unwrap();
        let terminal = repo(&home, "terminal");
        let terminal_workers = worktree(&home, &terminal, "terminal-workers");
        let other = repo(&home, "other");
        let plain = home.join("notes");
        fs::create_dir_all(terminal.join("src")).unwrap();
        fs::create_dir_all(&plain).unwrap();
        Self {
            _dir: dir,
            home,
            terminal,
            terminal_workers,
            other,
            plain,
        }
    }

    fn key(&self, dir: &Path) -> Option<String> {
        project_key(dir.to_str().unwrap(), &self.home)
    }

    fn ws(&self, id: &str) -> ScopeWorkspace {
        ScopeWorkspace {
            id: id.to_owned(),
            shareable: true,
            project: self.key(&self.terminal),
            folder_by_agent: false,
            sandbox: WorkspaceSandbox::empty(),
            group: None,
        }
    }
}

fn repo(home: &Path, name: &str) -> PathBuf {
    let dir = home.join(name);
    fs::create_dir_all(dir.join(".git").join("worktrees")).unwrap();
    dir
}

fn worktree(home: &Path, main: &Path, name: &str) -> PathBuf {
    let dir = home.join(name);
    let git_dir = main.join(".git").join("worktrees").join(name);
    fs::create_dir_all(&git_dir).unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(git_dir.join("commondir"), "../..\n").unwrap();
    fs::write(
        git_dir.join("gitdir"),
        format!("{}\n", dir.join(".git").display()),
    )
    .unwrap();
    fs::write(dir.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
    dir
}

fn sandboxed() -> WorkspaceSandbox {
    WorkspaceSandbox {
        enabled: true,
        ..WorkspaceSandbox::empty()
    }
}

fn group(id: &str, by_agent: bool) -> Option<ScopeGroup> {
    Some(ScopeGroup {
        id: id.to_owned(),
        by_agent,
    })
}

#[test]
fn gives_every_worktree_of_a_repository_the_same_key_from_its_shared_git_dir() {
    let t = Tree::new();
    assert_eq!(
        t.key(&t.terminal),
        Some(format!("git:{}", t.terminal.join(".git").display()))
    );
    assert_eq!(t.key(&t.terminal_workers), t.key(&t.terminal));
    assert_eq!(t.key(&t.terminal.join("src")), t.key(&t.terminal));
}

#[test]
fn gives_a_different_repository_a_different_key() {
    let t = Tree::new();
    assert_ne!(t.key(&t.other), t.key(&t.terminal));
}

#[test]
fn falls_back_to_the_folder_itself_outside_a_repository_with_tilde_expanded() {
    let t = Tree::new();
    let expected = Some(format!("dir:{}", t.plain.display()));
    assert_eq!(t.key(&t.plain), expected);
    assert_eq!(project_key("~/notes", &t.home), expected);
}

#[test]
fn never_makes_the_home_folder_a_folder_above_it_or_a_relative_path_a_project() {
    let t = Tree::new();
    for work_dir in [t.home.to_str().unwrap(), "~", "/", "notes"] {
        assert_eq!(project_key(work_dir, &t.home), None, "{work_dir}");
    }
}

#[test]
fn does_not_climb_into_a_repository_at_the_home_folder_itself() {
    let t = Tree::new();
    fs::create_dir_all(t.home.join(".git")).unwrap();
    assert_eq!(t.key(&t.plain), Some(format!("dir:{}", t.plain.display())));
}

#[test]
fn workspace_only_the_callers_own_workspace() {
    let t = Tree::new();
    let a = t.ws("a");
    let b = ScopeWorkspace {
        project: t.key(&t.terminal_workers),
        ..t.ws("b")
    };
    assert!(same_reach_scope(&a, &a, ReachMode::Workspace));
    assert!(!same_reach_scope(&a, &b, ReachMode::Workspace));
}

#[test]
fn project_two_worktrees_of_one_repository_are_one_scope() {
    let t = Tree::new();
    let a = t.ws("a");
    let b = ScopeWorkspace {
        project: t.key(&t.terminal_workers),
        ..t.ws("b")
    };
    assert!(same_reach_scope(&a, &b, ReachMode::Project));
}

#[test]
fn project_a_different_repository_or_a_different_plain_folder_is_not() {
    let t = Tree::new();
    let a = t.ws("a");
    let c = ScopeWorkspace {
        project: t.key(&t.other),
        ..t.ws("c")
    };
    assert!(!same_reach_scope(&a, &c, ReachMode::Project));
    let d = ScopeWorkspace {
        project: None,
        ..t.ws("d")
    };
    let e = ScopeWorkspace {
        project: None,
        ..t.ws("e")
    };
    assert!(!same_reach_scope(&d, &e, ReachMode::Project));
}

#[test]
fn project_a_sandboxed_caller_or_target_or_a_different_sandbox_is_never_shared() {
    let t = Tree::new();
    let a = t.ws("a");
    let b = ScopeWorkspace {
        project: t.key(&t.terminal_workers),
        ..t.ws("b")
    };
    let sandboxed_ws = |id: &str| ScopeWorkspace {
        sandbox: sandboxed(),
        ..t.ws(id)
    };
    assert!(!same_reach_scope(
        &sandboxed_ws("s"),
        &b,
        ReachMode::Project
    ));
    assert!(!same_reach_scope(
        &a,
        &sandboxed_ws("s"),
        ReachMode::Project
    ));
    assert!(!same_reach_scope(
        &sandboxed_ws("s1"),
        &sandboxed_ws("s2"),
        ReachMode::Project
    ));
}

#[test]
fn a_scratch_or_manager_workspace_is_never_shared_in_any_mode() {
    let t = Tree::new();
    for mode in [ReachMode::Project, ReachMode::Group] {
        let scratch = ScopeWorkspace {
            shareable: false,
            group: group("g1", false),
            ..t.ws("scratch")
        };
        let member = ScopeWorkspace {
            group: group("g1", false),
            ..t.ws("a")
        };
        assert!(!same_reach_scope(&member, &scratch, mode), "{mode:?}");
        assert!(!same_reach_scope(&scratch, &member, mode), "{mode:?}");
    }
}

#[test]
fn group_workspaces_the_human_put_in_one_group_are_one_scope_whatever_their_project() {
    let t = Tree::new();
    let caller = ScopeWorkspace {
        group: group("g1", false),
        ..t.ws("a")
    };
    let target = ScopeWorkspace {
        group: group("g1", false),
        project: t.key(&t.other),
        ..t.ws("c")
    };
    assert!(same_reach_scope(&caller, &target, ReachMode::Group));
    let elsewhere = ScopeWorkspace {
        group: group("g2", false),
        ..t.ws("d")
    };
    assert!(!same_reach_scope(&caller, &elsewhere, ReachMode::Group));
    assert!(!same_reach_scope(&caller, &t.ws("e"), ReachMode::Group));
}

#[test]
fn group_a_membership_an_agent_made_gives_no_reach_until_it_is_confirmed() {
    let t = Tree::new();
    let caller = ScopeWorkspace {
        group: group("g1", false),
        ..t.ws("a")
    };
    let target = ScopeWorkspace {
        group: group("g1", true),
        ..t.ws("c")
    };
    assert!(!same_reach_scope(&caller, &target, ReachMode::Group));
    assert!(!same_reach_scope(&target, &caller, ReachMode::Group));
    assert_eq!(
        unconfirmed_members(&caller, &target, ReachMode::Group),
        vec!["c".to_owned()]
    );
    assert_eq!(
        unconfirmed_members(&caller, &target, ReachMode::Project),
        Vec::<String>::new()
    );
}

#[test]
fn project_a_workspace_whose_folder_an_agent_set_is_not_shared_until_it_is_confirmed() {
    let t = Tree::new();
    let a = t.ws("a");
    let moved = ScopeWorkspace {
        folder_by_agent: true,
        ..t.ws("m")
    };
    assert!(!same_reach_scope(&a, &moved, ReachMode::Project));
    assert!(!same_reach_scope(&moved, &a, ReachMode::Project));
    assert_eq!(
        unconfirmed_members(&a, &moved, ReachMode::Project),
        vec!["m".to_owned()]
    );
    let nowhere = ScopeWorkspace {
        folder_by_agent: true,
        project: None,
        ..t.ws("x")
    };
    assert_eq!(
        unconfirmed_members(&a, &nowhere, ReachMode::Project),
        Vec::<String>::new()
    );
    assert!(same_reach_scope(&moved, &moved, ReachMode::Project));
}

#[test]
fn group_nothing_to_confirm_when_the_pair_could_not_share_a_scope_anyway() {
    let t = Tree::new();
    let caller = ScopeWorkspace {
        group: group("g1", false),
        ..t.ws("a")
    };
    let sandboxed_target = ScopeWorkspace {
        group: group("g1", true),
        sandbox: sandboxed(),
        ..t.ws("c")
    };
    assert_eq!(
        unconfirmed_members(&caller, &sandboxed_target, ReachMode::Group),
        Vec::<String>::new()
    );
}

#[test]
fn counts_a_membership_as_the_agents_until_the_human_confirms_it_or_moves_the_workspace() {
    let p = AgentProvenance::new();
    p.set_by_agent("w1", "g1");
    assert!(p.by_agent("w1", "g1"));
    assert!(!p.by_agent("w1", "g2"));
    p.confirm("w1");
    assert!(!p.by_agent("w1", "g1"));
}

#[test]
fn an_empty_id_is_never_in_scope_not_even_with_itself() {
    let t = Tree::new();
    let blank = t.ws("");
    let named = t.ws("a");
    for mode in [ReachMode::Workspace, ReachMode::Project, ReachMode::Group] {
        assert!(!same_reach_scope(&blank, &blank, mode), "{mode:?}");
        assert!(!same_reach_scope(&named, &blank, mode), "{mode:?}");
        assert!(!same_reach_scope(&blank, &named, mode), "{mode:?}");
    }
}

#[test]
fn forgets_a_workspace_and_lists_what_the_agent_placed() {
    let p = AgentProvenance::new();
    p.set_by_agent("w1", "g1");
    p.set_by_agent("w2", "g2");
    p.set_by_agent("w1", "g3");
    let mut entries = p.entries();
    entries.sort();
    assert_eq!(
        entries,
        vec![
            ("w1".to_owned(), "g3".to_owned()),
            ("w2".to_owned(), "g2".to_owned())
        ]
    );
    p.forget("w1");
    assert!(!p.by_agent("w1", "g3"));
    assert!(p.by_agent("w2", "g2"));
    p.forget("missing");
    assert_eq!(p.entries().len(), 1);
}

#[test]
fn a_fifo_named_dot_git_does_not_block_the_project_key() {
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    let t = Tree::new();
    let dir = t.home.join("fifo-project");
    fs::create_dir_all(&dir).unwrap();
    let made = Command::new("mkfifo")
        .arg(dir.join(".git"))
        .status()
        .unwrap();
    assert!(made.success());
    let (sender, receiver) = mpsc::channel();
    let home = t.home.clone();
    let work_dir = dir.to_str().unwrap().to_owned();
    std::thread::spawn(move || {
        let _ = sender.send(project_key(&work_dir, &home));
    });
    let key = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(key, Some(format!("dir:{}", dir.to_string_lossy())));
}

#[test]
fn ignores_a_git_file_that_points_at_another_repository_without_a_link_back() {
    let t = Tree::new();
    let victim_git = t.terminal.join(".git");
    let forged_plain = t.home.join("forged-plain");
    let forged_worktree = t.home.join("forged-worktree");
    fs::create_dir_all(&forged_plain).unwrap();
    fs::create_dir_all(&forged_worktree).unwrap();
    fs::write(
        forged_plain.join(".git"),
        format!("gitdir: {}\n", victim_git.display()),
    )
    .unwrap();
    let victim_tree = victim_git.join("worktrees").join("terminal-workers");
    fs::write(
        forged_worktree.join(".git"),
        format!("gitdir: {}\n", victim_tree.display()),
    )
    .unwrap();
    for dir in [&forged_plain, &forged_worktree] {
        assert_eq!(t.key(dir), Some(format!("dir:{}", dir.display())));
    }
}

#[test]
fn keeps_the_git_dir_of_a_checkout_that_names_its_work_tree_in_its_config() {
    let t = Tree::new();
    let dir = t.home.join("separate");
    let git_dir = t.home.join("separate-git");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&git_dir).unwrap();
    fs::write(dir.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
    fs::write(
        git_dir.join("config"),
        format!("[core]\n\tworktree = {}\n", dir.display()),
    )
    .unwrap();
    assert_eq!(t.key(&dir), Some(format!("git:{}", git_dir.display())));
}
