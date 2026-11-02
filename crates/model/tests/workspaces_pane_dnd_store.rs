#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::layout::types::DropZone;
use ostia_model::panes::drop_zone::TabDrop;
use ostia_model::workspaces::pane_dnd_store::PaneDndStore;

fn tab(target: &str, after: bool) -> TabDrop {
    TabDrop {
        target_id: target.to_owned(),
        after,
    }
}

#[test]
fn starts_idle_with_no_hovered_pane_and_no_zone() {
    let store = PaneDndStore::default();
    assert_eq!(store.over_id(), None);
    assert_eq!(store.zone(), None);
    assert_eq!(store.tab(), None);
    assert!(!store.dragging());
    assert_eq!(store.source_id(), None);
    assert!(!store.dropped_here());
}

#[test]
fn set_over_records_the_hovered_pane_id_and_drop_zone_together() {
    let mut store = PaneDndStore::default();
    assert!(store.set_over("pane-1", DropZone::Left, None));
    assert_eq!(store.over_id(), Some("pane-1"));
    assert_eq!(store.zone(), Some(DropZone::Left));
}

#[test]
fn set_over_overwrites_a_previously_hovered_pane_and_zone() {
    let mut store = PaneDndStore::default();
    store.set_over("pane-1", DropZone::Left, None);
    store.set_over("pane-2", DropZone::Bottom, None);
    assert_eq!(store.over_id(), Some("pane-2"));
    assert_eq!(store.zone(), Some(DropZone::Bottom));
}

#[test]
fn set_over_keeps_the_pane_id_but_updates_the_zone_when_only_the_zone_changes() {
    let mut store = PaneDndStore::default();
    store.set_over("pane-1", DropZone::Top, None);
    assert!(store.set_over("pane-1", DropZone::Right, None));
    assert_eq!(store.over_id(), Some("pane-1"));
    assert_eq!(store.zone(), Some(DropZone::Right));
}

#[test]
fn set_over_accepts_the_drop_zone() {
    for zone in [
        DropZone::Left,
        DropZone::Right,
        DropZone::Top,
        DropZone::Bottom,
        DropZone::Center,
    ] {
        let mut store = PaneDndStore::default();
        store.set_over("pane-x", zone, None);
        assert_eq!(store.zone(), Some(zone), "zone {zone:?}");
    }
}

#[test]
fn reset_clears_an_active_drag_back_to_idle() {
    let mut store = PaneDndStore::default();
    store.set_over("pane-1", DropZone::Center, None);
    store.reset();
    assert_eq!(store.over_id(), None);
    assert_eq!(store.zone(), None);
}

#[test]
fn reset_from_an_already_idle_state_stays_idle() {
    let mut store = PaneDndStore::default();
    store.reset();
    assert_eq!(store.over_id(), None);
    assert_eq!(store.zone(), None);
}

#[test]
fn set_over_changes_nothing_for_the_same_pane_zone_and_tab() {
    let mut store = PaneDndStore::default();
    assert!(store.set_over("pane-1", DropZone::Left, None));
    assert!(!store.set_over("pane-1", DropZone::Left, None));
    assert!(store.set_over("pane-1", DropZone::Left, Some(tab("t1", false))));
    assert!(!store.set_over("pane-1", DropZone::Left, Some(tab("t1", false))));
    assert!(store.set_over("pane-1", DropZone::Left, Some(tab("t1", true))));
    assert!(store.set_over("pane-1", DropZone::Left, Some(tab("t2", true))));
    assert!(store.set_over("pane-1", DropZone::Left, None));
    assert_eq!(store.tab(), None);
}

#[test]
fn start_begins_a_drag_from_a_source_and_clears_everything_else() {
    let mut store = PaneDndStore::default();
    store.set_over("pane-1", DropZone::Left, Some(tab("t1", true)));
    store.dropped();
    assert!(store.start(Some("pane-9")));
    assert!(store.dragging());
    assert_eq!(store.source_id(), Some("pane-9"));
    assert_eq!(store.over_id(), None);
    assert_eq!(store.zone(), None);
    assert_eq!(store.tab(), None);
    assert!(!store.dropped_here());
}

#[test]
fn start_accepts_a_drag_with_no_source_pane() {
    let mut store = PaneDndStore::default();
    assert!(store.start(None));
    assert!(store.dragging());
    assert_eq!(store.source_id(), None);
}

#[test]
fn leave_clears_the_hover_only_for_the_pane_that_is_hovered() {
    let mut store = PaneDndStore::default();
    store.set_over("pane-1", DropZone::Left, Some(tab("t1", false)));
    assert!(!store.leave("pane-2"));
    assert_eq!(store.over_id(), Some("pane-1"));
    assert!(store.leave("pane-1"));
    assert_eq!(store.over_id(), None);
    assert_eq!(store.zone(), None);
    assert_eq!(store.tab(), None);
}

#[test]
fn leave_keeps_the_drag_running() {
    let mut store = PaneDndStore::default();
    store.start(Some("pane-9"));
    store.set_over("pane-1", DropZone::Left, None);
    store.leave("pane-1");
    assert!(store.dragging());
    assert_eq!(store.source_id(), Some("pane-9"));
}

#[test]
fn dropped_clears_the_hover_and_marks_the_drop_as_here() {
    let mut store = PaneDndStore::default();
    store.start(Some("pane-9"));
    store.set_over("pane-1", DropZone::Left, Some(tab("t1", true)));
    assert!(store.dropped());
    assert_eq!(store.over_id(), None);
    assert_eq!(store.zone(), None);
    assert_eq!(store.tab(), None);
    assert!(store.dropped_here());
    assert!(store.dragging());
    assert_eq!(store.source_id(), Some("pane-9"));
}

#[test]
fn release_ends_a_running_drag_and_keeps_the_source_and_the_drop_mark() {
    let mut store = PaneDndStore::default();
    store.start(Some("pane-9"));
    store.set_over("pane-1", DropZone::Left, None);
    store.dropped();
    assert!(store.release());
    assert!(!store.dragging());
    assert_eq!(store.over_id(), None);
    assert_eq!(store.source_id(), Some("pane-9"));
    assert!(store.dropped_here());
}

#[test]
fn release_changes_nothing_when_no_drag_is_running() {
    let mut store = PaneDndStore::default();
    store.set_over("pane-1", DropZone::Left, None);
    assert!(!store.release());
    assert_eq!(store.over_id(), Some("pane-1"));
}

#[test]
fn reset_clears_the_source_the_drag_and_the_drop_mark() {
    let mut store = PaneDndStore::default();
    store.start(Some("pane-9"));
    store.dropped();
    store.reset();
    assert!(!store.dragging());
    assert_eq!(store.source_id(), None);
    assert!(!store.dropped_here());
}

#[test]
fn body_zone_is_the_zone_of_the_hovered_pane_unless_a_tab_target_is_set() {
    let mut store = PaneDndStore::default();
    assert_eq!(store.body_zone("pane-1"), None);
    store.set_over("pane-1", DropZone::Bottom, None);
    assert_eq!(store.body_zone("pane-1"), Some(DropZone::Bottom));
    assert_eq!(store.body_zone("pane-2"), None);
    store.set_over("pane-1", DropZone::Bottom, Some(tab("t1", false)));
    assert_eq!(store.body_zone("pane-1"), None);
}
