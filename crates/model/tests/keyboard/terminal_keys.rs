#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::chord_spec::{ChordProblem, ChordSpec, parse_chord};
use ostia_model::keyboard::terminal_keys::{
    TERMINAL_SEND_MAX, TerminalSend, TerminalSendType, parse_terminal_keys, parse_terminal_send,
    same_send, send_chord_problem, send_data,
};
use serde_json::{Value, json};

fn chord(text: &str) -> ChordSpec {
    parse_chord(text, true).unwrap_or_else(|| panic!("bad chord {text}"))
}

fn send(send_type: TerminalSendType, value: &str) -> TerminalSend {
    TerminalSend {
        send_type,
        value: value.to_owned(),
    }
}

fn data(send_type: TerminalSendType, value: &str) -> Option<String> {
    send_data(&send(send_type, value))
}

#[test]
fn sends_esc_and_then_the_value_for_an_escape_sequence_like_iterm2() {
    assert_eq!(
        data(TerminalSendType::Escape, "b").as_deref(),
        Some("\x1bb")
    );
    assert_eq!(
        data(TerminalSendType::Escape, "[1;5D").as_deref(),
        Some("\x1b[1;5D")
    );
}

#[test]
fn sends_one_character_per_hex_byte_with_or_without_0x_split_by_spaces_or_commas() {
    assert_eq!(
        data(TerminalSendType::Hex, "0x1b 0x7f").as_deref(),
        Some("\x1b\x7f")
    );
    assert_eq!(data(TerminalSendType::Hex, "0x5").as_deref(), Some("\x05"));
    assert_eq!(
        data(TerminalSendType::Hex, "1b,62").as_deref(),
        Some("\x1bb")
    );
    assert_eq!(
        data(TerminalSendType::Hex, " 0x15 ").as_deref(),
        Some("\x15")
    );
}

#[test]
fn refuses_hex_that_is_not_a_byte_from_0x00_to_0x7f() {
    for value in ["", " ", "0x80", "0xff", "0x100", "zz", "0x", "0x1b0x7f"] {
        assert_eq!(data(TerminalSendType::Hex, value), None, "{value:?}");
    }
}

#[test]
fn decodes_backslash_n_r_t_e_backslash_and_xhh_in_text_and_sends_the_rest_as_typed() {
    let cases = [
        ("clear\\r", "clear\r"),
        ("a\\tb\\nc", "a\tb\nc"),
        ("\\e[A", "\x1b[A"),
        ("\\x15", "\x15"),
        ("C:\\\\tmp", "C:\\tmp"),
        ("git status", "git status"),
    ];
    for (value, expected) in cases {
        assert_eq!(
            data(TerminalSendType::Text, value).as_deref(),
            Some(expected),
            "{value:?}"
        );
    }
}

#[test]
fn refuses_empty_text_unknown_escapes_and_x_above_7f() {
    for value in ["", "\\", "\\q", "\\x8a", "\\x1", "end\\"] {
        assert_eq!(data(TerminalSendType::Text, value), None, "{value:?}");
    }
}

#[test]
fn refuses_values_longer_than_1024_characters() {
    assert_eq!(TERMINAL_SEND_MAX, 1024);
    assert_eq!(
        data(TerminalSendType::Text, &"a".repeat(1024)).map(|text| text.len()),
        Some(1024)
    );
    assert_eq!(data(TerminalSendType::Text, &"a".repeat(1025)), None);
    assert_eq!(data(TerminalSendType::Escape, &"a".repeat(1025)), None);
}

#[test]
fn keeps_a_known_type_with_a_value_that_decodes_and_drops_anything_else() {
    let kept = send(TerminalSendType::Hex, "0x01");
    assert_eq!(
        parse_terminal_send(&json!({"type": "hex", "value": "0x01"})),
        Some(kept.clone())
    );
    assert_eq!(
        parse_terminal_send(&json!({"type": "hex", "value": "0x01", "extra": 1})),
        Some(kept)
    );
    let dropped = [
        Value::Null,
        json!("b"),
        json!([]),
        json!({"type": "macro", "value": "b"}),
        json!({"type": "escape"}),
        json!({"type": "escape", "value": 3}),
        json!({"type": "hex", "value": "0x80"}),
    ];
    for raw in dropped {
        assert_eq!(parse_terminal_send(&raw), None, "{raw}");
    }
}

#[test]
fn takes_option_cmd_and_ctrl_chords_and_single_non_typing_keys_like_forward_delete() {
    for text in [
        "Alt+Left",
        "Cmd+Backspace",
        "Alt+Delete",
        "Delete",
        "Home",
        "Shift+Tab",
        "Ctrl+Shift+K",
        "PageUp",
    ] {
        assert_eq!(send_chord_problem(&chord(text)), None, "{text}");
    }
}

#[test]
fn refuses_keys_that_type_plain_escape_tab_and_enter_and_the_1_9_range() {
    let cases = [
        ("a", ChordProblem::Bare),
        ("Shift+a", ChordProblem::Bare),
        ("Shift+Shift", ChordProblem::Invalid),
        ("Space", ChordProblem::Bare),
        ("Enter", ChordProblem::Bare),
        ("Escape", ChordProblem::Escape),
        ("Tab", ChordProblem::Tab),
        ("Cmd+1-9", ChordProblem::DigitRange),
    ];
    for (text, problem) in cases {
        assert_eq!(send_chord_problem(&chord(text)), Some(problem), "{text}");
    }
}

#[test]
fn keeps_chords_that_parse_with_a_valid_send_or_null_trimmed_and_drops_the_rest() {
    let parsed = parse_terminal_keys(&json!({
        " Cmd+Delete ": {"type": "hex", "value": "0x0b"},
        "Delete": null,
        "Alt+Left": {"type": "escape", "value": ""},
        "Cmd+Nope": {"type": "hex", "value": "0x01"},
        "": null
    }));
    assert_eq!(parsed.len(), 2);
    assert_eq!(
        parsed.get("Cmd+Delete"),
        Some(&Some(send(TerminalSendType::Hex, "0x0b")))
    );
    assert_eq!(parsed.get("Delete"), Some(&None));
}

#[test]
fn returns_an_empty_map_for_anything_that_is_not_an_object() {
    let cases = [
        Value::Null,
        json!("x"),
        json!([{"type": "hex", "value": "0x01"}]),
    ];
    for raw in cases {
        assert!(parse_terminal_keys(&raw).is_empty(), "{raw}");
    }
}

#[test]
fn compares_two_sends_by_type_and_value() {
    let base = send(TerminalSendType::Hex, "0x01");
    assert!(same_send(&base, &send(TerminalSendType::Hex, "0x01")));
    assert!(!same_send(&base, &send(TerminalSendType::Text, "0x01")));
    assert!(!same_send(&base, &send(TerminalSendType::Hex, "0x02")));
}

#[test]
fn counts_the_length_limit_in_utf16_units() {
    let pairs = "😀".repeat(512);
    assert_eq!(
        data(TerminalSendType::Text, &pairs).as_deref(),
        Some(pairs.as_str())
    );
    assert_eq!(data(TerminalSendType::Text, &"😀".repeat(513)), None);
    assert_eq!(data(TerminalSendType::Escape, &"😀".repeat(513)), None);
}

#[test]
fn refuses_a_backslash_before_a_line_break_in_text_and_keeps_non_ascii_text_as_typed() {
    assert_eq!(data(TerminalSendType::Text, "a\\\nb"), None);
    assert_eq!(data(TerminalSendType::Text, "a\\\rb"), None);
    assert_eq!(
        data(TerminalSendType::Text, "héllo\\n").as_deref(),
        Some("héllo\n")
    );
}

#[test]
fn accepts_upper_case_hex_digits_and_0x_prefix_in_text_and_hex() {
    assert_eq!(
        data(TerminalSendType::Text, "\\x1B").as_deref(),
        Some("\x1b")
    );
    assert_eq!(
        data(TerminalSendType::Hex, "0X1B 7F").as_deref(),
        Some("\x1b\x7f")
    );
    assert_eq!(
        data(TerminalSendType::Hex, "1b\t62\n63").as_deref(),
        Some("\x1bbc")
    );
}

#[test]
fn leaves_shifted_non_typing_keys_and_modified_plain_keys_free() {
    for text in [
        "Shift+Delete",
        "Shift+Home",
        "Ctrl+Escape",
        "Alt+Enter",
        "Cmd+Tab",
        "Ctrl+Space",
        "Alt+a",
    ] {
        assert_eq!(send_chord_problem(&chord(text)), None, "{text}");
    }
}

#[test]
fn drops_chords_that_name_a_dangerous_segment_and_sends_that_do_not_decode() {
    let parsed = parse_terminal_keys(&json!({
        "__proto__": {"type": "hex", "value": "0x01"},
        "constructor": null,
        "Cmd+Left": {"type": "text", "value": "\\q"},
        "Cmd+Right": {"type": "macro", "value": "x"},
        "Cmd+Up": "x",
        "Cmd+Down": {"type": "escape", "value": "b"}
    }));
    assert_eq!(parsed.len(), 1);
    assert_eq!(
        parsed.get("Cmd+Down"),
        Some(&Some(send(TerminalSendType::Escape, "b")))
    );
}
