#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::panes::tab_row::{TabSpan, hidden_tabs, reveal_scroll};

fn span(id: &str, left: f64, right: f64) -> TabSpan {
    TabSpan {
        id: id.to_string(),
        left,
        right,
    }
}

fn row() -> Vec<TabSpan> {
    vec![
        span("a", 0.0, 100.0),
        span("b", 100.0, 200.0),
        span("c", 200.0, 300.0),
        span("d", 300.0, 400.0),
    ]
}

#[test]
fn hides_nothing_when_every_tab_midpoint_is_in_view() {
    let hidden = hidden_tabs(0.0, 400.0, &row());
    assert!(hidden.start.is_empty());
    assert!(hidden.end.is_empty());
}

#[test]
fn hides_the_tabs_whose_midpoint_is_left_of_the_view_at_the_start() {
    let hidden = hidden_tabs(150.0, 400.0, &row());
    assert_eq!(hidden.start, vec!["a"]);
    assert!(hidden.end.is_empty());
}

#[test]
fn hides_the_tabs_whose_midpoint_is_right_of_the_view_at_the_end() {
    let hidden = hidden_tabs(0.0, 250.0, &row());
    assert!(hidden.start.is_empty());
    assert_eq!(hidden.end, vec!["d"]);
}

#[test]
fn hides_tabs_on_both_sides_and_keeps_the_tab_order() {
    let hidden = hidden_tabs(160.0, 240.0, &row());
    assert_eq!(hidden.start, vec!["a", "b"]);
    assert_eq!(hidden.end, vec!["c", "d"]);
}

#[test]
fn counts_a_tab_whose_midpoint_is_on_the_view_edge_as_visible() {
    let hidden = hidden_tabs(150.0, 250.0, &row());
    assert_eq!(hidden.start, vec!["a"]);
    assert_eq!(hidden.end, vec!["d"]);
}

#[test]
fn hides_a_partly_visible_tab_only_when_its_midpoint_is_out_of_view() {
    let tabs = vec![span("wide", 0.0, 300.0)];
    let hidden = hidden_tabs(160.0, 400.0, &tabs);
    assert_eq!(hidden.start, vec!["wide"]);
    let hidden = hidden_tabs(140.0, 400.0, &tabs);
    assert!(hidden.start.is_empty());
}

#[test]
fn hides_nothing_when_there_are_no_tabs() {
    let hidden = hidden_tabs(0.0, 100.0, &[]);
    assert!(hidden.start.is_empty());
    assert!(hidden.end.is_empty());
}

#[test]
fn scrolls_left_to_the_tab_when_the_tab_starts_before_the_view() {
    assert_eq!(reveal_scroll(200.0, 300.0, 120.0, 80.0), 120.0);
}

#[test]
fn keeps_the_scroll_when_the_tab_is_fully_in_view() {
    assert_eq!(reveal_scroll(100.0, 300.0, 150.0, 100.0), 100.0);
    assert_eq!(reveal_scroll(100.0, 300.0, 100.0, 300.0), 100.0);
}

#[test]
fn scrolls_right_by_the_overshoot_when_the_tab_ends_after_the_view() {
    assert_eq!(reveal_scroll(0.0, 300.0, 250.0, 100.0), 50.0);
}

#[test]
fn never_scrolls_past_the_start_of_a_tab_wider_than_the_view() {
    assert_eq!(reveal_scroll(0.0, 100.0, 40.0, 300.0), 40.0);
}
