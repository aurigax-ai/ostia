#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::hidden_text::{
    code_escape, has_control_character, is_control, is_hidden_format,
};

#[test]
fn names_c0_del_and_c1_as_controls_and_leaves_printable_text_alone() {
    for code in [0x00, 0x1b, 0x7f, 0x85, 0x9b] {
        assert!(is_control(code), "{code:#x}");
    }
    for code in [0x20, 0x41, 0xa0, 0x4e2d] {
        assert!(!is_control(code), "{code:#x}");
    }
}

#[test]
fn names_the_reordering_controls_and_line_separators_as_hidden() {
    for code in [0x061c, 0x202a, 0x202e, 0x2066, 0x2069, 0x2028, 0x2029] {
        assert!(is_hidden_format(code), "{code:#x}");
    }
}

#[test]
fn leaves_joiners_and_direction_marks_that_real_text_needs() {
    for code in [0x200c, 0x200d, 0x200e, 0x200f, 0x2027, 0x2030, 0x41, 0x4e2d] {
        assert!(!is_hidden_format(code), "{code:#x}");
    }
}

#[test]
fn escapes_as_x_for_one_byte_and_u_above() {
    assert_eq!(code_escape(0x1b), "\\x1b");
    assert_eq!(code_escape(0x202e), "\\u202e");
}

#[test]
fn finds_a_control_character_anywhere_in_a_text_and_passes_clean_text() {
    let rows = [
        ("", false),
        ("plain text", false),
        ("中文 and emoji 😀", false),
        ("tab\there", true),
        ("line\nbreak", true),
        ("a\u{7f}b", true),
        ("a\u{85}b", true),
        ("a\u{9f}b", true),
        ("ends with escape\u{1b}", true),
        ("a\u{a0}b", false),
        ("a\u{202e}b", false),
    ];
    for (text, expected) in rows {
        assert_eq!(has_control_character(text), expected, "{text:?}");
    }
}

#[test]
fn pads_the_escape_to_two_digits_for_a_byte_and_four_for_a_wider_code() {
    let rows = [
        (0x00, "\\x00"),
        (0x0a, "\\x0a"),
        (0xff, "\\xff"),
        (0x100, "\\u0100"),
        (0x061c, "\\u061c"),
        (0x2028, "\\u2028"),
    ];
    for (code, expected) in rows {
        assert_eq!(code_escape(code), expected, "{code:#x}");
    }
}
