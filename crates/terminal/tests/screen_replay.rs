#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::screen_replay::{SCREEN_INFO_FORMAT, screen_replay};

#[test]
fn writes_history_and_screen_then_puts_the_cursor_back_where_the_program_left_it() {
    assert_eq!(
        screen_replay("0 4 1 1 0 0 0 0 0 0", &["$ ls", "a  b", "$ "], None),
        "$ ls\x1b[0m\r\na  b\x1b[0m\r\n$ \x1b[0m\x1b[2;5H"
    );
}

#[test]
fn ksh_c12_brings_a_full_screen_program_back_on_the_alternate_screen_with_its_key_modes() {
    let replay = screen_replay(
        "1 9 0 1 1 1 0 0 1 1",
        &["normal1"],
        Some(&["ALTSCREEN", ""]),
    );
    assert_eq!(
        replay,
        "normal1\x1b[0m\x1b[?1049h\x1b[H\x1b[2JALTSCREEN\x1b[0m\r\n\x1b[0m\x1b[1;10H\x1b[?1h\x1b=\x1b[?1003h\x1b[?1006h"
    );
}

#[test]
fn ksh_c66_turns_bracketed_paste_back_on_when_the_program_had_it_on() {
    assert_eq!(
        screen_replay("0 2 0 1 0 0 0 0 0 0 1", &["$ "], None),
        "$ \x1b[0m\x1b[1;3H\x1b[?2004h"
    );
    assert!(!screen_replay("0 2 0 1 0 0 0 0 0 0 0", &["$ "], None).contains("\x1b[?2004h"));
}

#[test]
fn leaves_bracketed_paste_off_when_tmux_has_no_flag_for_it() {
    assert!(!screen_replay("0 2 0 1 0 0 0 0 0 0 ", &["$ "], None).contains("\x1b[?2004h"));
}

#[test]
fn hides_the_cursor_when_the_program_hid_it() {
    assert!(screen_replay("0 0 0 0 0 0 0 0 0 0", &[""], None).contains("\x1b[?25l"));
}

#[test]
fn keeps_the_cursor_visible_when_the_flag_is_not_zero() {
    assert!(!screen_replay("0 0 0 1 0 0 0 0 0 0", &[""], None).contains("\x1b[?25l"));
}

#[test]
fn turns_each_key_mode_on_only_for_its_own_flag() {
    let table = [
        (4, "\x1b[?1h"),
        (5, "\x1b="),
        (6, "\x1b[?1000h"),
        (7, "\x1b[?1002h"),
        (8, "\x1b[?1003h"),
        (9, "\x1b[?1006h"),
        (10, "\x1b[?2004h"),
    ];
    for (index, set) in table {
        let mut fields = ["0"; 11];
        fields[3] = "1";
        fields[index] = "1";
        let replay = screen_replay(&fields.join(" "), &[""], None);
        assert!(
            replay.ends_with(&format!("\x1b[1;1H{set}")),
            "index {index}: {replay:?}"
        );
    }
}

#[test]
fn writes_the_mode_sequences_in_flag_order_after_the_cursor_position() {
    assert_eq!(
        screen_replay("0 0 0 1 1 1 1 1 1 1 1", &[""], None),
        "\x1b[0m\x1b[1;1H\x1b[?1h\x1b=\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h"
    );
}

#[test]
fn treats_a_cursor_position_that_is_not_a_number_as_zero() {
    assert_eq!(screen_replay("0 abc  1", &["x"], None), "x\x1b[0m\x1b[1;1H");
    assert_eq!(screen_replay("0", &["x"], None), "x\x1b[0m\x1b[1;1H");
}

#[test]
fn keeps_the_cursor_visible_when_the_info_has_no_cursor_flag_field() {
    assert_eq!(screen_replay("0 1 1", &["x"], None), "x\x1b[0m\x1b[2;2H");
}

#[test]
fn ignores_spaces_around_the_info_line() {
    assert_eq!(
        screen_replay("  0 4 1 1 0 0 0 0 0 0\n", &["$ "], None),
        screen_replay("0 4 1 1 0 0 0 0 0 0", &["$ "], None)
    );
}

#[test]
fn writes_no_history_lines_and_no_separator_when_there_are_no_rows() {
    assert_eq!(screen_replay("0 0 0 1 0 0 0 0 0 0", &[], None), "\x1b[1;1H");
}

#[test]
fn asks_tmux_for_the_eleven_screen_fields_in_order() {
    assert_eq!(
        SCREEN_INFO_FORMAT,
        "#{alternate_on} #{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag} #{keypad_flag} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_any_flag} #{mouse_sgr_flag} #{bracket_paste_flag}"
    );
}
