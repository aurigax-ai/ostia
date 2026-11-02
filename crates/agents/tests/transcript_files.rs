#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use ostia_agents::transcript_files::{
    NewLines, TailWindow, read_new_lines, read_new_lines_with, read_tail_window, transcript_path,
};
use ostia_base::Error;
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use tempfile::TempDir;

fn claude(id: &str, cwd: Option<&str>) -> AgentResume {
    AgentResume {
        agent: ResumableAgent::Claude,
        id: id.to_owned(),
        cwd: cwd.map(str::to_owned),
        args: Vec::new(),
        typed: None,
    }
}

fn append(path: &Path, text: &str) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn tail(items: &[&str], truncated: bool, end: u64) -> TailWindow {
    TailWindow {
        lines: lines(items),
        truncated,
        end,
    }
}

fn news(items: &[&str], end: u64, reset: bool) -> NewLines {
    NewLines {
        lines: lines(items),
        end,
        reset,
    }
}

fn setup() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("s.jsonl");
    (dir, file)
}

#[tokio::test]
async fn returns_every_complete_line_and_where_they_end_leaving_a_half_written_tail_out() {
    let (_dir, file) = setup();
    fs::write(&file, "one\ntwo\nthr").unwrap();
    assert_eq!(
        read_tail_window(&file, 1024).await.unwrap(),
        tail(&["one", "two"], false, 8)
    );
}

#[tokio::test]
async fn drops_the_cut_first_line_of_a_window_that_starts_mid_file() {
    let (_dir, file) = setup();
    fs::write(&file, "aaaa\nbbbb\ncccc\n").unwrap();
    assert_eq!(
        read_tail_window(&file, 7).await.unwrap(),
        tail(&["cccc"], true, 15)
    );
}

#[tokio::test]
async fn returns_no_lines_for_a_file_with_no_newline_yet() {
    let (_dir, file) = setup();
    fs::write(&file, "partial").unwrap();
    assert_eq!(
        read_tail_window(&file, 1024).await.unwrap(),
        tail(&[], false, 0)
    );
}

#[tokio::test]
async fn reads_multibyte_text_and_reports_the_end_in_bytes() {
    let (_dir, file) = setup();
    fs::write(&file, "é€\nx\n").unwrap();
    assert_eq!(
        read_tail_window(&file, 1024).await.unwrap(),
        tail(&["é€", "x"], false, 8)
    );
}

#[tokio::test]
async fn refuses_a_symlink_and_a_directory() {
    let (dir, file) = setup();
    fs::write(&file, "x\n").unwrap();
    let link = dir.path().join("link.jsonl");
    symlink(&file, &link).unwrap();
    assert!(read_tail_window(&link, 1024).await.is_err());
    fs::create_dir(dir.path().join("d")).unwrap();
    assert!(read_tail_window(&dir.path().join("d"), 1024).await.is_err());
}

#[tokio::test]
async fn returns_what_was_appended_since_the_offset_only_whole_lines() {
    let (_dir, file) = setup();
    fs::write(&file, "one\n").unwrap();
    let first = read_new_lines(&file, 0).await.unwrap();
    assert_eq!(first, news(&["one"], 4, false));
    append(&file, "two\nthr");
    let second = read_new_lines(&file, first.end).await.unwrap();
    assert_eq!(second, news(&["two"], 8, false));
    append(&file, "ee\n");
    assert_eq!(
        read_new_lines(&file, second.end).await.unwrap(),
        news(&["three"], 14, false)
    );
    assert_eq!(
        read_new_lines(&file, 14).await.unwrap(),
        news(&[], 14, false)
    );
}

#[tokio::test]
async fn says_the_file_got_shorter_than_the_offset_without_handing_its_lines_over_again() {
    let (_dir, file) = setup();
    fs::write(&file, "a\nb\nc\n").unwrap();
    fs::write(&file, "x\n").unwrap();
    assert_eq!(read_new_lines(&file, 6).await.unwrap(), news(&[], 0, true));
}

#[tokio::test]
async fn reads_at_most_a_few_megabytes_a_call_and_carries_on_from_where_it_stopped() {
    let (_dir, file) = setup();
    let line = format!("{}\n", "x".repeat(1023));
    fs::write(&file, line.repeat(6000)).unwrap();
    let first = read_new_lines(&file, 0).await.unwrap();
    assert!(first.lines.len() < 6000);
    assert_eq!(first.end, first.lines.len() as u64 * 1024);
    let rest = read_new_lines(&file, first.end).await.unwrap();
    assert_eq!(first.lines.len() + rest.lines.len(), 6000);
}

#[tokio::test]
async fn reads_a_line_longer_than_a_call_by_widening_the_read() {
    let (_dir, file) = setup();
    let long = 5 * 1024 * 1024;
    fs::write(&file, format!("{}\nnext\n", "y".repeat(long))).unwrap();
    let read = read_new_lines(&file, 0).await.unwrap();
    let lengths: Vec<usize> = read.lines.iter().map(String::len).collect();
    assert_eq!(lengths, vec![long, 4]);
}

#[tokio::test]
async fn moves_past_a_single_line_longer_than_anything_it_will_read_instead_of_reading_it_again_every_call()
 {
    let (_dir, file) = setup();
    fs::write(&file, format!("{}\nok\n", "z".repeat(5000))).unwrap();
    let first = read_new_lines_with(&file, 0, 256, 1024).await.unwrap();
    assert_eq!(first, news(&[], 1024, false));
    let mut end = first.end;
    let mut found: Vec<String> = Vec::new();
    for _ in 0..40 {
        if !found.is_empty() {
            break;
        }
        let next = read_new_lines_with(&file, end, 256, 1024).await.unwrap();
        assert!(next.end > end);
        end = next.end;
        found = next.lines;
    }
    assert_eq!(found.last().map(String::as_str), Some("ok"));
}

#[tokio::test]
async fn refuses_a_symlink() {
    let (dir, file) = setup();
    fs::write(&file, "x\n").unwrap();
    let link = dir.path().join("link.jsonl");
    symlink(&file, &link).unwrap();
    assert!(read_new_lines(&link, 0).await.is_err());
}

#[tokio::test]
async fn rejects_a_missing_file() {
    let (dir, _file) = setup();
    let error = read_new_lines(&dir.path().join("none.jsonl"), 0)
        .await
        .unwrap_err();
    match error {
        Error::Io { source, .. } => assert_eq!(source.kind(), std::io::ErrorKind::NotFound),
        other => panic!("expected an io error, got {other:?}"),
    }
}

fn claude_home() -> TempDir {
    let home = TempDir::new().unwrap();
    let projects = home.path().join(".claude").join("projects");
    for project in ["-work-api", "-work-other"] {
        fs::create_dir_all(projects.join(project)).unwrap();
    }
    fs::write(projects.join("-work-other").join("s1.jsonl"), "x\n").unwrap();
    home
}

#[test]
fn finds_the_session_only_under_the_project_folder_of_the_cwd_it_was_given() {
    let home = claude_home();
    assert_eq!(
        transcript_path(&claude("s1", Some("/work/api")), home.path()),
        None
    );
    assert_eq!(
        transcript_path(&claude("s1", Some("/work/other")), home.path()),
        Some(home.path().join(".claude/projects/-work-other/s1.jsonl"))
    );
}

#[test]
fn names_the_project_folder_the_way_claude_does_every_non_alphanumeric_as_a_dash() {
    let home = claude_home();
    let folder = home.path().join(".claude/projects/-home-me-my-proj-v1-2");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("s2.jsonl"), "x\n").unwrap();
    assert!(transcript_path(&claude("s2", Some("/home/me/my_proj.v1/2")), home.path()).is_some());
}

#[test]
fn still_searches_every_project_when_no_cwd_is_known() {
    let home = claude_home();
    assert_eq!(
        transcript_path(&claude("s1", None), home.path()),
        Some(home.path().join(".claude/projects/-work-other/s1.jsonl"))
    );
}
