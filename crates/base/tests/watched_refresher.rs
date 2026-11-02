#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeSet, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_base::watched_refresher::{RefreshSource, WatchedRefresher, WatchedRefresherOptions};
use serde::Serialize;
use serde_json::json;
use tokio::sync::oneshot;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
struct Items {
    sidebar: Vec<String>,
}

#[derive(Default)]
struct State {
    enabled: AtomicBool,
    poll_ms: AtomicU64,
    reads: Mutex<Vec<BTreeSet<String>>>,
    gate: Mutex<Option<oneshot::Receiver<()>>>,
    failure: Mutex<Option<String>>,
    published: AtomicUsize,
    cleared: AtomicUsize,
    version: AtomicUsize,
}

#[derive(Clone, Default)]
struct Source(Arc<State>);

impl RefreshSource for Source {
    type Data = usize;
    type Items = Items;

    fn enabled(&self) -> bool {
        self.0.enabled.load(Ordering::SeqCst)
    }

    fn poll_ms(&self) -> u64 {
        self.0.poll_ms.load(Ordering::SeqCst)
    }

    fn read(
        &self,
        watched: &BTreeSet<String>,
    ) -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send>> {
        let state = Arc::clone(&self.0);
        state.reads.lock().unwrap().push(watched.clone());
        let gate = state.gate.lock().unwrap().take();
        Box::pin(async move {
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            if let Some(message) = state.failure.lock().unwrap().clone() {
                return Err(message);
            }
            Ok(state.version.load(Ordering::SeqCst))
        })
    }

    fn items_for(&self, ids: &BTreeSet<String>, data: &usize) -> Items {
        Items {
            sidebar: ids.iter().map(|id| format!("{id}:{data}")).collect(),
        }
    }

    fn published(&self, _data: &usize) {
        self.0.published.fetch_add(1, Ordering::SeqCst);
    }

    fn cleared(&self) {
        self.0.cleared.fetch_add(1, Ordering::SeqCst);
    }
}

type Sent = Arc<Mutex<Vec<(String, String, Items)>>>;

struct Rig {
    source: Source,
    refresher: WatchedRefresher<Source>,
    sent: Sent,
    logs: Arc<Mutex<Vec<String>>>,
}

fn rig() -> Rig {
    let source = Source::default();
    source.0.enabled.store(true, Ordering::SeqCst);
    source.0.poll_ms.store(10_000, Ordering::SeqCst);
    let sent: Sent = Arc::default();
    let logs: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = Arc::clone(&sent);
    let log_sink = Arc::clone(&logs);
    let refresher = WatchedRefresher::new(
        source.clone(),
        WatchedRefresherOptions {
            channel: "git:items".to_owned(),
            debounce: Duration::from_millis(200),
            events: HashSet::from(["git.changed".to_owned(), "pane.cwd".to_owned()]),
            send: Arc::new(move |window, channel, items: &Items| {
                sink.lock()
                    .unwrap()
                    .push((window.to_owned(), channel.to_owned(), items.clone()));
            }),
            log: Some(Arc::new(move |line| {
                log_sink.lock().unwrap().push(line.to_owned());
            })),
        },
    );
    Rig {
        source,
        refresher,
        sent,
        logs,
    }
}

async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    settle().await;
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

fn reads(rig: &Rig) -> usize {
    rig.source.0.reads.lock().unwrap().len()
}

fn items(entries: &[&str]) -> Items {
    Items {
        sidebar: entries.iter().map(|entry| (*entry).to_owned()).collect(),
    }
}

fn sent(rig: &Rig) -> Vec<(String, Items)> {
    rig.sent
        .lock()
        .unwrap()
        .iter()
        .map(|(window, _, items)| (window.clone(), items.clone()))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn reads_the_union_of_the_watched_workspaces_at_once_when_a_window_starts_watching() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a", "b"]));
    rig.refresher.watch("w2", &json!(["b", "c"]));
    assert!(rig.refresher.active());
    assert!(rig.refresher.pending());
    assert!(rig.refresher.polling());
    assert_eq!(reads(&rig), 0);
    advance(0).await;
    assert_eq!(reads(&rig), 1);
    assert_eq!(
        rig.source.0.reads.lock().unwrap()[0],
        BTreeSet::from(["a".to_owned(), "b".to_owned(), "c".to_owned()])
    );
    assert!(!rig.refresher.pending());
}

#[tokio::test(start_paused = true)]
async fn sends_each_window_the_items_of_its_own_workspaces_on_the_channel() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    rig.refresher.watch("w2", &json!(["b"]));
    advance(0).await;
    let sent = rig.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|(_, channel, _)| channel == "git:items"));
    assert!(sent.contains(&("w1".to_owned(), "git:items".to_owned(), items(&["a:0"]))));
    assert!(sent.contains(&("w2".to_owned(), "git:items".to_owned(), items(&["b:0"]))));
    assert_eq!(rig.source.0.published.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn does_nothing_while_the_source_is_disabled() {
    let rig = rig();
    rig.source.0.enabled.store(false, Ordering::SeqCst);
    rig.refresher.watch("w1", &json!(["a"]));
    assert!(!rig.refresher.active());
    assert!(!rig.refresher.pending());
    assert!(!rig.refresher.polling());
    advance(60_000).await;
    rig.refresher.activity("git.changed");
    advance(1_000).await;
    rig.refresher.refresh().await;
    assert_eq!(reads(&rig), 0);
    assert!(rig.sent.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn waits_the_debounce_after_a_listed_event_and_reads_once_for_a_burst() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    assert_eq!(reads(&rig), 1);
    rig.refresher.activity("git.changed");
    advance(150).await;
    rig.refresher.activity("pane.cwd");
    advance(150).await;
    assert_eq!(reads(&rig), 1);
    assert!(rig.refresher.pending());
    advance(60).await;
    assert_eq!(reads(&rig), 2);
    assert!(!rig.refresher.pending());
}

#[tokio::test(start_paused = true)]
async fn ignores_an_event_that_is_not_in_the_list_and_events_while_nothing_is_watched() {
    let rig = rig();
    rig.refresher.activity("git.changed");
    assert!(!rig.refresher.pending());
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.refresher.activity("terminal.output");
    assert!(!rig.refresher.pending());
    advance(1_000).await;
    assert_eq!(reads(&rig), 1);
}

#[tokio::test(start_paused = true)]
async fn polls_on_the_interval_of_the_source_while_focused() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    assert_eq!(reads(&rig), 1);
    advance(10_000).await;
    assert_eq!(reads(&rig), 2);
    advance(10_000).await;
    assert_eq!(reads(&rig), 3);
}

#[tokio::test(start_paused = true)]
async fn arms_the_poll_again_when_the_interval_of_the_source_changed() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.source.0.poll_ms.store(2_000, Ordering::SeqCst);
    rig.refresher.watch("w1", &json!(["a", "b"]));
    advance(0).await;
    assert_eq!(reads(&rig), 2);
    advance(2_000).await;
    assert_eq!(reads(&rig), 3);
    advance(2_000).await;
    assert_eq!(reads(&rig), 4);
}

#[tokio::test(start_paused = true)]
async fn stops_polling_when_the_app_loses_focus_and_reads_at_once_when_it_gets_it_back() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.refresher.set_focused(false);
    assert!(!rig.refresher.polling());
    advance(60_000).await;
    assert_eq!(reads(&rig), 1);
    rig.refresher.set_focused(true);
    assert!(rig.refresher.polling());
    advance(0).await;
    assert_eq!(reads(&rig), 2);
}

#[tokio::test(start_paused = true)]
async fn ignores_a_focus_change_to_the_state_it_already_has_or_while_nothing_is_watched() {
    let rig = rig();
    rig.refresher.set_focused(true);
    rig.refresher.set_focused(false);
    assert!(!rig.refresher.polling());
    rig.refresher.set_focused(true);
    assert!(!rig.refresher.pending());
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.refresher.set_focused(true);
    advance(0).await;
    assert_eq!(reads(&rig), 1);
}

#[tokio::test(start_paused = true)]
async fn runs_one_more_read_after_a_read_that_overlapped_a_request() {
    let rig = rig();
    let (open, gate) = oneshot::channel();
    *rig.source.0.gate.lock().unwrap() = Some(gate);
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    assert_eq!(reads(&rig), 1);
    rig.refresher.refresh().await;
    assert_eq!(reads(&rig), 1);
    rig.source.0.version.store(7, Ordering::SeqCst);
    open.send(()).unwrap();
    settle().await;
    assert!(rig.refresher.pending());
    advance(200).await;
    assert_eq!(reads(&rig), 2);
    assert_eq!(
        sent(&rig).last().unwrap(),
        &("w1".to_owned(), items(&["a:7"]))
    );
}

#[tokio::test(start_paused = true)]
async fn sends_a_window_only_when_its_items_changed() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    assert_eq!(sent(&rig).len(), 1);
    rig.refresher.refresh().await;
    assert_eq!(sent(&rig).len(), 1);
    assert_eq!(rig.source.0.published.load(Ordering::SeqCst), 2);
    rig.source.0.version.store(1, Ordering::SeqCst);
    rig.refresher.refresh().await;
    assert_eq!(sent(&rig).len(), 2);
    assert_eq!(sent(&rig)[1].1, items(&["a:1"]));
}

#[tokio::test(start_paused = true)]
async fn sends_empty_items_to_a_window_that_stopped_watching_while_others_still_do() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    rig.refresher.watch("w2", &json!(["b"]));
    advance(0).await;
    rig.sent.lock().unwrap().clear();
    rig.refresher.watch("w2", &json!([]));
    advance(0).await;
    assert_eq!(sent(&rig), vec![("w2".to_owned(), Items::default())]);
}

#[tokio::test(start_paused = true)]
async fn stops_everything_and_empties_every_window_once_the_last_window_stops_watching() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    rig.refresher.watch("w2", &json!(["b"]));
    advance(0).await;
    rig.sent.lock().unwrap().clear();
    rig.refresher.watch("w1", &json!([]));
    advance(0).await;
    rig.sent.lock().unwrap().clear();
    rig.refresher.watch("w2", &json!([]));
    assert!(!rig.refresher.active());
    assert!(!rig.refresher.polling());
    assert!(!rig.refresher.pending());
    assert_eq!(rig.source.0.cleared.load(Ordering::SeqCst), 1);
    let mut windows: Vec<_> = sent(&rig);
    windows.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(windows, vec![("w2".to_owned(), Items::default())]);
    let reads_before = reads(&rig);
    advance(60_000).await;
    assert_eq!(reads(&rig), reads_before);
}

#[tokio::test(start_paused = true)]
async fn sends_nothing_to_a_window_that_is_gone_and_forgets_what_it_was_sent() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.sent.lock().unwrap().clear();
    rig.refresher.window_gone("w1");
    advance(0).await;
    assert!(rig.sent.lock().unwrap().is_empty());
    assert!(!rig.refresher.active());
    assert!(!rig.refresher.polling());
    assert_eq!(rig.source.0.cleared.load(Ordering::SeqCst), 1);
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    assert_eq!(sent(&rig).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn reads_again_for_the_windows_left_when_one_window_is_gone() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    rig.refresher.watch("w2", &json!(["b"]));
    advance(0).await;
    rig.refresher.window_gone("w1");
    advance(0).await;
    assert_eq!(reads(&rig), 2);
    assert_eq!(
        rig.source.0.reads.lock().unwrap()[1],
        BTreeSet::from(["b".to_owned()])
    );
    assert_eq!(rig.source.0.cleared.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn logs_a_failed_read_and_reads_again_on_the_next_request() {
    let rig = rig();
    *rig.source.0.failure.lock().unwrap() = Some("git exploded".to_owned());
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    assert_eq!(*rig.logs.lock().unwrap(), vec!["git exploded".to_owned()]);
    assert!(rig.sent.lock().unwrap().is_empty());
    assert_eq!(rig.source.0.published.load(Ordering::SeqCst), 0);
    *rig.source.0.failure.lock().unwrap() = None;
    rig.refresher.refresh().await;
    assert_eq!(sent(&rig).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn drops_the_result_of_a_read_that_finished_after_nothing_was_watched() {
    let rig = rig();
    let (open, gate) = oneshot::channel();
    *rig.source.0.gate.lock().unwrap() = Some(gate);
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.refresher.watch("w1", &json!([]));
    open.send(()).unwrap();
    settle().await;
    assert!(rig.sent.lock().unwrap().is_empty());
    assert_eq!(rig.source.0.published.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn cancels_the_timer_and_the_poll_when_stopped() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    rig.refresher.activity("git.changed");
    rig.refresher.stop();
    assert!(!rig.refresher.pending());
    assert!(!rig.refresher.polling());
    advance(60_000).await;
    assert_eq!(reads(&rig), 0);
    assert!(rig.refresher.active());
}

#[tokio::test(start_paused = true)]
async fn does_not_start_a_second_poll_for_a_second_window() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a"]));
    advance(0).await;
    rig.refresher.watch("w2", &json!(["b"]));
    advance(0).await;
    assert_eq!(reads(&rig), 2);
    advance(10_000).await;
    assert_eq!(reads(&rig), 3);
}

#[tokio::test(start_paused = true)]
async fn ignores_a_watch_call_that_does_not_change_the_set() {
    let rig = rig();
    rig.refresher.watch("w1", &json!(["a", "b"]));
    advance(0).await;
    rig.refresher.watch("w1", &json!(["b", "a"]));
    advance(0).await;
    assert_eq!(reads(&rig), 1);
}
