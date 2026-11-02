#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::path::PathBuf;

use ostia_git::git::{ChangeArea, FileChange};
use ostia_git::repo::{
    MAX_SIDE_BYTES, RepoErrorCode, blame, branch_refs, commit, commit_detail, commit_sides,
    diff_sides, discard, graph_log, line_changes, log, pick_change, read_status, repo_relative,
    repo_root, run_ok, stage, unified_patch, unstage, worktree_key,
};
use support::{Sandbox, commit_all, git, host, init_repo, link, write};

fn repo_with(files: &[(&str, &str)]) -> (Sandbox, PathBuf) {
    let sandbox = Sandbox::new("ostia-git-repo-");
    let repo = sandbox.path("repo");
    init_repo(&repo);
    for (name, text) in files {
        let file = repo.join(name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        write(&file, text);
    }
    commit_all(&repo, "first");
    (sandbox, repo)
}

fn change(path: &str, area: ChangeArea, code: &str) -> FileChange {
    FileChange {
        path: path.to_owned(),
        orig_path: None,
        area,
        code: code.to_owned(),
    }
}

fn renamed(path: &str, orig: &str, area: ChangeArea) -> FileChange {
    FileChange {
        path: path.to_owned(),
        orig_path: Some(orig.to_owned()),
        area,
        code: "R".to_owned(),
    }
}

#[tokio::test]
async fn repo_root_is_the_top_of_the_repository_and_none_outside_one() {
    let (sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let inner = sandbox.dir("repo/src");
    let plain = sandbox.dir("plain");
    let host = host();
    assert_eq!(
        repo_root(&host, &inner).await,
        Some(repo.to_string_lossy().into_owned())
    );
    assert_eq!(repo_root(&host, &plain).await, None);
}

#[tokio::test]
async fn worktree_key_is_none_outside_a_repository() {
    let sandbox = Sandbox::new("ostia-git-repo-");
    let plain = sandbox.dir("plain");
    assert_eq!(worktree_key(&host(), &plain).await, None);
}

#[tokio::test]
async fn run_ok_reports_git_stderr_as_a_git_failed_error() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let err = run_ok(
        &host(),
        &repo,
        &["rev-parse", "--verify", "nope^{commit}"],
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, RepoErrorCode::GitFailed);
    assert!(!err.message.is_empty());
}

#[tokio::test]
async fn read_status_reports_the_branch_and_each_change_area() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    write(repo.join("b.txt"), "two\n");
    git(&repo, &["add", "b.txt"]);
    write(repo.join("c.txt"), "new\n");
    let status = read_status(&host(), &repo).await.unwrap();
    assert_eq!(status.branch.head.as_deref(), Some("main"));
    let mut seen: Vec<(String, ChangeArea)> = status
        .changes
        .iter()
        .map(|c| (c.path.clone(), c.area))
        .collect();
    seen.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        seen,
        [
            ("a.txt".to_owned(), ChangeArea::Unstaged),
            ("b.txt".to_owned(), ChangeArea::Staged),
            ("c.txt".to_owned(), ChangeArea::Untracked),
        ]
    );
}

#[tokio::test]
async fn diff_sides_reads_the_staged_unstaged_and_untracked_sides() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    write(repo.join("b.txt"), "staged\n");
    git(&repo, &["add", "b.txt"]);
    write(repo.join("b.txt"), "worktree\n");
    write(repo.join("c.txt"), "new\n");
    let host = host();
    let unstaged = diff_sides(&host, &repo, &change("a.txt", ChangeArea::Unstaged, "M"))
        .await
        .unwrap();
    assert_eq!(
        (unstaged.original.as_str(), unstaged.modified.as_str()),
        ("one\n", "two\n")
    );
    let staged = diff_sides(&host, &repo, &change("b.txt", ChangeArea::Staged, "M"))
        .await
        .unwrap();
    assert_eq!(
        (staged.original.as_str(), staged.modified.as_str()),
        ("one\n", "staged\n")
    );
    let both = diff_sides(&host, &repo, &change("b.txt", ChangeArea::Unstaged, "M"))
        .await
        .unwrap();
    assert_eq!(
        (both.original.as_str(), both.modified.as_str()),
        ("staged\n", "worktree\n")
    );
    let untracked = diff_sides(&host, &repo, &change("c.txt", ChangeArea::Untracked, "?"))
        .await
        .unwrap();
    assert_eq!(
        (untracked.original.as_str(), untracked.modified.as_str()),
        ("", "new\n")
    );
}

#[tokio::test]
async fn diff_sides_gives_an_empty_modified_side_for_a_deleted_file() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    fs::remove_file(repo.join("a.txt")).unwrap();
    let host = host();
    let unstaged = diff_sides(&host, &repo, &change("a.txt", ChangeArea::Unstaged, "D"))
        .await
        .unwrap();
    assert_eq!(
        (unstaged.original.as_str(), unstaged.modified.as_str()),
        ("one\n", "")
    );
    git(&repo, &["add", "a.txt"]);
    let staged = diff_sides(&host, &repo, &change("a.txt", ChangeArea::Staged, "D"))
        .await
        .unwrap();
    assert_eq!(
        (staged.original.as_str(), staged.modified.as_str()),
        ("one\n", "")
    );
}

#[tokio::test]
async fn diff_sides_reads_the_head_side_from_the_original_path_of_a_rename() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    git(&repo, &["mv", "a.txt", "b.txt"]);
    let sides = diff_sides(
        &host(),
        &repo,
        &renamed("b.txt", "a.txt", ChangeArea::Staged),
    )
    .await
    .unwrap();
    assert_eq!(
        (sides.original.as_str(), sides.modified.as_str()),
        ("one\n", "one\n")
    );
}

#[tokio::test]
async fn diff_sides_gives_the_head_and_working_sides_of_a_conflicted_file() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "base\n")]);
    git(&repo, &["checkout", "-q", "-b", "other"]);
    write(repo.join("a.txt"), "other\n");
    git(&repo, &["commit", "-q", "-a", "-m", "other"]);
    git(&repo, &["checkout", "-q", "main"]);
    write(repo.join("a.txt"), "main\n");
    git(&repo, &["commit", "-q", "-a", "-m", "main"]);
    let merge = std::process::Command::new("git")
        .args(["merge", "other"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(!merge.status.success());
    let sides = diff_sides(
        &host(),
        &repo,
        &change("a.txt", ChangeArea::Conflicted, "UU"),
    )
    .await
    .unwrap();
    assert_eq!(sides.original, "main\n");
    assert!(sides.modified.contains("<<<<<<<"));
}

#[tokio::test]
async fn diff_sides_gives_the_link_target_for_a_symlink() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    link("a.txt", repo.join("l"));
    let sides = diff_sides(&host(), &repo, &change("l", ChangeArea::Untracked, "?"))
        .await
        .unwrap();
    assert_eq!(sides.modified, "a.txt");
}

#[tokio::test]
async fn diff_sides_refuses_a_binary_file() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    fs::write(repo.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
    let err = diff_sides(
        &host(),
        &repo,
        &change("bin.dat", ChangeArea::Untracked, "?"),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, RepoErrorCode::Binary);
    assert_eq!(err.message, "binary file");
}

#[tokio::test]
async fn diff_sides_refuses_a_file_over_the_side_limit() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    fs::write(repo.join("big.txt"), vec![b'a'; MAX_SIDE_BYTES + 1]).unwrap();
    let err = diff_sides(
        &host(),
        &repo,
        &change("big.txt", ChangeArea::Untracked, "?"),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, RepoErrorCode::TooLarge);
    assert_eq!(err.message, "file is too large to diff");
}

#[tokio::test]
async fn diff_sides_gives_an_empty_side_for_a_file_that_is_gone() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let sides = diff_sides(
        &host(),
        &repo,
        &change("missing.txt", ChangeArea::Untracked, "?"),
    )
    .await
    .unwrap();
    assert_eq!((sides.original.as_str(), sides.modified.as_str()), ("", ""));
}

#[tokio::test]
async fn unified_patch_diffs_an_untracked_file_against_nothing() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("c.txt"), "new\n");
    let patch = unified_patch(&host(), &repo, &change("c.txt", ChangeArea::Untracked, "?"))
        .await
        .unwrap();
    assert!(patch.contains("+new"));
}

#[tokio::test]
async fn unified_patch_reads_the_index_for_a_staged_change_and_the_worktree_for_an_unstaged_one() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    git(&repo, &["add", "a.txt"]);
    write(repo.join("a.txt"), "three\n");
    let host = host();
    let staged = unified_patch(&host, &repo, &change("a.txt", ChangeArea::Staged, "M"))
        .await
        .unwrap();
    assert!(staged.contains("+two") && !staged.contains("+three"));
    let unstaged = unified_patch(&host, &repo, &change("a.txt", ChangeArea::Unstaged, "M"))
        .await
        .unwrap();
    assert!(unstaged.contains("+three") && unstaged.contains("-two"));
}

#[tokio::test]
async fn repo_relative_gives_a_slash_path_inside_the_repository() {
    let (_sandbox, repo) = repo_with(&[("src/a.txt", "one\n")]);
    let src = repo.join("src");
    assert_eq!(
        repo_relative(&repo, &src, "a.txt").await.unwrap(),
        "src/a.txt"
    );
    let absolute = repo.join("src").join("a.txt");
    assert_eq!(
        repo_relative(&repo, &repo, &absolute.to_string_lossy())
            .await
            .unwrap(),
        "src/a.txt"
    );
}

#[tokio::test]
async fn repo_relative_refuses_a_path_outside_the_repository() {
    let (sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let outside = sandbox.path("elsewhere.txt");
    write(&outside, "x\n");
    let err = repo_relative(&repo, &repo, "../elsewhere.txt")
        .await
        .unwrap_err();
    assert_eq!(err.code, RepoErrorCode::NotChanged);
    assert_eq!(err.message, "../elsewhere.txt is outside the repository");
    let err = repo_relative(&repo, &repo, &outside.to_string_lossy())
        .await
        .unwrap_err();
    assert_eq!(err.code, RepoErrorCode::NotChanged);
}

#[tokio::test]
async fn repo_relative_follows_a_symlink_out_of_the_repository_and_refuses_it() {
    let (sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let target = sandbox.dir("target");
    link(&target, repo.join("escape"));
    let err = repo_relative(&repo, &repo, "escape").await.unwrap_err();
    assert_eq!(err.code, RepoErrorCode::NotChanged);
}

#[tokio::test]
async fn line_changes_counts_tracked_and_untracked_lines() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "one\ntwo\n");
    write(repo.join("c.txt"), "x\ny\nz\n");
    let counted = line_changes(&host(), &repo, &["c.txt"]).await.unwrap();
    assert_eq!((counted.files, counted.added, counted.removed), (2, 4, 0));
}

#[tokio::test]
async fn line_changes_skips_an_untracked_file_that_is_binary_or_over_the_limit() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    fs::write(repo.join("bin.dat"), [0u8, 1, 2]).unwrap();
    fs::write(repo.join("big.txt"), vec![b'a'; MAX_SIDE_BYTES + 1]).unwrap();
    let counted = line_changes(&host(), &repo, &["bin.dat", "big.txt"])
        .await
        .unwrap();
    assert_eq!((counted.files, counted.added, counted.removed), (2, 0, 0));
}

#[tokio::test]
async fn line_changes_counts_only_the_first_five_hundred_untracked_files() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let names: Vec<String> = (0..501).map(|i| format!("u{i:03}.txt")).collect();
    for name in &names {
        write(repo.join(name), "x\n");
    }
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let counted = line_changes(&host(), &repo, &refs).await.unwrap();
    assert_eq!((counted.files, counted.added), (501, 500));
}

#[tokio::test]
async fn line_changes_is_none_when_there_is_no_commit_and_nothing_untracked() {
    let sandbox = Sandbox::new("ostia-git-repo-");
    let repo = sandbox.path("repo");
    init_repo(&repo);
    assert!(line_changes(&host(), &repo, &[]).await.is_none());
}

#[tokio::test]
async fn stage_with_no_paths_stages_everything() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    write(repo.join("c.txt"), "new\n");
    stage(&host(), &repo, &[]).await.unwrap();
    assert_eq!(
        git(&repo, &["diff", "--cached", "--name-only"]),
        "a.txt\nc.txt\n"
    );
}

#[tokio::test]
async fn stage_reads_a_path_as_a_literal_not_a_glob() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("*.txt"), "star\n");
    write(repo.join("a.txt"), "two\n");
    stage(&host(), &repo, &["*.txt"]).await.unwrap();
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "*.txt\n");
}

#[tokio::test]
async fn unstage_resets_to_head_and_without_a_head_removes_from_the_index() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let host = host();
    write(repo.join("a.txt"), "two\n");
    git(&repo, &["add", "a.txt"]);
    unstage(&host, &repo, &["a.txt"], true).await.unwrap();
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "");
    let sandbox = Sandbox::new("ostia-git-repo-");
    let fresh = sandbox.path("fresh");
    init_repo(&fresh);
    write(fresh.join("n.txt"), "n\n");
    git(&fresh, &["add", "n.txt"]);
    unstage(&host, &fresh, &[], false).await.unwrap();
    assert_eq!(git(&fresh, &["ls-files"]), "");
}

#[tokio::test]
async fn discard_restores_a_tracked_file_and_removes_an_untracked_one() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    write(repo.join("c.txt"), "new\n");
    discard(
        &host(),
        &repo,
        &[
            change("a.txt", ChangeArea::Unstaged, "M"),
            change("c.txt", ChangeArea::Untracked, "?"),
            change("ignored.txt", ChangeArea::Staged, "A"),
        ],
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "one\n");
    assert!(!repo.join("c.txt").exists());
}

#[tokio::test]
async fn commit_returns_the_new_sha() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    git(&repo, &["add", "a.txt"]);
    let sha = commit(&host(), &repo, "second").await.unwrap();
    assert_eq!(sha, git(&repo, &["rev-parse", "HEAD"]).trim());
}

#[tokio::test]
async fn commit_fails_with_git_failed_when_nothing_is_staged() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let err = commit(&host(), &repo, "empty").await.unwrap_err();
    assert_eq!(err.code, RepoErrorCode::GitFailed);
    assert!(!err.message.is_empty());
}

#[tokio::test]
async fn log_is_empty_in_a_folder_that_is_not_a_repository() {
    let sandbox = Sandbox::new("ostia-git-repo-");
    let plain = sandbox.dir("plain");
    assert!(log(&host(), &plain, 5).await.is_empty());
}

#[tokio::test]
async fn log_gives_newest_first_up_to_the_limit() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    git(&repo, &["commit", "-q", "-a", "-m", "second"]);
    let host = host();
    let subjects: Vec<String> = log(&host, &repo, 5)
        .await
        .into_iter()
        .map(|c| c.subject)
        .collect();
    assert_eq!(subjects, ["second", "first"]);
    assert_eq!(log(&host, &repo, 1).await.len(), 1);
}

#[tokio::test]
async fn branch_refs_lists_the_current_branch_first() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    git(&repo, &["branch", "alpha"]);
    let refs = branch_refs(&host(), &repo, Some("main")).await.unwrap();
    let names: Vec<(&str, bool)> = refs.iter().map(|r| (r.name.as_str(), r.current)).collect();
    assert_eq!(names, [("main", true), ("alpha", false)]);
}

#[tokio::test]
async fn graph_log_lists_commits_with_parents_and_refs() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "two\n");
    git(&repo, &["commit", "-q", "-a", "-m", "second"]);
    let commits = graph_log(&host(), &repo, &[], 10).await.unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].parents, [commits[1].sha.clone()]);
    assert!(commits[1].parents.is_empty());
}

#[tokio::test]
async fn commit_detail_refuses_a_value_that_is_not_a_commit_id() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    for input in ["xyz", "abc", "HEAD", "--all", "ABCDEF12", &"a".repeat(65)] {
        let err = commit_detail(&host(), &repo, input).await.unwrap_err();
        assert_eq!(err.code, RepoErrorCode::InvalidArgs, "{input}");
        assert_eq!(
            err.message,
            format!("{input} is not a commit id"),
            "{input}"
        );
    }
}

#[tokio::test]
async fn commit_detail_refuses_a_commit_id_that_does_not_exist() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let err = commit_detail(&host(), &repo, "deadbeef").await.unwrap_err();
    assert_eq!(err.code, RepoErrorCode::UnknownCommit);
    assert_eq!(err.message, "no commit deadbeef");
}

#[tokio::test]
async fn commit_detail_of_the_first_commit_has_no_parent_and_lists_its_files() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n"), ("b.txt", "two\n")]);
    let sha = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let detail = commit_detail(&host(), &repo, &sha).await.unwrap();
    assert_eq!(detail.parent, None);
    assert_eq!(detail.commit.sha, sha);
    assert_eq!(detail.commit.subject, "first");
    let mut files: Vec<(&str, &str)> = detail
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.code.as_str()))
        .collect();
    files.sort();
    assert_eq!(files, [("a.txt", "A"), ("b.txt", "A")]);
}

#[tokio::test]
async fn commit_detail_lists_the_files_against_the_first_parent_with_renames() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\nline\nmore\n"), ("b.txt", "keep\n")]);
    let first = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    git(&repo, &["mv", "a.txt", "c.txt"]);
    fs::remove_file(repo.join("b.txt")).unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "second"]);
    let sha = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let detail = commit_detail(&host(), &repo, &sha).await.unwrap();
    assert_eq!(detail.parent.as_deref(), Some(first.as_str()));
    let rename = detail.files.iter().find(|f| f.path == "c.txt").unwrap();
    assert_eq!(rename.orig_path.as_deref(), Some("a.txt"));
    assert_eq!(rename.code, "R");
    let removed = detail.files.iter().find(|f| f.path == "b.txt").unwrap();
    assert_eq!(removed.code, "D");
}

#[tokio::test]
async fn commit_sides_reads_the_parent_and_commit_versions_of_a_file() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n"), ("b.txt", "gone\n")]);
    write(repo.join("a.txt"), "two\n");
    write(repo.join("n.txt"), "new\n");
    fs::remove_file(repo.join("b.txt")).unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "second"]);
    let sha = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let host = host();
    let detail = commit_detail(&host, &repo, &sha).await.unwrap();
    let pick = |path: &str| {
        detail
            .files
            .iter()
            .find(|f| f.path == path)
            .unwrap()
            .clone()
    };
    let modified = commit_sides(&host, &repo, &detail, &pick("a.txt"))
        .await
        .unwrap();
    assert_eq!(
        (modified.original.as_str(), modified.modified.as_str()),
        ("one\n", "two\n")
    );
    let added = commit_sides(&host, &repo, &detail, &pick("n.txt"))
        .await
        .unwrap();
    assert_eq!(
        (added.original.as_str(), added.modified.as_str()),
        ("", "new\n")
    );
    let deleted = commit_sides(&host, &repo, &detail, &pick("b.txt"))
        .await
        .unwrap();
    assert_eq!(
        (deleted.original.as_str(), deleted.modified.as_str()),
        ("gone\n", "")
    );
}

#[tokio::test]
async fn blame_lists_each_line_with_the_commit_that_wrote_it() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    write(repo.join("a.txt"), "one\ntwo\n");
    git(&repo, &["commit", "-q", "-a", "-m", "second"]);
    let lines = blame(&host(), &repo, "a.txt").await.unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].summary, "first");
    assert_eq!(lines[1].summary, "second");
    assert_eq!(lines[1].text, "two");
}

#[tokio::test]
async fn blame_reads_the_path_as_a_literal_not_a_glob() {
    let (_sandbox, repo) = repo_with(&[("a.txt", "one\n")]);
    let err = blame(&host(), &repo, "*.txt").await.unwrap_err();
    assert_eq!(err.code, RepoErrorCode::GitFailed);
}

#[test]
fn pick_change_returns_none_when_no_change_matches_the_path() {
    let changes = vec![change("a.txt", ChangeArea::Unstaged, "M")];
    assert!(pick_change(&changes, "b.txt", None).is_none());
}

#[test]
fn pick_change_matches_the_original_path_of_a_rename() {
    let changes = vec![renamed("b.txt", "a.txt", ChangeArea::Staged)];
    assert_eq!(pick_change(&changes, "a.txt", None).unwrap().path, "b.txt");
}

#[test]
fn pick_change_prefers_the_asked_area_and_gives_none_when_it_is_absent() {
    let changes = vec![
        change("a.txt", ChangeArea::Staged, "M"),
        change("a.txt", ChangeArea::Unstaged, "M"),
    ];
    assert_eq!(
        pick_change(&changes, "a.txt", Some(ChangeArea::Staged))
            .unwrap()
            .area,
        ChangeArea::Staged
    );
    assert!(pick_change(&changes, "a.txt", Some(ChangeArea::Untracked)).is_none());
}

#[test]
fn pick_change_without_a_preference_goes_conflicted_unstaged_untracked_then_staged() {
    let order = [
        ChangeArea::Conflicted,
        ChangeArea::Unstaged,
        ChangeArea::Untracked,
        ChangeArea::Staged,
    ];
    for start in 0..order.len() {
        let changes: Vec<FileChange> = order[start..]
            .iter()
            .rev()
            .map(|area| change("a.txt", *area, "M"))
            .collect();
        assert_eq!(
            pick_change(&changes, "a.txt", None).unwrap().area,
            order[start],
            "from {start}"
        );
    }
}
