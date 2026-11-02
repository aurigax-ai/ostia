#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::workspaces::tab_move_refusal_text::{TabMoveStrings, tab_move_refusal_text};
use ostia_model::workspaces::tab_workspace_move::TabMoveRefusal;

fn strings() -> TabMoveStrings {
    TabMoveStrings {
        same: "The tab is already here".to_string(),
        unknown: "The tab is gone".to_string(),
        manager: "The manager keeps its own workspace".to_string(),
        scratch: "Tabs don’t move into or out of a scratch workspace".to_string(),
        sandbox: "Tabs don’t move into or out of a sandboxed workspace".to_string(),
    }
}

#[test]
fn gives_no_text_when_the_move_is_allowed() {
    assert_eq!(tab_move_refusal_text(&strings(), None), None);
}

#[test]
fn gives_the_dictionary_text_of_each_refusal() {
    let d = strings();
    let table = [
        (TabMoveRefusal::Same, d.same.as_str()),
        (TabMoveRefusal::Unknown, d.unknown.as_str()),
        (TabMoveRefusal::Manager, d.manager.as_str()),
        (TabMoveRefusal::Scratch, d.scratch.as_str()),
        (TabMoveRefusal::Sandbox, d.sandbox.as_str()),
    ];
    for (refusal, text) in table {
        assert_eq!(
            tab_move_refusal_text(&d, Some(refusal)),
            Some(text),
            "{refusal:?}"
        );
    }
}
