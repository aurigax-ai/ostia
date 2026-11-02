#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use ostia_git::git::{ChangeArea, FileChange};
use ostia_git::repo::{
    blame, commit, diff_sides, discard, line_changes, read_status, stage, unified_patch, unstage,
    worktree_key,
};
use support::{Sandbox, commit_all, git, git_inert, host, init_repo, link, write};

struct Armed {
    sandbox: Sandbox,
    repo: std::path::PathBuf,
}

fn armed() -> Armed {
    let sandbox = Sandbox::new("ostia-git-hardening-");
    let repo = sandbox.path("repo");
    let hooks = sandbox.dir("hooks");
    init_repo(&repo);
    write(repo.join("a.txt"), "one\n");
    write(repo.join("blob.evil"), "data\n");
    write(
        repo.join(".gitattributes"),
        "*.evil diff=evil filter=evil\n",
    );
    write(repo.join("info.cfg"), "data\n");
    commit_all(&repo, "first");
    for hook in ["pre-commit", "post-checkout"] {
        let path = hooks.join(hook);
        write(
            &path,
            &format!(
                "#!/bin/sh\ntouch \"{}\"\n",
                sandbox.marks.join(hook).display()
            ),
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &repo,
        &["config", "core.fsmonitor", &sandbox.program("fsmonitor")],
    );
    git(
        &repo,
        &["config", "filter.evil.clean", &sandbox.program("clean")],
    );
    git(
        &repo,
        &["config", "filter.evil.smudge", &sandbox.program("smudge")],
    );
    git(
        &repo,
        &[
            "config",
            "filter.viainfo.clean",
            &sandbox.program("infoclean"),
        ],
    );
    write(
        repo.join(".git").join("info").join("attributes"),
        "info.cfg filter=viainfo\n",
    );
    git(
        &repo,
        &["config", "diff.evil.textconv", &sandbox.program("textconv")],
    );
    git(
        &repo,
        &["config", "diff.external", &sandbox.program("external")],
    );
    git(
        &repo,
        &["config", "core.hooksPath", &hooks.to_string_lossy()],
    );
    write(repo.join("a.txt"), "two\n");
    write(repo.join("blob.evil"), "changed\n");
    write(repo.join("info.cfg"), "changed\n");
    Armed { sandbox, repo }
}

fn only(changes: Vec<FileChange>, path: &str) -> FileChange {
    let mut matching: Vec<FileChange> = changes.into_iter().filter(|c| c.path == path).collect();
    assert!(!matching.is_empty(), "no change for {path}");
    matching.remove(0)
}

#[tokio::test]
async fn never_runs_core_fsmonitor_for_a_status_a_key_or_a_line_count() {
    let a = armed();
    let host = host();
    read_status(&host, &a.repo).await.unwrap();
    worktree_key(&host, &a.repo).await;
    line_changes(&host, &a.repo, &[]).await;
    assert!(!a.sandbox.marked("fsmonitor"));
}

#[tokio::test]
async fn never_runs_a_clean_or_smudge_filter_named_by_the_repository_config_from_gitattributes_or_git_info_attributes()
 {
    let a = armed();
    let host = host();
    read_status(&host, &a.repo).await.unwrap();
    line_changes(&host, &a.repo, &[]).await;
    assert!(!a.sandbox.marked("clean"));
    assert!(!a.sandbox.marked("infoclean"));
    assert!(!a.sandbox.marked("smudge"));
}

#[tokio::test]
async fn never_runs_a_textconv_or_external_diff_driver_for_a_patch_a_line_count_or_a_blame() {
    let a = armed();
    let host = host();
    let change = only(
        read_status(&host, &a.repo).await.unwrap().changes,
        "blob.evil",
    );
    unified_patch(&host, &a.repo, &change).await.ok();
    line_changes(&host, &a.repo, &[]).await;
    blame(&host, &a.repo, "blob.evil").await.ok();
    assert!(!a.sandbox.marked("textconv"));
    assert!(!a.sandbox.marked("external"));
}

#[tokio::test]
async fn does_not_run_a_repository_hook_when_the_panel_discards_a_change() {
    let a = armed();
    let host = host();
    let change = only(read_status(&host, &a.repo).await.unwrap().changes, "a.txt");
    discard(&host, &a.repo, &[change]).await.unwrap();
    assert!(!a.sandbox.marked("post-checkout"));
}

#[tokio::test]
async fn still_runs_the_humans_own_pre_commit_hook_when_the_panel_commits() {
    let a = armed();
    let host = host();
    write(a.repo.join("c.txt"), "c\n");
    git(&a.repo, &["add", "c.txt"]);
    a.sandbox.clear_mark("fsmonitor");
    commit(&host, &a.repo, "from the panel").await.unwrap();
    assert!(a.sandbox.marked("pre-commit"));
    assert!(!a.sandbox.marked("fsmonitor"));
}

struct Nested {
    sandbox: Sandbox,
    outer: std::path::PathBuf,
    sub_git: std::path::PathBuf,
}

fn nested() -> Nested {
    let sandbox = Sandbox::new("ostia-git-hardening-");
    let outer = sandbox.path("outer");
    let inner = sandbox.path("inner");
    init_repo(&inner);
    write(inner.join("s.evil"), "one\n");
    write(inner.join("p.proc"), "one\n");
    write(
        inner.join(".gitattributes"),
        "*.evil filter=sub\n*.proc filter=subp\n",
    );
    commit_all(&inner, "inner");
    init_repo(&outer);
    git(
        &outer,
        &["submodule", "add", "-q", &inner.to_string_lossy(), "sub"],
    );
    git(&outer, &["commit", "-q", "-m", "outer"]);
    let sub_git = outer.join("sub");
    git(
        &sub_git,
        &["config", "filter.sub.clean", &sandbox.program("subclean")],
    );
    git(
        &sub_git,
        &[
            "config",
            "filter.subp.process",
            &sandbox.program("subprocess"),
        ],
    );
    git(
        &sub_git,
        &["config", "core.fsmonitor", &sandbox.program("subfsmonitor")],
    );
    write(sub_git.join("s.evil"), "two\n");
    write(sub_git.join("p.proc"), "two\n");
    Nested {
        sandbox,
        outer,
        sub_git,
    }
}

fn no_marks(n: &Nested) {
    for name in ["subclean", "subprocess", "subfsmonitor"] {
        assert!(!n.sandbox.marked(name), "{name} ran");
    }
}

#[tokio::test]
async fn runs_no_program_of_the_submodule_for_a_status_a_line_count_or_a_patch() {
    let n = nested();
    let host = host();
    let status = read_status(&host, &n.outer).await.unwrap();
    line_changes(&host, &n.outer, &[]).await;
    for change in &status.changes {
        unified_patch(&host, &n.outer, change).await.ok();
    }
    no_marks(&n);
}

#[tokio::test]
async fn lists_what_changed_inside_the_submodule_under_its_path() {
    let n = nested();
    let host = host();
    let status = read_status(&host, &n.outer).await.unwrap();
    let mut listed: Vec<String> = status
        .changes
        .iter()
        .map(|c| {
            let area = match c.area {
                ChangeArea::Staged => "staged",
                ChangeArea::Unstaged => "unstaged",
                ChangeArea::Untracked => "untracked",
                ChangeArea::Conflicted => "conflicted",
            };
            format!("{area}:{}", c.path)
        })
        .collect();
    listed.sort();
    assert_eq!(listed, ["unstaged:sub/p.proc", "unstaged:sub/s.evil"]);
    no_marks(&n);
}

#[tokio::test]
async fn diffs_stages_unstages_and_discards_a_path_inside_the_submodule_in_the_submodule() {
    let n = nested();
    let host = host();
    let change = only(
        read_status(&host, &n.outer).await.unwrap().changes,
        "sub/s.evil",
    );
    let sides = diff_sides(&host, &n.outer, &change).await.unwrap();
    assert_eq!(sides.original, "one\n");
    assert_eq!(sides.modified, "two\n");
    assert!(
        unified_patch(&host, &n.outer, &change)
            .await
            .unwrap()
            .contains("+two")
    );
    stage(&host, &n.outer, &["sub/s.evil"]).await.unwrap();
    assert_eq!(
        git_inert(&n.sub_git, &["diff", "--cached", "--name-only"]),
        "s.evil\n"
    );
    unstage(&host, &n.outer, &["sub/s.evil"], true)
        .await
        .unwrap();
    assert_eq!(
        git_inert(&n.sub_git, &["diff", "--cached", "--name-only"]),
        ""
    );
    discard(&host, &n.outer, &[change]).await.unwrap();
    assert_eq!(git_inert(&n.sub_git, &["show", ":s.evil"]), "one\n");
    no_marks(&n);
}

#[tokio::test]
async fn does_not_follow_a_submodule_path_that_leads_outside_the_repository() {
    let sandbox = Sandbox::new("ostia-git-hardening-");
    let other = sandbox.path("other");
    init_repo(&other);
    write(other.join("secret.txt"), "x\n");
    let outside = sandbox.path("outside-link");
    init_repo(&outside);
    let sha = {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("git")
            .args(["hash-object", "-t", "blob", "--stdin"])
            .current_dir(&outside)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"x").unwrap();
        String::from_utf8(child.wait_with_output().unwrap().stdout)
            .unwrap()
            .trim()
            .to_owned()
    };
    git(
        &outside,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{sha},link"),
        ],
    );
    link(&other, outside.join("link"));
    let status = read_status(&host(), &outside).await.unwrap();
    assert!(!status.changes.iter().any(|c| c.path.contains("secret.txt")));
}

struct Extra {
    sandbox: Sandbox,
    owner: std::path::PathBuf,
    sub_dir: std::path::PathBuf,
}

fn extra() -> Extra {
    let sandbox = Sandbox::new("ostia-git-hardening-");
    let base = sandbox.dir("extra");
    let owner = base.join("owner");
    let sub_source = base.join("subsource");
    init_repo(&sub_source);
    write(sub_source.join("f.txt"), "one\n");
    commit_all(&sub_source, "one");
    init_repo(&owner);
    git_inert(
        &owner,
        &[
            "submodule",
            "add",
            "-q",
            &sub_source.to_string_lossy(),
            "sub",
        ],
    );
    git_inert(&owner, &["commit", "-q", "-m", "owner"]);
    let sub_dir = owner.join("sub");
    write(sub_dir.join("f.txt"), "two\n");
    git_inert(&sub_dir, &["commit", "-q", "-a", "-m", "two"]);
    git_inert(
        &sub_dir,
        &["config", "diff.external", &sandbox.program("subexternal")],
    );
    git_inert(
        &sub_dir,
        &["config", "core.pager", &sandbox.program("subpager")],
    );
    git_inert(&owner, &["config", "diff.submodule", "diff"]);
    git_inert(&owner, &["config", "submodule.recurse", "true"]);
    Extra {
        sandbox,
        owner,
        sub_dir,
    }
}

#[tokio::test]
async fn does_not_open_a_submodule_diff_when_the_repository_asks_for_one() {
    let e = extra();
    let host = host();
    let status = read_status(&host, &e.owner).await.unwrap();
    for change in status.changes.iter().filter(|c| c.path == "sub") {
        unified_patch(&host, &e.owner, change).await.ok();
    }
    line_changes(&host, &e.owner, &[]).await;
    assert!(!e.sandbox.marked("subexternal"));
}

#[tokio::test]
async fn does_not_recurse_into_submodules_when_the_repository_asks_for_it() {
    let e = extra();
    let host = host();
    let before = git_inert(&e.sub_dir, &["rev-parse", "HEAD"]);
    write(e.owner.join("x.txt"), "x\n");
    stage(&host, &e.owner, &["x.txt"]).await.unwrap();
    unstage(&host, &e.owner, &["x.txt"], true).await.unwrap();
    discard(
        &host,
        &e.owner,
        &[FileChange {
            path: "sub".to_owned(),
            orig_path: None,
            area: ChangeArea::Unstaged,
            code: "M".to_owned(),
        }],
    )
    .await
    .unwrap();
    let after = git_inert(&e.sub_dir, &["rev-parse", "HEAD"]);
    assert_eq!(after, before);
}

#[tokio::test]
async fn never_fetches_from_a_promisor_remote_to_find_a_missing_object() {
    let sandbox = Sandbox::new("ostia-git-hardening-");
    let lazy = sandbox.dir("extra").join("lazy");
    init_repo(&lazy);
    write(lazy.join("a.txt"), "content\n");
    commit_all(&lazy, "a");
    let sha = git_inert(&lazy, &["rev-parse", ":a.txt"]).trim().to_owned();
    git_inert(&lazy, &["config", "extensions.partialClone", "origin"]);
    git_inert(&lazy, &["config", "remote.origin.promisor", "true"]);
    git_inert(
        &lazy,
        &["config", "remote.origin.url", "ssh://example.invalid/repo"],
    );
    git_inert(
        &lazy,
        &["config", "core.sshCommand", &sandbox.program("lazyssh")],
    );
    let object = Path::new(&lazy)
        .join(".git")
        .join("objects")
        .join(&sha[..2])
        .join(&sha[2..]);
    let _ = fs::remove_file(object);
    write(lazy.join("a.txt"), "changed\n");
    let host = host();
    let changes = read_status(&host, &lazy).await.unwrap().changes;
    let change = changes.first().unwrap();
    let _ = diff_sides(&host, &lazy, change).await;
    let _ = unified_patch(&host, &lazy, change).await;
    assert!(!sandbox.marked("lazyssh"));
}
