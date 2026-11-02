#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::poll;
use ostia_base::clock::Clock;
use ostia_panes::pane_waking::{PaneWaking, WakeEnd, WakeWaitResult};
use tokio_util::sync::CancellationToken;

fn never() -> CancellationToken {
    CancellationToken::new()
}

fn drain(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<(String, WakeEnd)>) -> Vec<String> {
    let mut seen = Vec::new();
    while let Ok((pane_id, how)) = receiver.try_recv() {
        let how = match how {
            WakeEnd::Started => "started",
            WakeEnd::Failed => "failed",
            WakeEnd::Closed => "closed",
        };
        seen.push(format!("{pane_id}:{how}"));
    }
    seen
}

fn fixed(now: i64) -> Clock {
    Arc::new(move || now)
}

#[test]
fn tells_a_standing_subscriber_how_each_wake_ended() {
    let waking = PaneWaking::new();
    let mut ends = waking.subscribe();
    waking.start("p1");
    waking.end("p1", WakeEnd::Failed, None);
    waking.end("p1", WakeEnd::Failed, None);
    waking.start("p2");
    waking.end("p2", WakeEnd::Started, None);
    assert_eq!(drain(&mut ends), vec!["p1:failed", "p2:started"]);
}

#[test]
fn holds_a_pane_from_its_wake_until_it_ends_once() {
    let waking = PaneWaking::new();
    assert!(!waking.has("p1"));
    waking.start("p1");
    assert!(waking.has("p1"));
    waking.end("p1", WakeEnd::Started, None);
    assert!(!waking.has("p1"));
}

#[test]
fn keeps_the_reason_of_a_failed_end_until_the_pane_wakes_again_and_abandons_without_an_end() {
    let waking = PaneWaking::new();
    waking.start("p1");
    waking.end(
        "p1",
        WakeEnd::Failed,
        Some("its agent exited with code 1 before it started"),
    );
    assert_eq!(waking.last_end("p1"), Some(WakeEnd::Failed));
    assert_eq!(
        waking.last_reason("p1").as_deref(),
        Some("its agent exited with code 1 before it started")
    );
    waking.start("p1");
    assert_eq!(waking.last_reason("p1"), None);
    waking.abandon("p1");
    assert!(!waking.has("p1"));
    assert_eq!(waking.last_end("p1"), None);
}

#[tokio::test(start_paused = true)]
async fn answers_started_at_once_for_panes_that_are_not_waking() {
    let waking = PaneWaking::new();
    assert_eq!(
        waking
            .until(&["p1"], Duration::from_millis(1000), &never())
            .await,
        WakeWaitResult::Started
    );
}

#[tokio::test(start_paused = true)]
async fn answers_started_only_after_every_pane_started() {
    let waking = PaneWaking::new();
    waking.start("p1");
    waking.start("p2");
    let token = never();
    let done = waking.until(&["p1", "p2"], Duration::from_secs(60), &token);
    tokio::pin!(done);
    assert!(poll!(done.as_mut()).is_pending());
    waking.end("p1", WakeEnd::Started, None);
    assert!(poll!(done.as_mut()).is_pending());
    waking.end("p2", WakeEnd::Started, None);
    assert_eq!(done.await, WakeWaitResult::Started);
}

#[tokio::test(start_paused = true)]
async fn answers_the_first_pane_that_failed_or_closed() {
    let waking = PaneWaking::new();
    waking.start("p1");
    waking.start("p2");
    let token = never();
    let ended = waking.until(&["p1", "p2"], Duration::from_secs(60), &token);
    tokio::pin!(ended);
    assert!(poll!(ended.as_mut()).is_pending());
    waking.end("p2", WakeEnd::Closed, None);
    assert_eq!(
        ended.await,
        WakeWaitResult::Closed {
            pane_id: "p2".to_owned()
        }
    );
    waking.start("p3");
    let failed = waking.until(&["p3"], Duration::from_secs(60), &token);
    tokio::pin!(failed);
    assert!(poll!(failed.as_mut()).is_pending());
    waking.end("p3", WakeEnd::Failed, None);
    assert_eq!(
        failed.await,
        WakeWaitResult::Failed {
            pane_id: "p3".to_owned()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn ignores_panes_it_does_not_wait_on_and_an_end_for_a_pane_that_is_not_waking() {
    let waking = PaneWaking::new();
    waking.start("p1");
    waking.start("other");
    let token = never();
    let done = waking.until(&["p1"], Duration::from_secs(60), &token);
    tokio::pin!(done);
    assert!(poll!(done.as_mut()).is_pending());
    waking.end("other", WakeEnd::Failed, None);
    waking.end("nobody", WakeEnd::Failed, None);
    assert!(poll!(done.as_mut()).is_pending());
    waking.end("p1", WakeEnd::Started, None);
    assert_eq!(done.await, WakeWaitResult::Started);
}

#[tokio::test(start_paused = true)]
async fn times_out_and_stops_when_the_caller_goes_away() {
    let waking = PaneWaking::new();
    waking.start("p1");
    let timed_out = waking
        .until(&["p1"], Duration::from_millis(1000), &never())
        .await;
    assert_eq!(timed_out, WakeWaitResult::Timeout);
    assert!(waking.has("p1"));

    let token = never();
    let gone = waking.until(&["p1"], Duration::from_secs(60), &token);
    tokio::pin!(gone);
    assert!(poll!(gone.as_mut()).is_pending());
    token.cancel();
    assert_eq!(gone.await, WakeWaitResult::Timeout);
}

#[test]
fn records_when_a_wake_started_and_forgets_it_at_the_end_or_when_abandoned() {
    let waking = PaneWaking::with_clock(fixed(1234));
    assert_eq!(waking.since("p1"), None);
    waking.start("p1");
    assert_eq!(waking.since("p1"), Some(1234));
    waking.end("p1", WakeEnd::Started, None);
    assert_eq!(waking.since("p1"), None);
    waking.start("p2");
    waking.abandon("p2");
    assert_eq!(waking.since("p2"), None);
}

#[test]
fn reports_the_last_end_only_while_the_pane_is_not_waking() {
    let waking = PaneWaking::new();
    waking.start("p1");
    waking.end("p1", WakeEnd::Closed, None);
    assert_eq!(waking.last_end("p1"), Some(WakeEnd::Closed));
    waking.start("p1");
    assert_eq!(waking.last_end("p1"), None);
    waking.end("p1", WakeEnd::Started, None);
    assert_eq!(waking.last_end("p1"), Some(WakeEnd::Started));
}

#[test]
fn keeps_no_reason_for_an_end_that_gives_none_or_an_empty_one() {
    let waking = PaneWaking::new();
    waking.start("p1");
    waking.end("p1", WakeEnd::Failed, Some(""));
    assert_eq!(waking.last_reason("p1"), None);
    waking.start("p2");
    waking.end("p2", WakeEnd::Failed, None);
    assert_eq!(waking.last_reason("p2"), None);
}

#[test]
fn ignores_an_end_for_a_pane_that_is_not_waking_in_every_record() {
    let waking = PaneWaking::new();
    let mut ends = waking.subscribe();
    let mut changes = waking.changes().subscribe();
    waking.end("nobody", WakeEnd::Failed, Some("why"));
    assert_eq!(waking.last_end("nobody"), None);
    assert_eq!(waking.last_reason("nobody"), None);
    assert!(drain(&mut ends).is_empty());
    assert!(changes.try_recv().is_err());
}

#[test]
fn fires_its_change_signal_once_for_each_end_that_counts() {
    let waking = PaneWaking::new();
    let mut changes = waking.changes().subscribe();
    waking.start("p1");
    assert!(changes.try_recv().is_err());
    waking.end("p1", WakeEnd::Started, None);
    assert!(changes.try_recv().is_ok());
    assert!(changes.try_recv().is_err());
    waking.end("p1", WakeEnd::Started, None);
    assert!(changes.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn waits_on_the_panes_that_wake_and_skips_the_ones_that_do_not() {
    let waking = PaneWaking::new();
    waking.start("p1");
    let token = never();
    let done = waking.until(&["p1", "idle"], Duration::from_secs(60), &token);
    tokio::pin!(done);
    assert!(poll!(done.as_mut()).is_pending());
    waking.end("p1", WakeEnd::Started, None);
    assert_eq!(done.await, WakeWaitResult::Started);
}

#[tokio::test(start_paused = true)]
async fn still_tells_a_standing_subscriber_while_a_caller_waits() {
    let waking = PaneWaking::new();
    let mut ends = waking.subscribe();
    waking.start("p1");
    let token = never();
    let done = waking.until(&["p1"], Duration::from_secs(60), &token);
    tokio::pin!(done);
    assert!(poll!(done.as_mut()).is_pending());
    waking.end("p1", WakeEnd::Failed, None);
    assert_eq!(
        done.await,
        WakeWaitResult::Failed {
            pane_id: "p1".to_owned()
        }
    );
    assert_eq!(drain(&mut ends), vec!["p1:failed"]);
}
