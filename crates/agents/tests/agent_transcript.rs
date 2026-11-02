#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;

use ostia_agents::agent_transcript::{
    TRANSCRIPT_TAIL_BYTES, codex_session_folder, read_session_info,
};
use ostia_agents::transcript_files::{read_range, read_tail};
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use serde_json::{Value, json};
use tempfile::TempDir;

fn home() -> TempDir {
    TempDir::new().unwrap()
}

fn resume(agent: ResumableAgent, id: &str) -> AgentResume {
    AgentResume {
        agent,
        id: id.to_owned(),
        cwd: None,
        args: Vec::new(),
    }
}

fn claude(id: &str) -> AgentResume {
    resume(ResumableAgent::Claude, id)
}

fn codex(id: &str) -> AgentResume {
    resume(ResumableAgent::Codex, id)
}

fn jsonl(lines: &[Value]) -> String {
    lines.iter().map(|line| format!("{line}\n")).collect()
}

fn info_of(resume: &AgentResume, home: &Path) -> Option<Value> {
    read_session_info(resume, home).map(|info| serde_json::to_value(info).unwrap())
}

fn claude_dir(home: &Path) -> PathBuf {
    let dir = home.join(".claude").join("projects").join("-w");
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn mkfifo(path: &Path) {
    let status = Command::new("mkfifo").arg(path).status().unwrap();
    assert!(status.success());
}

#[test]
fn finds_a_claude_transcript_by_session_id_in_any_project_folder() {
    let h = home();
    fs::write(
        claude_dir(h.path()).join("abc-1.jsonl"),
        jsonl(&[json!({"type": "ai-title", "aiTitle": "Hello"})]),
    )
    .unwrap();
    let found = info_of(&claude("abc-1"), h.path()).unwrap();
    assert_eq!(found["title"], "Hello");
    assert!(info_of(&claude("missing"), h.path()).is_none());
}

#[test]
fn ignores_a_symlinked_transcript() {
    let h = home();
    let dir = claude_dir(h.path());
    fs::write(
        h.path().join("elsewhere.jsonl"),
        jsonl(&[json!({"type": "ai-title", "aiTitle": "x"})]),
    )
    .unwrap();
    symlink(h.path().join("elsewhere.jsonl"), dir.join("abc-1.jsonl")).unwrap();
    assert!(info_of(&claude("abc-1"), h.path()).is_none());
}

#[test]
fn reads_a_long_codex_rollout_the_session_header_from_the_start_usage_from_the_end() {
    let h = home();
    let dir = h.path().join(".codex/sessions/2026/09/30");
    fs::create_dir_all(&dir).unwrap();
    let filler = format!(
        "{}\n",
        json!({"type": "response_item", "payload": {"type": "message", "content": "x".repeat(1000)}})
    );
    let repeat = usize::try_from(TRANSCRIPT_TAIL_BYTES).unwrap() / filler.len() + 10;
    let text = format!(
        "{}{}{}",
        jsonl(&[
            json!({"type": "session_meta", "payload": {"cwd": "/w", "git": {"branch": "dev"}}})
        ]),
        filler.repeat(repeat),
        jsonl(&[json!({"type": "turn_context", "payload": {"model": "gpt-5.4"}})]),
    );
    fs::write(dir.join("rollout-2026-09-30T06-56-33-01a0f1f5.jsonl"), text).unwrap();
    let info = info_of(&codex("01a0f1f5"), h.path()).unwrap();
    assert_eq!(info["branch"], "dev");
    assert_eq!(info["cwd"], "/w");
    assert_eq!(info["model"], "gpt-5.4");
}

fn rollout(h: &Path, lines: &[Value]) {
    let dir = h.join(".codex/sessions/2026/10/28");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("rollout-2026-10-28T01-21-22-01a180f4.jsonl"),
        jsonl(lines),
    )
    .unwrap();
}

#[test]
fn names_the_latest_folder_the_session_recorded_after_a_cd_not_the_one_it_started_in() {
    let h = home();
    rollout(
        h.path(),
        &[
            json!({"type": "session_meta", "payload": {"cwd": "/w/a"}}),
            json!({"type": "turn_context", "payload": {"cwd": "/w/a"}}),
            json!({"type": "turn_context", "payload": {"cwd": "/w/b"}}),
        ],
    );
    assert_eq!(
        codex_session_folder(&codex("01a180f4"), h.path()),
        Some("/w/b".to_owned())
    );
}

#[test]
fn keeps_a_folder_longer_than_a_display_field() {
    let h = home();
    let long = format!("/w/{}", "d".repeat(300));
    rollout(
        h.path(),
        &[json!({"type": "session_meta", "payload": {"cwd": long}})],
    );
    assert_eq!(
        codex_session_folder(&codex("01a180f4"), h.path()),
        Some(long)
    );
}

#[test]
fn names_nothing_for_claude_whose_transcript_follows_a_cd_the_session_does_not_resume_in_or_a_missing_record()
 {
    let h = home();
    fs::write(
        claude_dir(h.path()).join("abc-1.jsonl"),
        jsonl(&[json!({"type": "user", "cwd": "/w/sub"})]),
    )
    .unwrap();
    assert_eq!(codex_session_folder(&claude("abc-1"), h.path()), None);
    assert_eq!(codex_session_folder(&codex("missing"), h.path()), None);
}

#[test]
fn read_range_refuses_a_symlink_and_a_fifo_without_blocking() {
    let h = home();
    fs::write(h.path().join("real.jsonl"), "a\n").unwrap();
    symlink(h.path().join("real.jsonl"), h.path().join("link.jsonl")).unwrap();
    mkfifo(&h.path().join("pipe.jsonl"));
    assert!(read_range(&h.path().join("link.jsonl"), true, 100).is_err());
    assert!(read_range(&h.path().join("pipe.jsonl"), true, 100).is_err());
    assert_eq!(
        read_range(&h.path().join("real.jsonl"), true, 100).unwrap(),
        vec!["a".to_owned(), String::new()]
    );
}

#[tokio::test]
async fn read_range_reads_the_tail_asynchronously_with_the_same_refusals() {
    let h = home();
    fs::write(h.path().join("real.jsonl"), "a\n").unwrap();
    symlink(h.path().join("real.jsonl"), h.path().join("link.jsonl")).unwrap();
    mkfifo(&h.path().join("pipe.jsonl"));
    assert!(read_tail(&h.path().join("link.jsonl"), 100).await.is_err());
    assert!(read_tail(&h.path().join("pipe.jsonl"), 100).await.is_err());
    let read = read_tail(&h.path().join("real.jsonl"), 100).await.unwrap();
    assert_eq!(read.lines, vec!["a".to_owned(), String::new()]);
    assert!(!read.truncated);
}
