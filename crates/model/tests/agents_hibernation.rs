#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::agents::hibernation::{
    HibernationCandidate, HibernationPlan, HibernationPolicy, plan_hibernation,
};

fn candidate(pane_id: &str) -> HibernationCandidate {
    HibernationCandidate {
        pane_id: pane_id.to_owned(),
        workspace_id: "s1".to_owned(),
        agent_running: true,
        visible: false,
        idle_ms: 3_600_000,
    }
}

fn idle(pane_id: &str, idle_ms: u64) -> HibernationCandidate {
    HibernationCandidate {
        idle_ms,
        ..candidate(pane_id)
    }
}

fn policy() -> HibernationPolicy {
    HibernationPolicy {
        idle_seconds: 600,
        max_live_terminals: 2,
    }
}

fn pane_ids(plan: &HibernationPlan) -> Vec<&str> {
    plan.longest_idle_first
        .iter()
        .map(|c| c.pane_id.as_str())
        .collect()
}

#[test]
fn plans_nothing_while_the_live_agents_fit_under_the_limit() {
    assert_eq!(
        plan_hibernation(&[candidate("a"), candidate("b")], &policy()),
        HibernationPlan {
            excess: 0,
            longest_idle_first: Vec::new(),
        }
    );
}

#[test]
fn orders_the_idle_hidden_agents_longest_idle_first_with_how_many_are_over_the_limit() {
    let plan = plan_hibernation(
        &[
            idle("a", 700_000),
            idle("b", 5_000_000),
            idle("c", 900_000),
            idle("d", 800_000),
        ],
        &policy(),
    );
    assert_eq!(plan.excess, 2);
    assert_eq!(pane_ids(&plan), ["b", "c", "d", "a"]);
}

#[test]
fn never_offers_a_visible_pane_or_one_idle_for_less_than_the_threshold() {
    let shown = HibernationCandidate {
        visible: true,
        ..candidate("shown")
    };
    let plan = plan_hibernation(
        &[
            shown,
            idle("busy", 599_000),
            candidate("idle"),
            idle("also-idle", 1_000_000),
        ],
        &policy(),
    );
    assert_eq!(plan.excess, 2);
    assert_eq!(pane_ids(&plan), ["idle", "also-idle"]);
}

#[test]
fn counts_only_panes_where_the_agent_itself_is_running() {
    let not_agent = |id: &str| HibernationCandidate {
        agent_running: false,
        ..candidate(id)
    };
    let plan = plan_hibernation(
        &[
            not_agent("shell"),
            not_agent("other-cmd"),
            candidate("a"),
            candidate("b"),
        ],
        &policy(),
    );
    assert_eq!(
        plan,
        HibernationPlan {
            excess: 0,
            longest_idle_first: Vec::new(),
        }
    );
}

#[test]
fn offers_every_idle_hidden_agent_when_the_limit_is_zero() {
    let visible = HibernationCandidate {
        visible: true,
        ..candidate("b")
    };
    let plan = plan_hibernation(
        &[candidate("a"), visible],
        &HibernationPolicy {
            idle_seconds: 600,
            max_live_terminals: 0,
        },
    );
    assert_eq!(plan.excess, 2);
    assert_eq!(pane_ids(&plan), ["a"]);
}

#[test]
fn keeps_the_input_order_of_panes_that_are_idle_for_the_same_time() {
    let plan = plan_hibernation(
        &[idle("x", 900_000), idle("y", 900_000), idle("z", 900_000)],
        &HibernationPolicy {
            idle_seconds: 600,
            max_live_terminals: 0,
        },
    );
    assert_eq!(pane_ids(&plan), ["x", "y", "z"]);
}
