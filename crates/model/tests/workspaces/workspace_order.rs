#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::stores::app::settings_model::NewWorkspacePlacement;
use ostia_model::workspaces::workspace_order::{Orderable, insert_index, set_pinned, with_pinned};

#[derive(Clone, Debug, PartialEq)]
struct W {
    id: String,
    pinned: bool,
}

impl Orderable for W {
    fn id(&self) -> &str {
        &self.id
    }

    fn pinned(&self) -> bool {
        self.pinned
    }

    fn set_pinned_flag(&mut self, pinned: bool) {
        self.pinned = pinned;
    }
}

fn list(spec: &[&str]) -> Vec<W> {
    spec.iter()
        .map(|s| match s.strip_suffix('*') {
            Some(id) => W {
                id: id.to_string(),
                pinned: true,
            },
            None => W {
                id: s.to_string(),
                pinned: false,
            },
        })
        .collect()
}

fn ids(list: &[W]) -> Vec<String> {
    list.iter()
        .map(|w| {
            if w.pinned {
                format!("{}*", w.id)
            } else {
                w.id.clone()
            }
        })
        .collect()
}

#[test]
fn pins_a_workspace_to_the_end_of_the_pinned_group_at_the_top() {
    assert_eq!(
        ids(&set_pinned(list(&["a*", "b", "c"]), "c", true)),
        vec!["a*", "c*", "b"]
    );
}

#[test]
fn unpins_to_the_top_of_the_unpinned_group() {
    assert_eq!(
        ids(&set_pinned(list(&["a*", "b*", "c"]), "a", false)),
        vec!["b*", "a", "c"]
    );
}

#[test]
fn returns_the_same_list_when_nothing_changes() {
    let l = list(&["a*", "b"]);
    assert_eq!(set_pinned(l.clone(), "a", true), l);
    assert_eq!(set_pinned(l.clone(), "missing", true), l);
}

#[test]
fn appends_at_the_end_by_default() {
    assert_eq!(
        insert_index(
            &list(&["a*", "b", "c"]),
            NewWorkspacePlacement::End,
            Some("a")
        ),
        3
    );
}

#[test]
fn places_at_the_top_below_the_pinned_workspaces() {
    assert_eq!(
        insert_index(
            &list(&["a*", "b*", "c", "d"]),
            NewWorkspacePlacement::Top,
            Some("d")
        ),
        2
    );
    assert_eq!(
        insert_index(&list(&["a", "b"]), NewWorkspacePlacement::Top, Some("b")),
        0
    );
}

#[test]
fn places_right_after_the_active_workspace() {
    assert_eq!(
        insert_index(
            &list(&["a", "b", "c"]),
            NewWorkspacePlacement::AfterCurrent,
            Some("b")
        ),
        2
    );
}

#[test]
fn keeps_an_unpinned_newcomer_below_the_pinned_group_when_the_active_one_is_pinned() {
    assert_eq!(
        insert_index(
            &list(&["a*", "b*", "c"]),
            NewWorkspacePlacement::AfterCurrent,
            Some("a")
        ),
        2
    );
}

#[test]
fn falls_back_to_the_end_when_there_is_no_active_workspace() {
    assert_eq!(
        insert_index(
            &list(&["a", "b"]),
            NewWorkspacePlacement::AfterCurrent,
            None
        ),
        2
    );
}

#[test]
fn falls_back_to_the_end_when_the_active_workspace_is_gone() {
    assert_eq!(
        insert_index(
            &list(&["a", "b"]),
            NewWorkspacePlacement::AfterCurrent,
            Some("missing")
        ),
        2
    );
}

#[test]
fn sets_and_clears_the_pinned_flag_and_leaves_a_matching_workspace_alone() {
    let plain = list(&["a"]).remove(0);
    let pinned = list(&["a*"]).remove(0);
    assert_eq!(with_pinned(plain.clone(), true), pinned);
    assert_eq!(with_pinned(pinned.clone(), false), plain);
    assert_eq!(with_pinned(plain.clone(), false), plain);
    assert_eq!(with_pinned(pinned.clone(), true), pinned);
}
