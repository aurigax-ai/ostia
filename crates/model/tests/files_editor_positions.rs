#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use ostia_model::files::editor_positions::{EditorPosition, EditorPositions};

fn at(file: &str, line: u32, column: u32) -> EditorPosition {
    EditorPosition {
        file: file.to_owned(),
        line,
        column,
    }
}

#[test]
fn has_no_position_for_a_pane_that_registered_nothing() {
    assert_eq!(EditorPositions::default().position_of("p1"), None);
}

#[test]
fn reports_the_position_the_source_gives_now() {
    let positions = EditorPositions::default();
    let line = Arc::new(AtomicU32::new(3));
    let read = line.clone();
    let _registration = positions.register("p1", move || {
        Some(at("/w/a.rs", read.load(Ordering::SeqCst), 7))
    });
    assert_eq!(positions.position_of("p1"), Some(at("/w/a.rs", 3, 7)));
    line.store(9, Ordering::SeqCst);
    assert_eq!(positions.position_of("p1"), Some(at("/w/a.rs", 9, 7)));
}

#[test]
fn has_no_position_when_the_source_has_none() {
    let positions = EditorPositions::default();
    let _registration = positions.register("p1", || None);
    assert_eq!(positions.position_of("p1"), None);
}

#[test]
fn keeps_each_pane_apart() {
    let positions = EditorPositions::default();
    let _a = positions.register("p1", || Some(at("/w/a.rs", 1, 1)));
    let _b = positions.register("p2", || Some(at("/w/b.rs", 2, 2)));
    assert_eq!(positions.position_of("p1"), Some(at("/w/a.rs", 1, 1)));
    assert_eq!(positions.position_of("p2"), Some(at("/w/b.rs", 2, 2)));
    assert_eq!(positions.position_of("p3"), None);
}

#[test]
fn a_later_source_for_the_same_pane_replaces_the_earlier_one() {
    let positions = EditorPositions::default();
    let _first = positions.register("p1", || Some(at("/w/a.rs", 1, 1)));
    let _second = positions.register("p1", || Some(at("/w/b.rs", 2, 2)));
    assert_eq!(positions.position_of("p1"), Some(at("/w/b.rs", 2, 2)));
}

#[test]
fn releasing_a_source_removes_it() {
    let positions = EditorPositions::default();
    let registration = positions.register("p1", || Some(at("/w/a.rs", 1, 1)));
    registration.release();
    assert_eq!(positions.position_of("p1"), None);
}

#[test]
fn releasing_a_replaced_source_keeps_the_one_that_replaced_it() {
    let positions = EditorPositions::default();
    let first = positions.register("p1", || Some(at("/w/a.rs", 1, 1)));
    let _second = positions.register("p1", || Some(at("/w/b.rs", 2, 2)));
    first.release();
    assert_eq!(positions.position_of("p1"), Some(at("/w/b.rs", 2, 2)));
}

#[test]
fn releasing_one_pane_leaves_the_others() {
    let positions = EditorPositions::default();
    let a = positions.register("p1", || Some(at("/w/a.rs", 1, 1)));
    let _b = positions.register("p2", || Some(at("/w/b.rs", 2, 2)));
    a.release();
    assert_eq!(positions.position_of("p2"), Some(at("/w/b.rs", 2, 2)));
}

#[test]
fn a_source_can_ask_for_another_pane_without_a_deadlock() {
    let positions = EditorPositions::default();
    let inner = positions.clone();
    let _a = positions.register("p1", move || inner.position_of("p2"));
    let _b = positions.register("p2", || Some(at("/w/b.rs", 4, 5)));
    assert_eq!(positions.position_of("p1"), Some(at("/w/b.rs", 4, 5)));
}

#[test]
fn clones_share_one_registry() {
    let positions = EditorPositions::default();
    let other = positions.clone();
    let _a = positions.register("p1", || Some(at("/w/a.rs", 1, 1)));
    assert_eq!(other.position_of("p1"), Some(at("/w/a.rs", 1, 1)));
}
