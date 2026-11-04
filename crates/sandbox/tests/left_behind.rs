#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::{Duration, SystemTime};

use ostia_sandbox::left_behind::{left_behind_baseline, left_behind_since, watch_left_behind};
use tempfile::TempDir;

fn repo(at: &Path) {
    fs::create_dir_all(at.join(".git/hooks")).unwrap();
    fs::write(at.join(".git/config"), "[core]\n").unwrap();
}

#[tokio::test]
async fn lists_a_changed_git_config_and_a_new_hook_of_an_existing_repository() {
    let dir = TempDir::new().unwrap();
    repo(dir.path());
    let baseline = left_behind_baseline(dir.path()).await;
    fs::write(dir.path().join(".git/config"), "[core]\n\tfsmonitor = x\n").unwrap();
    fs::write(dir.path().join(".git/hooks/pre-commit"), "x").unwrap();
    assert_eq!(
        left_behind_since(dir.path(), &baseline).await,
        vec![".git/config", ".git/hooks/pre-commit"]
    );
}

#[tokio::test]
async fn lists_a_changed_envrc_and_a_git_file_that_appeared_in_a_nested_folder() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join(".envrc"), "a").unwrap();
    fs::create_dir_all(dir.path().join("a/b")).unwrap();
    let baseline = left_behind_baseline(dir.path()).await;
    fs::write(dir.path().join(".envrc"), "bb").unwrap();
    fs::write(dir.path().join("a/b/.git"), "gitdir: ../../x").unwrap();
    assert_eq!(
        left_behind_since(dir.path(), &baseline).await,
        vec![".envrc", "a/b/.git"]
    );
}

#[tokio::test]
async fn names_a_new_repository_once_without_its_config_and_hooks() {
    let dir = TempDir::new().unwrap();
    let baseline = left_behind_baseline(dir.path()).await;
    repo(&dir.path().join("sub"));
    fs::write(dir.path().join("sub/.git/hooks/post-merge"), "x").unwrap();
    assert_eq!(
        left_behind_since(dir.path(), &baseline).await,
        vec!["sub/.git"]
    );
}

#[tokio::test]
async fn lists_nothing_when_only_unchanged_files_and_ordinary_files_exist() {
    let dir = TempDir::new().unwrap();
    repo(dir.path());
    fs::write(dir.path().join(".envrc"), "a").unwrap();
    let baseline = left_behind_baseline(dir.path()).await;
    fs::write(dir.path().join("file.txt"), "x").unwrap();
    fs::File::options()
        .write(true)
        .open(dir.path().join("file.txt"))
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1))
        .unwrap();
    assert!(left_behind_since(dir.path(), &baseline).await.is_empty());
}

#[tokio::test]
async fn does_not_follow_a_link_out_of_the_folder_or_enter_node_modules() {
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let baseline = left_behind_baseline(dir.path()).await;
    repo(outside.path());
    symlink(outside.path(), dir.path().join("link")).unwrap();
    repo(&dir.path().join("node_modules/pkg"));
    assert!(left_behind_since(dir.path(), &baseline).await.is_empty());
}

#[tokio::test]
async fn stops_looking_below_the_depth_cap() {
    let dir = TempDir::new().unwrap();
    let baseline = left_behind_baseline(dir.path()).await;
    repo(&dir.path().join("a/b/c/d/e/f/g/h"));
    assert!(left_behind_since(dir.path(), &baseline).await.is_empty());
}

#[tokio::test]
async fn does_not_list_a_file_that_was_removed_since_the_baseline() {
    let dir = TempDir::new().unwrap();
    repo(dir.path());
    fs::write(dir.path().join(".envrc"), "a").unwrap();
    let baseline = left_behind_baseline(dir.path()).await;
    fs::remove_file(dir.path().join(".envrc")).unwrap();
    fs::remove_file(dir.path().join(".git/config")).unwrap();
    assert!(left_behind_since(dir.path(), &baseline).await.is_empty());
}

async fn next_report(
    reports: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<String>>,
) -> Option<Vec<String>> {
    tokio::time::timeout(Duration::from_secs(5), reports.recv())
        .await
        .ok()
        .flatten()
}

#[tokio::test]
async fn reports_once_when_the_watch_ends_and_says_nothing_for_a_quiet_session() {
    let dir = TempDir::new().unwrap();
    let (sink, mut reports) = tokio::sync::mpsc::unbounded_channel();
    let quiet_sink = sink.clone();
    let quiet = watch_left_behind(dir.path().to_path_buf(), move |paths| {
        let _ = quiet_sink.send(paths);
    });
    quiet.baseline_taken().await;
    quiet.end().unwrap().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(50), reports.recv())
            .await
            .ok()
            .flatten(),
        None
    );
    let busy = watch_left_behind(dir.path().to_path_buf(), move |paths| {
        let _ = sink.send(paths);
    });
    busy.baseline_taken().await;
    fs::write(dir.path().join(".envrc"), "x").unwrap();
    busy.end();
    busy.end();
    assert_eq!(
        next_report(&mut reports).await,
        Some(vec![".envrc".to_owned()])
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(100), reports.recv())
            .await
            .ok()
            .flatten(),
        None
    );
}

#[tokio::test]
async fn reports_when_the_watch_ends_on_a_thread_outside_the_runtime() {
    let dir = TempDir::new().unwrap();
    let (sink, mut reports) = tokio::sync::mpsc::unbounded_channel();
    let watch = watch_left_behind(dir.path().to_path_buf(), move |paths| {
        let _ = sink.send(paths);
    });
    watch.baseline_taken().await;
    fs::write(dir.path().join(".envrc"), "x").unwrap();
    std::thread::spawn(move || watch.end()).join().unwrap();
    assert_eq!(
        next_report(&mut reports).await,
        Some(vec![".envrc".to_owned()])
    );
}
