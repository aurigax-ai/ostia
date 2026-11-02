#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_model::terminal::blocks::{
    HistoryEntry, LineSpan, PaneOrigin, StepDirection, block_span, collect_history, is_idle_prompt,
    scroll_target_for, step_selection, sticky_block,
};
use ostia_model::terminal::blocks_store::{CommandBlock, LineAnchor};

fn anchor(line: i64) -> LineAnchor {
    LineAnchor { line }
}

fn block(id: &str) -> CommandBlock {
    CommandBlock {
        id: id.to_owned(),
        pane_id: "p1".to_owned(),
        prompt_line: anchor(0),
        input_line: Some(anchor(0)),
        output_start_line: anchor(1),
        end_line: Some(anchor(3)),
        end_col: 0,
        command: "ls".to_owned(),
        typed_command: None,
        exit_code: Some(0),
        cwd: Some("/home/u".to_owned()),
        started_at: 1,
        ended_at: Some(2),
        seq: None,
    }
}

fn span(start: i64, end: i64) -> LineSpan {
    LineSpan { start, end }
}

#[test]
fn spans_the_prompt_line_up_to_the_d_mark_for_a_finished_block() {
    assert_eq!(block_span(&block("a"), 50), span(0, 3));
}

#[test]
fn includes_the_d_row_when_output_ended_mid_line() {
    let mut b = block("a");
    b.end_col = 4;
    assert_eq!(block_span(&b, 50), span(0, 4));
}

#[test]
fn extends_a_running_block_to_the_cursor_line() {
    let mut b = block("a");
    b.end_line = None;
    assert_eq!(block_span(&b, 9), span(0, 10));
}

#[test]
fn falls_back_to_the_output_start_when_the_prompt_line_was_trimmed() {
    let mut b = block("a");
    b.prompt_line = anchor(-1);
    b.output_start_line = anchor(0);
    assert_eq!(block_span(&b, 50).start, 0);
}

#[test]
fn selects_the_newest_block_when_stepping_back_with_nothing_selected() {
    assert_eq!(
        step_selection(&["a", "b", "c"], None, StepDirection::Prev),
        Some("c")
    );
}

#[test]
fn selects_nothing_when_stepping_forward_with_nothing_selected() {
    assert_eq!(
        step_selection(&["a", "b", "c"], None, StepDirection::Next),
        None
    );
}

#[test]
fn moves_one_block_and_clamps_at_both_ends() {
    let ids = ["a", "b", "c"];
    assert_eq!(
        step_selection(&ids, Some("b"), StepDirection::Prev),
        Some("a")
    );
    assert_eq!(
        step_selection(&ids, Some("a"), StepDirection::Prev),
        Some("a")
    );
    assert_eq!(
        step_selection(&ids, Some("b"), StepDirection::Next),
        Some("c")
    );
    assert_eq!(
        step_selection(&ids, Some("c"), StepDirection::Next),
        Some("c")
    );
}

#[test]
fn restarts_from_the_newest_block_when_the_selected_one_is_gone() {
    assert_eq!(
        step_selection(&["a", "b", "c"], Some("gone"), StepDirection::Prev),
        Some("c")
    );
    assert_eq!(step_selection(&[], Some("a"), StepDirection::Prev), None);
}

#[test]
fn does_not_scroll_when_the_block_start_is_already_visible() {
    assert_eq!(scroll_target_for(span(12, 14), 10, 5), None);
}

#[test]
fn scrolls_to_the_block_start_when_it_is_above_or_below_the_viewport() {
    assert_eq!(scroll_target_for(span(3, 14), 10, 5), Some(3));
    assert_eq!(scroll_target_for(span(15, 16), 10, 5), Some(15));
}

fn sticky_blocks() -> Vec<CommandBlock> {
    let mut first = block("a");
    first.prompt_line = anchor(0);
    first.input_line = Some(anchor(0));
    first.end_line = Some(anchor(40));
    let mut second = block("b");
    second.prompt_line = anchor(40);
    second.input_line = Some(anchor(40));
    second.output_start_line = anchor(41);
    second.end_line = None;
    vec![first, second]
}

#[test]
fn shows_the_running_block_when_its_command_line_scrolled_above_the_viewport() {
    let blocks = sticky_blocks();
    assert_eq!(
        sticky_block(&blocks, 60, 90).map(|b| b.id.as_str()),
        Some("b")
    );
}

#[test]
fn shows_nothing_when_the_command_line_is_still_visible() {
    let blocks = sticky_blocks();
    assert!(sticky_block(&blocks, 40, 90).is_none());
}

#[test]
fn shows_an_earlier_block_whose_output_fills_the_top_of_the_viewport() {
    let blocks = sticky_blocks();
    assert_eq!(
        sticky_block(&blocks, 20, 90).map(|b| b.id.as_str()),
        Some("a")
    );
}

#[test]
fn shows_nothing_when_the_block_above_the_viewport_ended_before_it() {
    let mut done = block("c");
    done.end_line = Some(anchor(5));
    assert!(sticky_block(&[done], 10, 20).is_none());
}

#[test]
fn is_idle_only_with_an_open_draft_and_nothing_running() {
    let drafts: HashMap<String, ()> = HashMap::from([("p".to_owned(), ())]);
    let none: HashMap<String, String> = HashMap::new();
    let running: HashMap<String, String> = HashMap::from([("p".to_owned(), "b1".to_owned())]);
    let no_drafts: HashMap<String, ()> = HashMap::new();

    assert!(is_idle_prompt(&drafts, &none, "p"));
    assert!(!is_idle_prompt(&drafts, &running, "p"));
    assert!(!is_idle_prompt(&no_drafts, &none, "p"));
}

fn origins() -> HashMap<String, PaneOrigin> {
    HashMap::from([
        (
            "p1".to_owned(),
            PaneOrigin {
                workspace_id: "s1".to_owned(),
                workspace_name: "api".to_owned(),
            },
        ),
        (
            "p2".to_owned(),
            PaneOrigin {
                workspace_id: "s2".to_owned(),
                workspace_name: "web".to_owned(),
            },
        ),
    ])
}

fn run(id: &str, pane: &str, command: &str, started_at: i64) -> CommandBlock {
    let mut b = block(id);
    b.pane_id = pane.to_owned();
    b.command = command.to_owned();
    b.started_at = started_at;
    b
}

#[test]
fn lists_commands_from_every_pane_newest_first_deduped_by_command_text() {
    let mut web = run("c", "p2", "make test", 9);
    web.cwd = Some("/web".to_owned());
    let by_pane = HashMap::from([
        (
            "p1".to_owned(),
            vec![
                run("a", "p1", "make test", 1),
                run("b", "p1", "git status", 5),
            ],
        ),
        ("p2".to_owned(), vec![web, run("d", "p2", "   ", 10)]),
    ]);

    let history = collect_history(&by_pane, &origins());

    let commands: Vec<&str> = history.iter().map(|h| h.command.as_str()).collect();
    assert_eq!(commands, ["make test", "git status"]);
    let HistoryEntry {
        pane_id,
        workspace_name,
        cwd,
        at,
        ..
    } = &history[0];
    assert_eq!(pane_id, "p2");
    assert_eq!(workspace_name, "web");
    assert_eq!(cwd.as_deref(), Some("/web"));
    assert_eq!(*at, 9);
}

#[test]
fn skips_panes_that_no_longer_belong_to_a_workspace() {
    let by_pane = HashMap::from([("gone".to_owned(), vec![run("x", "gone", "rm -rf x", 1)])]);

    assert!(collect_history(&by_pane, &origins()).is_empty());
}
