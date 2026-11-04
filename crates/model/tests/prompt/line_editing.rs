use ostia_model::prompt::line_editing::{
    KeyLike, LineBuffer, LineEditOp, LineEditResult, apply_line_edit, line_edit_op, shell_key_bytes,
};

fn key(k: &str) -> KeyLike {
    let single_lower = k.len() == 1 && k.chars().all(|c| c.is_ascii_lowercase());
    KeyLike {
        key: k.to_owned(),
        code: single_lower.then(|| format!("Key{}", k.to_uppercase())),
        ctrl_key: false,
        alt_key: false,
        meta_key: false,
        shift_key: false,
    }
}

fn ctrl(k: &str) -> KeyLike {
    KeyLike {
        ctrl_key: true,
        ..key(k)
    }
}

fn alt(k: &str) -> KeyLike {
    KeyLike {
        alt_key: true,
        ..key(k)
    }
}

fn buf(text: &str, caret: usize) -> LineBuffer {
    LineBuffer {
        text: text.to_owned(),
        caret,
    }
}

fn edited(text: &str, caret: usize, killed: Option<&str>) -> LineEditResult {
    LineEditResult {
        text: text.to_owned(),
        caret,
        killed: killed.map(str::to_owned),
    }
}

#[test]
fn maps_readline_keys_the_editor_handles_itself() {
    assert_eq!(line_edit_op(&ctrl("a")), Some(LineEditOp::Home));
    assert_eq!(line_edit_op(&ctrl("e")), Some(LineEditOp::End));
    assert_eq!(line_edit_op(&ctrl("w")), Some(LineEditOp::KillWordBack));
    assert_eq!(line_edit_op(&ctrl("p")), Some(LineEditOp::HistoryPrev));
    assert_eq!(line_edit_op(&ctrl("l")), Some(LineEditOp::ClearScreen));
    assert_eq!(line_edit_op(&alt("b")), Some(LineEditOp::WordBack));
}

#[test]
fn maps_every_ctrl_and_alt_letter_the_editor_owns() {
    let ctrl_table = [
        ("a", LineEditOp::Home),
        ("e", LineEditOp::End),
        ("b", LineEditOp::CharBack),
        ("f", LineEditOp::CharForward),
        ("k", LineEditOp::KillEnd),
        ("u", LineEditOp::KillStart),
        ("w", LineEditOp::KillWordBack),
        ("d", LineEditOp::DeleteChar),
        ("h", LineEditOp::Backspace),
        ("y", LineEditOp::Yank),
        ("p", LineEditOp::HistoryPrev),
        ("n", LineEditOp::HistoryNext),
        ("l", LineEditOp::ClearScreen),
    ];
    for (letter, op) in ctrl_table {
        assert_eq!(line_edit_op(&ctrl(letter)), Some(op), "ctrl+{letter}");
    }
    let alt_table = [
        ("b", LineEditOp::WordBack),
        ("f", LineEditOp::WordForward),
        ("d", LineEditOp::KillWordForward),
    ];
    for (letter, op) in alt_table {
        assert_eq!(line_edit_op(&alt(letter)), Some(op), "alt+{letter}");
    }
    assert_eq!(line_edit_op(&alt("a")), None);
}

#[test]
fn reads_the_physical_key_so_a_non_latin_layout_still_maps() {
    let layout_key = KeyLike {
        code: Some("KeyA".to_owned()),
        ..ctrl("ф")
    };
    assert_eq!(line_edit_op(&layout_key), Some(LineEditOp::Home));
}

#[test]
fn ignores_shifted_meta_and_alt_gr_combinations_and_keys_it_does_not_own() {
    let shifted = KeyLike {
        shift_key: true,
        ..ctrl("a")
    };
    assert_eq!(line_edit_op(&shifted), None);
    let meta = KeyLike {
        meta_key: true,
        ..key("a")
    };
    assert_eq!(line_edit_op(&meta), None);
    let alt_gr = KeyLike {
        alt_key: true,
        ..ctrl("a")
    };
    assert_eq!(line_edit_op(&alt_gr), None);
    assert_eq!(line_edit_op(&ctrl("r")), None);
    assert_eq!(line_edit_op(&key("a")), None);
}

#[test]
fn encodes_keys_that_hand_off_to_the_shells_own_widgets() {
    assert_eq!(shell_key_bytes(&ctrl("r")).as_deref(), Some("\x12"));
    assert_eq!(shell_key_bytes(&ctrl("t")).as_deref(), Some("\x14"));
    assert_eq!(shell_key_bytes(&alt("c")).as_deref(), Some("\x1bc"));
    let period = KeyLike {
        code: Some("Period".to_owned()),
        ..alt(".")
    };
    assert_eq!(shell_key_bytes(&period).as_deref(), Some("\x1b."));
}

#[test]
fn leaves_copy_paste_cut_and_undo_to_the_text_field() {
    for k in ["c", "v", "x", "z"] {
        assert_eq!(shell_key_bytes(&ctrl(k)), None, "ctrl+{k}");
    }
    let shifted = KeyLike {
        shift_key: true,
        ..ctrl("r")
    };
    assert_eq!(shell_key_bytes(&shifted), None);
    assert_eq!(shell_key_bytes(&key("r")), None);
}

#[test]
fn encodes_control_codes_and_escape_prefixes_for_the_remaining_keys() {
    assert_eq!(shell_key_bytes(&ctrl("a")).as_deref(), Some("\x01"));
    assert_eq!(shell_key_bytes(&alt("!")).as_deref(), Some("\x1b!"));
    assert_eq!(shell_key_bytes(&alt("A")).as_deref(), Some("\x1ba"));
    assert_eq!(shell_key_bytes(&ctrl("1")), None);
    assert_eq!(shell_key_bytes(&alt("Enter")), None);
    let alt_gr = KeyLike {
        alt_key: true,
        ..ctrl("r")
    };
    assert_eq!(shell_key_bytes(&alt_gr), None);
}

#[test]
fn moves_within_the_current_line_of_a_multi_line_draft() {
    assert_eq!(
        apply_line_edit(LineEditOp::Home, &buf("ls\necho hi", 8), "").caret,
        3
    );
    assert_eq!(
        apply_line_edit(LineEditOp::End, &buf("ls -la\necho", 1), "").caret,
        6
    );
}

#[test]
fn moves_by_words() {
    assert_eq!(
        apply_line_edit(LineEditOp::WordBack, &buf("git commit -m", 13), "").caret,
        12
    );
    assert_eq!(
        apply_line_edit(LineEditOp::WordForward, &buf("git commit", 0), "").caret,
        3
    );
}

#[test]
fn moves_by_one_character_and_stays_inside_the_text() {
    let back = |text, caret| apply_line_edit(LineEditOp::CharBack, &buf(text, caret), "").caret;
    let forward =
        |text, caret| apply_line_edit(LineEditOp::CharForward, &buf(text, caret), "").caret;
    assert_eq!(back("abc", 2), 1);
    assert_eq!(back("abc", 0), 0);
    assert_eq!(forward("abc", 1), 2);
    assert_eq!(forward("abc", 3), 3);
}

#[test]
fn kills_to_the_ends_of_the_line_and_by_whitespace_word_returning_the_killed_text() {
    assert_eq!(
        apply_line_edit(LineEditOp::KillEnd, &buf("echo hello", 4), ""),
        edited("echo", 4, Some(" hello"))
    );
    assert_eq!(
        apply_line_edit(LineEditOp::KillStart, &buf("echo hello", 5), ""),
        edited("hello", 0, Some("echo "))
    );
    assert_eq!(
        apply_line_edit(LineEditOp::KillWordBack, &buf("cd ~/a/b ", 9), ""),
        edited("cd ", 3, Some("~/a/b "))
    );
}

#[test]
fn kills_the_word_ahead_and_kills_nothing_at_the_edges() {
    assert_eq!(
        apply_line_edit(LineEditOp::KillWordForward, &buf("git commit", 0), ""),
        edited(" commit", 0, Some("git"))
    );
    assert_eq!(
        apply_line_edit(LineEditOp::KillEnd, &buf("abc", 3), ""),
        edited("abc", 3, None)
    );
    assert_eq!(
        apply_line_edit(LineEditOp::KillStart, &buf("abc", 0), ""),
        edited("abc", 0, None)
    );
}

#[test]
fn joins_the_next_line_when_killing_at_the_end_of_a_line() {
    assert_eq!(
        apply_line_edit(LineEditOp::KillEnd, &buf("a\nb", 1), "").text,
        "ab"
    );
}

#[test]
fn yanks_the_last_killed_text_at_the_caret() {
    assert_eq!(
        apply_line_edit(LineEditOp::Yank, &buf("echo ", 5), "hello"),
        edited("echo hello", 10, None)
    );
    assert_eq!(
        apply_line_edit(LineEditOp::Yank, &buf("echo ", 5), ""),
        edited("echo ", 5, None)
    );
}

#[test]
fn deletes_characters_on_either_side_of_the_caret() {
    assert_eq!(
        apply_line_edit(LineEditOp::DeleteChar, &buf("abc", 1), "").text,
        "ac"
    );
    assert_eq!(
        apply_line_edit(LineEditOp::DeleteChar, &buf("abc", 3), "").text,
        "abc"
    );
    let backspaced = apply_line_edit(LineEditOp::Backspace, &buf("abc", 1), "");
    assert_eq!(backspaced.text, "bc");
    assert_eq!(backspaced.caret, 0);
    assert_eq!(
        apply_line_edit(LineEditOp::Backspace, &buf("abc", 0), "").text,
        "abc"
    );
}

#[test]
fn leaves_the_draft_alone_for_ops_the_host_runs_itself() {
    for op in [
        LineEditOp::HistoryPrev,
        LineEditOp::HistoryNext,
        LineEditOp::ClearScreen,
    ] {
        assert_eq!(
            apply_line_edit(op, &buf("echo hi", 3), "x"),
            edited("echo hi", 3, None),
            "{op:?}"
        );
    }
}

#[test]
fn takes_a_caret_at_the_start_of_a_draft_that_begins_with_a_newline_as_the_start_of_the_next_line()
{
    assert_eq!(
        apply_line_edit(LineEditOp::Home, &buf("\nabc", 0), "").caret,
        1
    );
}
