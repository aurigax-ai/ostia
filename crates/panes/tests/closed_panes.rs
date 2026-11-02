#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_panes::closed_panes::{ClosedPane, ClosedPanes, closed_label};

const ID: &str = "3f6a7ced-1111-4222-8333-444455556666";

fn everywhere(_workspace_id: &str) -> bool {
    true
}

fn closed(external_id: &str, workspace_id: &str, closed_at: i64) -> ClosedPane {
    ClosedPane {
        external_id: external_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        name: None,
        closed_at,
    }
}

#[test]
fn recalls_a_closed_pane_by_its_id_or_by_8_or_more_characters_of_it() {
    let panes = ClosedPanes::default();
    panes.remember(closed(ID, "ws1", 5));
    assert_eq!(panes.recall(ID, everywhere).unwrap().external_id, ID);
    assert_eq!(panes.recall(&ID[..8], everywhere).unwrap().external_id, ID);
    assert!(panes.recall(&ID[..7], everywhere).is_none());
    assert!(panes.recall("0000000000", everywhere).is_none());
}

#[test]
fn answers_nothing_for_a_pane_of_a_workspace_the_caller_cannot_see() {
    let panes = ClosedPanes::default();
    panes.remember(closed(ID, "ws-far", 5));
    assert!(
        panes
            .recall(ID, |workspace_id| workspace_id == "ws1")
            .is_none()
    );
    assert!(
        panes
            .recall(&ID[..8], |workspace_id| workspace_id == "ws1")
            .is_none()
    );
}

#[test]
fn does_not_guess_between_two_closed_panes_that_share_a_prefix() {
    let panes = ClosedPanes::default();
    panes.remember(closed(&format!("{}-aaaa", &ID[..8]), "ws1", 5));
    panes.remember(closed(&format!("{}-bbbb", &ID[..8]), "ws1", 6));
    assert!(panes.recall(&ID[..8], everywhere).is_none());
}

#[test]
fn keeps_the_newest_256_and_says_when_and_as_what_a_pane_closed() {
    let panes = ClosedPanes::default();
    for i in 0..260 {
        panes.remember(closed(&format!("id-{i}"), "ws1", i));
    }
    assert!(panes.recall("id-0", everywhere).is_none());
    assert!(panes.recall("id-259", everywhere).is_some());
    let named = ClosedPane {
        name: Some("w-1241".to_owned()),
        ..closed("x", "w", 0)
    };
    assert_eq!(closed_label(&named, 7_200_000), "closed 2h ago (w-1241)");
    assert_eq!(closed_label(&closed("x", "w", 0), 30_000), "closed 30s ago");
}

#[test]
fn forgets_every_closed_pane() {
    let panes = ClosedPanes::default();
    panes.remember(closed(ID, "ws1", 5));
    panes.forget_all();
    assert!(panes.recall(ID, everywhere).is_none());
}

#[test]
fn moves_a_pane_that_closes_again_to_the_newest_place_and_keeps_one_record() {
    let panes = ClosedPanes::default();
    panes.remember(closed("id-0", "ws1", 1));
    for i in 1..256 {
        panes.remember(closed(&format!("id-{i}"), "ws1", i));
    }
    panes.remember(closed("id-0", "ws1", 300));
    panes.remember(closed("id-256", "ws1", 301));
    assert_eq!(panes.recall("id-0", everywhere).unwrap().closed_at, 300);
    assert!(panes.recall("id-1", everywhere).is_none());
    assert!(panes.recall("id-2", everywhere).is_some());
}

#[test]
fn labels_a_closed_pane_with_an_empty_name_like_one_with_no_name() {
    let empty = ClosedPane {
        name: Some(String::new()),
        ..closed("x", "w", 0)
    };
    assert_eq!(closed_label(&empty, 30_000), "closed 30s ago");
}

#[test]
fn labels_the_age_in_minutes_and_days_and_never_below_zero() {
    let table = [
        (0, 59_999, "closed 59s ago"),
        (0, 60_000, "closed 1m ago"),
        (0, 3_599_999, "closed 59m ago"),
        (0, 86_399_999, "closed 23h ago"),
        (0, 86_400_000, "closed 1d ago"),
        (10_000, 0, "closed 0s ago"),
    ];
    for (closed_at, now, expected) in table {
        assert_eq!(
            closed_label(&closed("x", "w", closed_at), now),
            expected,
            "closed_at {closed_at} now {now}"
        );
    }
}
