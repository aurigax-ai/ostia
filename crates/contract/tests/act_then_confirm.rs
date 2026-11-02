#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::act_then_confirm::{
    ChangeSignal, ConfirmSpec, Off, Settled, Subscribe, Wake, act_then_confirm, any_of, confirmed,
    mismatch, poll_every,
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::yield_now;

fn inert() -> Subscribe {
    Subscribe::new(|_wake| Box::new(|| {}))
}

fn counter() -> (Wake, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let wake: Wake = Arc::new(move || {
        seen.fetch_add(1, Ordering::SeqCst);
    });
    (wake, count)
}

async fn settle() {
    for _ in 0..8 {
        yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn acts_first_then_answers_with_what_it_observed_at_once() {
    let steps = Arc::new(Mutex::new(Vec::new()));
    let act_steps = steps.clone();
    let observe_steps = steps.clone();
    let seen = act_then_confirm(ConfirmSpec {
        act: move || async move {
            act_steps.lock().unwrap().push("act");
        },
        observe: move || {
            let steps = observe_steps.clone();
            async move {
                steps.lock().unwrap().push("observe");
                Some(confirmed("done"))
            }
        },
        signal: inert(),
        timeout: Duration::from_secs(1),
        on_timeout: || async { mismatch("late", None) },
    })
    .await;
    assert_eq!(*steps.lock().unwrap(), vec!["act", "observe"]);
    assert_eq!(seen, Settled::Confirmed("done"));
}

#[tokio::test(start_paused = true)]
async fn looks_again_on_each_signal_until_the_state_settles() {
    let signal = ChangeSignal::new();
    let state = Arc::new(Mutex::new("starting"));
    let observed = state.clone();
    let answer = tokio::spawn(act_then_confirm(ConfirmSpec {
        act: || async {},
        observe: move || {
            let state = observed.clone();
            async move {
                let now = *state.lock().unwrap();
                (now == "running").then(|| confirmed(now.to_string()))
            }
        },
        signal: signal.subscribe(),
        timeout: Duration::from_secs(1),
        on_timeout: || async { mismatch("timed out", None) },
    }));
    settle().await;
    signal.fire();
    settle().await;
    *state.lock().unwrap() = "running";
    signal.fire();
    assert_eq!(
        answer.await.unwrap(),
        Settled::Confirmed("running".to_string())
    );
}

#[tokio::test(start_paused = true)]
async fn answers_a_mismatch_with_its_reason_and_the_timeout_state_when_nothing_settles() {
    let gone = act_then_confirm(ConfirmSpec {
        act: || async {},
        observe: || async { Some(mismatch("gone", Some(json!({"status": "failed"})))) },
        signal: inert(),
        timeout: Duration::from_secs(1),
        on_timeout: || async { mismatch("late", None) },
    })
    .await;
    assert_eq!(
        gone,
        Settled::Mismatch {
            reason: "gone".to_string(),
            value: Some(json!({"status": "failed"})),
        }
    );
    let timed_out: Settled<Value> = act_then_confirm(ConfirmSpec {
        act: || async {},
        observe: || async { None },
        signal: inert(),
        timeout: Duration::from_millis(5),
        on_timeout: || async { mismatch("timed out", None) },
    })
    .await;
    assert_eq!(
        timed_out,
        Settled::Mismatch {
            reason: "timed out".to_string(),
            value: None,
        }
    );
}

#[tokio::test(start_paused = true)]
async fn builds_a_mismatch_with_no_value_when_none_is_given() {
    let bare: Settled<u32> = mismatch("no value", None);
    assert_eq!(
        bare,
        Settled::Mismatch {
            reason: "no value".to_string(),
            value: None,
        }
    );
    assert_eq!(confirmed(7), Settled::Confirmed(7));
}

#[tokio::test(start_paused = true)]
async fn looks_once_more_when_a_signal_arrives_while_a_look_is_running() {
    let signal = ChangeSignal::new();
    let ready = Arc::new(Mutex::new(false));
    let looks = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let observed_ready = ready.clone();
    let observed_looks = looks.clone();
    let observed_release = release.clone();
    let answer = tokio::spawn(act_then_confirm(ConfirmSpec {
        act: || async {},
        observe: move || {
            let ready = observed_ready.clone();
            let looks = observed_looks.clone();
            let release = observed_release.clone();
            async move {
                let number = looks.fetch_add(1, Ordering::SeqCst) + 1;
                let was_ready = *ready.lock().unwrap();
                if number == 2 {
                    release.notified().await;
                }
                was_ready.then(|| confirmed("ready"))
            }
        },
        signal: signal.subscribe(),
        timeout: Duration::from_secs(1),
        on_timeout: || async { mismatch("timed out", None) },
    }));
    while looks.load(Ordering::SeqCst) < 2 {
        yield_now().await;
    }
    *ready.lock().unwrap() = true;
    signal.fire();
    signal.fire();
    settle().await;
    release.notify_one();
    assert_eq!(answer.await.unwrap(), Settled::Confirmed("ready"));
    assert_eq!(looks.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn stops_listening_and_never_times_out_after_it_settles() {
    let signal = ChangeSignal::new();
    let timeouts = Arc::new(AtomicUsize::new(0));
    let looks = Arc::new(AtomicUsize::new(0));
    let late = timeouts.clone();
    let observed = looks.clone();
    let answer = tokio::spawn(act_then_confirm(ConfirmSpec {
        act: || async {},
        observe: move || {
            let looks = observed.clone();
            async move {
                let number = looks.fetch_add(1, Ordering::SeqCst) + 1;
                (number >= 3).then(|| confirmed("up"))
            }
        },
        signal: signal.subscribe(),
        timeout: Duration::from_millis(50),
        on_timeout: move || {
            let late = late.clone();
            async move {
                late.fetch_add(1, Ordering::SeqCst);
                mismatch("timed out", None)
            }
        },
    }));
    settle().await;
    signal.fire();
    assert_eq!(answer.await.unwrap(), Settled::Confirmed("up"));
    let after = looks.load(Ordering::SeqCst);
    signal.fire();
    tokio::time::advance(Duration::from_secs(1)).await;
    settle().await;
    assert_eq!(looks.load(Ordering::SeqCst), after);
    assert_eq!(timeouts.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn ends_the_wait_at_the_timeout_even_when_no_signal_ever_comes() {
    let looks = Arc::new(AtomicUsize::new(0));
    let observed = looks.clone();
    let result: Settled<()> = act_then_confirm(ConfirmSpec {
        act: || async {},
        observe: move || {
            observed.fetch_add(1, Ordering::SeqCst);
            async { None }
        },
        signal: inert(),
        timeout: Duration::from_secs(30),
        on_timeout: || async { mismatch("timed out", None) },
    })
    .await;
    assert_eq!(
        result,
        Settled::Mismatch {
            reason: "timed out".to_string(),
            value: None,
        }
    );
    assert_eq!(looks.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn wakes_every_subscriber_on_fire_and_stops_one_that_unsubscribed() {
    let signal = ChangeSignal::new();
    let (first_wake, first) = counter();
    let (second_wake, second) = counter();
    let first_off = signal.subscribe().attach(first_wake);
    let _second_off = signal.subscribe().attach(second_wake);
    signal.fire();
    first_off();
    signal.fire();
    assert_eq!(first.load(Ordering::SeqCst), 1);
    assert_eq!(second.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn any_of_wakes_from_each_source_and_unsubscribes_from_all() {
    let left = ChangeSignal::new();
    let right = ChangeSignal::new();
    let (wake, count) = counter();
    let off: Off = any_of(vec![left.subscribe(), right.subscribe()]).attach(wake);
    left.fire();
    right.fire();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    off();
    left.fire();
    right.fire();
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn polls_on_the_interval_and_stops_when_unsubscribed() {
    let (wake, count) = counter();
    let off = poll_every(Duration::from_millis(10)).attach(wake);
    settle().await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    for expected in 1..=3 {
        tokio::time::advance(Duration::from_millis(10)).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), expected);
    }
    off();
    settle().await;
    tokio::time::advance(Duration::from_millis(100)).await;
    settle().await;
    assert_eq!(count.load(Ordering::SeqCst), 3);
}
