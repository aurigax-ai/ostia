#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::chat_edits::{
    CHAT_EDITS_MAX, ChatEdit, ChatEditError, ChatEditFailure, apply_edits, parse_edits,
};
use serde_json::{Value, json};

fn edit(old_text: &str, new_text: &str) -> ChatEdit {
    ChatEdit {
        old_text: old_text.to_owned(),
        new_text: new_text.to_owned(),
        replace_all: false,
    }
}

fn edit_all(old_text: &str, new_text: &str) -> ChatEdit {
    ChatEdit {
        old_text: old_text.to_owned(),
        new_text: new_text.to_owned(),
        replace_all: true,
    }
}

fn failure(error: ChatEditError, edit: usize, count: Option<usize>) -> ChatEditFailure {
    ChatEditFailure { error, edit, count }
}

#[test]
fn reads_the_edits_list_the_tool_schema_describes() {
    assert_eq!(
        parse_edits(&json!({
            "path": "a.ts",
            "edits": [
                {"old_text": "a", "new_text": "b"},
                {"old_text": "c", "new_text": "", "replace_all": true},
            ],
        })),
        Some(vec![edit("a", "b"), edit_all("c", "")])
    );
}

#[test]
fn accepts_one_replacement_written_without_the_list() {
    assert_eq!(
        parse_edits(&json!({"path": "a.ts", "old_text": "a", "new_text": "b"})),
        Some(vec![edit("a", "b")])
    );
}

#[test]
fn refuses_an_empty_target_a_missing_replacement_no_edits_and_too_many() {
    assert_eq!(
        parse_edits(&json!({"edits": [{"old_text": "", "new_text": "b"}]})),
        None
    );
    assert_eq!(parse_edits(&json!({"edits": [{"old_text": "a"}]})), None);
    assert_eq!(parse_edits(&json!({"edits": []})), None);
    assert_eq!(parse_edits(&json!({"path": "a.ts"})), None);
    assert_eq!(parse_edits(&json!("a")), None);
    let many: Vec<Value> = (0..=CHAT_EDITS_MAX)
        .map(|_| json!({"old_text": "a", "new_text": "b"}))
        .collect();
    assert_eq!(parse_edits(&json!({"edits": many})), None);
}

#[test]
fn applies_each_edit_to_the_result_of_the_one_before_it() {
    assert_eq!(
        apply_edits("const a = 1\n", &[edit("a", "b"), edit("b = 1", "b = 2")]),
        Ok("const b = 2\n".to_owned())
    );
}

#[test]
fn names_the_edit_that_matched_nothing_or_more_than_once() {
    assert_eq!(
        apply_edits("x x", &[edit("y", "z")]),
        Err(failure(ChatEditError::NoMatch, 0, None))
    );
    assert_eq!(
        apply_edits("x x", &[edit("x", "z")]),
        Err(failure(ChatEditError::Ambiguous, 0, Some(2)))
    );
}

#[test]
fn counts_overlapping_matches_so_a_short_target_in_a_run_is_ambiguous() {
    assert_eq!(
        apply_edits("aaa", &[edit("aa", "b")]),
        Err(failure(ChatEditError::Ambiguous, 0, Some(2)))
    );
    let error = apply_edits("x\n\n\ny", &[edit("\n\n", "\n")]).unwrap_err();
    assert_eq!(error.error, ChatEditError::Ambiguous);
}

#[test]
fn writes_new_lines_with_the_files_crlf_endings_also_when_the_target_is_one_line() {
    assert_eq!(
        apply_edits("a\r\nb\r\n", &[edit("a", "a\nnew")]),
        Ok("a\r\nnew\r\nb\r\n".to_owned())
    );
    assert_eq!(
        apply_edits("a\nb\n", &[edit("a", "a\nnew")]),
        Ok("a\nnew\nb\n".to_owned())
    );
}

#[test]
fn does_not_treat_the_replacement_as_a_pattern() {
    assert_eq!(
        apply_edits("price", &[edit("price", "$& $1")]),
        Ok("$& $1".to_owned())
    );
    assert_eq!(
        apply_edits("a a", &[edit_all("a", "$&")]),
        Ok("$& $&".to_owned())
    );
}

#[test]
fn reads_the_camel_case_names_and_lets_the_snake_case_name_win_unless_it_is_null() {
    assert_eq!(
        parse_edits(&json!({"oldText": "a", "newText": "b", "replaceAll": true})),
        Some(vec![edit_all("a", "b")])
    );
    assert_eq!(
        parse_edits(&json!({"old_text": null, "oldText": "a", "new_text": null, "newText": "b"})),
        Some(vec![edit("a", "b")])
    );
    assert_eq!(
        parse_edits(&json!({"old_text": "", "oldText": "a", "new_text": "b"})),
        None
    );
    assert_eq!(
        parse_edits(
            &json!({"old_text": "a", "new_text": "b", "replace_all": false, "replaceAll": true})
        ),
        Some(vec![edit("a", "b")])
    );
}

#[test]
fn replaces_all_only_for_a_true_flag() {
    for flag in [json!("true"), json!(1), json!(null), json!("yes")] {
        assert_eq!(
            parse_edits(&json!({"old_text": "a", "new_text": "b", "replace_all": flag})),
            Some(vec![edit("a", "b")]),
            "flag {flag}"
        );
    }
}

#[test]
fn takes_the_input_as_one_edit_when_edits_is_not_a_list() {
    assert_eq!(
        parse_edits(&json!({"edits": "x", "old_text": "a", "new_text": "b"})),
        Some(vec![edit("a", "b")])
    );
    assert_eq!(parse_edits(&json!({"edits": "x"})), None);
    assert_eq!(parse_edits(&json!(null)), None);
    assert_eq!(
        parse_edits(&json!([{"old_text": "a", "new_text": "b"}])),
        None
    );
}

#[test]
fn accepts_exactly_the_maximum_number_of_edits() {
    let list: Vec<Value> = (0..CHAT_EDITS_MAX)
        .map(|_| json!({"old_text": "a", "new_text": "b"}))
        .collect();
    assert_eq!(
        parse_edits(&json!({"edits": list})).map(|edits| edits.len()),
        Some(CHAT_EDITS_MAX)
    );
    assert_eq!(CHAT_EDITS_MAX, 32);
}

#[test]
fn refuses_the_whole_list_when_one_entry_is_not_an_edit() {
    for bad in [
        json!("a"),
        json!(null),
        json!(3),
        json!([]),
        json!({"old_text": 1, "new_text": "b"}),
        json!({"old_text": "a", "new_text": 2}),
    ] {
        let list = json!({"edits": [{"old_text": "a", "new_text": "b"}, bad.clone()]});
        assert_eq!(parse_edits(&list), None, "entry {bad}");
    }
}

#[test]
fn replaces_every_match_when_the_edit_asks_for_all() {
    assert_eq!(
        apply_edits("x x x", &[edit_all("x", "yy")]),
        Ok("yy yy yy".to_owned())
    );
    assert_eq!(
        apply_edits("aaa", &[edit_all("aa", "b")]),
        Ok("ba".to_owned())
    );
}

#[test]
fn reports_the_index_of_the_failing_edit() {
    assert_eq!(
        apply_edits("a b b", &[edit("a", "c"), edit("b", "d")]),
        Err(failure(ChatEditError::Ambiguous, 1, Some(2)))
    );
    assert_eq!(
        apply_edits("a b", &[edit("a", "c"), edit("q", "d")]),
        Err(failure(ChatEditError::NoMatch, 1, None))
    );
}

#[test]
fn reports_no_change_when_the_result_equals_the_input() {
    assert_eq!(
        apply_edits("a", &[edit("a", "a")]),
        Err(failure(ChatEditError::NoChange, 0, None))
    );
    assert_eq!(
        apply_edits("a", &[edit("a", "b"), edit("b", "a")]),
        Err(failure(ChatEditError::NoChange, 0, None))
    );
    assert_eq!(
        apply_edits("a", &[]),
        Err(failure(ChatEditError::NoChange, 0, None))
    );
}

#[test]
fn converts_a_multi_line_target_to_crlf_when_the_file_uses_crlf() {
    assert_eq!(
        apply_edits("a\r\nb\r\nc", &[edit("a\nb", "x\ny")]),
        Ok("x\r\ny\r\nc".to_owned())
    );
}

#[test]
fn keeps_a_target_or_replacement_that_already_holds_a_carriage_return() {
    assert_eq!(
        apply_edits("a\r\nb\r\nc", &[edit("a\r\nb", "x\ry\nz")]),
        Ok("x\ry\nz\r\nc".to_owned())
    );
    assert_eq!(
        apply_edits("a\r\nb\nc", &[edit("b\nc", "q")]),
        Ok("a\r\nq".to_owned())
    );
}

#[test]
fn keeps_a_target_that_matches_as_written_in_a_crlf_file() {
    assert_eq!(
        apply_edits("a\nb\r\nc", &[edit("a\nb", "x")]),
        Ok("x\r\nc".to_owned())
    );
}

#[test]
fn leaves_line_endings_alone_when_the_file_has_no_crlf() {
    assert_eq!(
        apply_edits("a\nb", &[edit("a", "x\ny")]),
        Ok("x\ny\nb".to_owned())
    );
}

#[test]
fn matches_non_ascii_text_by_character() {
    assert_eq!(
        apply_edits("héllo 😀 wörld", &[edit("😀", "ok")]),
        Ok("héllo ok wörld".to_owned())
    );
    assert_eq!(
        apply_edits("ééé", &[edit("éé", "x")]),
        Err(failure(ChatEditError::Ambiguous, 0, Some(2)))
    );
}
