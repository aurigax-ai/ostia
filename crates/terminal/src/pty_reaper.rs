use std::collections::{HashMap, HashSet};

use ostia_base::clock::Clock;
use ostia_base::{PaneId, WindowId};

pub const DETACH_GRACE_MS: i64 = 3_000;
pub const RECOVERY_GRACE_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReapReason {
    GraceExpired,
    Exit,
    Closed,
    Restart,
    Hibernated,
    Quit,
    ProcessKill,
}

pub struct RecoveryBook {
    clock: Clock,
    until: HashMap<WindowId, i64>,
}

impl RecoveryBook {
    pub fn new(clock: Clock) -> Self {
        Self {
            clock,
            until: HashMap::new(),
        }
    }

    pub fn start(&mut self, window: &WindowId) {
        let now = (self.clock)();
        self.until.retain(|_, until| *until > now);
        self.until.insert(window.clone(), now + RECOVERY_GRACE_MS);
    }

    pub fn is_recovering(&self, window: Option<&WindowId>) -> bool {
        let Some(window) = window else {
            return false;
        };
        self.until
            .get(window)
            .is_some_and(|until| *until > (self.clock)())
    }

    pub fn end(&mut self, window: &WindowId) -> bool {
        let was = self.is_recovering(Some(window));
        self.until.remove(window);
        was
    }

    pub fn grace_for(&self, window: Option<&WindowId>) -> i64 {
        let Some(window) = window else {
            return DETACH_GRACE_MS;
        };
        if !self.is_recovering(Some(window)) {
            return DETACH_GRACE_MS;
        }
        let remaining = self.until.get(window).copied().unwrap_or(0) - (self.clock)();
        DETACH_GRACE_MS.max(remaining)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrphanCheck {
    pub current: bool,
    pub owners: usize,
    pub moving: bool,
    pub held: bool,
    pub recovering: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrphanVerdict {
    Keep,
    Wait,
    Reap,
}

pub fn orphan_verdict(check: &OrphanCheck) -> OrphanVerdict {
    if !check.current || check.owners > 0 || check.moving || check.held {
        return OrphanVerdict::Keep;
    }
    if check.recovering {
        return OrphanVerdict::Wait;
    }
    OrphanVerdict::Reap
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredPty {
    pub pane_id: PaneId,
    pub owners: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct RecoveryPlan {
    pub hold: Vec<PaneId>,
    pub reap: Vec<PaneId>,
}

pub fn plan_recovery(
    window_ptys: &[RecoveredPty],
    live_pane_ids: &HashSet<PaneId>,
) -> RecoveryPlan {
    let mut plan = RecoveryPlan {
        hold: Vec::new(),
        reap: Vec::new(),
    };
    for pty in window_ptys {
        if !live_pane_ids.contains(&pty.pane_id) {
            plan.reap.push(pty.pane_id.clone());
        } else if pty.owners == 0 {
            plan.hold.push(pty.pane_id.clone());
        }
    }
    plan
}
