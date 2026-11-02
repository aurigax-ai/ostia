#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::sidebar::workspace_groups::{
    DragSource, DropPlace, DropTarget, GroupPatch, GroupRule, Groupable, Grouping, WorkspaceGroup,
    apply_drop, create_group, delete_group, insert_workspace, join_group, leave_group,
    match_group_rule, move_workspace_by, normalize_groups, patch_group, pin_workspace, to_blocks,
};
use ostia_model::workspaces::workspace_order::Orderable;
use ostia_workspaces::workspace_text::WorkspaceGroupColor;

#[derive(Clone, Debug, PartialEq)]
struct W {
    id: String,
    pinned: bool,
    group_id: Option<String>,
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

impl Groupable for W {
    fn group_id(&self) -> Option<&str> {
        self.group_id.as_deref()
    }

    fn set_group_id(&mut self, group_id: Option<String>) {
        self.group_id = group_id;
    }
}

fn group(id: &str) -> WorkspaceGroup {
    WorkspaceGroup {
        id: id.to_owned(),
        name: id.to_uppercase(),
        color: None,
        collapsed: false,
    }
}

fn parse(spec: &str) -> W {
    let pinned = spec.ends_with('*');
    let bare = spec.trim_end_matches('*');
    let (id, group_id) = match bare.split_once(':') {
        Some((id, group_id)) => (id, Some(group_id.to_owned())),
        None => (bare, None),
    };
    W {
        id: id.to_owned(),
        pinned,
        group_id,
    }
}

fn state(spec: &[&str]) -> Grouping<W> {
    let workspaces: Vec<W> = spec.iter().map(|s| parse(s)).collect();
    let mut ids: Vec<String> = Vec::new();
    for w in &workspaces {
        if let Some(group_id) = &w.group_id
            && !ids.contains(group_id)
        {
            ids.push(group_id.clone());
        }
    }
    Grouping {
        workspaces,
        groups: ids.iter().map(|id| group(id)).collect(),
    }
}

fn layout(g: &Grouping<W>) -> Vec<String> {
    g.workspaces
        .iter()
        .map(|w| {
            format!(
                "{}{}{}",
                w.id,
                w.group_id
                    .as_ref()
                    .map(|g| format!(":{g}"))
                    .unwrap_or_default(),
                if w.pinned { "*" } else { "" }
            )
        })
        .collect()
}

fn group_ids(g: &Grouping<W>) -> Vec<String> {
    g.groups.iter().map(|x| x.id.clone()).collect()
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn ws(id: &str) -> DragSource {
    DragSource::Workspace(id.to_owned())
}

fn grp(id: &str) -> DragSource {
    DragSource::Group(id.to_owned())
}

fn over_ws(id: &str, place: DropPlace) -> DropTarget {
    DropTarget::Workspace {
        id: id.to_owned(),
        place,
    }
}

fn over_group(id: &str, place: DropPlace) -> DropTarget {
    DropTarget::Group {
        id: id.to_owned(),
        place,
    }
}

#[test]
fn normalize_groups_pulls_a_groups_members_together_at_its_first_member() {
    assert_eq!(
        layout(&normalize_groups(state(&["a:g", "b", "c:g"]))),
        strs(&["a:g", "c:g", "b"])
    );
}

#[test]
fn normalize_groups_drops_a_group_with_no_members_and_orders_groups_as_they_appear() {
    let mut g = state(&["a:h", "b:g"]);
    g.groups = vec![group("g"), group("empty"), group("h")];
    assert_eq!(group_ids(&normalize_groups(g)), strs(&["h", "g"]));
}

#[test]
fn normalize_groups_ungroups_a_pinned_workspace_and_a_workspace_naming_an_unknown_group() {
    let g = Grouping {
        workspaces: vec![parse("a:g*"), parse("b:gone")],
        groups: vec![group("g")],
    };
    let next = normalize_groups(g);
    assert_eq!(layout(&next), strs(&["a*", "b"]));
    assert!(next.groups.is_empty());
}

#[test]
fn to_blocks_yields_one_block_per_group_and_one_per_ungrouped_workspace_in_order() {
    let blocks = to_blocks(&state(&["a", "b:g", "c:g", "d"]));
    let seen: Vec<(Option<String>, Vec<String>)> = blocks
        .iter()
        .map(|b| {
            (
                b.group.as_ref().map(|g| g.id.clone()),
                b.workspaces.iter().map(|w| w.id.clone()).collect(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            (None, strs(&["a"])),
            (Some("g".to_owned()), strs(&["b", "c"])),
            (None, strs(&["d"])),
        ]
    );
}

#[test]
fn move_workspace_by_moves_a_grouped_workspace_only_within_its_group() {
    let g = state(&["a", "b:g", "c:g", "d"]);
    assert_eq!(
        layout(&move_workspace_by(&g, "c", -1)),
        strs(&["a", "c:g", "b:g", "d"])
    );
    assert_eq!(move_workspace_by(&g, "b", -1), g);
    assert_eq!(move_workspace_by(&g, "c", 1), g);
}

#[test]
fn move_workspace_by_steps_an_ungrouped_workspace_over_a_whole_group() {
    let g = state(&["a", "b:g", "c:g", "d"]);
    assert_eq!(
        layout(&move_workspace_by(&g, "d", -1)),
        strs(&["a", "d", "b:g", "c:g"])
    );
    assert_eq!(
        layout(&move_workspace_by(&g, "a", 1)),
        strs(&["b:g", "c:g", "a", "d"])
    );
}

#[test]
fn move_workspace_by_never_moves_an_unpinned_workspace_above_a_pinned_one_or_a_pinned_one_below() {
    let g = state(&["a*", "b", "c"]);
    assert_eq!(move_workspace_by(&g, "b", -1), g);
    assert_eq!(move_workspace_by(&g, "a", 1), g);
    assert_eq!(
        layout(&move_workspace_by(&g, "c", -1)),
        strs(&["a*", "c", "b"])
    );
}

#[test]
fn apply_drop_joins_the_group_of_the_row_it_is_dropped_next_to() {
    let next = apply_drop(
        &state(&["a", "b:g", "c:g"]),
        &ws("a"),
        &over_ws("c", DropPlace::After),
    );
    assert_eq!(layout(&next), strs(&["b:g", "c:g", "a:g"]));
}

#[test]
fn apply_drop_leaves_its_group_when_dropped_next_to_an_ungrouped_row_and_drops_the_emptied_group() {
    let next = apply_drop(
        &state(&["a:g", "b"]),
        &ws("a"),
        &over_ws("b", DropPlace::After),
    );
    assert_eq!(layout(&next), strs(&["b", "a"]));
    assert!(next.groups.is_empty());
}

#[test]
fn apply_drop_moves_between_groups() {
    let next = apply_drop(
        &state(&["a:g", "b:g", "c:h"]),
        &ws("b"),
        &over_ws("c", DropPlace::Before),
    );
    assert_eq!(layout(&next), strs(&["a:g", "b:h", "c:h"]));
}

#[test]
fn apply_drop_onto_a_group_header_inside_makes_it_the_first_member_before_places_it_above() {
    let g = state(&["a", "b:g", "c:g"]);
    assert_eq!(
        layout(&apply_drop(
            &g,
            &ws("a"),
            &over_group("g", DropPlace::Inside)
        )),
        strs(&["a:g", "b:g", "c:g"])
    );
    assert_eq!(
        layout(&apply_drop(
            &g,
            &ws("c"),
            &over_group("g", DropPlace::Before)
        )),
        strs(&["a", "c", "b:g"])
    );
}

#[test]
fn apply_drop_at_the_end_is_an_ungrouped_workspace() {
    let next = apply_drop(&state(&["a:g", "b:g", "c"]), &ws("a"), &DropTarget::End);
    assert_eq!(layout(&next), strs(&["b:g", "c", "a"]));
}

#[test]
fn apply_drop_unpins_a_pinned_workspace_that_joins_a_group_and_keeps_ungrouped_drops_below_pinned_ones()
 {
    let g = state(&["p*", "a", "b:g"]);
    assert_eq!(
        layout(&apply_drop(&g, &ws("p"), &over_ws("b", DropPlace::After))),
        strs(&["a", "b:g", "p:g"])
    );
    assert_eq!(
        layout(&apply_drop(&g, &ws("b"), &over_ws("p", DropPlace::Before))),
        strs(&["p*", "b", "a"])
    );
}

#[test]
fn apply_drop_reorders_whole_groups_before_or_after_another_block() {
    let g = state(&["a", "b:g", "c:g", "d:h"]);
    assert_eq!(
        layout(&apply_drop(
            &g,
            &grp("h"),
            &over_group("g", DropPlace::Before)
        )),
        strs(&["a", "d:h", "b:g", "c:g"])
    );
    assert_eq!(
        layout(&apply_drop(&g, &grp("g"), &over_ws("a", DropPlace::Before))),
        strs(&["b:g", "c:g", "a", "d:h"])
    );
    let moved = apply_drop(&g, &grp("g"), &over_ws("d", DropPlace::After));
    assert_eq!(layout(&moved), strs(&["a", "d:h", "b:g", "c:g"]));
    assert_eq!(group_ids(&moved), strs(&["h", "g"]));
}

#[test]
fn apply_drop_returns_the_same_state_for_a_no_op_drop() {
    let g = state(&["a", "b:g"]);
    assert_eq!(apply_drop(&g, &ws("a"), &over_ws("a", DropPlace::After)), g);
    assert_eq!(
        apply_drop(&g, &grp("g"), &over_ws("b", DropPlace::Before)),
        g
    );
    assert_eq!(
        apply_drop(&g, &ws("b"), &over_group("g", DropPlace::Inside)),
        g
    );
}

#[test]
fn create_group_around_one_workspace_unpins_it() {
    let next = create_group(&state(&["p*", "a"]), "p", group("g"));
    assert_eq!(layout(&next), strs(&["p:g", "a"]));
    assert_eq!(group_ids(&next), strs(&["g"]));
}

#[test]
fn join_group_as_its_last_member() {
    assert_eq!(
        layout(&join_group(&state(&["a", "b:g", "c"]), "c", "g")),
        strs(&["a", "b:g", "c:g"])
    );
}

#[test]
fn leave_group_to_just_below_it() {
    assert_eq!(
        layout(&leave_group(&state(&["a:g", "b:g", "c"]), "a")),
        strs(&["b:g", "a", "c"])
    );
}

#[test]
fn delete_group_but_keeps_every_member_ungrouped() {
    let next = delete_group(&state(&["a:g", "b:g", "c"]), "g");
    assert_eq!(layout(&next), strs(&["a", "b", "c"]));
    assert!(next.groups.is_empty());
}

#[test]
fn pinning_a_grouped_workspace_takes_it_out_of_the_group() {
    assert_eq!(
        layout(&pin_workspace(&state(&["a", "b:g"]), "b", true)),
        strs(&["b*", "a"])
    );
}

#[test]
fn patch_group_renames_recolors_and_collapses_a_group() {
    let g = state(&["a:g"]);
    let next = patch_group(
        &g,
        "g",
        GroupPatch {
            name: Some("api".to_owned()),
            color: Some(Some(WorkspaceGroupColor::Blue)),
            collapsed: Some(true),
        },
    );
    assert_eq!(
        next.groups,
        vec![WorkspaceGroup {
            id: "g".to_owned(),
            name: "api".to_owned(),
            color: Some(WorkspaceGroupColor::Blue),
            collapsed: true,
        }]
    );
    let cleared = patch_group(
        &next,
        "g",
        GroupPatch {
            name: None,
            color: Some(None),
            collapsed: Some(false),
        },
    );
    assert_eq!(
        cleared.groups,
        vec![WorkspaceGroup {
            id: "g".to_owned(),
            name: "api".to_owned(),
            color: None,
            collapsed: false,
        }]
    );
}

#[test]
fn insert_workspace_grouped_goes_last_in_its_group_and_ungrouped_goes_to_the_end() {
    let g = state(&["a:g", "b:g", "c"]);
    assert_eq!(
        layout(&insert_workspace(&g, parse("n:g"))),
        strs(&["a:g", "b:g", "n:g", "c"])
    );
    assert_eq!(
        layout(&insert_workspace(&g, parse("n"))),
        strs(&["a:g", "b:g", "c", "n"])
    );
}

fn rule(pattern: &str, group: &str) -> GroupRule {
    GroupRule {
        pattern: pattern.to_owned(),
        group: group.to_owned(),
    }
}

fn rules() -> Vec<GroupRule> {
    vec![
        rule("~/work/*", "work"),
        rule("/srv/**", "servers"),
        rule("/tmp/scratch-?", "scratch"),
    ]
}

#[test]
fn match_group_rule_matches_star_within_one_folder_double_star_across_folders_and_question_mark_one_character()
 {
    let rules = rules();
    assert_eq!(
        match_group_rule(&rules, "~/work/api").as_deref(),
        Some("work")
    );
    assert_eq!(match_group_rule(&rules, "~/work/api/sub"), None);
    assert_eq!(
        match_group_rule(&rules, "/srv/a/b/c/").as_deref(),
        Some("servers")
    );
    assert_eq!(
        match_group_rule(&rules, "/tmp/scratch-1").as_deref(),
        Some("scratch")
    );
    assert_eq!(match_group_rule(&rules, "/tmp/scratch-12"), None);
}

#[test]
fn match_group_rule_treats_regex_characters_in_a_pattern_literally() {
    assert_eq!(
        match_group_rule(&[rule("/a+b/(x)", "g")], "/a+b/(x)").as_deref(),
        Some("g")
    );
    assert_eq!(match_group_rule(&[rule("/a+b", "g")], "/aab"), None);
}

#[test]
fn match_group_rule_uses_the_first_matching_rule() {
    assert_eq!(
        match_group_rule(&[rule("/x/**", "first"), rule("/x/y", "second")], "/x/y").as_deref(),
        Some("first")
    );
}
