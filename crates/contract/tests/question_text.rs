#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::utf16_len;
use ostia_contract::question_text::{clip_to, one_line, plain_block};

#[test]
fn puts_a_line_on_one_row_without_control_characters() {
    assert_eq!(one_line("  Ship\n\u{1b}[31mit\u{7}?  "), "Ship [31mit?");
    assert_eq!(one_line("yes\tplease"), "yes please");
    assert_eq!(one_line(" no "), "no");
}

#[test]
fn keeps_line_breaks_and_tabs_in_a_block_and_drops_other_control_characters() {
    assert_eq!(plain_block("one\r\n\ttwo\u{0}\u{9b}"), "one\n\ttwo");
    assert_eq!(plain_block("a\u{1b}\u{7}b\nc"), "ab\nc");
}

#[test]
fn shows_reordering_controls_and_line_separators_as_escapes_and_keeps_joiners_and_marks() {
    assert_eq!(one_line("ok\u{202e}?"), "ok\\u202e?");
    assert_eq!(plain_block("a\u{2066}b\u{2028}d"), "a\\u2066b\\u2028d");
    let kept = "می\u{200c}خواهم שלום\u{200f} 👨\u{200d}💻 控制";
    assert_eq!(one_line(kept), kept);
    assert_eq!(plain_block(kept), kept);
}

#[test]
fn clips_a_long_text_to_the_cap_with_an_ellipsis() {
    let clipped = clip_to(&"q".repeat(550), 500);
    assert_eq!(utf16_len(&clipped), 500);
    assert!(clipped.ends_with('…'));
    assert_eq!(clip_to("short", 500), "short");
}
