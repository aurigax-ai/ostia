#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_gateway::push::waiting_since::{PaneChange, WaitingSince};

struct Rig {
    waiting: WaitingSince,
    clock: Arc<AtomicI64>,
}

fn rig() -> Rig {
    let clock = Arc::new(AtomicI64::new(1000));
    let workspaces: HashMap<&'static str, &'static str> =
        HashMap::from([("p1", "ws-a"), ("p2", "ws-a"), ("p3", "ws-b")]);
    let reader = Arc::clone(&clock);
    let waiting = WaitingSince::new(
        Arc::new(move || reader.load(Ordering::SeqCst)),
        move |pane| {
            workspaces
                .get(pane)
                .map(|workspace| (*workspace).to_owned())
        },
    );
    Rig { waiting, clock }
}

impl Rig {
    fn tick(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn attention(&self, pane: &str, state: Option<&str>) {
        self.waiting.observe(
            pane,
            &PaneChange::Attention {
                state: state.map(str::to_owned),
            },
        );
    }
}

#[test]
fn psh_c45_stays_constant_while_a_pane_keeps_waiting_and_changes_on_the_next_wait() {
    let rig = rig();
    rig.attention("p1", Some("waiting"));
    assert_eq!(rig.waiting.of_pane("p1"), Some(1000));
    rig.tick(5000);
    rig.attention("p1", Some("waiting"));
    assert_eq!(rig.waiting.of_pane("p1"), Some(1000));
    rig.attention("p1", Some("working"));
    assert_eq!(rig.waiting.of_pane("p1"), None);
    rig.tick(5000);
    rig.attention("p1", Some("waiting"));
    assert_eq!(rig.waiting.of_pane("p1"), Some(11_000));
}

#[test]
fn psh_c46_clears_when_the_agent_stops_waiting_or_the_pane_closes() {
    let rig = rig();
    for state in ["none", "done", "error"] {
        rig.attention("p1", Some("waiting"));
        rig.attention("p1", Some(state));
        assert_eq!(rig.waiting.of_pane("p1"), None, "{state}");
    }
    rig.attention("p1", Some("waiting"));
    rig.waiting.observe("p1", &PaneChange::Closed);
    assert_eq!(rig.waiting.of_pane("p1"), None);
}

#[test]
fn psh_c47_gives_a_workspace_the_newest_wait_among_its_panes() {
    let rig = rig();
    rig.attention("p1", Some("waiting"));
    rig.tick(2000);
    rig.attention("p2", Some("waiting"));
    rig.tick(2000);
    rig.attention("p3", Some("waiting"));
    assert_eq!(rig.waiting.of_workspace("ws-a"), Some(3000));
    rig.attention("p2", Some("done"));
    assert_eq!(rig.waiting.of_workspace("ws-a"), Some(1000));
    assert_eq!(rig.waiting.of_workspace("ws-none"), None);
}

#[test]
fn psh_c62_keeps_the_wait_when_the_pane_is_only_viewed_or_its_terminal_state_changes() {
    let rig = rig();
    rig.attention("p1", Some("waiting"));
    rig.tick(9000);
    rig.waiting.observe("p1", &PaneChange::State);
    assert_eq!(rig.waiting.of_pane("p1"), Some(1000));
    assert!(rig.waiting.any());
}

#[test]
fn clears_a_wait_when_the_attention_change_carries_no_state() {
    let rig = rig();
    rig.attention("p1", Some("waiting"));
    rig.attention("p1", None);
    assert_eq!(rig.waiting.of_pane("p1"), None);
    assert!(!rig.waiting.any());
}

#[test]
fn any_is_true_while_one_pane_waits_and_false_when_none_does() {
    let rig = rig();
    assert!(!rig.waiting.any());
    rig.attention("p1", Some("waiting"));
    rig.attention("p3", Some("waiting"));
    rig.waiting.observe("p1", &PaneChange::Closed);
    assert!(rig.waiting.any());
    rig.waiting.observe("p3", &PaneChange::Closed);
    assert!(!rig.waiting.any());
}

#[test]
fn leaves_a_waiting_pane_with_no_workspace_out_of_every_workspace_answer() {
    let rig = rig();
    rig.attention("orphan", Some("waiting"));
    assert_eq!(rig.waiting.of_pane("orphan"), Some(1000));
    assert_eq!(rig.waiting.of_workspace("ws-a"), None);
    assert!(rig.waiting.any());
}

#[test]
fn ignores_a_close_or_a_state_change_for_a_pane_that_never_waited() {
    let rig = rig();
    rig.waiting.observe("p1", &PaneChange::Closed);
    rig.waiting.observe("p1", &PaneChange::State);
    assert_eq!(rig.waiting.of_pane("p1"), None);
    assert!(!rig.waiting.any());
}
