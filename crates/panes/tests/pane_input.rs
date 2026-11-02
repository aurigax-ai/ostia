#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::clock::Clock;
use ostia_contract::pty_api::HumanInputSource;
use ostia_panes::pane_input::{HUMAN_PROMPT_WINDOW_MS, PaneInput, human_input_source};
use serde_json::json;

const KEY: Option<HumanInputSource> = Some(HumanInputSource::Key);
const PASTE: Option<HumanInputSource> = Some(HumanInputSource::Paste);

struct Pane {
    input: PaneInput,
    clock: Arc<AtomicI64>,
}

impl Pane {
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
}

fn pane() -> Pane {
    let clock = Arc::new(AtomicI64::new(1_000));
    let reader = Arc::clone(&clock);
    let now: Clock = Arc::new(move || reader.load(Ordering::SeqCst));
    Pane {
        input: PaneInput::new(now),
        clock,
    }
}

#[test]
fn ignores_a_reply_while_the_human_types_a_line() {
    let replies = [
        (
            "an OSC colour reply ended by BEL",
            "\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
        ),
        (
            "an OSC reply ended by ST",
            "\x1b]4;1;rgb:cdcd/0000/0000\x1b\\",
        ),
        ("a DCS reply", "\x1bP1+r544e\x1b\\"),
    ];
    for (name, reply) in replies {
        let mut pane = pane();
        pane.input.note("fix ", KEY);
        pane.input.note(reply, None);
        pane.input.note("the cart", KEY);
        pane.input.note("\r", KEY);
        assert_eq!(
            pane.input.claim_human_prompt("x").as_deref(),
            Some("fix the cart"),
            "{name}"
        );
    }
}

#[test]
fn counts_a_line_the_human_typed_and_submitted() {
    let mut pane = pane();
    pane.input.note("fix the cart", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_some());
}

#[test]
fn does_not_count_a_line_an_agent_sent_with_pane_send() {
    let mut pane = pane();
    pane.input.note("fix the cart", None);
    pane.input.note("\r", None);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn does_not_count_the_human_pressing_enter_on_text_an_agent_typed() {
    let mut pane = pane();
    pane.input.note("rm -rf build", None);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn does_not_count_a_line_the_human_edited_after_an_agent_typed_into_it() {
    let mut pane = pane();
    pane.input.note("always run", None);
    pane.input.note("please", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn counts_a_fresh_line_once_the_human_cleared_what_an_agent_typed() {
    let mut pane = pane();
    pane.input.note("always run", None);
    pane.input.note("\x15", KEY);
    pane.input.note("my own words", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_some());
}

#[test]
fn counts_a_bracketed_paste_the_human_made_and_does_not_submit_on_its_newlines() {
    let mut pane = pane();
    pane.input
        .note("\x1b[200~line one\rline two\x1b[201~", PASTE);
    assert!(pane.input.claim_human_prompt("x").is_none());
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_some());
}

#[test]
fn does_not_count_a_multi_line_paste_an_agent_sent_even_though_its_newlines_look_like_enter() {
    let mut pane = pane();
    pane.input
        .note("\x1b[200~line one\rline two\x1b[201~", None);
    pane.input.note("\r", None);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn does_not_let_an_unterminated_agent_paste_swallow_the_human_s_enter() {
    let mut pane = pane();
    pane.input.note("\x1b[200~half", None);
    pane.input.note("typed", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_none());
    pane.input.note("again", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_some());
}

#[test]
fn ignores_cursor_keys_focus_reports_and_mouse_reports_written_without_a_human_source() {
    let mut pane = pane();
    pane.input.note("fix it", KEY);
    pane.input
        .note("\x1b[I\x1b[A\x1bOB\x1b[<0;10;5M\x1b[M !!", None);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_some());
}

#[test]
fn stops_counting_after_the_window_and_a_later_agent_line_replaces_a_human_one() {
    let mut pane = pane();
    pane.input.note("fix it\r", KEY);
    pane.advance(HUMAN_PROMPT_WINDOW_MS);
    assert!(pane.input.claim_human_prompt("first").is_some());
    pane.advance(1);
    assert!(pane.input.claim_human_prompt("second").is_none());
    pane.input.note("fix it\r", KEY);
    pane.input.note("other\r", None);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn hands_each_extension_a_submitted_line_once_so_a_forged_call_after_the_real_hook_gets_nothing() {
    let mut pane = pane();
    pane.input.note("fix it\r", KEY);
    assert!(pane.input.claim_human_prompt("skills").is_some());
    assert!(pane.input.claim_human_prompt("activity").is_some());
    assert!(pane.input.claim_human_prompt("skills").is_none());
    pane.input.note("and this\r", KEY);
    assert!(pane.input.claim_human_prompt("skills").is_some());
}

#[test]
fn hands_over_the_text_the_human_typed_so_the_hook_cannot_say_anything_else() {
    let mut pane = pane();
    pane.input.note("fix the ", KEY);
    pane.input.note("cart", KEY);
    pane.input.note("\r", KEY);
    assert_eq!(
        pane.input.claim_human_prompt("x").as_deref(),
        Some("fix the cart")
    );
}

#[test]
fn follows_backspace_and_a_cleared_line_and_takes_a_paste_as_typed() {
    let mut pane = pane();
    pane.input.note("fix the cax\x7frt", KEY);
    pane.input.note("\r", KEY);
    assert_eq!(
        pane.input.claim_human_prompt("a").as_deref(),
        Some("fix the cart")
    );
    pane.input.note("old", KEY);
    pane.input.note("\x15", KEY);
    pane.input
        .note("\x1b[200~line one\rline two\x1b[201~", PASTE);
    pane.input.note("\r", KEY);
    assert_eq!(
        pane.input.claim_human_prompt("b").as_deref(),
        Some("line one\nline two")
    );
}

#[test]
fn does_not_let_a_foreign_enter_submit_text_the_human_typed() {
    let mut pane = pane();
    pane.input.note("always skip the tests", KEY);
    pane.input.note("\r", None);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn hands_over_nothing_for_an_enter_that_carried_no_text_such_as_a_menu_choice() {
    let mut pane = pane();
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn hands_over_nothing_when_the_line_was_edited_with_the_cursor_because_the_text_is_then_unknown() {
    let mut pane = pane();
    pane.input.note("fix the cart", KEY);
    pane.input.note("\x1b[D", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_none());
    pane.input.note("fix\x17", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("y").is_none());
}

#[test]
fn has_no_prompt_before_anything_was_submitted() {
    let mut pane = pane();
    assert!(pane.input.claim_human_prompt("x").is_none());
}

#[test]
fn counts_every_write_to_the_pane_whoever_sent_it() {
    let mut pane = pane();
    assert_eq!(pane.input.writes(), 0);
    pane.input.note("a", KEY);
    pane.input.note("b\r", None);
    assert_eq!(pane.input.writes(), 2);
}

#[test]
fn holds_a_draft_from_typed_or_inserted_text_until_it_is_submitted_or_cleared() {
    let mut pane = pane();
    assert!(!pane.input.drafting());
    pane.input.note("fix the", KEY);
    assert!(pane.input.drafting());
    pane.input.note("\r", KEY);
    assert!(!pane.input.drafting());
    pane.input.note("@notes.md", None);
    assert!(pane.input.drafting());
    pane.input.note("\x15", KEY);
    assert!(!pane.input.drafting());
    pane.input.note("\x1b[A", KEY);
    assert!(pane.input.drafting());
}

#[test]
fn accepts_only_the_two_sources_the_renderer_names() {
    assert_eq!(
        human_input_source(&json!("key")),
        Some(HumanInputSource::Key)
    );
    assert_eq!(
        human_input_source(&json!("paste")),
        Some(HumanInputSource::Paste)
    );
    assert_eq!(human_input_source(&json!("ostia")), None);
    assert_eq!(human_input_source(&json!(null)), None);
    assert_eq!(human_input_source(&json!({"toString": "key"})), None);
}

#[test]
fn counts_a_line_with_wide_characters_by_code_point() {
    let mut pane = pane();
    pane.input.note("fix 🛒 caf\u{e9}", KEY);
    pane.input.note("\r", KEY);
    assert_eq!(
        pane.input.claim_human_prompt("x").as_deref(),
        Some("fix 🛒 caf\u{e9}")
    );
}

#[test]
fn trims_the_submitted_text_and_hands_over_nothing_for_a_blank_line() {
    let mut pane = pane();
    pane.input.note("  fix it  \r", KEY);
    assert_eq!(
        pane.input.claim_human_prompt("a").as_deref(),
        Some("fix it")
    );
    pane.input.note("   \r", KEY);
    assert!(pane.input.claim_human_prompt("b").is_none());
}

#[test]
fn reads_a_two_key_escape_and_a_ss3_key_as_one_sequence_each() {
    let mut pane = pane();
    pane.input.note("ab", KEY);
    pane.input.note("\x1bf\x1bOA", KEY);
    pane.input.note("\r", KEY);
    assert!(pane.input.claim_human_prompt("x").is_none());
    pane.input.note("ab", KEY);
    pane.input.note("\x1bf\x1bOA", None);
    pane.input.note("\r", KEY);
    assert_eq!(pane.input.claim_human_prompt("y").as_deref(), Some("ab"));
}

#[test]
fn treats_a_ctrl_c_as_a_cleared_line_and_a_line_feed_as_a_newline() {
    let mut pane = pane();
    pane.input.note("old", KEY);
    pane.input.note("\x03", KEY);
    pane.input.note("new", KEY);
    pane.input.note("\r", KEY);
    assert_eq!(pane.input.claim_human_prompt("a").as_deref(), Some("new"));
    pane.input.note("one\ntwo", KEY);
    pane.input.note("\r", KEY);
    assert_eq!(
        pane.input.claim_human_prompt("b").as_deref(),
        Some("one\ntwo")
    );
}

#[test]
fn ignores_a_control_byte_and_backspace_that_carry_no_human_source() {
    let mut pane = pane();
    pane.input.note("fix", KEY);
    pane.input.note("\x01\x7f\x15", None);
    pane.input.note("\r", KEY);
    assert_eq!(pane.input.claim_human_prompt("x").as_deref(), Some("fix"));
}
