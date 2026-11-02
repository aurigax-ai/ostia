use std::sync::Arc;

use ostia_model::ids::IdMint;
use ostia_model::layout::tab_join::join_split_tab;
use ostia_model::layout::tree::{
    create_pane, find_split_tab_by_name, pane_ids, split_of, split_tab_of_pane, tab_id_of,
};
use ostia_model::layout::types::{Direction, LayoutNode, PaneNode, SurfaceKind};
use ostia_model::panes::agent_split_tabs::AgentSplitTabs;
use ostia_model::panes::split_tab_placement::{
    forget_dragged, joined_terminal, mark_new_split_tab, split_tab_anchor, split_tab_partner,
    tab_columns, tab_membership,
};
use ostia_model::panes::split_tab_seeds::SplitTabSeeds;

fn panes(ids: &mut IdMint, count: usize) -> Vec<Arc<PaneNode>> {
    (0..count)
        .map(|_| Arc::new(create_pane(ids, SurfaceKind::Terminal, None, None)))
        .collect()
}

fn loose(ids: &mut IdMint, members: &[Arc<PaneNode>]) -> LayoutNode {
    let children = members.iter().cloned().map(LayoutNode::Pane).collect();
    split_of(ids, Direction::Horizontal, children).into()
}

fn joined(
    ids: &mut IdMint,
    root: &LayoutNode,
    members: &[&Arc<PaneNode>],
    name: &str,
) -> LayoutNode {
    let members: Vec<String> = members.iter().map(|pane| pane.id.clone()).collect();
    join_split_tab(ids, root, &members, name, 3.0, None)
}

fn named_id(root: &LayoutNode, name: &str) -> String {
    find_split_tab_by_name(root, name).unwrap().id.clone()
}

#[test]
fn returns_the_seeded_pane_while_it_is_still_a_loose_pane() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "workers", &members[1].id);
    assert_eq!(
        split_tab_partner(&seeds, "w1", &root, "workers"),
        Some(members[1].id.clone())
    );
}

#[test]
fn has_no_partner_without_a_seed_for_that_workspace_and_name() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let seeds = SplitTabSeeds::default();
    assert_eq!(split_tab_partner(&seeds, "w1", &root, "workers"), None);
    seeds.seed_split_tab("w1", "workers", &members[0].id);
    assert_eq!(split_tab_partner(&seeds, "w2", &root, "workers"), None);
    assert_eq!(split_tab_partner(&seeds, "w1", &root, "other"), None);
}

#[test]
fn has_no_partner_when_the_seeded_pane_is_gone_from_the_layout() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members[..1]);
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "workers", &members[1].id);
    assert_eq!(split_tab_partner(&seeds, "w1", &root, "workers"), None);
}

#[test]
fn has_no_partner_when_the_seeded_pane_already_sits_in_a_split_tab() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let root = loose(&mut ids, &members);
    let root = joined(&mut ids, &root, &[&members[1], &members[2]], "workers");
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "workers", &members[1].id);
    assert_eq!(split_tab_partner(&seeds, "w1", &root, "workers"), None);
}

#[test]
fn marks_a_split_tab_that_the_change_made() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let before = loose(&mut ids, &members);
    let after = joined(&mut ids, &before, &[&members[1], &members[2]], "workers");
    let agents = AgentSplitTabs::default();
    mark_new_split_tab(&agents, &before, &after, "workers");
    assert!(agents.is_agent_split_tab(&named_id(&after, "workers")));
}

#[test]
fn leaves_a_split_tab_that_existed_before_the_change_unmarked() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let loose_root = loose(&mut ids, &members);
    let before = joined(
        &mut ids,
        &loose_root,
        &[&members[1], &members[2]],
        "workers",
    );
    let after = before.clone();
    let agents = AgentSplitTabs::default();
    mark_new_split_tab(&agents, &before, &after, "workers");
    assert!(!agents.is_agent_split_tab(&named_id(&after, "workers")));
}

#[test]
fn marks_nothing_when_no_split_tab_has_that_name() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let before = loose(&mut ids, &members);
    let after = joined(&mut ids, &before, &[&members[1], &members[2]], "workers");
    let agents = AgentSplitTabs::default();
    mark_new_split_tab(&agents, &before, &after, "missing");
    assert!(!agents.is_agent_split_tab(&named_id(&after, "workers")));
}

#[test]
fn anchors_on_the_last_pane_of_an_existing_agent_split_tab() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 4);
    let root = loose(&mut ids, &members);
    let root = joined(&mut ids, &root, &[&members[1], &members[2]], "workers");
    let agents = AgentSplitTabs::default();
    agents.mark_agent_split_tab(&named_id(&root, "workers"));
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "workers", &members[3].id);
    assert_eq!(
        split_tab_anchor(&seeds, &agents, "w1", &root, "workers"),
        Some(members[2].id.clone())
    );
}

#[test]
fn refuses_to_anchor_on_a_split_tab_the_user_made() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 4);
    let root = loose(&mut ids, &members);
    let root = joined(&mut ids, &root, &[&members[1], &members[2]], "workers");
    let agents = AgentSplitTabs::default();
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "workers", &members[3].id);
    assert_eq!(
        split_tab_anchor(&seeds, &agents, "w1", &root, "workers"),
        None
    );
}

#[test]
fn anchors_on_the_seeded_partner_when_no_split_tab_has_the_name() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let agents = AgentSplitTabs::default();
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "workers", &members[1].id);
    assert_eq!(
        split_tab_anchor(&seeds, &agents, "w1", &root, "workers"),
        Some(members[1].id.clone())
    );
}

#[test]
fn has_no_anchor_when_there_is_no_split_tab_and_no_partner() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let agents = AgentSplitTabs::default();
    let seeds = SplitTabSeeds::default();
    assert_eq!(
        split_tab_anchor(&seeds, &agents, "w1", &root, "workers"),
        None
    );
}

#[test]
fn joins_the_new_terminal_with_the_anchor_into_a_new_split_tab() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let fresh = Arc::new(create_pane(&mut ids, SurfaceKind::Terminal, None, None));
    let next = joined_terminal(
        &mut ids,
        &root,
        &members[0].id,
        fresh.clone(),
        "workers",
        3.0,
    );
    let tab = find_split_tab_by_name(&next, "workers").unwrap();
    assert_eq!(
        pane_ids(&LayoutNode::Split(tab)),
        vec![members[0].id.clone(), fresh.id.clone()]
    );
    assert!(split_tab_of_pane(&next, &members[1].id).is_none());
}

#[test]
fn adds_the_new_terminal_to_the_split_tab_that_already_has_the_name() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let root = loose(&mut ids, &members);
    let root = joined(&mut ids, &root, &[&members[1], &members[2]], "workers");
    let fresh = Arc::new(create_pane(&mut ids, SurfaceKind::Terminal, None, None));
    let next = joined_terminal(
        &mut ids,
        &root,
        &members[2].id,
        fresh.clone(),
        "workers",
        3.0,
    );
    let tab = find_split_tab_by_name(&next, "workers").unwrap();
    assert_eq!(
        pane_ids(&LayoutNode::Split(tab)),
        vec![
            members[1].id.clone(),
            members[2].id.clone(),
            fresh.id.clone()
        ]
    );
}

#[test]
fn gives_as_many_columns_as_fit_the_window_with_a_floor_of_two() {
    let table = [
        (1920.0, 4.0),
        (1440.0, 3.0),
        (960.0, 2.0),
        (479.0, 2.0),
        (0.0, 2.0),
    ];
    for (width, columns) in table {
        assert_eq!(tab_columns(width), columns, "width {width}");
    }
}

#[test]
fn names_the_tab_and_the_split_tab_of_a_pane() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let root = loose(&mut ids, &members);
    assert_eq!(
        tab_membership(&root, &members[0].id),
        format!("{}:", members[0].id)
    );
    let root = joined(&mut ids, &root, &[&members[1], &members[2]], "workers");
    let tab_id = tab_id_of(&root, &members[1].id).unwrap();
    assert_eq!(
        tab_membership(&root, &members[1].id),
        format!("{tab_id}:workers")
    );
    assert_eq!(
        tab_membership(&root, &members[0].id),
        format!("{}:", members[0].id)
    );
}

#[test]
fn names_a_pane_that_is_not_in_the_layout_as_null() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 1);
    let root = loose(&mut ids, &members);
    assert_eq!(tab_membership(&root, "pane-missing"), "null:");
}

#[test]
fn forgets_the_seeds_of_every_pane_in_a_dragged_split_tab() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 4);
    let root = loose(&mut ids, &members);
    let root = joined(&mut ids, &root, &[&members[1], &members[2]], "workers");
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "a", &members[1].id);
    seeds.seed_split_tab("w1", "b", &members[2].id);
    seeds.seed_split_tab("w1", "c", &members[3].id);
    forget_dragged(&seeds, Some(&root), &named_id(&root, "workers"));
    assert_eq!(seeds.split_tab_seed("w1", "a"), None);
    assert_eq!(seeds.split_tab_seed("w1", "b"), None);
    assert_eq!(
        seeds.split_tab_seed("w1", "c").as_deref(),
        Some(members[3].id.as_str())
    );
}

#[test]
fn forgets_the_seed_of_a_dragged_pane() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "a", &members[0].id);
    seeds.seed_split_tab("w1", "b", &members[1].id);
    forget_dragged(&seeds, Some(&root), &members[0].id);
    assert_eq!(seeds.split_tab_seed("w1", "a"), None);
    assert_eq!(
        seeds.split_tab_seed("w1", "b").as_deref(),
        Some(members[1].id.as_str())
    );
}

#[test]
fn keeps_every_seed_when_the_dragged_source_or_the_layout_is_missing() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = loose(&mut ids, &members);
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "a", &members[0].id);
    forget_dragged(&seeds, Some(&root), "pane-missing");
    forget_dragged(&seeds, None, &members[0].id);
    assert_eq!(
        seeds.split_tab_seed("w1", "a").as_deref(),
        Some(members[0].id.as_str())
    );
}
