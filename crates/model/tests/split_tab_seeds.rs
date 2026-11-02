#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::panes::split_tab_seeds::SplitTabSeeds;

#[test]
fn returns_the_seeded_pane_for_a_workspace_and_name() {
    let seeds = SplitTabSeeds::default();
    assert_eq!(seeds.split_tab_seed("w1", "agents"), None);
    seeds.seed_split_tab("w1", "agents", "p1");
    assert_eq!(seeds.split_tab_seed("w1", "agents").as_deref(), Some("p1"));
}

#[test]
fn replaces_the_seed_of_the_same_name_and_keeps_workspaces_apart() {
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "agents", "p1");
    seeds.seed_split_tab("w1", "agents", "p2");
    seeds.seed_split_tab("w2", "agents", "p3");
    assert_eq!(seeds.split_tab_seed("w1", "agents").as_deref(), Some("p2"));
    assert_eq!(seeds.split_tab_seed("w2", "agents").as_deref(), Some("p3"));
    assert_eq!(seeds.split_tab_seed("w1", "other"), None);
}

#[test]
fn forgets_every_seed_whose_pane_is_gone_in_every_workspace() {
    let seeds = SplitTabSeeds::default();
    seeds.seed_split_tab("w1", "a", "p1");
    seeds.seed_split_tab("w1", "b", "p2");
    seeds.seed_split_tab("w2", "a", "p1");
    seeds.seed_split_tab("w2", "c", "p3");
    seeds.forget_split_tab_seeds(["p1", "p9"]);
    assert_eq!(seeds.split_tab_seed("w1", "a"), None);
    assert_eq!(seeds.split_tab_seed("w2", "a"), None);
    assert_eq!(seeds.split_tab_seed("w1", "b").as_deref(), Some("p2"));
    assert_eq!(seeds.split_tab_seed("w2", "c").as_deref(), Some("p3"));
}

#[test]
fn shares_seeds_between_clones() {
    let seeds = SplitTabSeeds::default();
    seeds.clone().seed_split_tab("w1", "a", "p1");
    assert_eq!(seeds.split_tab_seed("w1", "a").as_deref(), Some("p1"));
}
