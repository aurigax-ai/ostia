#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ostia_gateway::bind_follower::{BindFollower, BindFollowerOptions};
use parking_lot::Mutex;
use tokio::sync::Notify;

const EVERY_MS: u64 = 1000;

struct Probe {
    resolved: Arc<Mutex<Option<String>>>,
    bound: Arc<Mutex<Option<String>>>,
    rebinds: Arc<AtomicUsize>,
    finish: Arc<Notify>,
    follower: BindFollower,
}

fn probe(hold_rebind: bool) -> Probe {
    let resolved = Arc::new(Mutex::new(Some("192.168.2.108".to_owned())));
    let bound = Arc::new(Mutex::new(Some("192.168.2.108".to_owned())));
    let rebinds = Arc::new(AtomicUsize::new(0));
    let finish = Arc::new(Notify::new());
    let follower = BindFollower::create(BindFollowerOptions {
        every_ms: EVERY_MS,
        resolve: {
            let resolved = resolved.clone();
            Arc::new(move || resolved.lock().clone())
        },
        bound: {
            let bound = bound.clone();
            Arc::new(move || bound.lock().clone())
        },
        rebind: {
            let rebinds = rebinds.clone();
            let finish = finish.clone();
            let bound = bound.clone();
            let resolved = resolved.clone();
            Arc::new(move || -> Pin<Box<dyn Future<Output = ()> + Send>> {
                let rebinds = rebinds.clone();
                let finish = finish.clone();
                let bound = bound.clone();
                let resolved = resolved.clone();
                Box::pin(async move {
                    rebinds.fetch_add(1, Ordering::SeqCst);
                    if hold_rebind {
                        finish.notified().await;
                    }
                    *bound.lock() = resolved.lock().clone();
                })
            })
        },
    });
    Probe {
        resolved,
        bound,
        rebinds,
        finish,
        follower,
    }
}

async fn elapse(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn rebinds(probe: &Probe) -> usize {
    probe.rebinds.load(Ordering::SeqCst)
}

#[tokio::test(start_paused = true)]
async fn rebinds_on_a_tick_when_the_address_it_resolves_is_not_the_one_bound() {
    let p = probe(false);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 1);
    assert_eq!(p.bound.lock().as_deref(), Some("10.0.0.7"));
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 1);
}

#[tokio::test(start_paused = true)]
async fn does_nothing_while_the_resolved_address_is_the_bound_one() {
    let p = probe(false);
    p.follower.start();
    elapse(EVERY_MS * 5).await;
    assert_eq!(rebinds(&p), 0);
}

#[tokio::test(start_paused = true)]
async fn treats_two_missing_addresses_as_the_same_and_one_missing_as_different() {
    let p = probe(false);
    *p.resolved.lock() = None;
    *p.bound.lock() = None;
    p.follower.start();
    elapse(EVERY_MS * 2).await;
    assert_eq!(rebinds(&p), 0);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 1);
    *p.resolved.lock() = None;
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 2);
}

#[tokio::test(start_paused = true)]
async fn waits_one_full_interval_before_the_first_tick() {
    let p = probe(false);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    elapse(0).await;
    assert_eq!(rebinds(&p), 0);
    elapse(EVERY_MS - 1).await;
    assert_eq!(rebinds(&p), 0);
    elapse(1).await;
    assert_eq!(rebinds(&p), 1);
}

#[tokio::test(start_paused = true)]
async fn counts_the_interval_from_the_call_to_start() {
    let p = probe(false);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    tokio::time::advance(Duration::from_millis(EVERY_MS)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert_eq!(rebinds(&p), 1);
}

#[tokio::test(start_paused = true)]
async fn skips_a_tick_while_the_previous_rebind_is_still_running() {
    let p = probe(true);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    elapse(EVERY_MS * 4).await;
    assert_eq!(rebinds(&p), 1);
    p.finish.notify_one();
    elapse(0).await;
    assert_eq!(p.bound.lock().as_deref(), Some("10.0.0.7"));
    *p.resolved.lock() = Some("10.0.0.8".to_owned());
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 2);
}

#[tokio::test(start_paused = true)]
async fn rebinds_again_on_the_next_tick_when_the_first_rebind_did_not_catch_up() {
    let p = probe(false);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    elapse(EVERY_MS).await;
    *p.resolved.lock() = Some("10.0.0.9".to_owned());
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 2);
    assert_eq!(p.bound.lock().as_deref(), Some("10.0.0.9"));
}

#[tokio::test(start_paused = true)]
async fn starting_twice_keeps_one_timer() {
    let p = probe(false);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    p.follower.start();
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 1);
    *p.resolved.lock() = Some("10.0.0.8".to_owned());
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 2);
}

#[tokio::test(start_paused = true)]
async fn stop_ends_the_ticks_and_start_can_run_again() {
    let p = probe(false);
    *p.resolved.lock() = Some("10.0.0.7".to_owned());
    p.follower.start();
    p.follower.stop();
    elapse(EVERY_MS * 3).await;
    assert_eq!(rebinds(&p), 0);
    p.follower.start();
    elapse(EVERY_MS).await;
    assert_eq!(rebinds(&p), 1);
    p.follower.stop();
    p.follower.stop();
    *p.resolved.lock() = Some("10.0.0.8".to_owned());
    elapse(EVERY_MS * 3).await;
    assert_eq!(rebinds(&p), 1);
}
