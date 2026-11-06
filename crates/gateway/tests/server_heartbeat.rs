#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ostia_gateway::server_client::ServerError;
use ostia_gateway::server_heartbeat::start_server_heartbeat;

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

struct Account {
    beats: Arc<AtomicUsize>,
    stop: ostia_gateway::server_heartbeat::HeartbeatStop,
}

fn start(signed_in: bool, fails: bool) -> Account {
    let beats = Arc::new(AtomicUsize::new(0));
    let counted = beats.clone();
    let stop = start_server_heartbeat(
        move || signed_in,
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async move {
                if fails {
                    Err(ServerError::new(429, "rate-limited"))
                } else {
                    Ok(())
                }
            }
        },
    );
    Account { beats, stop }
}

async fn advance(by: Duration) {
    tokio::time::advance(by).await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

fn count(account: &Account) -> usize {
    account.beats.load(Ordering::SeqCst)
}

#[tokio::test(start_paused = true)]
async fn sya_c200_checks_in_at_start_and_then_every_24_hours_while_signed_in() {
    let account = start(true, false);
    assert_eq!(count(&account), 1, "the first check starts at the call");
    advance(Duration::ZERO).await;
    assert_eq!(count(&account), 1);
    advance(DAY - Duration::from_secs(1)).await;
    assert_eq!(count(&account), 1);
    advance(Duration::from_secs(2)).await;
    assert_eq!(count(&account), 2);
    advance(DAY).await;
    assert_eq!(count(&account), 3);
    account.stop.stop();
    advance(DAY * 2).await;
    assert_eq!(count(&account), 3);
}

#[tokio::test(start_paused = true)]
async fn sya_c201_sends_nothing_while_signed_out() {
    let account = start(false, false);
    advance(DAY * 2).await;
    assert_eq!(count(&account), 0);
}

#[tokio::test(start_paused = true)]
async fn sya_c202_shrugs_off_a_refusal_and_asks_again_only_the_next_day() {
    let account = start(true, true);
    advance(DAY / 2).await;
    assert_eq!(count(&account), 1);
    advance(DAY / 2 + Duration::from_secs(1)).await;
    assert_eq!(count(&account), 2);
}

#[tokio::test(start_paused = true)]
async fn asks_the_account_again_each_day_so_a_sign_out_stops_the_next_check() {
    let signed_in = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let beats = Arc::new(AtomicUsize::new(0));
    let (flag, counted) = (signed_in.clone(), beats.clone());
    let stop = start_server_heartbeat(
        move || flag.load(Ordering::SeqCst),
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        },
    );
    advance(Duration::ZERO).await;
    assert_eq!(beats.load(Ordering::SeqCst), 1);
    signed_in.store(false, Ordering::SeqCst);
    advance(DAY + Duration::from_secs(1)).await;
    assert_eq!(beats.load(Ordering::SeqCst), 1);
    signed_in.store(true, Ordering::SeqCst);
    advance(DAY).await;
    assert_eq!(beats.load(Ordering::SeqCst), 2);
    stop.stop();
}
