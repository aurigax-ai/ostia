#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::terminal_text::{
    PlainTerminalText, PromptMark, PromptMarkScanner, plain_terminal_text,
};

const C: &str = "\x1b]133;C\x1b\\";
const D0: &str = "\x1b]133;D;0\x1b\\";

fn plain(text: &str, consumed: usize) -> PlainTerminalText {
    PlainTerminalText {
        text: text.to_owned(),
        consumed,
    }
}

fn mark(kind: &str, arg: Option<&str>, start: usize, end: usize) -> PromptMark {
    PromptMark {
        kind: kind.to_owned(),
        arg: arg.map(str::to_owned),
        start,
        end,
    }
}

mod plain_terminal_text_cases {
    use super::*;

    #[test]
    fn drops_colours_cursor_moves_and_osc_strings_and_keeps_the_text() {
        let raw = "\x1b[1;32mready\x1b[0m in \x1b]8;;http://x\x07link\x1b]8;;\x07 42ms\r\n\x1b[2Kdone\r\n";
        assert_eq!(
            plain_terminal_text(raw),
            plain("ready in link 42ms\ndone\n", raw.len())
        );
    }

    #[test]
    fn keeps_only_what_a_carriage_return_left_on_the_line() {
        assert_eq!(
            plain_terminal_text("10%\r50%\r100%\r\nok\r\n").text,
            "100%\nok\n"
        );
    }

    #[test]
    fn applies_backspaces_and_drops_other_control_characters() {
        assert_eq!(plain_terminal_text("abx\x08c\x07\tz\n").text, "abc\tz\n");
    }

    #[test]
    fn stops_before_an_escape_sequence_that_is_not_complete_yet() {
        assert_eq!(plain_terminal_text("line\r\n\x1b[38;5"), plain("line\n", 6));
    }

    #[test]
    fn stops_before_a_trailing_carriage_return_whose_newline_may_still_come() {
        assert_eq!(plain_terminal_text("half\r"), plain("half", 4));
    }

    #[test]
    fn stops_before_a_lone_escape_and_before_an_unterminated_string() {
        assert_eq!(plain_terminal_text("ab\x1b"), plain("ab", 2));
        assert_eq!(plain_terminal_text("ab\x1b]0;tit"), plain("ab", 2));
    }

    #[test]
    fn drops_a_string_that_ends_with_the_string_terminator_or_with_the_next_escape() {
        let ended = "\x1b]0;t\x1b\\x";
        assert_eq!(plain_terminal_text(ended), plain("x", ended.len()));
        let cut = "\x1b]0;t\x1b[31mx";
        assert_eq!(plain_terminal_text(cut), plain("x", cut.len()));
    }

    #[test]
    fn drops_a_two_character_escape() {
        assert_eq!(plain_terminal_text("a\x1b7b"), plain("ab", 4));
    }

    #[test]
    fn keeps_a_line_break_after_a_carriage_return_and_drops_the_delete_character() {
        assert_eq!(plain_terminal_text("ab\r\n").text, "ab\n");
        assert_eq!(plain_terminal_text("ab\rc").text, "c");
        assert_eq!(plain_terminal_text("a\x7fb").text, "ab");
    }

    #[test]
    fn ignores_a_backspace_on_an_empty_line() {
        assert_eq!(plain_terminal_text("\x08x").text, "x");
    }

    #[test]
    fn counts_the_consumed_length_in_utf16_units() {
        assert_eq!(plain_terminal_text("é😀\n"), plain("é😀\n", 4));
        assert_eq!(plain_terminal_text("😀\r"), plain("😀", 2));
    }
}

mod prompt_mark_scanner_cases {
    use super::*;

    #[test]
    fn reports_each_osc_133_mark_with_its_position_in_the_stream() {
        let data = format!("$ ls{C}out\r\n{D0}");
        let marks = PromptMarkScanner::default().scan(&data, 1000 + data.len());
        assert_eq!(
            marks,
            vec![
                mark("C", None, 1004, 1004 + C.len()),
                mark("D", Some("0"), 1004 + C.len() + 5, 1000 + data.len()),
            ]
        );
    }

    #[test]
    fn accepts_the_bel_terminator() {
        assert_eq!(
            PromptMarkScanner::default().scan("\x1b]133;D;130\x07", 12),
            vec![mark("D", Some("130"), 0, 12)]
        );
    }

    #[test]
    fn finds_a_mark_split_across_chunks_exactly_once() {
        let data = format!("ab{C}cd");
        for cut in 1..data.len() {
            let mut scanner = PromptMarkScanner::default();
            let mut marks = scanner.scan(&data[..cut], cut);
            marks.extend(scanner.scan(&data[cut..], data.len()));
            assert_eq!(marks, vec![mark("C", None, 2, 2 + C.len())], "cut {cut}");
        }
    }

    #[test]
    fn ignores_other_osc_sequences() {
        assert_eq!(
            PromptMarkScanner::default().scan("\x1b]7;file:///tmp\x07\x1b]633;E;ls\x07", 30),
            Vec::new()
        );
    }

    #[test]
    fn reads_the_kind_and_the_first_argument_and_ignores_the_rest() {
        let scanner = &mut PromptMarkScanner::default();
        let extra = "\x1b]133;D;0;extra\x07";
        assert_eq!(
            scanner.scan(extra, extra.len()),
            vec![mark("D", Some("0"), 0, extra.len())]
        );
        let empty = "\x1b]133;\x07";
        assert_eq!(
            scanner.scan(empty, empty.len()),
            vec![mark("", None, 0, empty.len())]
        );
    }

    #[test]
    fn ends_a_mark_before_an_escape_that_does_not_start_the_string_terminator() {
        assert_eq!(
            PromptMarkScanner::default().scan("\x1b]133;A\x1b[0m", 11),
            vec![mark("A", None, 0, 7)]
        );
    }

    #[test]
    fn carries_a_short_unterminated_mark_and_drops_one_longer_than_256_characters() {
        let short = "\x1b]133;xxxxxxxxxx";
        let mut scanner = PromptMarkScanner::default();
        assert_eq!(scanner.scan(short, short.len()), Vec::new());
        assert_eq!(
            scanner.scan("\x07", short.len() + 1),
            vec![mark("xxxxxxxxxx", None, 0, short.len() + 1)]
        );
        let long = format!("\x1b]133;{}", "x".repeat(300));
        let mut scanner = PromptMarkScanner::default();
        assert_eq!(scanner.scan(&long, long.len()), Vec::new());
        assert_eq!(scanner.scan("\x07", long.len() + 1), Vec::new());
    }

    #[test]
    fn counts_positions_in_utf16_units() {
        let data = "😀\x1b]133;C\x07";
        assert_eq!(
            PromptMarkScanner::default().scan(data, 100),
            vec![mark("C", None, 92, 100)]
        );
    }
}
