#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_model::attention::{AttentionState, PaneAttention};
use ostia_model::layout::{PaneNode, SurfaceKind};
use ostia_model::workspaces::workspace_summary::{latest_attention_message, running_title};

fn pane(id: &str) -> PaneNode {
    PaneNode::new(id, "zsh", SurfaceKind::Terminal)
}

fn titled(id: &str, title: &str) -> PaneNode {
    PaneNode::new(id, title, SurfaceKind::Terminal)
}

fn attention(state: AttentionState, unread: bool, message: Option<&str>, at: f64) -> PaneAttention {
    PaneAttention {
        state,
        unread,
        message: message.map(str::to_owned),
        at,
    }
}

fn by_pane(entries: Vec<(&str, PaneAttention)>) -> HashMap<String, PaneAttention> {
    entries
        .into_iter()
        .map(|(id, a)| (id.to_owned(), a))
        .collect()
}

fn running(entries: &[(&str, &str)]) -> HashMap<String, String> {
    entries
        .iter()
        .map(|(id, block)| ((*id).to_owned(), (*block).to_owned()))
        .collect()
}

#[test]
fn shows_the_newest_unread_message_across_the_workspaces_panes() {
    let by_pane = by_pane(vec![
        (
            "a",
            attention(AttentionState::Done, true, Some("tests passed"), 1.0),
        ),
        (
            "b",
            attention(
                AttentionState::Waiting,
                true,
                Some("Claude needs permission"),
                2.0,
            ),
        ),
    ]);
    assert_eq!(
        latest_attention_message(&[pane("a"), pane("b")], &by_pane),
        Some("Claude needs permission")
    );
}

#[test]
fn keeps_a_waiting_agents_message_after_it_was_read_until_the_state_clears() {
    let by_pane = by_pane(vec![(
        "a",
        attention(
            AttentionState::Waiting,
            false,
            Some("Approve the migration?"),
            3.0,
        ),
    )]);
    assert_eq!(
        latest_attention_message(&[pane("a")], &by_pane),
        Some("Approve the migration?")
    );
}

#[test]
fn ignores_read_messages_and_panes_outside_the_workspace() {
    let by_pane = by_pane(vec![
        (
            "a",
            attention(AttentionState::Done, false, Some("old"), 5.0),
        ),
        (
            "z",
            attention(AttentionState::Waiting, true, Some("elsewhere"), 9.0),
        ),
    ]);
    assert_eq!(latest_attention_message(&[pane("a")], &by_pane), None);
}

#[test]
fn keeps_an_error_message_after_it_was_read() {
    let by_pane = by_pane(vec![(
        "a",
        attention(AttentionState::Error, false, Some("build failed"), 1.0),
    )]);
    assert_eq!(
        latest_attention_message(&[pane("a")], &by_pane),
        Some("build failed")
    );
}

#[test]
fn skips_a_pane_with_no_message_or_an_empty_one() {
    let by_pane = by_pane(vec![
        ("a", attention(AttentionState::Waiting, true, None, 9.0)),
        ("b", attention(AttentionState::Waiting, true, Some(""), 9.0)),
        (
            "c",
            attention(AttentionState::Done, true, Some("kept"), 1.0),
        ),
    ]);
    assert_eq!(
        latest_attention_message(&[pane("a"), pane("b"), pane("c")], &by_pane),
        Some("kept")
    );
}

#[test]
fn keeps_the_first_pane_when_two_messages_have_the_same_time() {
    let by_pane = by_pane(vec![
        (
            "a",
            attention(AttentionState::Done, true, Some("first"), 4.0),
        ),
        (
            "b",
            attention(AttentionState::Done, true, Some("second"), 4.0),
        ),
    ]);
    assert_eq!(
        latest_attention_message(&[pane("a"), pane("b")], &by_pane),
        Some("first")
    );
}

#[test]
fn shows_nothing_when_no_pane_has_attention() {
    assert_eq!(
        latest_attention_message(&[pane("a")], &HashMap::new()),
        None
    );
    assert_eq!(latest_attention_message(&[], &HashMap::new()), None);
}

#[test]
fn prefers_the_active_panes_program_title_while_it_runs() {
    let panes = [titled("a", "npm run dev"), titled("b", "✳ Review PR")];
    assert_eq!(
        running_title(&panes, Some("b"), &running(&[("a", "blk1"), ("b", "blk2")])),
        Some("✳ Review PR")
    );
}

#[test]
fn falls_back_to_any_running_terminal_and_shows_nothing_at_an_idle_prompt() {
    let panes = [titled("a", "~"), titled("b", "vim notes.md")];
    assert_eq!(
        running_title(&panes, Some("a"), &running(&[("b", "blk")])),
        Some("vim notes.md")
    );
    assert_eq!(running_title(&panes, Some("a"), &running(&[])), None);
}

#[test]
fn falls_back_to_the_first_running_terminal_when_there_is_no_active_pane() {
    let panes = [titled("a", "first"), titled("b", "second")];
    assert_eq!(
        running_title(&panes, None, &running(&[("a", "x"), ("b", "y")])),
        Some("first")
    );
}

#[test]
fn ignores_a_running_pane_that_is_not_a_terminal() {
    let panes = [
        PaneNode::new("a", "notes.md", SurfaceKind::Editor),
        titled("b", "htop"),
    ];
    assert_eq!(
        running_title(&panes, Some("a"), &running(&[("a", "x"), ("b", "y")])),
        Some("htop")
    );
}
