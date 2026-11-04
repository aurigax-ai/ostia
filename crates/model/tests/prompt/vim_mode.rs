use ostia_model::prompt::vim_mode::{
    OperatorTarget, VimBuffer, VimCommand, VimInsert, VimMode, VimMotion, VimParse, VimResult,
    apply_vim_command, can_move_vertically, clamp_normal, enter_normal, parse_vim_keys,
};

fn run(keys: &str, text: &str, caret: usize) -> VimResult {
    match parse_vim_keys(keys) {
        VimParse::Command(command) => apply_vim_command(
            &command,
            &VimBuffer {
                text: text.to_owned(),
                caret,
            },
        ),
        other => panic!("not a command: {keys}: {other:?}"),
    }
}

fn result(text: &str, caret: usize, mode: VimMode) -> VimResult {
    VimResult {
        text: text.to_owned(),
        caret,
        mode,
    }
}

fn parsed(keys: &str) -> VimCommand {
    match parse_vim_keys(keys) {
        VimParse::Command(command) => command,
        other => panic!("not a command: {keys}: {other:?}"),
    }
}

fn motion(motion: VimMotion, count: usize) -> VimCommand {
    VimCommand::Move { motion, count }
}

#[test]
fn parses_motions_counts_and_single_key_edits() {
    assert_eq!(parsed("w"), motion(VimMotion::W, 1));
    assert_eq!(parsed("3l"), motion(VimMotion::L, 3));
    assert_eq!(parsed("0"), motion(VimMotion::LineStart, 1));
    assert_eq!(parsed("12x"), VimCommand::DeleteChar { count: 12 });
    assert_eq!(parsed("u"), VimCommand::Undo { count: 1 });
    assert_eq!(
        parsed("A"),
        VimCommand::Insert {
            at: VimInsert::LineEnd
        }
    );
}

#[test]
fn waits_for_the_rest_of_a_count_or_an_operator() {
    for keys in ["", "1", "10", "d", "2c3"] {
        assert_eq!(parse_vim_keys(keys), VimParse::Pending, "{keys:?}");
    }
}

#[test]
fn multiplies_operator_counts_and_reads_doubled_operators_as_whole_lines() {
    assert_eq!(
        parsed("d2w"),
        VimCommand::Delete {
            target: OperatorTarget::Motion(VimMotion::W),
            count: 2
        }
    );
    assert_eq!(
        parsed("2d3w"),
        VimCommand::Delete {
            target: OperatorTarget::Motion(VimMotion::W),
            count: 6
        }
    );
    assert_eq!(
        parsed("3dd"),
        VimCommand::Delete {
            target: OperatorTarget::Line,
            count: 3
        }
    );
    assert_eq!(
        parsed("cw"),
        VimCommand::Change {
            target: OperatorTarget::Motion(VimMotion::W),
            count: 1
        }
    );
    assert_eq!(
        parsed("d$"),
        VimCommand::Delete {
            target: OperatorTarget::Motion(VimMotion::LineEnd),
            count: 1
        }
    );
}

#[test]
fn rejects_unknown_keys_and_operator_pairs_it_does_not_support() {
    for keys in ["z", "dz", "dc", "dj"] {
        assert_eq!(parse_vim_keys(keys), VimParse::Rejected, "{keys:?}");
    }
}

#[test]
fn reads_capital_d_and_c_as_an_operator_to_the_line_end() {
    assert_eq!(
        parsed("D"),
        VimCommand::Delete {
            target: OperatorTarget::Motion(VimMotion::LineEnd),
            count: 1
        }
    );
    assert_eq!(
        parsed("C"),
        VimCommand::Change {
            target: OperatorTarget::Motion(VimMotion::LineEnd),
            count: 1
        }
    );
    assert_eq!(parse_vim_keys("xx"), VimParse::Rejected);
}

#[test]
fn moves_by_words_forward_backward_and_to_word_ends() {
    let text = "git commit --amend";
    assert_eq!(run("w", text, 0).caret, 4);
    assert_eq!(run("2w", text, 0).caret, 11);
    assert_eq!(run("w", text, 11).caret, 13);
    assert_eq!(run("e", text, 0).caret, 2);
    assert_eq!(run("e", text, 2).caret, 9);
    assert_eq!(run("b", text, 11).caret, 4);
    assert_eq!(run("2b", text, 17).caret, 11);
    assert_eq!(run("3b", text, 17).caret, 4);
}

#[test]
fn stays_on_the_line_with_h_l_0_and_dollar_and_never_passes_the_last_character() {
    let text = "git commit --amend";
    assert_eq!(run("h", text, 0).caret, 0);
    assert_eq!(run("5h", text, 3).caret, 0);
    assert_eq!(run("100l", text, 0).caret, 17);
    assert_eq!(run("$", text, 2).caret, 17);
    assert_eq!(run("0", text, 9).caret, 0);
    assert_eq!(run("$", "ab\ncd", 0).caret, 1);
    assert_eq!(run("l", "ab\ncd", 1).caret, 1);
}

#[test]
fn moves_between_lines_with_j_and_k_keeping_the_column_where_it_can() {
    let lines = "first line\nab\nthird line";
    assert_eq!(run("j", lines, 6).caret, 12);
    assert_eq!(run("2j", lines, 6).caret, 20);
    assert_eq!(run("k", lines, 20).caret, 12);
    assert_eq!(run("k", lines, 3).caret, 3);
    assert!(!can_move_vertically(lines, 3, false));
    assert!(can_move_vertically(lines, 3, true));
    assert!(!can_move_vertically(lines, 20, true));
}

#[test]
fn stays_put_on_the_last_line_with_j_and_keeps_the_column() {
    assert_eq!(run("j", "one\ntwo", 5).caret, 5);
    assert_eq!(run("j", "ab", 0).caret, 0);
}

#[test]
fn deletes_characters_with_x_and_a_count_not_past_the_line_end() {
    assert_eq!(run("x", "abc", 1), result("ac", 1, VimMode::Normal));
    assert_eq!(run("5x", "abc\nd", 1), result("a\nd", 0, VimMode::Normal));
}

#[test]
fn deletes_words_to_the_line_edges_and_whole_lines() {
    assert_eq!(run("dw", "git commit --amend", 4).text, "git --amend");
    assert_eq!(run("d2w", "a b c d", 0).text, "c d");
    assert_eq!(run("dw", "one two\nnext", 4).text, "one \nnext");
    assert_eq!(run("db", "git commit", 8).text, "git it");
    assert_eq!(
        run("d$", "echo hello", 5),
        result("echo ", 4, VimMode::Normal)
    );
    assert_eq!(run("d0", "echo hello", 5).text, "hello");
    assert_eq!(
        run("dd", "one\ntwo\nthree", 5),
        result("one\nthree", 4, VimMode::Normal)
    );
    assert_eq!(run("2dd", "one\ntwo\nthree", 0).text, "three");
    assert_eq!(run("dd", "one\ntwo", 5), result("one", 0, VimMode::Normal));
    assert_eq!(run("dd", "only", 2), result("", 0, VimMode::Normal));
}

#[test]
fn deletes_one_character_either_side_and_to_the_end_of_a_word() {
    assert_eq!(run("dh", "abc", 2), result("ac", 1, VimMode::Normal));
    assert_eq!(run("dl", "abc", 1), result("ac", 1, VimMode::Normal));
    assert_eq!(
        run("de", "git commit", 0),
        result(" commit", 0, VimMode::Normal)
    );
}

#[test]
fn changes_to_the_end_of_the_word_not_the_space_after_it_and_enters_insert_mode() {
    assert_eq!(
        run("cw", "git commit --amend", 4),
        result("git  --amend", 4, VimMode::Insert)
    );
    assert_eq!(run("c2w", "a b c", 0).text, " c");
    assert_eq!(
        run("cc", "one\ntwo\nthree", 5),
        result("one\n\nthree", 4, VimMode::Insert)
    );
    assert_eq!(
        run("C", "echo hello", 5),
        result("echo ", 5, VimMode::Insert)
    );
}

#[test]
fn enters_insert_mode_at_the_caret_after_it_at_the_line_edges_and_on_new_lines() {
    assert_eq!(run("i", "abc", 1), result("abc", 1, VimMode::Insert));
    assert_eq!(run("a", "abc", 1).caret, 2);
    assert_eq!(run("A", "abc\ndef", 1).caret, 3);
    assert_eq!(run("I", "  abc", 4).caret, 2);
    assert_eq!(
        run("o", "abc\ndef", 1),
        result("abc\n\ndef", 4, VimMode::Insert)
    );
    assert_eq!(
        run("O", "abc\ndef", 5),
        result("abc\n\ndef", 4, VimMode::Insert)
    );
}

#[test]
fn leaves_the_buffer_alone_for_undo_which_the_host_runs() {
    assert_eq!(run("u", "abc", 1), result("abc", 1, VimMode::Normal));
}

#[test]
fn steps_the_caret_back_one_character_unless_it_is_at_the_line_start() {
    let normal = |text: &str, caret| {
        enter_normal(&VimBuffer {
            text: text.to_owned(),
            caret,
        })
    };
    assert_eq!(normal("abc", 3), result("abc", 2, VimMode::Normal));
    assert_eq!(normal("ab\ncd", 3).caret, 3);
    assert_eq!(normal("", 0).caret, 0);
}

#[test]
fn keeps_the_caret_on_a_character_of_its_line() {
    assert_eq!(clamp_normal("abc", 3), 2);
    assert_eq!(clamp_normal("ab\n\ncd", 3), 3);
    assert_eq!(clamp_normal("", 5), 0);
}
