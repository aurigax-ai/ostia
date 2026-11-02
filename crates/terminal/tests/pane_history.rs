#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use history_support::{HistoryOptions, make_history, numbered_lines, put, wait_for};
use ostia_terminal::history_records::{new_history_key, open_lines, seal_lines};
use ostia_terminal::pane_history::{HistoryBlock, RECORD_BYTES};
use parking_lot::Mutex;

fn mode(path: &std::path::Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn text(lines: &[&str]) -> Vec<String> {
    lines.iter().map(ToString::to_string).collect()
}

#[test]
fn round_trips_lines_and_refuses_another_key() {
    let key = new_history_key();
    let lines = text(&["one", "\x1b[31mtwo\x1b[0m", ""]);
    let sealed = seal_lines(&key, &lines).unwrap();
    assert!(!sealed.windows(3).any(|window| window == b"one"));
    assert_eq!(open_lines(&key, &sealed).unwrap(), lines);
    assert!(open_lines(&new_history_key(), &sealed).is_err());
}

#[tokio::test]
async fn reads_back_what_was_appended_written_or_still_pending_in_order() {
    let made = make_history(HistoryOptions::default());
    let history = made.history;
    let lines = |from: u64, count: u64| -> Vec<String> {
        (from..from + count).map(|i| format!("line {i}")).collect()
    };
    put(&history, &lines(0, 3000));
    history.flush().await;
    put(&history, &lines(3000, 10));
    assert_eq!(history.end(), 3010);
    assert_eq!(history.read(2995, 10).await, lines(2995, 10));
    assert_eq!(history.read(0, 2).await, lines(0, 2));
    assert_eq!(history.read(3008, 100).await, lines(3008, 2));
}

#[tokio::test]
async fn reads_back_pending_batches_line_by_line_empty_lines_and_one_line_batches_included() {
    let made = make_history(HistoryOptions::default());
    let history = made.history;
    put(&history, &text(&["first", "", "third"]));
    put(&history, &text(&[""]));
    put(&history, &text(&["\x1b[31mred\x1b[0m"]));
    assert_eq!(history.end(), 5);
    let all = text(&["first", "", "third", "", "\x1b[31mred\x1b[0m"]);
    assert_eq!(history.read(0, 5).await, all);
    assert_eq!(history.read(2, 2).await, text(&["third", ""]));
    history.flush().await;
    assert_eq!(history.read(0, 5).await, all);
}

#[tokio::test]
async fn keeps_nothing_readable_on_disk_a_0700_folder_0600_files_no_plaintext() {
    let made = make_history(HistoryOptions::default());
    let lines: Vec<String> = (0..50)
        .map(|i| format!("secret-looking text {i}"))
        .collect();
    put(&made.history, &lines);
    made.history.flush().await;
    assert_eq!(mode(&made.dir), 0o700);
    let files: Vec<_> = fs::read_dir(&made.dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    assert_eq!(mode(&files[0]), 0o600);
    let bytes = fs::read(&files[0]).unwrap();
    assert!(!bytes.windows(14).any(|window| window == b"secret-looking"));
}

#[tokio::test]
async fn writes_a_record_once_enough_text_is_pending_without_waiting_for_the_idle_flush() {
    let made = make_history(HistoryOptions::default());
    put(&made.history, &["x".repeat(RECORD_BYTES)]);
    let dir = made.dir.clone();
    wait_for(|| dir.exists() && fs::read_dir(&dir).unwrap().count() == 1).await;
}

#[tokio::test]
async fn drops_the_oldest_segment_past_the_cap_and_moves_the_first_line() {
    let made = make_history(HistoryOptions {
        limit_bytes: Some(1),
        segment_bytes: Some(1),
        ..HistoryOptions::default()
    });
    let history = made.history;
    let lines =
        |from: u64| -> Vec<String> { (from..from + 100).map(|i| format!("line {i}")).collect() };
    put(&history, &lines(0));
    history.flush().await;
    history.block_started(1, 10, Some("make"));
    put(&history, &lines(100));
    history.flush().await;
    put(&history, &lines(200));
    history.flush().await;
    assert_eq!(history.first(), 200);
    let dir = made.dir.clone();
    wait_for(|| fs::read_dir(&dir).unwrap().count() == 1).await;
    assert_eq!(history.read(0, 300).await, lines(200));
    assert!(history.block(1).is_none());
}

#[tokio::test]
async fn records_blocks_and_finds_them_by_sequence_number() {
    let made = make_history(HistoryOptions::default());
    let history = made.history;
    put(&history, &numbered_lines(0, 5));
    history.block_started(7, 1, Some("ls"));
    history.block_ended(7, 4, 3, 2, None);
    assert_eq!(
        history.block(7),
        Some(HistoryBlock {
            seq: 7,
            start: 1,
            end: Some(4),
            end_col: 3,
            exit_code: Some(2),
            command: Some("ls".to_string()),
        })
    );
}

#[tokio::test]
async fn wipes_every_line_block_and_file_but_keeps_counting_lines() {
    let made = make_history(HistoryOptions::default());
    let history = made.history;
    put(&history, &numbered_lines(0, 100));
    history.block_started(1, 2, Some("cat"));
    history.flush().await;
    history.wipe();
    history.flush().await;
    assert_eq!(history.first(), 100);
    assert!(history.read(0, 100).await.is_empty());
    assert!(history.block(1).is_none());
    assert_eq!(fs::read_dir(&made.dir).unwrap().count(), 0);
    put(&history, &text(&["after"]));
    assert_eq!(history.read(100, 1).await, text(&["after"]));
}

#[tokio::test]
async fn turns_itself_off_when_it_cannot_make_room_and_reports_why() {
    let made = make_history(HistoryOptions {
        ensure_space: Some(Arc::new(|_| false)),
        ..HistoryOptions::default()
    });
    let history = made.history;
    put(&history, &numbered_lines(0, 3));
    history.flush().await;
    assert_eq!(*made.failures.lock(), vec!["disk-full".to_string()]);
    assert!(!history.live());
    put(&history, &text(&["ignored"]));
    assert!(history.read(0, 10).await.is_empty());
}

#[tokio::test]
async fn removes_its_folder_when_disposed() {
    let made = make_history(HistoryOptions::default());
    put(&made.history, &numbered_lines(0, 3));
    made.history.flush().await;
    assert!(made.dir.exists());
    made.history.dispose().await;
    assert!(!made.dir.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removes_its_folder_only_after_a_write_that_is_opening_its_segment_finishes() {
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let entered_tx = Mutex::new(entered_tx);
    let release_rx = Mutex::new(release_rx);
    let made = make_history(HistoryOptions {
        ensure_space: Some(Arc::new(move |_| {
            entered_tx.lock().send(()).unwrap();
            release_rx.lock().recv().unwrap();
            true
        })),
        ..HistoryOptions::default()
    });
    let history = made.history;
    put(&history, &numbered_lines(0, 3));
    let flushing = tokio::spawn({
        let history = history.clone();
        async move { history.flush().await }
    });
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    let disposing = tokio::spawn({
        let history = history.clone();
        async move { history.dispose().await }
    });
    release_tx.send(()).unwrap();
    flushing.await.unwrap();
    disposing.await.unwrap();
    assert!(made.failures.lock().is_empty());
    assert!(!made.dir.exists());
}
