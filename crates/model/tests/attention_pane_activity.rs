#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::attention::pane_activity::PaneActivity;

#[test]
fn reads_back_the_time_a_pane_was_marked() {
    let mut activity = PaneActivity::default();
    activity.mark("p1", 500.0);
    assert_eq!(activity.at("p1"), Some(500.0));
}

#[test]
fn a_pane_never_marked_has_no_time() {
    assert_eq!(PaneActivity::default().at("p1"), None);
}

#[test]
fn marking_again_replaces_the_time() {
    let mut activity = PaneActivity::default();
    activity.mark("p1", 500.0);
    activity.mark("p1", 900.0);
    assert_eq!(activity.at("p1"), Some(900.0));
}

#[test]
fn keeps_a_time_for_each_pane() {
    let mut activity = PaneActivity::default();
    activity.mark("p1", 1.0);
    activity.mark("p2", 2.0);
    assert_eq!(activity.at("p1"), Some(1.0));
    assert_eq!(activity.at("p2"), Some(2.0));
}

#[test]
fn forgetting_a_pane_removes_only_that_pane() {
    let mut activity = PaneActivity::default();
    activity.mark("p1", 1.0);
    activity.mark("p2", 2.0);
    activity.forget("p1");
    assert_eq!(activity.at("p1"), None);
    assert_eq!(activity.at("p2"), Some(2.0));
}

#[test]
fn forgetting_a_pane_that_was_never_marked_changes_nothing() {
    let mut activity = PaneActivity::default();
    activity.mark("p1", 1.0);
    activity.forget("missing");
    assert_eq!(activity.at("p1"), Some(1.0));
}
