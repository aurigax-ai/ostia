#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use history_support::{
    HistoryOptions, make_history, mark, numbered, numbered_lines, plain, strip_vt,
};
use ostia_terminal::history_feed::{
    PANE_SEND_CHARS, SLICE_CHARS, SPILL_BACKLOG, SpillClient, SpillPort, SpillPressure,
};
use ostia_terminal::history_spill::{GAP_LINE, SPILL_BATCH, SpillSink};
use ostia_terminal::pane_histories::{PaneHistories, PaneHistoriesDeps};
use ostia_terminal::scrollback_history::ScrollbackHistory;
use ostia_terminal::spill_host::{SpillEvent, SpillRequest};
use ostia_terminal::spill_terminal::{SPILL_SCROLLBACK, SpillTerminal};
use parking_lot::Mutex;

#[derive(Default)]
struct FakePort {
    posted: Mutex<Vec<SpillRequest>>,
    listener: Mutex<Option<Arc<dyn Fn(SpillEvent) + Send + Sync>>>,
}

impl SpillPort for FakePort {
    fn post_message(&self, request: SpillRequest) -> Result<(), String> {
        self.posted.lock().push(request);
        Ok(())
    }

    fn on_message(&self, listener: Arc<dyn Fn(SpillEvent) + Send + Sync>) {
        *self.listener.lock() = Some(listener);
    }
}

impl FakePort {
    fn posted(&self) -> Vec<SpillRequest> {
        self.posted.lock().clone()
    }

    fn answer(&self, event: SpillEvent) {
        let listener = self.listener.lock().clone().unwrap();
        listener(event);
    }
}

struct CountingPressure {
    can_pause: bool,
    held: AtomicUsize,
    released: AtomicUsize,
}

impl CountingPressure {
    fn new(can_pause: bool) -> Arc<Self> {
        Arc::new(Self {
            can_pause,
            held: AtomicUsize::new(0),
            released: AtomicUsize::new(0),
        })
    }
}

impl SpillPressure for CountingPressure {
    fn can_pause(&self) -> bool {
        self.can_pause
    }

    fn hold(&self, chars: usize) {
        self.held.fetch_add(chars, Ordering::SeqCst);
    }

    fn release(&self, chars: usize) {
        self.released.fetch_add(chars, Ordering::SeqCst);
    }

    fn close(&self) {}
}

struct LinesSink {
    lines: Mutex<Vec<String>>,
}

impl SpillSink for LinesSink {
    fn end(&self) -> u64 {
        u64::try_from(self.lines.lock().len()).unwrap()
    }

    fn live(&self) -> bool {
        true
    }

    fn append(&self, lines: &[String]) {
        self.lines.lock().extend_from_slice(lines);
    }

    fn block_started(&self, _seq: u64, _start: u64, _command: Option<&str>) {}

    fn block_ended(
        &self,
        _seq: u64,
        _end: u64,
        _end_col: u64,
        _exit_code: i32,
        _command: Option<&str>,
    ) {
    }

    fn wipe(&self) {}

    fn flush(&self) {}
}

fn writes(posted: &[SpillRequest]) -> Vec<(u64, usize, Vec<u8>)> {
    posted
        .iter()
        .filter_map(|request| match request {
            SpillRequest::Write {
                session,
                data,
                chars,
            } => Some((*session, *chars, data.clone())),
            _ => None,
        })
        .collect()
}

fn kinds(posted: &[SpillRequest]) -> Vec<&'static str> {
    posted
        .iter()
        .map(|request| match request {
            SpillRequest::Open { .. } => "open",
            SpillRequest::Write { .. } => "write",
            SpillRequest::Resync { .. } => "resync",
            SpillRequest::Restore { .. } => "restore",
            SpillRequest::Resize { .. } => "resize",
            SpillRequest::Tail { .. } => "tail",
            SpillRequest::PendingEnd { .. } => "pendingEnd",
            SpillRequest::Close { .. } => "close",
        })
        .collect()
}

fn batch() -> u64 {
    u64::try_from(SPILL_BATCH).unwrap()
}

async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

fn make_histories() -> (PaneHistories, tempfile::TempDir) {
    let root = tempfile::Builder::new().prefix("feeds-").tempdir().unwrap();
    let histories = PaneHistories::new(PaneHistoriesDeps {
        root: root.path().to_path_buf(),
        setting: Arc::new(|| ScrollbackHistory::Unlimited),
        start_spill: Arc::new(|| SpillClient::spawn().unwrap()),
        free_bytes: None,
        on_failed: None,
        segment_bytes: None,
    });
    (histories, root)
}

#[test]
fn keeps_every_line_the_worker_could_still_spill_a_batch_fits_in_its_scrollback() {
    assert!(SPILL_BATCH < SPILL_SCROLLBACK);
}

#[tokio::test]
async fn spills_through_the_built_worker() {
    let client = SpillClient::spawn().unwrap();
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, None);
    feed.write(&numbered(0, 3 * batch()));
    feed.close().await;
    assert_eq!(plain(&made.history).await, numbered_lines(0, 3 * batch()));
    client.end("test-done");
}

#[tokio::test]
async fn keeps_wide_and_combined_characters_through_the_worker() {
    let client = SpillClient::spawn().unwrap();
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, None);
    feed.write("漢字 🙂 café\r\n");
    feed.write(&numbered(0, batch()));
    feed.close().await;
    assert_eq!(plain(&made.history).await[0], "漢字 🙂 café");
    client.end("test-done");
}

#[tokio::test(start_paused = true)]
async fn posts_output_once_the_pane_goes_quiet_as_one_message_ahead_of_the_next_request() {
    let port = Arc::new(FakePort::default());
    let client = SpillClient::new(port.clone());
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, None);
    let written = || -> Vec<String> {
        writes(&port.posted())
            .into_iter()
            .map(|(_, _, data)| String::from_utf8(data).unwrap())
            .collect()
    };
    feed.write("a");
    feed.write("b");
    feed.resize(100, 30);
    feed.write("c");
    tokio::time::advance(Duration::from_millis(60)).await;
    settle().await;
    feed.write("d");
    tokio::time::advance(Duration::from_millis(60)).await;
    settle().await;
    assert_eq!(written(), vec!["ab".to_string()]);
    tokio::time::advance(Duration::from_millis(60)).await;
    settle().await;
    assert_eq!(
        kinds(&port.posted()),
        vec!["open", "write", "resize", "write"]
    );
    assert_eq!(written(), vec!["ab".to_string(), "cd".to_string()]);
    client.end("test-done");
}

#[tokio::test]
async fn never_holds_more_than_a_pane_cap_of_unsent_output_and_sends_it_in_bounded_slices() {
    let port = Arc::new(FakePort::default());
    let client = SpillClient::new(port.clone());
    let pressure = CountingPressure::new(true);
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, Some(pressure.clone()));
    let chunk = "x".repeat(64 * 1024);
    let mut written = 0usize;
    for _ in 0..160 {
        feed.write(&chunk);
        written += chunk.len();
        let sent: usize = writes(&port.posted())
            .iter()
            .map(|(_, chars, _)| chars)
            .sum();
        assert!(written - sent < PANE_SEND_CHARS);
    }
    let largest = writes(&port.posted())
        .iter()
        .map(|(_, chars, _)| *chars)
        .max()
        .unwrap();
    assert!(largest <= SLICE_CHARS);
    assert_eq!(pressure.held.load(Ordering::SeqCst), written);
    client.end("test-done");
}

#[tokio::test]
async fn releases_held_output_only_as_the_worker_parses_it_so_a_slow_worker_pauses_the_pty() {
    let port = Arc::new(FakePort::default());
    let client = SpillClient::new(port.clone());
    let pressure = CountingPressure::new(true);
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, Some(pressure.clone()));
    for _ in 0..64 {
        feed.write(&"y".repeat(64 * 1024));
    }
    assert_eq!(pressure.released.load(Ordering::SeqCst), 0);
    let (session, chars, _) = writes(&port.posted()).remove(0);
    port.answer(SpillEvent::Parsed { session, chars });
    assert_eq!(pressure.released.load(Ordering::SeqCst), chars);
    client.end("test-done");
}

#[tokio::test]
async fn stops_taking_output_a_pane_cannot_pause_for_at_the_backlog_bound_then_resyncs_from_the_screen_once_the_worker_caught_up()
 {
    let port = Arc::new(FakePort::default());
    let client = SpillClient::new(port.clone());
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, Some(CountingPressure::new(false)));
    feed.watch_screen(Arc::new(|| "screen now".to_string()));
    for _ in 0..800 {
        feed.write(&"z".repeat(64 * 1024));
    }
    feed.resize(81, 24);
    let sent: usize = writes(&port.posted())
        .iter()
        .map(|(_, chars, _)| chars)
        .sum();
    assert!(i64::try_from(sent).unwrap() <= SPILL_BACKLOG.high);
    assert!(!kinds(&port.posted()).contains(&"resync"));
    for (session, chars, _) in writes(&port.posted()) {
        port.answer(SpillEvent::Parsed { session, chars });
    }
    let resyncs: Vec<SpillRequest> = port
        .posted()
        .into_iter()
        .filter(|request| matches!(request, SpillRequest::Resync { .. }))
        .collect();
    assert_eq!(
        resyncs,
        vec![SpillRequest::Resync {
            session: 0,
            screen: "screen now".to_string(),
        }]
    );
    client.end("test-done");
}

#[test]
fn marks_a_gap_only_where_lines_were_lost_and_spills_on_after_a_resync_without_repeating_the_screen()
 {
    let sink = Arc::new(LinesSink {
        lines: Mutex::new(Vec::new()),
    });
    let mut spill = SpillTerminal::new(80, 24, sink.clone(), 0).unwrap();
    spill.write(numbered(0, 3 * batch()).as_bytes());
    spill.resync("screen 1\r\nscreen 2");
    spill.write(numbered(5000, 3 * batch()).as_bytes());
    spill.close();
    let plain_lines: Vec<String> = sink.lines.lock().iter().map(|l| strip_vt(l)).collect();
    let gaps = plain_lines
        .iter()
        .filter(|l| **l == strip_vt(GAP_LINE))
        .count();
    assert_eq!(gaps, 1);
    assert_eq!(
        plain_lines[..usize::try_from(3 * batch()).unwrap()],
        numbered_lines(0, 3 * batch())
    );
    assert!(!plain_lines.contains(&"screen 1".to_string()));
    let tail_from = plain_lines.len() - usize::try_from(3 * batch()).unwrap();
    assert_eq!(plain_lines[tail_from..], numbered_lines(5000, 3 * batch()));
}

#[tokio::test]
async fn turns_history_off_with_the_reason_when_the_worker_is_gone_and_answers_what_was_asked() {
    let client = SpillClient::spawn().unwrap();
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, None);
    let tail = feed.tail();
    client.end("spill-worker-exited");
    assert!(tail.await.is_empty());
    assert_eq!(
        *made.failures.lock(),
        vec!["spill-worker-exited".to_string()]
    );
    assert!(!made.history.live());
    assert!(!client.alive());
    feed.write(&numbered(0, 10));
    assert!(feed.tail().await.is_empty());
}

#[tokio::test]
async fn numbers_a_restarted_shell_after_the_lines_its_previous_shell_spilled_on_the_way_out() {
    let client = SpillClient::spawn().unwrap();
    let made = make_history(HistoryOptions::default());
    let first = client.open(&made.history, 80, 24, None);
    first.write(&numbered(0, 30));
    first.close().await;
    let second = client.open(&made.history, 80, 24, None);
    second.write(&format!(
        "{}{}{}{}$ ",
        mark("C"),
        numbered(30, 3),
        mark("D;0"),
        mark("A")
    ));
    second.close().await;
    let mut expected = numbered_lines(0, 33);
    expected.push("$ ".to_string());
    assert_eq!(plain(&made.history).await, expected);
    let block = made.history.block(1).unwrap();
    assert_eq!((block.start, block.end), (30, Some(33)));
    client.end("test-done");
}

#[tokio::test]
async fn takes_the_next_shell_its_block_numbers_from_the_worker_counting_a_c_mark_main_had_not_parsed_yet()
 {
    let (histories, _root) = make_histories();
    let feed = histories.feed_for("p", 80, 24, None).unwrap();
    feed.write(&format!(
        "{}out\r\n{}{}$ ",
        mark("C"),
        mark("D;0"),
        mark("A")
    ));
    drop(feed.close());
    histories.settled("p").await;
    let next = histories.feed_for("p", 80, 24, None).unwrap();
    assert_eq!(next.seq_base(), 1);
    drop(next.close());
    histories.remove_all().await.unwrap();
}

#[tokio::test]
async fn decides_a_restart_continues_the_history_only_after_the_old_session_closed_so_its_restore_spills_nothing_twice()
 {
    let (histories, _root) = make_histories();
    let first = histories.feed_for("p", 80, 24, None).unwrap();
    first.write(&numbered(0, 2 * batch()));
    first.tail().await;
    let saved = numbered(0, 2 * batch());
    drop(first.close());
    histories.settled("p").await;
    let feed = histories.feed_for("p", 80, 24, None).unwrap();
    assert!(feed.continues());
    feed.restore(saved.trim_end());
    feed.write(&numbered(2 * batch(), 30));
    drop(feed.close());
    histories.settled("p").await;
    let lines = plain(&histories.get("p").unwrap()).await;
    let outputs: Vec<String> = lines
        .into_iter()
        .filter(|l| l.starts_with("out "))
        .collect();
    assert_eq!(outputs, numbered_lines(0, 2 * batch() + 30));
    histories.remove_all().await.unwrap();
}
