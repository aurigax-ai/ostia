#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::command_line::decode_command_line;

#[test]
fn restores_backslashes_semicolons_and_newlines_the_shell_integration_encoded() {
    assert_eq!(
        decode_command_line(r"echo a\\b\x3b ls\x0acat"),
        "echo a\\b; ls\ncat"
    );
}

#[test]
fn leaves_text_without_escapes_unchanged() {
    assert_eq!(
        decode_command_line("git status --short"),
        "git status --short"
    );
}

#[test]
fn keeps_a_lone_backslash_that_is_not_a_known_escape() {
    assert_eq!(decode_command_line(r"printf \n"), r"printf \n");
}

#[test]
fn reads_hex_in_either_case_and_only_two_digits() {
    let rows = [
        (r"\x4A", "J"),
        (r"\x4a", "J"),
        (r"\x414", "A4"),
        (r"\x4", r"\x4"),
        (r"\xzz", r"\xzz"),
        (r"\x", r"\x"),
    ];
    for (encoded, expected) in rows {
        assert_eq!(
            decode_command_line(encoded),
            expected,
            "encoded {encoded:?}"
        );
    }
}

#[test]
fn decodes_a_byte_above_seven_bits_as_one_latin_one_character() {
    assert_eq!(decode_command_line(r"caf\xe9"), "caf\u{e9}");
    assert_eq!(decode_command_line(r"\xff"), "\u{ff}");
}

#[test]
fn reads_an_escaped_backslash_before_a_hex_escape_so_the_hex_stays_text() {
    assert_eq!(decode_command_line(r"\\x41"), r"\x41");
    assert_eq!(decode_command_line(r"\\\x41"), r"\A");
}

#[test]
fn keeps_a_trailing_backslash_and_multibyte_text() {
    assert_eq!(decode_command_line("日本語 😀\\"), "日本語 😀\\");
}
