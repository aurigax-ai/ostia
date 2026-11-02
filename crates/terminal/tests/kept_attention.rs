#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::KeptAttentionState;
use ostia_terminal::attention_file::SavedAttention;
use ostia_terminal::kept_attention::{KEPT_AGENT_UNREPORTED, KeptAttention};

fn waiting() -> Option<SavedAttention> {
    Some(SavedAttention {
        state: KeptAttentionState::Waiting,
        message: Some(KEPT_AGENT_UNREPORTED.to_owned()),
    })
}

#[test]
fn ksh_c67_treats_a_reattached_pane_whose_agent_kept_running_as_waiting_until_it_reports() {
    let attention = KeptAttention::default();
    attention.reattached("a", true);
    assert_eq!(attention.peek("a"), waiting());
    attention.reported("a");
    assert_eq!(attention.peek("a"), None);
}

#[test]
fn leaves_a_reattached_pane_without_a_running_agent_alone() {
    let attention = KeptAttention::default();
    attention.reattached("a", false);
    assert_eq!(attention.peek("a"), None);
}

#[test]
fn forgets_an_old_mark_when_the_pane_is_reattached_again_without_an_agent() {
    let attention = KeptAttention::default();
    attention.reattached("a", true);
    attention.reattached("a", false);
    assert_eq!(attention.peek("a"), None);
}

#[test]
fn says_the_agent_kept_running_in_the_words_ts_uses() {
    assert_eq!(
        KEPT_AGENT_UNREPORTED,
        "its agent kept running across a restart and has not reported its state since"
    );
}

#[test]
fn marks_each_pane_on_its_own() {
    let attention = KeptAttention::default();
    attention.reattached("a", true);
    attention.reattached("b", true);
    attention.reported("a");
    assert_eq!(attention.peek("a"), None);
    assert_eq!(attention.peek("b"), waiting());
    assert_eq!(attention.peek("c"), None);
}

#[test]
fn ignores_a_report_from_a_pane_that_was_never_marked_and_keeps_the_mark_through_a_second_reattach()
{
    let attention = KeptAttention::default();
    attention.reported("a");
    assert_eq!(attention.peek("a"), None);
    attention.reattached("a", true);
    attention.reattached("a", true);
    assert_eq!(attention.peek("a"), waiting());
    attention.reported("a");
    assert_eq!(attention.peek("a"), None);
}

#[test]
fn shares_the_marks_between_clones() {
    let attention = KeptAttention::default();
    let other = attention.clone();
    attention.reattached("a", true);
    assert_eq!(other.peek("a"), waiting());
}
