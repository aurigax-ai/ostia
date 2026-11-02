#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::panes::panel_keep_alive::{
    KEEP_ALIVE_MAX, PanelInstance, instance_key, keep_instance, same_instance,
};

fn at(ext_id: &str, workspace_id: &str) -> PanelInstance {
    PanelInstance {
        ext_id: ext_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
    }
}

fn on_w1(ext_id: &str) -> PanelInstance {
    at(ext_id, "w1")
}

#[test]
fn adds_a_new_instance_as_the_most_recent() {
    assert_eq!(
        keep_instance(&[on_w1("a")], &on_w1("b"), KEEP_ALIVE_MAX),
        vec![on_w1("a"), on_w1("b")]
    );
}

#[test]
fn moves_a_kept_instance_to_the_end_without_duplicating_it() {
    assert_eq!(
        keep_instance(&[on_w1("a"), on_w1("b")], &on_w1("a"), KEEP_ALIVE_MAX),
        vec![on_w1("b"), on_w1("a")]
    );
}

#[test]
fn evicts_the_least_recently_shown_instance_past_the_cap_and_never_the_shown_one() {
    let mut kept: Vec<PanelInstance> = Vec::new();
    for id in ["a", "b", "c", "d"] {
        kept = keep_instance(&kept, &on_w1(id), KEEP_ALIVE_MAX);
    }
    assert_eq!(kept, vec![on_w1("b"), on_w1("c"), on_w1("d")]);
    assert_eq!(kept.len(), KEEP_ALIVE_MAX);
}

#[test]
fn counts_the_same_extension_in_two_workspaces_as_two_instances() {
    let first = keep_instance(&[], &at("a", "w1"), KEEP_ALIVE_MAX);
    let kept = keep_instance(&first, &at("a", "w2"), KEEP_ALIVE_MAX);
    assert_eq!(kept, vec![at("a", "w1"), at("a", "w2")]);
    assert_ne!(instance_key(&at("a", "w1")), instance_key(&at("a", "w2")));
}

#[test]
fn keeps_only_the_shown_instance_when_the_cap_is_one() {
    assert_eq!(
        keep_instance(&[on_w1("a")], &on_w1("b"), 1),
        vec![on_w1("b")]
    );
}

#[test]
fn has_a_cap_of_three() {
    assert_eq!(KEEP_ALIVE_MAX, 3);
}

#[test]
fn matches_an_instance_only_on_extension_and_workspace_together() {
    assert!(same_instance(&at("a", "w1"), &at("a", "w1")));
    assert!(!same_instance(&at("a", "w1"), &at("a", "w2")));
    assert!(!same_instance(&at("a", "w1"), &at("b", "w1")));
}

#[test]
fn keys_an_instance_by_extension_then_newline_then_workspace() {
    assert_eq!(instance_key(&at("ext", "w9")), "ext\nw9");
}

#[test]
fn drops_the_oldest_kept_instances_when_the_list_is_already_over_the_cap() {
    let kept = [on_w1("a"), on_w1("b"), on_w1("c"), on_w1("d")];
    assert_eq!(
        keep_instance(&kept, &on_w1("e"), KEEP_ALIVE_MAX),
        vec![on_w1("c"), on_w1("d"), on_w1("e")]
    );
}
