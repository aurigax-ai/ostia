#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_panes::wake_reason::wake_reason;
use serde_json::json;

#[test]
fn keeps_plain_text_and_drops_anything_that_is_not_a_string() {
    assert_eq!(
        wake_reason(&json!("its agent exited with code 1")),
        Some("its agent exited with code 1".to_owned())
    );
    assert_eq!(wake_reason(&json!(7)), None);
    assert_eq!(wake_reason(&json!("  ")), None);
}

#[test]
fn strips_control_characters_and_escape_sequences_so_the_answer_stays_one_plain_line() {
    assert_eq!(
        wake_reason(&json!("bad\u{1b}[31m\r\nreason\u{7}")),
        Some("bad[31mreason".to_owned())
    );
}

#[test]
fn caps_the_length() {
    let capped = wake_reason(&json!("x".repeat(5000))).unwrap();
    assert_eq!(capped.encode_utf16().count(), 200);
}
