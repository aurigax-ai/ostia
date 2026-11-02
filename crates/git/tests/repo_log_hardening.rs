#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use ostia_git::repo::{commit_detail, graph_log, log};
use support::{Sandbox, git, host, init_repo, write};

#[tokio::test]
async fn never_runs_gpg_program_for_the_log_the_graph_or_a_commit_detail() {
    let sandbox = Sandbox::new("ostia-git-log-hardening-");
    let repo = sandbox.path("repo");
    init_repo(&repo);
    write(repo.join("a.txt"), "one\n");
    git(&repo, &["add", "."]);
    let tree = git(&repo, &["write-tree"]).trim().to_owned();
    let signed = [
        format!("tree {tree}"),
        "author t <a@b.c> 1767225600 +0000".to_owned(),
        "committer t <a@b.c> 1767225600 +0000".to_owned(),
        "gpgsig -----BEGIN PGP SIGNATURE-----".to_owned(),
        " ".to_owned(),
        " ZmFrZQ==".to_owned(),
        " -----END PGP SIGNATURE-----".to_owned(),
        String::new(),
        "signed".to_owned(),
        String::new(),
    ]
    .join("\n");
    let commit_file = sandbox.path("commit.txt");
    write(&commit_file, &signed);
    let sha = git(
        &repo,
        &[
            "hash-object",
            "-t",
            "commit",
            "-w",
            &commit_file.to_string_lossy(),
        ],
    )
    .trim()
    .to_owned();
    git(&repo, &["update-ref", "refs/heads/main", &sha]);
    let gpg = sandbox.program("gpg-ran");
    git(&repo, &["config", "log.showSignature", "true"]);
    git(&repo, &["config", "gpg.program", &gpg]);
    let host = host();
    let subjects: Vec<String> = log(&host, &repo, 5)
        .await
        .into_iter()
        .map(|c| c.subject)
        .collect();
    assert_eq!(subjects, ["signed"]);
    graph_log(&host, &repo, &[], 5).await.unwrap();
    commit_detail(&host, &repo, &sha).await.unwrap();
    assert!(!sandbox.marked("gpg-ran"));
}

#[tokio::test]
async fn does_not_use_a_bare_repository_found_in_the_folder() {
    let sandbox = Sandbox::new("ostia-git-log-hardening-");
    let repo = sandbox.path("repo");
    init_repo(&repo);
    write(repo.join("a.txt"), "one\n");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "one"]);
    let bare = sandbox.dir("nested");
    git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    git(&repo, &["push", "-q", &bare.to_string_lossy(), "main:main"]);
    assert!(log(&host(), &bare, 5).await.is_empty());
}
