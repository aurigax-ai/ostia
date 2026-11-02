#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_terminal::kept_power::{PowerAware, PowerEvent, PowerEvents, watch_power};

#[derive(Default)]
struct FakePower {
    suspend: Vec<Box<dyn Fn() + Send + Sync>>,
    resume: Vec<Box<dyn Fn() + Send + Sync>>,
}

impl FakePower {
    fn emit(&self, event: PowerEvent) {
        let listeners = match event {
            PowerEvent::Suspend => &self.suspend,
            PowerEvent::Resume => &self.resume,
        };
        for listener in listeners {
            listener();
        }
    }
}

impl PowerEvents for FakePower {
    fn on(&mut self, event: PowerEvent, listener: Box<dyn Fn() + Send + Sync>) {
        match event {
            PowerEvent::Suspend => self.suspend.push(listener),
            PowerEvent::Resume => self.resume.push(listener),
        }
    }
}

#[derive(Default)]
struct FakeKept {
    suspended: AtomicUsize,
    resumed: AtomicUsize,
}

impl PowerAware for FakeKept {
    fn suspend(&self) {
        self.suspended.fetch_add(1, Ordering::SeqCst);
    }

    fn resume(&self) {
        self.resumed.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn detaches_the_kept_shells_on_suspend_and_reconnects_them_on_resume() {
    let mut power = FakePower::default();
    let kept = Arc::new(FakeKept::default());
    watch_power(&mut power, Arc::clone(&kept));
    power.emit(PowerEvent::Suspend);
    assert_eq!(kept.suspended.load(Ordering::SeqCst), 1);
    assert_eq!(kept.resumed.load(Ordering::SeqCst), 0);
    power.emit(PowerEvent::Resume);
    assert_eq!(kept.resumed.load(Ordering::SeqCst), 1);
    assert_eq!(kept.suspended.load(Ordering::SeqCst), 1);
}

#[test]
fn does_nothing_to_the_kept_shells_until_a_power_event_arrives() {
    let mut power = FakePower::default();
    let kept = Arc::new(FakeKept::default());
    watch_power(&mut power, Arc::clone(&kept));
    assert_eq!(kept.suspended.load(Ordering::SeqCst), 0);
    assert_eq!(kept.resumed.load(Ordering::SeqCst), 0);
}

#[test]
fn follows_every_suspend_and_resume_in_turn() {
    let mut power = FakePower::default();
    let kept = Arc::new(FakeKept::default());
    watch_power(&mut power, Arc::clone(&kept));
    for _ in 0..3 {
        power.emit(PowerEvent::Suspend);
        power.emit(PowerEvent::Resume);
    }
    assert_eq!(kept.suspended.load(Ordering::SeqCst), 3);
    assert_eq!(kept.resumed.load(Ordering::SeqCst), 3);
}
