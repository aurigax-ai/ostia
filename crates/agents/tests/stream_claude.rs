#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use ostia_agents::stream_claude::{ClaudeSourceDeps, claude_source};
use ostia_agents::stream_source::{Emit, StreamSource};
use ostia_contract::agent_stream::{StreamEnd, StreamEvent};
use serde_json::{Value, json};
use tempfile::TempDir;

const SESSION: &str = "s-claude";
const POLL_MS: u64 = 300;
const MIB: usize = 1024 * 1024;

fn ev(value: Value) -> StreamEvent {
    serde_json::from_value(value).unwrap()
}

fn evs(values: Vec<Value>) -> Vec<StreamEvent> {
    values.into_iter().map(ev).collect()
}

fn user_line(uuid: &str, text: &str) -> String {
    format!(
        "{}\n",
        json!({"type": "user", "uuid": uuid, "message": {"role": "user", "content": text}})
    )
}

fn assistant_line(uuid: &str, text: &str) -> String {
    format!(
        "{}\n",
        json!({
            "type": "assistant",
            "uuid": uuid,
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn"
            }
        })
    )
}

fn turn_lines(turn: &str, prompt: &str, reply: &str) -> String {
    format!(
        "{}{}",
        user_line(turn, prompt),
        assistant_line(&format!("a-{turn}"), reply)
    )
}

fn turn_events(turn: &str, prompt: &str, reply: &str) -> Vec<Value> {
    vec![
        json!({"type": "turn.started", "turn": turn}),
        json!({"type": "prompt", "turn": turn, "id": turn, "text": prompt}),
        json!({"type": "text", "turn": turn, "id": format!("a-{turn}:0"), "text": reply}),
        json!({"type": "turn.ended", "turn": turn, "status": "done"}),
    ]
}

fn filler(bytes: usize) -> String {
    let line = format!("{}\n", json!({"type": "noise", "pad": "x".repeat(1000)}));
    line.repeat(bytes / line.len() + 1)
}

fn append(path: &Path, text: &str) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

type Found = Arc<Mutex<Option<PathBuf>>>;
type Batches = Arc<Mutex<Vec<Vec<StreamEvent>>>>;
type Closes = Arc<Mutex<Vec<StreamEnd>>>;

struct Rig {
    found: Found,
    closes: Closes,
    source: Box<dyn StreamSource>,
}

fn rig(path: Option<&Path>) -> Rig {
    let found: Found = Arc::new(Mutex::new(path.map(Path::to_path_buf)));
    let closes: Closes = Arc::default();
    let lookup = Arc::clone(&found);
    let log = Arc::clone(&closes);
    let source = claude_source(ClaudeSourceDeps {
        find: Box::new(move || {
            let path = lookup.lock().unwrap().clone();
            async move { path }.boxed()
        }),
        session: SESSION.to_owned(),
        closed: Box::new(move |reason| log.lock().unwrap().push(reason)),
    });
    Rig {
        found,
        closes,
        source: Box::new(source),
    }
}

fn collector() -> (Emit, Batches) {
    let batches: Batches = Arc::default();
    let log = Arc::clone(&batches);
    let emit: Emit = Arc::new(move |events| log.lock().unwrap().push(events));
    (emit, batches)
}

fn flat(batches: &Batches) -> Vec<StreamEvent> {
    batches.lock().unwrap().iter().flatten().cloned().collect()
}

async fn tick() {
    tokio::time::advance(Duration::from_millis(POLL_MS)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_millis(2));
    }
}

async fn ticks(count: usize) {
    for _ in 0..count {
        tick().await;
    }
}

async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tick().await;
    }
    panic!("condition not reached");
}

fn transcript(dir: &TempDir, text: &str) -> PathBuf {
    let path = dir.path().join("session.jsonl");
    fs::write(&path, text).unwrap();
    path
}

#[tokio::test(start_paused = true)]
async fn backfill_returns_the_last_turns_of_the_transcript_oldest_first() {
    let dir = TempDir::new().unwrap();
    let path = transcript(
        &dir,
        &format!(
            "{}{}{}",
            turn_lines("u1", "one", "r1"),
            turn_lines("u2", "two", "r2"),
            turn_lines("u3", "three", "r3")
        ),
    );
    let rig = rig(Some(&path));
    let backfill = rig.source.backfill(2).await.unwrap();
    let mut expected = turn_events("u2", "two", "r2");
    expected.extend(turn_events("u3", "three", "r3"));
    assert_eq!(backfill.events, evs(expected));
    assert!(!backfill.truncated);
}

#[tokio::test(start_paused = true)]
async fn backfill_is_empty_when_no_transcript_is_found() {
    let rig = rig(None);
    let backfill = rig.source.backfill(5).await.unwrap();
    assert!(backfill.events.is_empty());
    assert!(!backfill.truncated);
}

#[tokio::test(start_paused = true)]
async fn backfill_is_empty_when_the_transcript_file_is_missing() {
    let dir = TempDir::new().unwrap();
    let rig = rig(Some(&dir.path().join("gone.jsonl")));
    let backfill = rig.source.backfill(5).await.unwrap();
    assert!(backfill.events.is_empty());
    assert!(!backfill.truncated);
}

#[tokio::test(start_paused = true)]
async fn backfill_fails_when_the_transcript_is_not_a_regular_file() {
    let dir = TempDir::new().unwrap();
    let pipe = dir.path().join("pipe.jsonl");
    assert!(
        Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    let rig = rig(Some(&pipe));
    assert!(rig.source.backfill(5).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn backfill_widens_the_window_until_enough_turns_are_read() {
    let dir = TempDir::new().unwrap();
    let path = transcript(
        &dir,
        &format!(
            "{}{}{}{}",
            turn_lines("u1", "one", "r1"),
            turn_lines("u2", "two", "r2"),
            filler(5 * MIB),
            turn_lines("u3", "three", "r3")
        ),
    );
    let rig = rig(Some(&path));
    let backfill = rig.source.backfill(2).await.unwrap();
    let mut expected = turn_events("u2", "two", "r2");
    expected.extend(turn_events("u3", "three", "r3"));
    assert_eq!(backfill.events, evs(expected));
    assert!(!backfill.truncated);
}

#[tokio::test(start_paused = true)]
async fn backfill_reports_truncated_when_the_widest_window_lacks_the_turns() {
    let dir = TempDir::new().unwrap();
    let path = transcript(
        &dir,
        &format!(
            "{}{}{}",
            turn_lines("u1", "one", "r1"),
            filler(33 * MIB),
            turn_lines("u2", "two", "r2")
        ),
    );
    let rig = rig(Some(&path));
    let backfill = rig.source.backfill(2).await.unwrap();
    assert_eq!(backfill.events, evs(turn_events("u2", "two", "r2")));
    assert!(backfill.truncated);
}

#[tokio::test(start_paused = true)]
async fn live_emits_the_events_of_lines_appended_after_the_backfill() {
    let dir = TempDir::new().unwrap();
    let path = transcript(&dir, &turn_lines("u1", "one", "r1"));
    let rig = rig(Some(&path));
    rig.source.backfill(5).await.unwrap();
    let (emit, batches) = collector();
    rig.source.live(emit);
    ticks(2).await;
    assert!(flat(&batches).is_empty());
    append(&path, &turn_lines("u2", "two", "r2"));
    until(|| flat(&batches).len() >= 4).await;
    assert_eq!(flat(&batches), evs(turn_events("u2", "two", "r2")));
    rig.source.close();
}

#[tokio::test(start_paused = true)]
async fn live_holds_a_partial_line_until_it_is_complete() {
    let dir = TempDir::new().unwrap();
    let path = transcript(&dir, "");
    let rig = rig(Some(&path));
    rig.source.backfill(5).await.unwrap();
    let (emit, batches) = collector();
    rig.source.live(emit);
    let full = user_line("u1", "one");
    let (head, tail) = full.split_at(full.len() / 2);
    append(&path, head);
    ticks(3).await;
    assert!(flat(&batches).is_empty());
    append(&path, tail);
    until(|| !flat(&batches).is_empty()).await;
    assert_eq!(
        flat(&batches),
        evs(vec![
            json!({"type": "turn.started", "turn": "u1"}),
            json!({"type": "prompt", "turn": "u1", "id": "u1", "text": "one"})
        ])
    );
    rig.source.close();
}

#[tokio::test(start_paused = true)]
async fn live_finds_a_transcript_that_appears_after_it_started() {
    let dir = TempDir::new().unwrap();
    let rig = rig(None);
    let (emit, batches) = collector();
    rig.source.live(emit);
    ticks(2).await;
    assert!(flat(&batches).is_empty());
    let path = transcript(&dir, &turn_lines("u1", "one", "r1"));
    *rig.found.lock().unwrap() = Some(path);
    until(|| flat(&batches).len() >= 4).await;
    assert_eq!(flat(&batches), evs(turn_events("u1", "one", "r1")));
    assert!(rig.closes.lock().unwrap().is_empty());
    rig.source.close();
}

#[tokio::test(start_paused = true)]
async fn live_starts_over_with_the_session_and_live_markers_when_the_file_shrinks() {
    let dir = TempDir::new().unwrap();
    let path = transcript(
        &dir,
        &format!(
            "{}{}",
            turn_lines("u1", "one", "first reply"),
            turn_lines("u2", "two", "second reply")
        ),
    );
    let rig = rig(Some(&path));
    rig.source.backfill(1).await.unwrap();
    let (emit, batches) = collector();
    rig.source.live(emit);
    fs::write(&path, turn_lines("u9", "nine", "r9")).unwrap();
    until(|| !flat(&batches).is_empty()).await;
    let mut expected = vec![json!({"type": "session", "session": SESSION})];
    expected.extend(turn_events("u9", "nine", "r9"));
    expected.push(json!({"type": "live"}));
    assert_eq!(flat(&batches), evs(expected));
    rig.source.close();
}

#[tokio::test(start_paused = true)]
async fn live_ends_unavailable_at_once_on_an_error_that_is_not_an_errno() {
    let dir = TempDir::new().unwrap();
    let pipe = dir.path().join("pipe.jsonl");
    assert!(
        Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    let rig = rig(Some(&pipe));
    let (emit, _batches) = collector();
    rig.source.live(emit);
    until(|| !rig.closes.lock().unwrap().is_empty()).await;
    ticks(3).await;
    assert_eq!(*rig.closes.lock().unwrap(), vec![StreamEnd::Unavailable]);
}

#[tokio::test(start_paused = true)]
async fn live_ends_unavailable_only_after_twenty_failed_polls_with_an_errno() {
    let dir = TempDir::new().unwrap();
    let real = dir.path().join("real.jsonl");
    fs::write(&real, "").unwrap();
    let link = dir.path().join("link.jsonl");
    symlink(&real, &link).unwrap();
    let rig = rig(Some(&link));
    let (emit, _batches) = collector();
    rig.source.live(emit);
    ticks(10).await;
    assert!(rig.closes.lock().unwrap().is_empty());
    until(|| !rig.closes.lock().unwrap().is_empty()).await;
    ticks(3).await;
    assert_eq!(*rig.closes.lock().unwrap(), vec![StreamEnd::Unavailable]);
}

#[tokio::test(start_paused = true)]
async fn close_stops_the_polling() {
    let dir = TempDir::new().unwrap();
    let path = transcript(&dir, "");
    let rig = rig(Some(&path));
    rig.source.backfill(5).await.unwrap();
    let (emit, batches) = collector();
    rig.source.live(emit);
    rig.source.close();
    append(&path, &turn_lines("u1", "one", "r1"));
    ticks(4).await;
    assert!(flat(&batches).is_empty());
    assert!(rig.closes.lock().unwrap().is_empty());
}
