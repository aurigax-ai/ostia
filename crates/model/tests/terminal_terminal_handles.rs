#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_model::terminal::terminal_handles::HandleRegistry;

#[test]
fn returns_the_handle_registered_for_a_pane() {
    let mut registry = HandleRegistry::default();
    let handle = Arc::new("term".to_owned());
    registry.register("p1", Arc::clone(&handle));
    assert!(Arc::ptr_eq(registry.get("p1").unwrap(), &handle));
    assert!(registry.get("p2").is_none());
}

#[test]
fn a_second_registration_for_the_pane_replaces_the_first() {
    let mut registry = HandleRegistry::default();
    let first = Arc::new("term".to_owned());
    let second = Arc::new("term".to_owned());
    registry.register("p1", Arc::clone(&first));
    registry.register("p1", Arc::clone(&second));
    assert!(Arc::ptr_eq(registry.get("p1").unwrap(), &second));
}

#[test]
fn unregister_removes_the_handle_it_registered() {
    let mut registry = HandleRegistry::default();
    let handle = Arc::new("term".to_owned());
    registry.register("p1", Arc::clone(&handle));
    assert!(registry.unregister("p1", &handle));
    assert!(registry.get("p1").is_none());
}

#[test]
fn a_stale_unregister_leaves_the_newer_handle_in_place() {
    let mut registry = HandleRegistry::default();
    let first = Arc::new("term".to_owned());
    let second = Arc::new("term".to_owned());
    registry.register("p1", Arc::clone(&first));
    registry.register("p1", Arc::clone(&second));
    assert!(!registry.unregister("p1", &first));
    assert!(Arc::ptr_eq(registry.get("p1").unwrap(), &second));
}

#[test]
fn unregister_compares_the_instance_and_not_the_value() {
    let mut registry = HandleRegistry::default();
    let registered = Arc::new("same".to_owned());
    let equal_copy = Arc::new("same".to_owned());
    registry.register("p1", Arc::clone(&registered));
    assert!(!registry.unregister("p1", &equal_copy));
    assert!(registry.get("p1").is_some());
}

#[test]
fn unregister_for_an_unknown_pane_changes_nothing() {
    let mut registry = HandleRegistry::default();
    let handle = Arc::new("term".to_owned());
    registry.register("p1", Arc::clone(&handle));
    assert!(!registry.unregister("p2", &handle));
    assert!(registry.get("p1").is_some());
}
