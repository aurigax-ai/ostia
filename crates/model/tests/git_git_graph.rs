#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;

use ostia_model::git::git_graph::{GraphEdge, GraphNode, layout_graph};

fn n(sha: &str, parents: &[&str]) -> GraphNode {
    GraphNode {
        sha: sha.to_owned(),
        parents: parents.iter().map(|p| (*p).to_owned()).collect(),
        pending: false,
    }
}

fn moves(edges: &[GraphEdge]) -> Vec<String> {
    edges
        .iter()
        .map(|e| format!("{}>{}", e.from, e.to))
        .collect()
}

#[test]
fn keeps_a_linear_history_on_one_lane_with_straight_edges() {
    let rows = layout_graph(&[n("c", &["b"]), n("b", &["a"]), n("a", &[])]);
    assert_eq!(rows.iter().map(|r| r.lane).collect::<Vec<_>>(), [0, 0, 0]);
    assert_eq!(rows.iter().map(|r| r.width).collect::<Vec<_>>(), [1, 1, 1]);
    assert!(moves(&rows[0].top).is_empty());
    assert_eq!(moves(&rows[0].bottom), ["0>0"]);
    assert_eq!(moves(&rows[1].top), ["0>0"]);
    assert!(moves(&rows[2].bottom).is_empty());
    let colors: HashSet<usize> = rows.iter().map(|r| r.color).collect();
    assert_eq!(colors.len(), 1);
}

#[test]
fn opens_a_second_lane_for_a_branch_and_folds_it_back_into_its_fork_point() {
    let rows = layout_graph(&[
        n("main2", &["base"]),
        n("feat2", &["feat1"]),
        n("feat1", &["base"]),
        n("base", &[]),
    ]);
    assert_eq!(
        rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
        [0, 1, 1, 0]
    );
    assert_eq!(moves(&rows[1].top), ["0>0"]);
    assert_eq!(moves(&rows[1].bottom), ["1>1", "0>0"]);
    assert_eq!(moves(&rows[2].bottom), ["1>0", "0>0"]);
    assert_eq!(moves(&rows[3].top), ["0>0"]);
    assert_eq!(rows[3].width, 1);
    assert_ne!(rows[1].color, rows[0].color);
}

#[test]
fn draws_a_merge_as_a_curve_into_a_new_lane_that_rejoins_at_the_fork() {
    let rows = layout_graph(&[
        n("m", &["a2", "b1"]),
        n("a2", &["base"]),
        n("b1", &["base"]),
        n("base", &[]),
    ]);
    assert_eq!(
        rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
        [0, 0, 1, 0]
    );
    assert_eq!(moves(&rows[0].bottom), ["0>0", "0>1"]);
    assert_eq!(rows[0].bottom[1].color, rows[2].color);
    assert_ne!(rows[0].bottom[1].color, rows[0].color);
    assert_eq!(moves(&rows[1].bottom), ["0>0", "1>1"]);
    assert_eq!(moves(&rows[2].bottom), ["1>0", "0>0"]);
    assert_eq!(moves(&rows[3].top), ["0>0"]);
}

#[test]
fn merges_into_a_parent_that_another_lane_already_waits_for_without_opening_a_lane() {
    let rows = layout_graph(&[
        n("tip", &["x"]),
        n("m", &["y", "x"]),
        n("y", &["x"]),
        n("x", &[]),
    ]);
    assert_eq!(
        rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
        [0, 1, 1, 0]
    );
    assert_eq!(moves(&rows[1].bottom), ["1>1", "1>0", "0>0"]);
    assert!(rows.iter().all(|r| r.width <= 2));
}

#[test]
fn fans_an_octopus_merge_out_to_one_lane_per_parent() {
    let rows = layout_graph(&[
        n("oct", &["p1", "p2", "p3"]),
        n("p1", &["root"]),
        n("p2", &["root"]),
        n("p3", &["root"]),
        n("root", &[]),
    ]);
    assert_eq!(rows[0].lane, 0);
    assert_eq!(moves(&rows[0].bottom), ["0>0", "0>1", "0>2"]);
    let colors: HashSet<usize> = rows[0].bottom.iter().map(|e| e.color).collect();
    assert_eq!(colors.len(), 3);
    assert_eq!(
        rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
        [0, 0, 1, 2, 0]
    );
    assert_eq!(moves(&rows[2].bottom), ["1>0", "0>0", "2>2"]);
    assert_eq!(moves(&rows[3].top), ["0>0", "2>2"]);
    assert_eq!(moves(&rows[3].bottom), ["2>0", "0>0"]);
    assert_eq!(rows[3].width, 3);
    assert_eq!(moves(&rows[4].top), ["0>0"]);
    assert_eq!(rows[4].width, 1);
}

#[test]
fn lays_out_a_criss_cross_merge_without_losing_either_history_line() {
    let rows = layout_graph(&[
        n("m1", &["a", "b"]),
        n("m2", &["b", "a"]),
        n("a", &["root"]),
        n("b", &["root"]),
        n("root", &[]),
    ]);
    assert_eq!(
        rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
        [0, 2, 0, 1, 0]
    );
    assert_eq!(moves(&rows[1].bottom), ["2>1", "2>0", "0>0", "1>1"]);
    assert_eq!(moves(&rows[2].top), ["0>0", "1>1"]);
    assert_eq!(moves(&rows[3].bottom), ["1>0", "0>0"]);
    assert_eq!(moves(&rows[4].top), ["0>0"]);
}

#[test]
fn reuses_a_freed_lane_instead_of_growing_wider() {
    let rows = layout_graph(&[
        n("b1", &["base"]),
        n("a1", &["base"]),
        n("base", &["old"]),
        n("c1", &["old"]),
        n("old", &[]),
    ]);
    assert_eq!(
        rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
        [0, 1, 0, 1, 0]
    );
    assert_eq!(rows.iter().map(|r| r.width).max(), Some(2));
}

#[test]
fn marks_every_edge_from_a_pending_node_as_pending_until_the_parent_is_reached() {
    let mut worktree = n("worktree", &["head"]);
    worktree.pending = true;
    let rows = layout_graph(&[
        worktree,
        n("other", &["head"]),
        n("head", &["root"]),
        n("root", &[]),
    ]);
    assert_eq!(
        rows[0].bottom,
        [GraphEdge {
            from: 0,
            to: 0,
            color: 0,
            pending: true
        }]
    );
    assert_eq!((rows[1].top[0].from, rows[1].top[0].to), (0, 0));
    assert!(rows[1].top[0].pending);
    let own = rows[1].bottom.iter().find(|e| e.from == 1).unwrap();
    assert!(!own.pending);
    let reached = rows[2].top.iter().find(|e| e.from == 0).unwrap();
    assert_eq!(reached.to, 0);
    assert!(reached.pending);
    assert_eq!(
        rows[2].bottom,
        [GraphEdge {
            from: 0,
            to: 0,
            color: rows[2].color,
            pending: false
        }]
    );
}

#[test]
fn leaves_lanes_of_parents_outside_the_loaded_page_running_off_the_bottom() {
    let rows = layout_graph(&[n("b", &["a"])]);
    assert_eq!(moves(&rows[0].bottom), ["0>0"]);
}

#[test]
fn gives_no_rows_for_no_nodes() {
    assert!(layout_graph(&[]).is_empty());
}

#[test]
fn a_repeated_parent_draws_one_edge() {
    let rows = layout_graph(&[n("m", &["a", "a"]), n("a", &[])]);
    assert_eq!(moves(&rows[0].bottom), ["0>0"]);
}

#[test]
fn a_root_with_no_parents_draws_no_bottom_edge_and_a_second_root_starts_a_new_color() {
    let rows = layout_graph(&[n("r1", &[]), n("r2", &[])]);
    assert!(rows[0].bottom.is_empty());
    assert_eq!(rows.iter().map(|r| r.lane).collect::<Vec<_>>(), [0, 0]);
    assert_eq!(rows.iter().map(|r| r.color).collect::<Vec<_>>(), [0, 1]);
}

#[test]
fn a_node_that_nothing_waits_for_takes_the_first_free_lane_and_a_new_color() {
    let rows = layout_graph(&[n("a", &["x"]), n("b", &["y"]), n("c", &["z"])]);
    assert_eq!(rows.iter().map(|r| r.lane).collect::<Vec<_>>(), [0, 1, 2]);
    assert_eq!(rows.iter().map(|r| r.color).collect::<Vec<_>>(), [0, 1, 2]);
    assert_eq!(rows[2].width, 3);
}
