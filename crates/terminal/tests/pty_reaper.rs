#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::clock::Clock;
use ostia_base::{PaneId, WindowId};
use ostia_terminal::pty_reaper::{
    DETACH_GRACE_MS, OrphanCheck, OrphanVerdict, RECOVERY_GRACE_MS, RecoveredPty, RecoveryBook,
    RecoveryPlan, orphan_verdict, plan_recovery,
};

struct TestClock {
    now: Arc<AtomicI64>,
}

impl TestClock {
    fn new() -> Self {
        Self {
            now: Arc::new(AtomicI64::new(1_000)),
        }
    }

    fn clock(&self) -> Clock {
        let now = Arc::clone(&self.now);
        Arc::new(move || now.load(Ordering::SeqCst))
    }

    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

fn window(id: &str) -> WindowId {
    WindowId::new(id)
}

fn pane(id: &str) -> PaneId {
    PaneId::new(id)
}

const ORPHAN: OrphanCheck = OrphanCheck {
    current: true,
    owners: 0,
    moving: false,
    held: false,
    recovering: false,
};

#[test]
fn reaps_a_pty_with_no_owners_once_the_grace_is_over() {
    assert_eq!(orphan_verdict(&ORPHAN), OrphanVerdict::Reap);
}

#[test]
fn waits_instead_of_reaping_while_its_window_is_reloading_or_recovering() {
    let check = OrphanCheck {
        recovering: true,
        ..ORPHAN
    };
    assert_eq!(orphan_verdict(&check), OrphanVerdict::Wait);
}

#[test]
fn keeps_a_pty_that_is_owned_moving_held_for_a_recovered_window_or_replaced() {
    let owned = OrphanCheck {
        owners: 1,
        ..ORPHAN
    };
    let moving = OrphanCheck {
        moving: true,
        ..ORPHAN
    };
    let held = OrphanCheck {
        held: true,
        ..ORPHAN
    };
    let replaced = OrphanCheck {
        current: false,
        recovering: true,
        ..ORPHAN
    };
    for (name, check) in [
        ("owned", owned),
        ("moving", moving),
        ("held", held),
        ("replaced", replaced),
    ] {
        assert_eq!(orphan_verdict(&check), OrphanVerdict::Keep, "{name}");
    }
}

#[test]
fn uses_the_normal_detach_grace_for_a_window_that_is_not_recovering() {
    let book = RecoveryBook::new(TestClock::new().clock());
    assert!(!book.is_recovering(Some(&window("1"))));
    assert_eq!(book.grace_for(Some(&window("1"))), DETACH_GRACE_MS);
    assert_eq!(book.grace_for(None), DETACH_GRACE_MS);
}

#[test]
fn extends_the_grace_for_a_recovering_window_only() {
    let c = TestClock::new();
    let mut book = RecoveryBook::new(c.clock());
    book.start(&window("1"));
    assert!(book.is_recovering(Some(&window("1"))));
    assert!(!book.is_recovering(Some(&window("2"))));
    assert_eq!(book.grace_for(Some(&window("1"))), RECOVERY_GRACE_MS);
    c.advance(60_000);
    assert_eq!(
        book.grace_for(Some(&window("1"))),
        RECOVERY_GRACE_MS - 60_000
    );
    assert_eq!(book.grace_for(Some(&window("2"))), DETACH_GRACE_MS);
}

#[test]
fn stops_recovering_when_the_window_reports_ready_or_the_recovery_grace_runs_out() {
    let c = TestClock::new();
    let mut book = RecoveryBook::new(c.clock());
    book.start(&window("1"));
    assert!(book.end(&window("1")));
    assert!(!book.is_recovering(Some(&window("1"))));
    assert!(!book.end(&window("1")));
    book.start(&window("2"));
    c.advance(RECOVERY_GRACE_MS);
    assert!(!book.is_recovering(Some(&window("2"))));
}

#[test]
fn never_gives_less_than_the_detach_grace_when_a_recovery_is_nearly_over() {
    let c = TestClock::new();
    let mut book = RecoveryBook::new(c.clock());
    book.start(&window("1"));
    c.advance(RECOVERY_GRACE_MS - 100);
    assert!(book.is_recovering(Some(&window("1"))));
    assert_eq!(book.grace_for(Some(&window("1"))), DETACH_GRACE_MS);
}

#[test]
fn holds_detached_ptys_the_reloaded_window_still_shows_and_reaps_the_rest() {
    let live: HashSet<PaneId> = [pane("p1"), pane("p2")].into_iter().collect();
    let plan = plan_recovery(
        &[
            RecoveredPty {
                pane_id: pane("p1"),
                owners: 0,
            },
            RecoveredPty {
                pane_id: pane("p2"),
                owners: 1,
            },
            RecoveredPty {
                pane_id: pane("closed"),
                owners: 0,
            },
            RecoveredPty {
                pane_id: pane("stale"),
                owners: 1,
            },
        ],
        &live,
    );
    assert_eq!(
        plan,
        RecoveryPlan {
            hold: vec![pane("p1")],
            reap: vec![pane("closed"), pane("stale")],
        }
    );
}
