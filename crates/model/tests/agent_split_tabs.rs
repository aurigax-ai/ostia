#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::panes::agent_split_tabs::AgentSplitTabs;

#[test]
fn reports_a_marked_tab_as_made_by_an_agent() {
    let tabs = AgentSplitTabs::default();
    assert!(!tabs.is_agent_split_tab("t1"));
    tabs.mark_agent_split_tab("t1");
    assert!(tabs.is_agent_split_tab("t1"));
    assert!(!tabs.is_agent_split_tab("t2"));
}

#[test]
fn forgets_a_marked_tab_and_ignores_an_unknown_one() {
    let tabs = AgentSplitTabs::default();
    tabs.mark_agent_split_tab("t1");
    tabs.mark_agent_split_tab("t1");
    tabs.forget_agent_split_tab("t1");
    assert!(!tabs.is_agent_split_tab("t1"));
    tabs.forget_agent_split_tab("never-marked");
}

#[test]
fn shares_marks_between_clones_and_not_between_instances() {
    let tabs = AgentSplitTabs::default();
    let clone = tabs.clone();
    clone.mark_agent_split_tab("t1");
    assert!(tabs.is_agent_split_tab("t1"));
    assert!(!AgentSplitTabs::default().is_agent_split_tab("t1"));
}
