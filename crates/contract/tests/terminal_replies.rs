#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::terminal_replies::is_terminal_reply;

#[test]
fn treats_a_name_as_a_reply() {
    let rows: [(&str, &str); 17] = [
        ("focus in", "\x1b[I"),
        ("focus out", "\x1b[O"),
        ("primary device attributes", "\x1b[?1;2c"),
        ("secondary device attributes", "\x1b[>0;276;0c"),
        ("status report", "\x1b[0n"),
        ("cursor position", "\x1b[24;80R"),
        ("extended cursor position", "\x1b[?24;80;1R"),
        ("mode report", "\x1b[?2004;2$y"),
        ("window size report", "\x1b[8;24;80t"),
        ("keyboard protocol report", "\x1b[?0u"),
        ("colour report", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07"),
        (
            "colour report with a string terminator",
            "\x1b]4;1;rgb:cdcd/0000/0000\x1b\\",
        ),
        ("colour report without rgb", "\x1b]10;?\x07"),
        ("window title report", "\x1b]lbuild logs\x1b\\"),
        ("icon label report", "\x1b]Lbuild\x07"),
        ("string report", "\x1bP1+r544e\x1b\\"),
        (
            "several replies in one frame",
            "\x1b[I\x1b[?1;2c\x1b[24;80R",
        ),
    ];
    for (name, data) in rows {
        assert!(is_terminal_reply(data), "{name}: {data:?}");
    }
}

#[test]
fn treats_name_as_input() {
    let rows: [(&str, &str); 13] = [
        ("a letter", "a"),
        ("a line", "ls\r"),
        ("enter", "\r"),
        ("interrupt", "\x03"),
        ("escape", "\x1b"),
        ("an arrow", "\x1b[A"),
        ("a function key", "\x1b[15~"),
        ("a modified F3", "\x1b[1;5R"),
        (
            "a cursor report at row 1, column 2 (known collision with Shift+F3)",
            "\x1b[1;2R",
        ),
        ("a paste", "\x1b[200~hello\x1b[201~"),
        ("a reply followed by a key", "\x1b[Ia"),
        ("a key followed by a reply", "a\x1b[I"),
        ("nothing", ""),
    ];
    for (name, data) in rows {
        assert!(!is_terminal_reply(data), "{name}: {data:?}");
    }
}

#[test]
fn matches_only_the_whole_frame_and_reads_ascii_digits_only() {
    let rows: [(&str, bool); 6] = [
        ("\x1b[I\n", false),
        ("\n\x1b[I", false),
        ("\x1b[\u{0661}\u{0662};80R", false),
        ("\x1b[24;80R\x1b[1;2R", false),
        ("\x1b[1;9R", true),
        ("\x1b]11;rgb:1e1e\u{2028}x\x07", true),
    ];
    for (data, reply) in rows {
        assert_eq!(is_terminal_reply(data), reply, "{data:?}");
    }
}
