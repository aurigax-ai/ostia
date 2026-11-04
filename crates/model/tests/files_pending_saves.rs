#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::pending;
use std::time::Duration;

use ostia_model::files::pending_saves::{PendingSaves, SAVE_WAIT};
use tokio::time::{Instant, sleep};

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

async fn done_after(seconds: u64) -> u8 {
    sleep(secs(seconds)).await;
    1
}

#[test]
fn waits_ten_seconds_for_saves_by_default() {
    assert_eq!(SAVE_WAIT, secs(10));
}

#[tokio::test(start_paused = true)]
async fn gives_back_the_result_of_the_save() {
    let saves = PendingSaves::default();
    assert_eq!(saves.track("/w/a.txt", done_after(1)).await.unwrap(), 1);
}

#[tokio::test(start_paused = true)]
async fn gives_back_a_failed_save_as_it_is() {
    let saves = PendingSaves::default();
    let failed = saves
        .track("/w/a.txt", async { Err::<u8, &str>("disk full") })
        .await
        .unwrap();
    assert_eq!(failed, Err("disk full"));
}

#[tokio::test(start_paused = true)]
async fn settles_at_once_when_nothing_is_pending() {
    let saves = PendingSaves::default();
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], SAVE_WAIT).await;
    saves.settle(&[], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn waits_for_a_pending_save_of_a_listed_path() {
    let saves = PendingSaves::default();
    let _save = saves.track("/w/a.txt", done_after(3));
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), secs(3));
}

#[tokio::test(start_paused = true)]
async fn does_not_wait_for_a_path_that_is_not_listed() {
    let saves = PendingSaves::default();
    let _other = saves.track("/w/b.txt", pending::<u8>());
    let _save = saves.track("/w/a.txt", done_after(2));
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), secs(2));
}

#[tokio::test(start_paused = true)]
async fn waits_for_every_save_of_every_listed_path() {
    let saves = PendingSaves::default();
    let _one = saves.track("/w/a.txt", done_after(2));
    let _two = saves.track("/w/a.txt", done_after(4));
    let _three = saves.track("/w/b.txt", done_after(5));
    let start = Instant::now();
    saves.settle(&["/w/a.txt", "/w/b.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), secs(5));
}

#[tokio::test(start_paused = true)]
async fn settles_once_a_save_has_failed() {
    let saves = PendingSaves::default();
    let _save = saves.track("/w/a.txt", async {
        sleep(secs(2)).await;
        Err::<u8, &str>("denied")
    });
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), secs(2));
}

#[tokio::test(start_paused = true)]
async fn gives_up_after_the_time_limit_when_a_save_never_ends() {
    let saves = PendingSaves::default();
    let _save = saves.track("/w/a.txt", pending::<u8>());
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), SAVE_WAIT);
}

#[tokio::test(start_paused = true)]
async fn gives_up_at_a_shorter_limit_than_the_save_needs() {
    let saves = PendingSaves::default();
    let _save = saves.track("/w/a.txt", done_after(8));
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], secs(3)).await;
    assert_eq!(start.elapsed(), secs(3));
}

#[tokio::test(start_paused = true)]
async fn a_limit_of_zero_does_not_wait() {
    let saves = PendingSaves::default();
    let _save = saves.track("/w/a.txt", pending::<u8>());
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], Duration::ZERO).await;
    assert_eq!(start.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn forgets_saves_that_have_finished() {
    let saves = PendingSaves::default();
    let _save = saves.track("/w/a.txt", done_after(1));
    sleep(secs(2)).await;
    let start = Instant::now();
    saves.settle(&["/w/a.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn takes_the_pending_saves_when_settle_is_called_not_when_it_is_awaited() {
    let saves = PendingSaves::default();
    let _early = saves.track("/w/a.txt", done_after(1));
    let settling = saves.settle(&["/w/a.txt"], SAVE_WAIT);
    let _late = saves.track("/w/a.txt", pending::<u8>());
    let start = Instant::now();
    settling.await;
    assert_eq!(start.elapsed(), secs(1));
}

#[tokio::test(start_paused = true)]
async fn two_clones_share_the_pending_saves() {
    let saves = PendingSaves::default();
    let other = saves.clone();
    let _save = saves.track("/w/a.txt", done_after(2));
    let start = Instant::now();
    other.settle(&["/w/a.txt"], SAVE_WAIT).await;
    assert_eq!(start.elapsed(), secs(2));
}
