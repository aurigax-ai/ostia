#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::WorkspaceLiveState::{self, Done, Error, Idle, Waiting, Working};
use ostia_model::ids::{IdMint, IdNamespace};
use ostia_model::layout::tree::create_terminal_pane;
use ostia_model::layout::types::{PaneNode, SurfaceKind};
use ostia_model::workspaces::row_summary::{
    FactTone, RowFact, RowFactInput, RowMark, StateCounts, live_terminal_count, row_fact, row_mark,
    state_counts,
};

fn pane(id: &str, kind: SurfaceKind, hibernated: bool) -> PaneNode {
    let mut ids = IdMint::new(IdNamespace::new("test"));
    let mut pane = create_terminal_pane(&mut ids, "t", Some("/x"));
    pane.id = id.to_string();
    pane.kind = kind;
    pane.hibernated = hibernated;
    pane
}

fn fact(
    state: WorkspaceLiveState,
    message: Option<&str>,
    offline: Option<&str>,
    running: Option<&str>,
) -> Option<RowFact> {
    row_fact(RowFactInput {
        state,
        message,
        offline,
        running,
    })
}

fn line(text: &str, tone: FactTone) -> Option<RowFact> {
    Some(RowFact {
        text: text.to_string(),
        tone,
    })
}

#[test]
fn marks_every_state_but_idle() {
    let marks: Vec<Option<RowMark>> = [Idle, Done, Working, Waiting, Error]
        .into_iter()
        .map(row_mark)
        .collect();
    assert_eq!(
        marks,
        vec![
            None,
            Some(RowMark::Done),
            Some(RowMark::Working),
            Some(RowMark::Waiting),
            Some(RowMark::Error),
        ]
    );
}

#[test]
fn counts_shells_and_agents_never_hibernated_tabs_or_other_surfaces() {
    let panes = [
        pane("a", SurfaceKind::Terminal, false),
        pane("b", SurfaceKind::Agent, false),
        pane("c", SurfaceKind::Terminal, true),
        pane("d", SurfaceKind::Browser, false),
    ];
    assert_eq!(live_terminal_count(&panes), 2);
}

#[test]
fn is_zero_with_no_tabs() {
    assert_eq!(live_terminal_count(&[]), 0);
}

#[test]
fn has_no_line_when_nothing_is_live() {
    assert_eq!(fact(Idle, None, None, None), None);
}

#[test]
fn colours_the_message_by_the_state_it_explains() {
    assert_eq!(
        fact(Waiting, Some("Allow?"), None, None),
        line("Allow?", FactTone::Waiting)
    );
    assert_eq!(
        fact(Error, Some("exit 1"), None, None).map(|f| f.tone),
        Some(FactTone::Error)
    );
    assert_eq!(
        fact(Done, Some("Finished"), None, None).map(|f| f.tone),
        Some(FactTone::Plain)
    );
}

#[test]
fn puts_the_message_before_offline_before_the_running_command() {
    let all = |message| fact(Working, message, Some("o"), Some("r"));
    assert_eq!(
        fact(Working, Some("m"), Some("o"), Some("r")).map(|f| f.text),
        Some("m".to_string())
    );
    assert_eq!(all(None), line("o", FactTone::Muted));
    assert_eq!(
        fact(Working, None, None, Some("r")),
        line("r", FactTone::Muted)
    );
}

#[test]
fn counts_one_per_nonzero_state_and_ignores_idle_and_done() {
    assert_eq!(
        state_counts(&[Waiting, Waiting, Error, Working, Idle, Done]),
        StateCounts {
            waiting: 2,
            error: 1,
            working: 1,
        }
    );
}

#[test]
fn colours_a_message_plain_in_the_idle_and_working_states() {
    for state in [Idle, Working] {
        assert_eq!(
            fact(state, Some("m"), None, None),
            line("m", FactTone::Plain),
            "{state:?}"
        );
    }
}

#[test]
fn skips_an_empty_message_offline_or_running_text_as_the_ts_does() {
    assert_eq!(
        fact(Waiting, Some(""), Some("o"), Some("r")),
        line("o", FactTone::Muted)
    );
    assert_eq!(
        fact(Waiting, Some(""), Some(""), Some("r")),
        line("r", FactTone::Muted)
    );
    assert_eq!(fact(Waiting, Some(""), Some(""), Some("")), None);
}
