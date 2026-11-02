#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::utf16_len;
use ostia_contract::questions::{
    QUESTION_CHOICE_MAX, QUESTION_CHOICES_MAX, QUESTION_CONTEXT_MAX, QUESTION_MAX,
    QUESTION_REPLY_MAX, QUESTION_TIMEOUT_MAX_S, QuestionAskError, QuestionContent, QuestionMode,
    QuestionReply, QuestionReplyTarget, normalize_question, normalize_reply,
};
use serde_json::{Value, json};

fn content(raw: Value) -> QuestionContent {
    match normalize_question(&raw) {
        Ok(content) => content,
        Err(refusal) => panic!("{:?}: {}", refusal.error, refusal.message),
    }
}

fn refusal(raw: Value) -> Option<QuestionAskError> {
    normalize_question(&raw).err().map(|refusal| refusal.error)
}

fn single() -> QuestionReplyTarget {
    QuestionReplyTarget {
        choices: vec!["a".to_owned(), "b".to_owned(), "c".to_owned()],
        mode: QuestionMode::Single,
        permission: false,
    }
}

fn multi() -> QuestionReplyTarget {
    QuestionReplyTarget {
        mode: QuestionMode::Multi,
        ..single()
    }
}

fn text() -> QuestionReplyTarget {
    QuestionReplyTarget {
        choices: Vec::new(),
        mode: QuestionMode::Text,
        permission: false,
    }
}

fn permission() -> QuestionReplyTarget {
    QuestionReplyTarget {
        permission: true,
        ..single()
    }
}

fn reply_text(target: &QuestionReplyTarget, raw: Value) -> Option<String> {
    normalize_reply(target, &raw).map(|reply| reply.text)
}

#[test]
fn reads_a_free_text_question_when_no_choices_are_given() {
    assert_eq!(
        content(json!({"question": "What next?"})),
        QuestionContent {
            question: "What next?".to_owned(),
            context: String::new(),
            choices: Vec::new(),
            mode: QuestionMode::Text,
            timeout_ms: None,
        }
    );
}

#[test]
fn is_single_choice_with_choices_and_multi_only_when_asked() {
    assert_eq!(
        content(json!({"question": "q", "choices": ["a", "b"]})).mode,
        QuestionMode::Single
    );
    assert_eq!(
        content(json!({"question": "q", "choices": ["a", "b"], "multi": true})).mode,
        QuestionMode::Multi
    );
}

#[test]
fn puts_the_question_and_each_choice_on_one_line_without_control_characters() {
    let parsed = content(json!({
        "question": "  Ship\n\u{1b}[31mit\u{7}?  ",
        "choices": ["yes\tplease", " no "],
    }));
    assert_eq!(parsed.question, "Ship [31mit?");
    assert_eq!(parsed.choices, ["yes please", "no"]);
}

#[test]
fn keeps_line_breaks_and_tabs_in_the_context_and_drops_other_control_characters() {
    assert_eq!(
        content(json!({"question": "q", "context": "one\r\n\ttwo\u{0}\u{9b}"})).context,
        "one\n\ttwo"
    );
}

#[test]
fn shows_reordering_controls_and_line_separators_as_escapes_and_keeps_joiners_and_marks() {
    let parsed = content(json!({"question": "ok\u{202e}?", "context": "a\u{2066}b\u{2028}d"}));
    assert_eq!(parsed.question, "ok\\u202e?");
    assert_eq!(parsed.context, "a\\u2066b\\u2028d");
    let kept = "می\u{200c}خواهم שלום\u{200f} 👨\u{200d}💻 控制";
    let parsed = content(json!({"question": kept, "context": kept}));
    assert_eq!(parsed.question, kept);
    assert_eq!(parsed.context, kept);
}

#[test]
fn clips_a_long_question_and_a_long_context() {
    let parsed = content(json!({
        "question": "q".repeat(QUESTION_MAX + 50),
        "context": "c".repeat(QUESTION_CONTEXT_MAX + 50),
    }));
    assert_eq!(utf16_len(&parsed.question), QUESTION_MAX);
    assert!(parsed.question.ends_with('…'));
    assert_eq!(utf16_len(&parsed.context), QUESTION_CONTEXT_MAX);
}

#[test]
fn refuses_a_missing_or_blank_question() {
    let invalid = Some(QuestionAskError::InvalidQuestion);
    assert_eq!(refusal(json!({})), invalid);
    assert_eq!(refusal(json!({"question": " \n "})), invalid);
    assert_eq!(refusal(json!({"question": 7})), invalid);
    assert_eq!(refusal(Value::Null), invalid);
}

#[test]
fn refuses_too_many_too_long_empty_repeated_or_non_text_choices() {
    let invalid = Some(QuestionAskError::InvalidChoices);
    let many: Vec<String> = (0..=QUESTION_CHOICES_MAX)
        .map(|i| format!("c{i}"))
        .collect();
    assert_eq!(refusal(json!({"question": "q", "choices": many})), invalid);
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["x".repeat(QUESTION_CHOICE_MAX + 1)]})),
        invalid
    );
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["a", " "]})),
        invalid
    );
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["a", "a "]})),
        invalid
    );
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["a", 3]})),
        invalid
    );
    assert_eq!(refusal(json!({"question": "q", "choices": "a"})), invalid);
}

#[test]
fn refuses_multi_without_choices() {
    assert_eq!(
        refusal(json!({"question": "q", "multi": true})),
        Some(QuestionAskError::InvalidChoices)
    );
}

#[test]
fn accepts_a_timeout_in_range_and_refuses_one_outside_it() {
    assert_eq!(
        content(json!({"question": "q", "timeoutSeconds": 1.5})).timeout_ms,
        Some(1500)
    );
    let invalid = Some(QuestionAskError::InvalidTimeout);
    assert_eq!(
        refusal(json!({"question": "q", "timeoutSeconds": 0})),
        invalid
    );
    assert_eq!(
        refusal(json!({"question": "q", "timeoutSeconds": QUESTION_TIMEOUT_MAX_S + 1})),
        invalid
    );
    assert_eq!(
        refusal(json!({"question": "q", "timeoutSeconds": "60"})),
        invalid
    );
}

#[test]
fn refuses_a_context_that_is_not_text() {
    assert_eq!(
        refusal(json!({"question": "q", "context": {"a": 1}})),
        Some(QuestionAskError::InvalidContext)
    );
}

#[test]
fn accepts_one_choice_with_a_comment() {
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [1], "text": " because "})),
        Some(QuestionReply {
            choices: vec![1],
            text: "because".to_owned(),
        })
    );
}

#[test]
fn accepts_a_reply_with_no_choice_in_every_form() {
    let neither = json!({"choices": [], "text": "neither"});
    assert_eq!(
        reply_text(&single(), neither.clone()).as_deref(),
        Some("neither")
    );
    assert_eq!(reply_text(&multi(), neither).as_deref(), Some("neither"));
    assert_eq!(
        reply_text(&text(), json!({"choices": [], "text": "free"})).as_deref(),
        Some("free")
    );
}

#[test]
fn sorts_and_de_duplicates_several_choices() {
    assert_eq!(
        normalize_reply(&multi(), &json!({"choices": [2, 0, 2], "text": ""})),
        Some(QuestionReply {
            choices: vec![0, 2],
            text: String::new(),
        })
    );
}

#[test]
fn refuses_two_choices_for_a_single_choice_question() {
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [0, 1], "text": ""})),
        None
    );
}

#[test]
fn refuses_a_choice_the_question_does_not_have() {
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [3], "text": ""})),
        None
    );
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [-1], "text": ""})),
        None
    );
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [0.5], "text": ""})),
        None
    );
    assert_eq!(
        normalize_reply(&text(), &json!({"choices": [0], "text": "x"})),
        None
    );
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": ["constructor"], "text": ""})),
        None
    );
}

#[test]
fn refuses_an_empty_answer_and_a_malformed_one() {
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [], "text": "  "})),
        None
    );
    assert_eq!(normalize_reply(&single(), &Value::Null), None);
    assert_eq!(normalize_reply(&single(), &json!({"choices": [0]})), None);
    assert_eq!(normalize_reply(&single(), &json!({"text": "x"})), None);
}

#[test]
fn strips_control_characters_from_the_reply_and_clips_it() {
    assert_eq!(
        reply_text(&text(), json!({"choices": [], "text": "a\u{1b}\u{7}b\nc"})).as_deref(),
        Some("ab\nc")
    );
    let clipped = reply_text(
        &text(),
        json!({"choices": [], "text": "x".repeat(QUESTION_REPLY_MAX + 9)}),
    )
    .unwrap();
    assert_eq!(utf16_len(&clipped), QUESTION_REPLY_MAX);
}

#[test]
fn new_a_null_choices_list_counts_as_no_choices() {
    let parsed = content(json!({"question": "q", "choices": null}));
    assert!(parsed.choices.is_empty());
    assert_eq!(parsed.mode, QuestionMode::Text);
}

#[test]
fn new_a_null_context_a_null_multi_and_a_null_timeout_are_refused() {
    assert_eq!(
        refusal(json!({"question": "q", "context": null})),
        Some(QuestionAskError::InvalidContext)
    );
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["a"], "multi": null})),
        Some(QuestionAskError::InvalidChoices)
    );
    assert_eq!(
        refusal(json!({"question": "q", "multi": "yes", "choices": ["a"]})),
        Some(QuestionAskError::InvalidChoices)
    );
    assert_eq!(
        refusal(json!({"question": "q", "timeoutSeconds": null})),
        Some(QuestionAskError::InvalidTimeout)
    );
}

#[test]
fn new_the_timeout_edges_are_inclusive_and_round_to_milliseconds() {
    assert_eq!(
        content(json!({"question": "q", "timeoutSeconds": 1})).timeout_ms,
        Some(1000)
    );
    assert_eq!(
        content(json!({"question": "q", "timeoutSeconds": QUESTION_TIMEOUT_MAX_S})).timeout_ms,
        Some(QUESTION_TIMEOUT_MAX_S * 1000)
    );
    assert_eq!(
        content(json!({"question": "q", "timeoutSeconds": 2.0004})).timeout_ms,
        Some(2000)
    );
    assert_eq!(
        content(json!({"question": "q", "timeoutSeconds": 2.0006})).timeout_ms,
        Some(2001)
    );
    assert_eq!(
        refusal(json!({"question": "q", "timeoutSeconds": 0.999})),
        Some(QuestionAskError::InvalidTimeout)
    );
    assert_eq!(
        refusal(json!({"question": "q", "timeoutSeconds": -5})),
        Some(QuestionAskError::InvalidTimeout)
    );
}

#[test]
fn new_the_refusal_messages_are_the_texts_clients_read() {
    let message = |raw: Value| normalize_question(&raw).err().unwrap().message;
    assert_eq!(message(json!({})), "a question is needed");
    assert_eq!(
        message(json!({"question": "q", "context": 1})),
        "context must be text"
    );
    assert_eq!(
        message(json!({"question": "q", "choices": "a"})),
        "choices must be a list of labels"
    );
    assert_eq!(
        message(json!({"question": "q", "choices": ["a", " "]})),
        "a choice is empty"
    );
    assert_eq!(
        message(json!({"question": "q", "choices": ["a", "a"]})),
        "two choices have the same label"
    );
    assert_eq!(
        message(json!({"question": "q", "multi": "x"})),
        "multi must be true or false"
    );
    assert_eq!(
        message(json!({"question": "q", "multi": true})),
        "multi needs at least one choice"
    );
    assert_eq!(
        message(json!({"question": "q", "timeoutSeconds": 0})),
        "timeout is 1 to 86400 seconds"
    );
    let many: Vec<String> = (0..=QUESTION_CHOICES_MAX)
        .map(|i| format!("c{i}"))
        .collect();
    assert_eq!(
        message(json!({"question": "q", "choices": many})),
        "at most 12 choices"
    );
    assert_eq!(
        message(json!({"question": "q", "choices": ["x".repeat(QUESTION_CHOICE_MAX + 1)]})),
        "a choice is longer than 120 characters"
    );
}

#[test]
fn new_a_question_is_checked_before_the_context_and_the_choices() {
    assert_eq!(
        refusal(json!({"question": " ", "context": 1, "choices": "a"})),
        Some(QuestionAskError::InvalidQuestion)
    );
    assert_eq!(
        refusal(json!({"question": "q", "context": 1, "choices": "a"})),
        Some(QuestionAskError::InvalidContext)
    );
}

#[test]
fn new_a_choice_is_cut_to_a_line_before_the_empty_and_repeat_checks() {
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["a b", "a\nb"]})),
        Some(QuestionAskError::InvalidChoices)
    );
    assert_eq!(
        refusal(json!({"question": "q", "choices": ["\u{1b}\u{7}"]})),
        Some(QuestionAskError::InvalidChoices)
    );
}

#[test]
fn new_a_choice_at_the_cap_is_kept_and_counted_in_utf16_units() {
    let at_cap = "x".repeat(QUESTION_CHOICE_MAX);
    assert_eq!(
        content(json!({"question": "q", "choices": [at_cap.clone()]})).choices,
        [at_cap]
    );
    let emoji = "😀".repeat(QUESTION_CHOICE_MAX / 2 + 1);
    assert_eq!(
        refusal(json!({"question": "q", "choices": [emoji]})),
        Some(QuestionAskError::InvalidChoices)
    );
    let twelve: Vec<String> = (0..QUESTION_CHOICES_MAX).map(|i| format!("c{i}")).collect();
    assert_eq!(
        content(json!({"question": "q", "choices": twelve.clone()})).choices,
        twelve
    );
}

#[test]
fn new_a_whole_number_sent_as_a_float_is_a_valid_choice_index() {
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [1.0], "text": ""})),
        Some(QuestionReply {
            choices: vec![1],
            text: String::new(),
        })
    );
}

#[test]
fn new_a_reply_that_is_not_an_object_or_has_a_wrong_field_type_is_refused() {
    assert_eq!(normalize_reply(&single(), &json!("a")), None);
    assert_eq!(normalize_reply(&single(), &json!([0])), None);
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": [0], "text": 1})),
        None
    );
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": 0, "text": "x"})),
        None
    );
    assert_eq!(
        normalize_reply(&single(), &json!({"choices": null, "text": "x"})),
        None
    );
}

#[test]
fn new_a_permission_question_needs_exactly_one_choice() {
    assert_eq!(
        normalize_reply(&permission(), &json!({"choices": [], "text": "because"})),
        None
    );
    assert_eq!(
        normalize_reply(&permission(), &json!({"choices": [0, 1], "text": ""})),
        None
    );
    assert_eq!(
        normalize_reply(&permission(), &json!({"choices": [2], "text": ""})),
        Some(QuestionReply {
            choices: vec![2],
            text: String::new(),
        })
    );
}

#[test]
fn new_a_choice_with_empty_text_is_a_reply_and_a_text_alone_is_a_reply() {
    assert_eq!(
        normalize_reply(&multi(), &json!({"choices": [1], "text": ""})),
        Some(QuestionReply {
            choices: vec![1],
            text: String::new(),
        })
    );
    assert_eq!(
        reply_text(&single(), json!({"choices": [], "text": "\u{1b}"})),
        None
    );
}

#[test]
fn new_a_reply_text_keeps_tabs_and_shows_hidden_formatting_as_escapes() {
    assert_eq!(
        reply_text(&text(), json!({"choices": [], "text": "a\r\n\tb\u{202e}"})).as_deref(),
        Some("a\n\tb\\u202e")
    );
}
