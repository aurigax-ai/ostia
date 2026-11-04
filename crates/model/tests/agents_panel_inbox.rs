#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_approvals::asks::{ApprovalRequest, QuestionRequest};
use ostia_model::agents::needs_you::{NeedsYouItem, PaneWhere};
use ostia_model::agents::panel_inbox::{
    InboxApproval, InboxCard, InboxInput, InboxNote, card_pane, inbox_cards, waiting_count,
};

fn question(id: &str, pane_id: &str, at: i64) -> QuestionRequest {
    QuestionRequest {
        id: id.to_owned(),
        pane_id: pane_id.to_owned(),
        question: id.to_owned(),
        context: String::new(),
        choices: Vec::new(),
        at,
        permission: None,
        source_workspace: None,
    }
}

fn approval(id: &str, workspace_id: &str, at: i64) -> InboxApproval {
    InboxApproval {
        approval: ApprovalRequest {
            id: id.to_owned(),
            kind: None,
            pane_id: "pa".to_owned(),
            caps: Vec::new(),
            action: id.to_owned(),
            detail: String::new(),
            at,
        },
        workspace_id: workspace_id.to_owned(),
    }
}

fn note(id: &str, pane_id: Option<&str>, at: i64) -> InboxNote {
    InboxNote {
        id: id.to_owned(),
        text: "note".to_owned(),
        pane_id: pane_id.map(str::to_owned),
        at,
    }
}

fn place(workspace_id: &str) -> PaneWhere {
    PaneWhere {
        workspace_id: workspace_id.to_owned(),
        workspace: workspace_id.to_owned(),
        path: "/p".to_owned(),
        short_path: "/p".to_owned(),
        pane: "tab".to_owned(),
    }
}

fn where_of(item: &NeedsYouItem) -> Option<PaneWhere> {
    match item {
        NeedsYouItem::Question { question, .. } => {
            Some(place(if question.pane_id.starts_with("mine") {
                "w1"
            } else {
                "w2"
            }))
        }
        NeedsYouItem::Approval { .. } => None,
    }
}

fn ids(cards: &[InboxCard]) -> Vec<&str> {
    cards.iter().map(InboxCard::id).collect()
}

fn is_note(card: &InboxCard) -> bool {
    matches!(card, InboxCard::Note { .. })
}

#[test]
fn lists_the_workspaces_questions_approvals_and_notes_in_one_flat_list_oldest_first() {
    let questions = [
        question("late", "mine-1", 30),
        question("other", "theirs", 5),
    ];
    let approvals = [approval("mid", "w1", 20), approval("elsewhere", "w2", 1)];
    let notes = [note("abcdefghij", Some("p1"), 10)];
    let cards = inbox_cards(&InboxInput {
        questions: &questions,
        sent: &[],
        approvals: &approvals,
        notes: &notes,
        workspace_id: "w1",
        where_of: &where_of,
    });
    assert_eq!(ids(&cards), ["abcdefghij", "mid", "late"]);
    assert_eq!(
        cards.iter().map(is_note).collect::<Vec<_>>(),
        [true, false, false]
    );
}

#[test]
fn names_the_pane_a_card_belongs_to_and_none_for_a_note_without_one() {
    let questions = [question("q", "mine-1", 1)];
    let approvals = [approval("a", "w1", 2)];
    let notes = [
        note("abcdefghij", None, 3),
        note("bcdefghijk", Some("p9"), 4),
    ];
    let cards = inbox_cards(&InboxInput {
        questions: &questions,
        sent: &[],
        approvals: &approvals,
        notes: &notes,
        workspace_id: "w1",
        where_of: &where_of,
    });
    assert_eq!(
        cards.iter().map(card_pane).collect::<Vec<_>>(),
        [Some("mine-1"), Some("pa"), None, Some("p9")]
    );
}

#[test]
fn keeps_a_question_just_answered_in_the_list_but_does_not_count_it_as_waiting() {
    let answered = question("done", "mine-1", 1);
    let questions = [question("open", "mine-1", 2)];
    let approvals = [approval("a", "w1", 3)];
    let notes = [note("abcdefghij", None, 4)];
    let cards = inbox_cards(&InboxInput {
        questions: &questions,
        sent: std::slice::from_ref(&answered),
        approvals: &approvals,
        notes: &notes,
        workspace_id: "w1",
        where_of: &where_of,
    });
    assert_eq!(cards.len(), 4);
    assert_eq!(waiting_count(&cards), 3);
}

#[test]
fn leaves_out_a_question_whose_place_is_unknown() {
    let questions = [question("q", "mine-1", 1)];
    let cards = inbox_cards(&InboxInput {
        questions: &questions,
        sent: &[],
        approvals: &[],
        notes: &[],
        workspace_id: "w1",
        where_of: &|_| None,
    });
    assert!(cards.is_empty());
}
