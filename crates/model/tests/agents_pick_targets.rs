#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_model::agents::pick_targets::{PickTargetInput, PickWorkspace, pick_targets};
use ostia_model::attention::{AttentionState, PaneAttention};
use ostia_model::layout::types::{Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind};

fn pane(id: &str, kind: SurfaceKind, cwd: Option<&str>) -> LayoutNode {
    let mut node = PaneNode::new(id, id, kind);
    node.cwd = cwd.map(str::to_owned);
    node.into()
}

fn split(children: Vec<LayoutNode>) -> LayoutNode {
    let count = children.len();
    LayoutNode::Split(
        SplitNode {
            id: format!("s-{count}"),
            direction: Direction::Horizontal,
            children,
            sizes: Vec::new(),
            name: None,
            folded: false,
        }
        .into(),
    )
}

fn workspaces() -> Vec<PickWorkspace> {
    vec![
        PickWorkspace {
            id: "A".to_owned(),
            name: "web".to_owned(),
        },
        PickWorkspace {
            id: "B".to_owned(),
            name: "api".to_owned(),
        },
    ]
}

fn layouts() -> HashMap<String, LayoutNode> {
    HashMap::from([
        (
            "A".to_owned(),
            split(vec![
                pane("a-term", SurfaceKind::Terminal, Some("~/web")),
                pane("a-web", SurfaceKind::Browser, None),
                pane("a-agent", SurfaceKind::Terminal, None),
            ]),
        ),
        (
            "B".to_owned(),
            split(vec![
                pane("b-term", SurfaceKind::Terminal, Some("~/api")),
                pane("b-edit", SurfaceKind::Editor, None),
            ]),
        ),
    ])
}

fn input(
    attention: HashMap<String, PaneAttention>,
    touched_at: HashMap<String, f64>,
) -> PickTargetInput {
    PickTargetInput {
        workspaces: workspaces(),
        layouts: layouts(),
        source_workspace_id: "A".to_owned(),
        attention,
        touched_at,
    }
}

#[test]
fn lists_only_terminal_panes_same_workspace_first() {
    let list = pick_targets(&input(HashMap::new(), HashMap::new()));
    let ids: Vec<&str> = list.iter().map(|t| t.pane_id.as_str()).collect();
    assert_eq!(ids, ["a-term", "a-agent", "b-term"]);
    let same: Vec<bool> = list.iter().map(|t| t.same_workspace).collect();
    assert_eq!(same, [true, true, false]);
    assert_eq!(list[2].workspace_name, "api");
    assert_eq!(list[0].cwd.as_deref(), Some("~/web"));
}

#[test]
fn puts_the_most_recently_active_terminal_of_the_workspace_first() {
    let touched = HashMap::from([
        ("a-term".to_owned(), 10.0),
        ("a-agent".to_owned(), 20.0),
        ("b-term".to_owned(), 99.0),
    ]);
    let list = pick_targets(&input(HashMap::new(), touched));
    assert_eq!(list[0].pane_id, "a-agent");
    assert_eq!(list.last().unwrap().pane_id, "b-term");
}

#[test]
fn carries_each_pane_attention_state() {
    let attention = HashMap::from([(
        "a-agent".to_owned(),
        PaneAttention {
            state: AttentionState::Waiting,
            unread: true,
            message: None,
            at: 1.0,
        },
    )]);
    let list = pick_targets(&input(attention, HashMap::new()));
    let state_of = |id: &str| list.iter().find(|t| t.pane_id == id).unwrap().state;
    assert_eq!(state_of("a-agent"), AttentionState::Waiting);
    assert_eq!(state_of("a-term"), AttentionState::None);
}

#[test]
fn includes_a_pane_of_the_agent_kind() {
    let mut data = input(HashMap::new(), HashMap::new());
    data.layouts.insert(
        "B".to_owned(),
        split(vec![
            pane("b-agent", SurfaceKind::Agent, None),
            pane("b-git", SurfaceKind::Git, None),
        ]),
    );
    let list = pick_targets(&data);
    let ids: Vec<&str> = list.iter().map(|t| t.pane_id.as_str()).collect();
    assert_eq!(ids, ["a-term", "a-agent", "b-agent"]);
}

#[test]
fn skips_a_workspace_that_has_no_layout() {
    let mut data = input(HashMap::new(), HashMap::new());
    data.layouts.remove("B");
    let list = pick_targets(&data);
    assert!(list.iter().all(|t| t.workspace_id == "A"));
    assert_eq!(list.len(), 2);
}

#[test]
fn keeps_the_layout_order_when_recency_is_equal() {
    let touched = HashMap::from([("a-term".to_owned(), 5.0), ("a-agent".to_owned(), 5.0)]);
    let list = pick_targets(&input(HashMap::new(), touched));
    let ids: Vec<&str> = list.iter().map(|t| t.pane_id.as_str()).collect();
    assert_eq!(ids, ["a-term", "a-agent", "b-term"]);
}

#[test]
fn ranks_other_workspaces_by_recency_after_the_source_workspace() {
    let mut data = input(HashMap::new(), HashMap::new());
    data.layouts.insert(
        "B".to_owned(),
        split(vec![
            pane("b-old", SurfaceKind::Terminal, None),
            pane("b-new", SurfaceKind::Terminal, None),
        ]),
    );
    data.touched_at = HashMap::from([("b-old".to_owned(), 1.0), ("b-new".to_owned(), 2.0)]);
    let list = pick_targets(&data);
    let ids: Vec<&str> = list.iter().map(|t| t.pane_id.as_str()).collect();
    assert_eq!(ids, ["a-term", "a-agent", "b-new", "b-old"]);
}

#[test]
fn treats_a_workspace_with_the_source_id_as_the_same_workspace_wherever_it_sits() {
    let mut data = input(HashMap::new(), HashMap::new());
    data.source_workspace_id = "B".to_owned();
    let list = pick_targets(&data);
    let ids: Vec<&str> = list.iter().map(|t| t.pane_id.as_str()).collect();
    assert_eq!(ids, ["b-term", "a-term", "a-agent"]);
}
