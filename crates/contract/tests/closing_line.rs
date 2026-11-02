#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::utf16_len;
use ostia_contract::closing_line::{STATUS_MESSAGE_MAX, closing_from_stop, closing_line};
use serde_json::json;

#[test]
fn takes_the_first_line_with_text_on_one_line_without_escape_sequences() {
    assert_eq!(
        closing_line("\n\n  PR #12   open \u{1b}[31m, tests green\u{7}\nlong report follows"),
        Some("PR #12 open [31m, tests green".to_owned())
    );
}

#[test]
fn clips_a_long_line_to_the_status_cap_with_an_ellipsis() {
    let line = closing_line(&"x".repeat(1000)).unwrap();
    assert_eq!(utf16_len(&line), STATUS_MESSAGE_MAX);
    assert!(line.ends_with('…'));
}

#[test]
fn is_none_for_anything_that_holds_no_printable_text() {
    assert_eq!(closing_line(""), None);
    assert_eq!(closing_line(" \n\u{1b}\u{7} "), None);
}

#[test]
fn reads_the_closing_line_out_of_a_stop_hook_payload() {
    let raw = json!({
        "session_id": "s-1",
        "hook_event_name": "Stop",
        "last_assistant_message": "Done: PR #7 is up.\nDetails below.",
    })
    .to_string();
    assert_eq!(
        closing_from_stop(&raw),
        Some("Done: PR #7 is up.".to_owned())
    );
}

#[test]
fn is_none_for_a_payload_without_a_message_a_bad_session_id_or_text_that_is_not_json() {
    assert_eq!(
        closing_from_stop(&json!({ "session_id": "s-1" }).to_string()),
        None
    );
    assert_eq!(
        closing_from_stop(&json!({ "session_id": "", "last_assistant_message": "hi" }).to_string()),
        None
    );
    assert_eq!(closing_from_stop("not json"), None);
}
