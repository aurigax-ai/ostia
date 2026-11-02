#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use ostia_contract::open_files::WaitOutcome;
use ostia_files::open_waits::{OpenWaits, WaitRequest};
use parking_lot::Mutex;
use tokio::sync::oneshot;

type Ended = Arc<Mutex<Vec<(String, Vec<String>)>>>;
type Cause = (&'static str, fn(&OpenWaits));

fn request() -> WaitRequest {
    WaitRequest {
        window_id: "1".to_owned(),
        workspace_id: "w1".to_owned(),
        caller_pane_id: "term".to_owned(),
        pane_ids: vec!["a".to_owned(), "b".to_owned()],
    }
}

fn recording() -> (OpenWaits, Ended) {
    let ended: Ended = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&ended);
    let waits = OpenWaits::new(move |window_id: &str, pane_ids: &[String]| {
        sink.lock().push((window_id.to_owned(), pane_ids.to_vec()));
    });
    (waits, ended)
}

async fn still_waiting(done: &mut oneshot::Receiver<WaitOutcome>) -> bool {
    tokio::time::timeout(Duration::from_millis(20), done)
        .await
        .is_err()
}

#[tokio::test(start_paused = true)]
async fn ends_with_closed_only_when_the_last_waited_tab_is_closed() {
    let (waits, ended) = recording();
    let mut wait = waits.start(request());
    waits.pane_closed("a");
    waits.pane_closed("unrelated");
    assert!(still_waiting(&mut wait.done).await);
    waits.pane_closed("b");
    assert_eq!(wait.done.await.unwrap(), WaitOutcome::Closed);
    assert_eq!(
        *ended.lock(),
        [("1".to_owned(), vec!["a".to_owned(), "b".to_owned()])]
    );
    assert_eq!(waits.size(), 0);
}

#[tokio::test(start_paused = true)]
async fn ends_with_gone_and_leaves_nothing_behind_when_the_cause_happens() {
    let causes: [Cause; 6] = [
        ("a waited tab moved out of reach", |w| w.pane_moved("a")),
        ("the caller’s pane moved", |w| w.pane_moved("term")),
        ("the workspace closed", |w| w.workspace_closed("w1")),
        ("the window or its renderer went away", |w| {
            w.window_gone("1")
        }),
        ("the caller’s shell exited", |w| w.caller_exited("term")),
        ("the caller’s pane closed", |w| w.pane_closed("term")),
    ];
    for (name, cause) in causes {
        let waits = OpenWaits::default();
        let wait = waits.start(request());
        cause(&waits);
        assert_eq!(wait.done.await.unwrap(), WaitOutcome::Gone, "{name}");
        assert_eq!(waits.size(), 0, "{name}");
    }
}

#[tokio::test(start_paused = true)]
async fn ends_with_gone_when_the_commands_connection_closes_and_tells_the_window_to_drop_the_line()
{
    let (waits, ended) = recording();
    let wait = waits.start(request());
    waits.cancel(wait.id);
    assert_eq!(wait.done.await.unwrap(), WaitOutcome::Gone);
    assert_eq!(
        *ended.lock(),
        [("1".to_owned(), vec!["a".to_owned(), "b".to_owned()])]
    );
    waits.cancel(wait.id);
    assert_eq!(ended.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn leaves_other_waits_alone() {
    let waits = OpenWaits::default();
    let mine = waits.start(request());
    let mut other = waits.start(WaitRequest {
        workspace_id: "w2".to_owned(),
        caller_pane_id: "t2".to_owned(),
        pane_ids: vec!["c".to_owned()],
        ..request()
    });
    waits.workspace_closed("w1");
    assert_eq!(mine.done.await.unwrap(), WaitOutcome::Gone);
    assert!(still_waiting(&mut other.done).await);
    waits.pane_closed("c");
    assert_eq!(other.done.await.unwrap(), WaitOutcome::Closed);
}

#[tokio::test(start_paused = true)]
async fn ends_at_once_when_no_tab_was_opened() {
    let (waits, ended) = recording();
    let wait = waits.start(WaitRequest {
        pane_ids: Vec::new(),
        ..request()
    });
    assert_eq!(wait.done.await.unwrap(), WaitOutcome::Gone);
    assert_eq!(waits.size(), 0);
    assert!(ended.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn gives_each_wait_its_own_id() {
    let waits = OpenWaits::default();
    let first = waits.start(request());
    let second = waits.start(request());
    let empty = waits.start(WaitRequest {
        pane_ids: Vec::new(),
        ..request()
    });
    assert_ne!(first.id, second.id);
    assert_ne!(second.id, empty.id);
    assert_eq!(waits.size(), 2);
}

#[tokio::test(start_paused = true)]
async fn counts_a_pane_named_twice_once_and_ends_with_closed_when_it_closes() {
    let waits = OpenWaits::default();
    let wait = waits.start(WaitRequest {
        pane_ids: vec!["a".to_owned(), "a".to_owned()],
        ..request()
    });
    waits.pane_closed("a");
    assert_eq!(wait.done.await.unwrap(), WaitOutcome::Closed);
}

#[tokio::test(start_paused = true)]
async fn runs_the_ended_callback_after_releasing_its_lock() {
    let slot: Arc<Mutex<Option<OpenWaits>>> = Arc::new(Mutex::new(None));
    let seen: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
    let (inner_slot, inner_seen) = (Arc::clone(&slot), Arc::clone(&seen));
    let waits = OpenWaits::new(move |_: &str, _: &[String]| {
        let size = inner_slot.lock().as_ref().map(OpenWaits::size);
        inner_seen.lock().extend(size);
    });
    *slot.lock() = Some(waits.clone());
    let wait = waits.start(request());
    waits.cancel(wait.id);
    assert_eq!(wait.done.await.unwrap(), WaitOutcome::Gone);
    assert_eq!(*seen.lock(), [0]);
}
