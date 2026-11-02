#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::terminal::replaced_shells::ReplacedShells;

#[test]
fn a_pane_that_was_never_noted_has_no_replaced_shell() {
    let shells = ReplacedShells::default();
    assert!(!shells.has("p1"));
}

#[test]
fn remembers_a_noted_pane_and_no_other() {
    let mut shells = ReplacedShells::default();
    shells.note("p1");
    assert!(shells.has("p1"));
    assert!(!shells.has("p2"));
}

#[test]
fn noting_a_pane_twice_keeps_it_noted() {
    let mut shells = ReplacedShells::default();
    shells.note("p1");
    shells.note("p1");
    assert!(shells.has("p1"));
}

#[test]
fn reset_forgets_every_pane() {
    let mut shells = ReplacedShells::default();
    shells.note("p1");
    shells.note("p2");
    shells.reset();
    assert!(!shells.has("p1"));
    assert!(!shells.has("p2"));
}

#[test]
fn a_pane_can_be_noted_again_after_a_reset() {
    let mut shells = ReplacedShells::default();
    shells.note("p1");
    shells.reset();
    shells.note("p1");
    assert!(shells.has("p1"));
}
