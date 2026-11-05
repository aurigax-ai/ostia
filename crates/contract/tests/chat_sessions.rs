#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::chat_sessions::{
    CHAT_EDIT_TEXT_MAX, CHAT_SESSION_MAX_BYTES, CHAT_SESSIONS_MAX, CHAT_TITLE_MAX,
    CHAT_TOTAL_MAX_BYTES, chat_markdown, chat_summary, chat_title, normalize_chat_session,
    tool_call_ids_of,
};
use serde_json::{Value, json};

fn session_of(messages: Vec<Value>) -> Value {
    json!({
        "id": "c1",
        "title": "Tools",
        "createdAt": 1,
        "updatedAt": 2,
        "messages": messages,
    })
}

fn tool_session(parts: Vec<Value>) -> Value {
    session_of(vec![
        json!({"id": "u", "role": "user", "parts": [{"type": "text", "text": "read it"}]}),
        json!({"id": "a", "role": "assistant", "parts": parts}),
    ])
}

fn normalized(raw: Value) -> Value {
    normalize_chat_session(&raw).unwrap()
}

fn kept_parts(parts: Vec<Value>) -> Vec<Value> {
    let session = normalized(session_of(vec![
        json!({"id": "a", "role": "assistant", "parts": parts}),
    ]));
    session["messages"][0]["parts"].as_array().unwrap().clone()
}

fn kept_message(message: Value) -> Option<Value> {
    let session = normalized(session_of(vec![message]));
    session["messages"].as_array().unwrap().first().cloned()
}

fn call_part(id: &str) -> Value {
    json!({"type": "dynamic-tool", "toolName": "t", "toolCallId": id, "state": "output-available"})
}

fn edit_of(id: &str, seq: i64) -> Value {
    json!({
        "toolCallId": id,
        "path": "/p/a",
        "root": "/p",
        "state": "applied",
        "version": null,
        "seq": seq,
    })
}

fn session_with_edits(edits: Vec<Value>, calls: &[&str]) -> Value {
    let mut raw = tool_session(calls.iter().map(|id| call_part(id)).collect());
    raw["edits"] = Value::Array(edits);
    raw
}

fn kept_edits(raw: Value) -> Option<Vec<Value>> {
    normalized(raw)
        .get("edits")
        .map(|edits| edits.as_array().unwrap().clone())
}

fn kept_edit(edit: Value) -> Option<Value> {
    let id = edit["toolCallId"].as_str().unwrap_or("t1").to_owned();
    kept_edits(session_with_edits(vec![edit], &[&id])).map(|mut edits| edits.remove(0))
}

fn keys_of(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn keeps_an_oversized_tool_part_by_clipping_its_strings_instead_of_dropping_it() {
    let big = "x".repeat(100_000);
    let saved = normalized(tool_session(vec![json!({
        "type": "dynamic-tool",
        "toolName": "read_file",
        "toolCallId": "t1",
        "state": "output-available",
        "input": {"path": "/p/a"},
        "output": {"text": big},
    })]));
    let part = &saved["messages"][1]["parts"][0];
    assert_eq!(part["state"], json!("output-available"));
    let text = part["output"]["text"].as_str().unwrap();
    assert!(text.len() < big.len());
    assert!(text.ends_with("…[truncated]"));
}

#[test]
fn exports_tool_calls_their_results_errors_and_denials_to_markdown_in_order() {
    let saved = normalized(tool_session(vec![
        json!({"type": "step-start"}),
        json!({"type": "text", "text": "Let me look."}),
        json!({
            "type": "dynamic-tool",
            "toolName": "read_file",
            "toolCallId": "t1",
            "state": "output-available",
            "input": {"path": "/p/a"},
            "output": "hello",
        }),
        json!({
            "type": "dynamic-tool",
            "toolName": "write_file",
            "toolCallId": "t2",
            "state": "output-denied",
            "input": {"path": "/p/a", "content": "x"},
            "approval": {"id": "ap", "approved": false},
        }),
        json!({
            "type": "dynamic-tool",
            "toolName": "mcp__fake__fail",
            "toolCallId": "t3",
            "state": "output-error",
            "input": {},
            "errorText": "boom",
        }),
        json!({"type": "step-start"}),
        json!({"type": "text", "text": "Done."}),
    ]));
    let md = chat_markdown(&saved);
    let order = [
        "Let me look.",
        "`read_file`: done",
        "hello",
        "`write_file`: denied",
        "`mcp__fake__fail`: failed",
        "boom",
        "Done.",
    ];
    let mut at = 0;
    for piece in order {
        let next = md[at..]
            .find(piece)
            .unwrap_or_else(|| panic!("{piece} is missing or out of order in {md}"));
        at += next;
    }
}

#[test]
fn writes_the_same_markdown_as_the_ts_exporter() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust/chat-markdown.json"
    ))
    .unwrap();
    assert_eq!(rows.len(), 5);
    for row in rows {
        let id = row["input"]["id"].as_str().unwrap().to_owned();
        let saved = normalized(row["input"].clone());
        assert_eq!(
            chat_markdown(&saved),
            row["markdown"].as_str().unwrap(),
            "{id}"
        );
    }
}

#[test]
fn skips_system_messages_and_writes_one_heading_for_each_turn() {
    let saved = normalized(session_of(vec![
        json!({"id": "s", "role": "system", "parts": [{"type": "text", "text": "hidden"}]}),
        json!({"id": "u", "role": "user", "parts": [{"type": "text", "text": "hi"}]}),
        json!({"id": "a", "role": "assistant", "parts": [{"type": "text", "text": "yo"}]}),
    ]));
    assert_eq!(
        chat_markdown(&saved),
        "# Tools\n\n## You\n\nhi\n\n## Assistant\n\nyo\n"
    );
}

#[test]
fn writes_the_model_line_and_ends_an_empty_chat_with_one_newline() {
    let mut raw = session_of(vec![]);
    raw["model"] = json!("  gpt  ");
    assert_eq!(chat_markdown(&normalized(raw)), "# Tools\n\nModel: gpt\n");
    assert_eq!(chat_markdown(&normalized(session_of(vec![]))), "# Tools\n");
}

#[test]
fn quotes_each_context_item_in_a_fence_before_the_text_of_the_turn() {
    let saved = normalized(session_of(vec![json!({
        "id": "u",
        "role": "user",
        "parts": [{"type": "text", "text": "why"}],
        "metadata": {"context": [{"kind": "output", "label": "Output", "text": "ls"}]},
    })]));
    assert_eq!(
        chat_markdown(&saved),
        "# Tools\n\n## You\n\n> Output\n\n```\nls\n```\n\nwhy\n"
    );
}

#[test]
fn joins_the_text_parts_of_a_turn_and_leaves_out_reasoning_and_blank_text() {
    let saved = normalized(session_of(vec![
        json!({"id": "u", "role": "user", "parts": [
            {"type": "text", "text": "one "},
            {"type": "reasoning", "text": "secret"},
            {"type": "text", "text": "two"},
        ]}),
        json!({"id": "b", "role": "assistant", "parts": [{"type": "text", "text": " \n "}]}),
    ]));
    assert_eq!(
        chat_markdown(&saved),
        "# Tools\n\n## You\n\none two\n\n## Assistant\n"
    );
}

#[test]
fn fences_a_result_that_holds_backticks_with_four_backticks() {
    let saved = normalized(tool_session(vec![json!({
        "type": "dynamic-tool",
        "toolName": "run",
        "toolCallId": "t1",
        "state": "output-available",
        "input": {},
        "output": "a ``` b",
    })]));
    let md = chat_markdown(&saved);
    assert!(md.contains("````\na ``` b\n````\n"), "{md}");
}

#[test]
fn names_a_tool_from_its_type_or_its_tool_name_and_labels_every_state() {
    let table = [
        (
            json!({"type": "tool-read-file", "state": "output-available"}),
            "read-file",
            "done",
        ),
        (
            json!({"type": "tool-read-file", "state": "output-error"}),
            "read-file",
            "failed",
        ),
        (
            json!({"type": "tool-read-file", "state": "output-denied"}),
            "read-file",
            "denied",
        ),
        (
            json!({"type": "tool-read-file", "state": "input-streaming"}),
            "read-file",
            "not run",
        ),
        (
            json!({"type": "tool-read-file", "state": "constructor"}),
            "read-file",
            "not run",
        ),
        (
            json!({"type": "tool-read-file", "state": 4}),
            "read-file",
            "not run",
        ),
        (json!({"type": "tool-read-file"}), "read-file", "not run"),
        (
            json!({"type": "dynamic-tool", "toolName": "fs"}),
            "fs",
            "not run",
        ),
        (json!({"type": "dynamic-tool"}), "tool", "not run"),
        (
            json!({"type": "dynamic-tool", "toolName": 7}),
            "7",
            "not run",
        ),
    ];
    for (mut part, name, label) in table {
        part["toolCallId"] = json!("t1");
        let md = chat_markdown(&normalized(tool_session(vec![part.clone()])));
        assert!(
            md.contains(&format!("> Tool `{name}`: {label}\n")),
            "{part}: {md}"
        );
    }
}

#[test]
fn leaves_out_an_empty_input_and_a_part_that_is_not_a_tool() {
    let md = chat_markdown(&normalized(tool_session(vec![
        json!({"type": "tool-a", "toolCallId": "t1", "state": "output-available", "input": {}, "output": "ok"}),
        json!({"type": "toolbox", "text": "no"}),
        json!({"type": "step-start"}),
    ])));
    assert_eq!(
        md,
        "# Tools\n\n## You\n\nread it\n\n## Assistant\n\n> Tool `a`: done\n\n```\nok\n```\n"
    );
}

#[test]
fn writes_the_input_as_indented_json_and_an_object_result_the_same_way() {
    let md = chat_markdown(&normalized(tool_session(vec![json!({
        "type": "tool-a",
        "toolCallId": "t1",
        "state": "output-available",
        "input": {"b": [1, 2.5, null], "a": {}, "c": []},
        "output": {"n": 3},
    })])));
    assert!(
        md.contains(
            "```json\n{\n  \"b\": [\n    1,\n    2.5,\n    null\n  ],\n  \"a\": {},\n  \"c\": []\n}\n```\n\n```\n{\n  \"n\": 3\n}\n```\n"
        ),
        "{md}"
    );
}

#[test]
fn writes_an_empty_fence_for_a_result_that_is_missing_and_null_for_a_null_result() {
    let md = chat_markdown(&normalized(tool_session(vec![
        json!({"type": "tool-a", "toolCallId": "t1", "state": "output-available"}),
        json!({"type": "tool-b", "toolCallId": "t2", "state": "output-available", "output": null}),
    ])));
    assert!(md.contains("> Tool `a`: done\n\n```\n\n```\n"), "{md}");
    assert!(md.contains("> Tool `b`: done\n\n```\nnull\n```\n"), "{md}");
}

#[test]
fn writes_an_error_text_only_when_it_is_a_string() {
    let md = chat_markdown(&normalized(tool_session(vec![
        json!({"type": "tool-a", "toolCallId": "t1", "state": "output-error", "errorText": 5}),
        json!({"type": "tool-b", "toolCallId": "t2", "state": "output-error", "errorText": "bad"}),
        json!({"type": "tool-c", "toolCallId": "t3", "state": "output-available", "errorText": "no"}),
    ])));
    assert!(
        md.contains("> Tool `a`: failed\n\n> Tool `b`: failed\n\n```\nbad\n```\n"),
        "{md}"
    );
    assert!(!md.contains("no\n```"), "{md}");
}

#[test]
fn clips_before_a_surrogate_pair_that_the_limit_would_cut() {
    let output = format!("x{}", "😀".repeat(2000));
    let md = chat_markdown(&normalized(tool_session(vec![json!({
        "type": "tool-a",
        "toolCallId": "t1",
        "state": "output-available",
        "output": output,
    })])));
    let kept = format!("x{}", "😀".repeat(1999));
    assert!(md.contains(&format!("{kept}…[truncated]\n```")), "{md}");
    assert!(!md.contains('\u{FFFD}'));
}

#[test]
fn clips_a_tool_result_at_4000_utf16_units() {
    let table = [
        ("x".repeat(4000), false),
        ("x".repeat(4001), true),
        ("😀".repeat(2000), false),
        ("😀".repeat(2001), true),
    ];
    for (output, clipped) in table {
        let md = chat_markdown(&normalized(tool_session(vec![json!({
            "type": "tool-a",
            "toolCallId": "t1",
            "state": "output-available",
            "output": output,
        })])));
        assert_eq!(md.contains("…[truncated]"), clipped, "{}", output.len());
        if clipped {
            let kept = output
                .chars()
                .take(output.chars().count() - 1)
                .collect::<String>();
            assert!(
                md.contains(&format!("{kept}…[truncated]\n```")),
                "{}",
                output.len()
            );
        } else {
            assert!(
                md.contains(&format!("```\n{output}\n```")),
                "{}",
                output.len()
            );
        }
    }
}

#[test]
fn clips_a_long_input_json_text_as_a_whole_not_its_strings() {
    let long = "y".repeat(5000);
    let md = chat_markdown(&normalized(tool_session(vec![json!({
        "type": "tool-a",
        "toolCallId": "t1",
        "state": "output-error",
        "input": {"text": long},
        "errorText": "e",
    })])));
    let start = md.find("```json\n").unwrap() + "```json\n".len();
    let end = md[start..].find("…[truncated]\n```").unwrap();
    assert_eq!(md[start..start + end].chars().count(), 4000);
}

#[test]
fn keeps_the_text_of_a_turn_that_a_tool_call_splits_in_order() {
    let md = chat_markdown(&normalized(tool_session(vec![
        json!({"type": "text", "text": "before "}),
        json!({"type": "text", "text": "tool"}),
        call_part("t1"),
        json!({"type": "text", "text": "after"}),
    ])));
    let before = md.find("before tool").unwrap();
    let tool = md.find("> Tool `t`").unwrap();
    let after = md.find("after").unwrap();
    assert!(before < tool && tool < after, "{md}");
}

#[test]
fn reduces_a_value_that_is_not_a_session_to_nothing() {
    let table = [
        json!(null),
        json!("c1"),
        json!([]),
        json!({}),
        json!({"id": "c1", "createdAt": 1, "updatedAt": 2}),
        json!({"id": "c1", "createdAt": 1, "updatedAt": 2, "messages": {}}),
        json!({"id": "c1", "createdAt": "1", "updatedAt": 2, "messages": []}),
        json!({"id": "c1", "createdAt": 1, "updatedAt": null, "messages": []}),
        json!({"id": "c1", "createdAt": 1, "messages": []}),
        json!({"createdAt": 1, "updatedAt": 2, "messages": []}),
        json!({"id": 5, "createdAt": 1, "updatedAt": 2, "messages": []}),
    ];
    for raw in table {
        assert_eq!(normalize_chat_session(&raw), None, "{raw}");
    }
}

#[test]
fn accepts_an_id_of_one_to_64_letters_digits_underscores_and_dashes() {
    let table = [
        ("a".to_owned(), true),
        ("A_b-9".to_owned(), true),
        ("a".repeat(64), true),
        ("a".repeat(65), false),
        (String::new(), false),
        ("a b".to_owned(), false),
        ("a/b".to_owned(), false),
        ("..".to_owned(), false),
        ("a.b".to_owned(), false),
        ("é".to_owned(), false),
        ("a\n".to_owned(), false),
    ];
    for (id, kept) in table {
        let raw = json!({"id": id, "createdAt": 1, "updatedAt": 2, "messages": []});
        assert_eq!(normalize_chat_session(&raw).is_some(), kept, "{id:?}");
    }
}

#[test]
fn writes_the_session_fields_in_the_order_the_ts_normalizer_does() {
    let mut raw = tool_session(vec![call_part("t1")]);
    raw["workspaceId"] = json!("w1");
    raw["model"] = json!("m");
    raw["modelRef"] = json!({"extId": "assistant", "provider": "openai", "model": "gpt"});
    raw["trimmed"] = json!(true);
    raw["edits"] = json!([edit_of("t1", 1)]);
    raw["extra"] = json!("dropped");
    raw["messageCount"] = json!(99);
    let saved = normalized(raw);
    assert_eq!(
        keys_of(&saved),
        [
            "id",
            "title",
            "createdAt",
            "updatedAt",
            "messageCount",
            "messages",
            "workspaceId",
            "model",
            "modelRef",
            "trimmed",
            "edits"
        ]
    );
    assert_eq!(saved["messageCount"], json!(2));
}

#[test]
fn folds_the_title_to_one_line_of_at_most_120_units_and_names_an_empty_one_chat() {
    let table = [
        (json!("  Deploy   notes "), "Deploy notes".to_owned()),
        (json!("a\n\tb\r\nc"), "a b c".to_owned()),
        (json!("a\u{feff}b"), "a b".to_owned()),
        (json!("a\u{a0}b"), "a b".to_owned()),
        (json!("a\u{85}b"), "a\u{85}b".to_owned()),
        (json!("\u{feff} x \u{2029}"), "x".to_owned()),
        (json!("😀".repeat(61)), "😀".repeat(60)),
        (json!("x".repeat(121)), "x".repeat(120)),
        (json!(""), String::new()),
        (json!("   "), String::new()),
        (json!(5), String::new()),
        (json!(null), String::new()),
    ];
    for (title, expected) in table {
        assert_eq!(chat_title(Some(&title)), expected, "{title}");
        let mut raw = session_of(vec![]);
        raw["title"] = title.clone();
        let want = if expected.is_empty() {
            "Chat"
        } else {
            expected.as_str()
        };
        assert_eq!(normalized(raw)["title"], json!(want), "{title}");
    }
    assert_eq!(chat_title(None), "");
    assert_eq!(CHAT_TITLE_MAX, 120);
}

#[test]
fn keeps_the_last_400_messages_and_counts_only_the_kept_ones() {
    let messages: Vec<Value> = (0..405)
        .map(|i| json!({"id": format!("m{i}"), "role": "user", "parts": []}))
        .collect();
    let saved = normalized(session_of(messages));
    let kept = saved["messages"].as_array().unwrap();
    assert_eq!(kept.len(), 400);
    assert_eq!(kept[0]["id"], json!("m5"));
    assert_eq!(kept[399]["id"], json!("m404"));
    assert_eq!(saved["messageCount"], json!(400));
}

#[test]
fn drops_a_message_with_a_bad_role_an_empty_or_long_id_or_parts_that_are_not_a_list() {
    let table = [
        (json!({"id": "m", "role": "nobody", "parts": []}), false),
        (json!({"id": "m", "role": 1, "parts": []}), false),
        (json!({"id": "m", "parts": []}), false),
        (json!({"id": "", "role": "user", "parts": []}), false),
        (json!({"id": 5, "role": "user", "parts": []}), false),
        (json!({"role": "user", "parts": []}), false),
        (json!({"id": "m", "role": "user"}), false),
        (json!({"id": "m", "role": "user", "parts": {}}), false),
        (json!({"id": "m", "role": "user", "parts": "x"}), false),
        (json!("m"), false),
        (json!(null), false),
        (json!({"id": "m", "role": "system", "parts": []}), true),
        (json!({"id": "m", "role": "user", "parts": []}), true),
        (json!({"id": "m", "role": "assistant", "parts": []}), true),
        (
            json!({"id": "i".repeat(128), "role": "user", "parts": []}),
            true,
        ),
        (
            json!({"id": "i".repeat(129), "role": "user", "parts": []}),
            false,
        ),
    ];
    for (message, kept) in table {
        assert_eq!(kept_message(message.clone()).is_some(), kept, "{message}");
    }
}

#[test]
fn keeps_only_the_id_role_parts_and_metadata_of_a_message() {
    let message = kept_message(json!({
        "id": "m", "role": "user", "parts": [], "extra": 1, "metadata": {"model": "x"},
    }))
    .unwrap();
    assert_eq!(keys_of(&message), ["id", "role", "parts", "metadata"]);
}

#[test]
fn keeps_a_part_type_of_a_lowercase_letter_then_up_to_63_letters_digits_and_dashes() {
    let table = [
        ("step-start".to_owned(), true),
        ("a".to_owned(), true),
        ("tool-a1".to_owned(), true),
        (format!("a{}", "b".repeat(63)), true),
        (format!("a{}", "b".repeat(64)), false),
        ("Text".to_owned(), false),
        ("1a".to_owned(), false),
        ("-a".to_owned(), false),
        ("a_b".to_owned(), false),
        ("a b".to_owned(), false),
        (String::new(), false),
    ];
    for (kind, kept) in table {
        let parts = kept_parts(vec![json!({"type": kind})]);
        assert_eq!(parts.len(), usize::from(kept), "{kind}");
    }
    assert!(
        kept_parts(vec![
            json!({"type": 5}),
            json!({}),
            json!("text"),
            json!(null)
        ])
        .is_empty()
    );
}

#[test]
fn needs_a_string_text_for_text_and_reasoning_parts_and_cuts_it_at_100000_units() {
    let table = [
        (json!({"type": "text"}), None),
        (json!({"type": "text", "text": 5}), None),
        (json!({"type": "reasoning", "text": null}), None),
        (
            json!({"type": "text", "text": ""}),
            Some(json!({"type": "text", "text": ""})),
        ),
        (
            json!({"type": "text", "text": "hi", "extra": 1}),
            Some(json!({"type": "text", "text": "hi"})),
        ),
        (
            json!({"type": "reasoning", "text": "x".repeat(100_001)}),
            Some(json!({"type": "reasoning", "text": "x".repeat(100_000)})),
        ),
        (
            json!({"type": "text", "text": "😀".repeat(50_001)}),
            Some(json!({"type": "text", "text": "😀".repeat(50_000)})),
        ),
    ];
    for (part, expected) in table {
        let kept = kept_parts(vec![part.clone()]);
        assert_eq!(kept.first().cloned(), expected, "{part}");
    }
}

#[test]
fn keeps_every_field_of_a_part_of_another_type() {
    let part = json!({"type": "file", "url": "u", "nested": {"a": [1, 2.5, null]}, "ok": true});
    assert_eq!(kept_parts(vec![part.clone()]), vec![part]);
}

fn data_part(kind: &str, units: usize) -> Value {
    let probe = json!({"type": kind, "data": ""});
    let base = serde_json::to_string(&probe).unwrap().len();
    json!({"type": kind, "data": "d".repeat(units - base)})
}

#[test]
fn drops_a_part_of_another_type_whose_json_is_over_65536_units() {
    let at_limit = data_part("custom", 65_536);
    assert_eq!(serde_json::to_string(&at_limit).unwrap().len(), 65_536);
    assert_eq!(kept_parts(vec![at_limit.clone()]), vec![at_limit]);
    let over = data_part("custom", 65_537);
    assert!(kept_parts(vec![over]).is_empty());
    let toolbox = data_part("toolbox", 65_537);
    assert!(kept_parts(vec![toolbox]).is_empty());
}

#[test]
fn clips_the_strings_of_an_oversized_tool_part_in_steps_of_16000_4000_1000_and_200() {
    let table = [
        (1usize, 70_000usize, 16_000usize),
        (5, 20_000, 4000),
        (40, 3000, 1000),
        (200, 400, 200),
    ];
    for (count, len, want) in table {
        for kind in ["dynamic-tool", "tool-x"] {
            let fields: serde_json::Map<String, Value> = (0..count)
                .map(|i| (format!("f{i}"), json!("x".repeat(len))))
                .collect();
            let mut part = json!({"type": kind, "toolCallId": "t1"});
            part["fields"] = Value::Object(fields);
            let kept = kept_parts(vec![part]);
            assert_eq!(kept.len(), 1, "{kind} {count}x{len}");
            let first = kept[0]["fields"]["f0"].as_str().unwrap();
            assert_eq!(
                first,
                format!("{}…[truncated]", "x".repeat(want)),
                "{kind} {count}x{len}"
            );
            assert_eq!(kept[0]["toolCallId"], json!("t1"));
        }
    }
}

#[test]
fn drops_an_oversized_tool_part_that_does_not_fit_even_at_200_units_a_string() {
    let strings: Vec<Value> = (0..400).map(|_| json!("x".repeat(300))).collect();
    let part = json!({"type": "tool-x", "toolCallId": "t1", "list": strings});
    assert!(kept_parts(vec![part]).is_empty());
}

#[test]
fn leaves_a_string_of_exactly_the_clip_length_alone_when_it_clips_the_others() {
    let part = json!({
        "type": "tool-x",
        "exact": "y".repeat(16_000),
        "over": "z".repeat(70_000),
    });
    let kept = kept_parts(vec![part]);
    assert_eq!(kept[0]["exact"], json!("y".repeat(16_000)));
    assert_eq!(
        kept[0]["over"],
        json!(format!("{}…[truncated]", "z".repeat(16_000)))
    );
}

#[test]
fn replaces_what_lies_deeper_than_eight_levels_with_null_when_it_clips_a_tool_part() {
    let part = json!({
        "type": "tool-x",
        "big": "x".repeat(70_000),
        "deep": {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": "leaf"}}}}}}}}},
        "list": [[[[[[[[["deep"]]]]]]]]],
    });
    let kept = kept_parts(vec![part]);
    assert_eq!(
        kept[0]["deep"]["a"]["b"]["c"]["d"]["e"]["f"]["g"],
        json!({"h": null})
    );
    assert_eq!(kept[0]["list"][0][0][0][0][0][0][0][0], json!(null));
}

#[test]
fn does_not_touch_the_depth_of_a_tool_part_that_fits() {
    let deep = json!({"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": "leaf"}}}}}}}}});
    let part = json!({"type": "tool-x", "deep": deep});
    assert_eq!(kept_parts(vec![part.clone()]), vec![part]);
}

#[test]
fn keeps_the_metadata_a_message_has_and_leaves_it_out_when_nothing_is_valid() {
    let table = [
        (json!(null), None),
        (json!("x"), None),
        (json!([]), None),
        (json!({}), None),
        (
            json!({"createdAt": "1", "model": 5, "error": "", "stopped": false, "context": "x"}),
            None,
        ),
        (json!({"stopped": 1}), None),
        (json!({"context": []}), None),
        (
            json!({"context": [{"kind": "bogus", "label": "l", "text": "t"}]}),
            None,
        ),
        (json!({"createdAt": 1.5}), Some(json!({"createdAt": 1.5}))),
        (json!({"createdAt": 0}), Some(json!({"createdAt": 0}))),
        (json!({"stopped": true}), Some(json!({"stopped": true}))),
        (json!({"model": "  gpt  "}), Some(json!({"model": "gpt"}))),
        (
            json!({"model": "\u{feff}gpt\u{a0}"}),
            Some(json!({"model": "gpt"})),
        ),
        (
            json!({"model": "\u{85}gpt"}),
            Some(json!({"model": "\u{85}gpt"})),
        ),
        (
            json!({"model": "m".repeat(201)}),
            Some(json!({"model": "m".repeat(200)})),
        ),
        (
            json!({"error": "e".repeat(501)}),
            Some(json!({"error": "e".repeat(500)})),
        ),
        (json!({"error": " boom "}), Some(json!({"error": "boom"}))),
    ];
    for (metadata, expected) in table {
        let message = kept_message(json!({
            "id": "m", "role": "user", "parts": [], "metadata": metadata,
        }))
        .unwrap();
        assert_eq!(message.get("metadata").cloned(), expected, "{metadata}");
    }
}

#[test]
fn writes_the_metadata_fields_in_the_order_created_context_model_error_stopped() {
    let message = kept_message(json!({
        "id": "m",
        "role": "user",
        "parts": [],
        "metadata": {
            "stopped": true,
            "error": "e",
            "model": "m",
            "context": [{"kind": "output", "label": "Output", "text": "ls"}],
            "createdAt": 1,
        },
    }))
    .unwrap();
    assert_eq!(
        keys_of(&message["metadata"]),
        ["createdAt", "context", "model", "error", "stopped"]
    );
}

#[test]
fn keeps_the_context_items_that_are_valid_and_drops_the_rest() {
    let message = kept_message(json!({
        "id": "m",
        "role": "user",
        "parts": [],
        "metadata": {"context": [
            {"kind": "output", "label": "Output", "text": "ls"},
            {"kind": "bogus", "label": "L", "text": "t"},
            {"kind": "output", "label": "", "text": "t"},
            "x",
        ]},
    }))
    .unwrap();
    assert_eq!(
        message["metadata"]["context"],
        json!([{"kind": "output", "label": "Output", "text": "ls"}])
    );
}

#[test]
fn keeps_the_workspace_id_model_and_model_ref_when_they_are_valid() {
    let table = [
        (
            json!({"workspaceId": "  w1  "}),
            "workspaceId",
            Some(json!("w1")),
        ),
        (
            json!({"workspaceId": "w".repeat(65)}),
            "workspaceId",
            Some(json!("w".repeat(64))),
        ),
        (json!({"workspaceId": "   "}), "workspaceId", None),
        (json!({"workspaceId": 5}), "workspaceId", None),
        (
            json!({"model": " fake · big "}),
            "model",
            Some(json!("fake · big")),
        ),
        (
            json!({"model": "m".repeat(201)}),
            "model",
            Some(json!("m".repeat(200))),
        ),
        (json!({"model": ""}), "model", None),
        (json!({"trimmed": true}), "trimmed", Some(json!(true))),
        (json!({"trimmed": false}), "trimmed", None),
        (json!({"trimmed": 1}), "trimmed", None),
        (json!({"trimmed": "true"}), "trimmed", None),
        (
            json!({"modelRef": {"extId": "assistant", "provider": "openai", "model": "gpt"}}),
            "modelRef",
            Some(json!({"extId": "assistant", "provider": "openai", "model": "gpt"})),
        ),
        (
            json!({"modelRef": {"provider": "openai", "model": "gpt"}}),
            "modelRef",
            None,
        ),
        (json!({"modelRef": "x"}), "modelRef", None),
    ];
    for (extra, key, expected) in table {
        let mut raw = session_of(vec![]);
        for (name, value) in extra.as_object().unwrap() {
            raw[name] = value.clone();
        }
        assert_eq!(normalized(raw).get(key).cloned(), expected, "{extra}");
    }
}

#[test]
fn keeps_what_undo_needs_of_an_edit_and_writes_its_fields_in_order() {
    let mut raw = edit_of("t1", 3);
    raw["existed"] = json!(true);
    raw["auto"] = json!(true);
    raw["version"] = json!("a".repeat(64));
    raw["decisions"] = json!(["accepted", "rejected"]);
    raw["before"] = json!("old");
    raw["after"] = json!("new");
    raw["extra"] = json!("dropped");
    let edit = kept_edit(raw).unwrap();
    assert_eq!(
        keys_of(&edit),
        [
            "toolCallId",
            "path",
            "root",
            "existed",
            "outside",
            "symlink",
            "auto",
            "state",
            "version",
            "seq",
            "decisions",
            "before",
            "after"
        ]
    );
    assert_eq!(edit["existed"], json!(true));
    assert_eq!(edit["outside"], json!(false));
    assert_eq!(edit["auto"], json!(true));
    assert_eq!(edit["version"], json!("a".repeat(64)));
    assert_eq!(edit["decisions"], json!(["accepted", "rejected"]));
}

#[test]
fn refuses_an_edit_with_a_bad_tool_call_id_path_root_seq_state_or_version() {
    let long_path = format!("/{}", "p".repeat(4096));
    let table: Vec<(&str, Value, Value)> = vec![
        ("toolCallId", json!(""), json!(false)),
        ("toolCallId", json!(5), json!(false)),
        ("toolCallId", json!("t".repeat(129)), json!(false)),
        ("path", json!("p/a"), json!(false)),
        ("path", json!(5), json!(false)),
        ("path", json!(long_path), json!(false)),
        ("path", json!(format!("/{}", "p".repeat(4095))), json!(true)),
        ("root", json!("p"), json!(false)),
        ("root", json!(null), json!(false)),
        ("seq", json!(-1), json!(false)),
        ("seq", json!("1"), json!(false)),
        ("seq", json!(null), json!(false)),
        ("seq", json!(0), json!(true)),
        ("state", json!("bogus"), json!(false)),
        ("state", json!(null), json!(false)),
        ("state", json!("undone"), json!(true)),
        ("version", json!("a".repeat(63)), json!(false)),
        ("version", json!("A".repeat(64)), json!(false)),
        ("version", json!("g".repeat(64)), json!(false)),
        ("version", json!(5), json!(false)),
        ("version", json!(null), json!(true)),
    ];
    for (field, value, kept) in table {
        let mut raw = edit_of("t1", 1);
        raw[field] = value.clone();
        assert_eq!(
            kept_edit(raw).is_some(),
            kept == json!(true),
            "{field} {value}"
        );
    }
}

#[test]
fn refuses_an_edit_that_has_no_version_field_while_a_null_version_is_kept() {
    let mut raw = edit_of("t1", 1);
    raw.as_object_mut().unwrap().remove("version");
    assert_eq!(kept_edit(raw), None);
    assert_eq!(kept_edit(edit_of("t1", 1)).unwrap()["version"], json!(null));
}

#[test]
fn rounds_the_seq_of_an_edit_down_and_reads_the_flags_only_when_they_are_true() {
    let mut raw = edit_of("t1", 0);
    raw["seq"] = json!(2.7);
    for flag in ["existed", "outside", "symlink", "auto"] {
        raw[flag] = json!(1);
    }
    let edit = kept_edit(raw).unwrap();
    assert_eq!(edit["seq"], json!(2));
    for flag in ["existed", "outside", "symlink", "auto"] {
        assert_eq!(edit[flag], json!(false), "{flag}");
    }
}

#[test]
fn reads_hunk_decisions_as_accepted_rejected_or_null_and_caps_them_at_5000() {
    let mut raw = edit_of("t1", 1);
    raw["decisions"] = json!(["accepted", "rejected", "bogus", null, 1, "Accepted"]);
    assert_eq!(
        kept_edit(raw).unwrap()["decisions"],
        json!(["accepted", "rejected", null, null, null, null])
    );
    let mut many = edit_of("t1", 1);
    many["decisions"] = Value::Array((0..5001).map(|_| json!("accepted")).collect());
    assert_eq!(
        kept_edit(many).unwrap()["decisions"]
            .as_array()
            .unwrap()
            .len(),
        5000
    );
    let mut text = edit_of("t1", 1);
    text["decisions"] = json!("accepted");
    assert_eq!(kept_edit(text).unwrap()["decisions"], json!([]));
    assert_eq!(kept_edit(edit_of("t1", 1)).unwrap()["decisions"], json!([]));
}

#[test]
fn keeps_the_before_and_after_texts_of_an_edit_only_together_and_only_up_to_64_kib() {
    let limit = CHAT_EDIT_TEXT_MAX;
    let table = [
        (json!("a"), json!("b"), true),
        (json!(""), json!(""), true),
        (json!("a"), json!(null), false),
        (json!(null), json!("b"), false),
        (json!("a"), json!(5), false),
        (json!("a".repeat(limit)), json!("b".repeat(limit)), true),
        (json!("a".repeat(limit + 1)), json!("b"), false),
        (json!("a"), json!("b".repeat(limit + 1)), false),
        (json!("😀".repeat(limit / 2)), json!("b"), true),
        (json!("😀".repeat(limit / 2 + 1)), json!("b"), false),
    ];
    for (before, after, kept) in table {
        let mut raw = edit_of("t1", 1);
        raw["before"] = before.clone();
        raw["after"] = after.clone();
        let edit = kept_edit(raw).unwrap();
        assert_eq!(
            edit.get("before").is_some(),
            kept,
            "{}",
            before.to_string().len()
        );
        assert_eq!(edit.get("after").is_some(), kept);
    }
    assert_eq!(limit, 64 * 1024);
}

#[test]
fn keeps_one_edit_for_each_tool_call_that_is_in_the_kept_messages() {
    let raw = session_with_edits(
        vec![
            edit_of("t1", 1),
            edit_of("t1", 2),
            edit_of("orphan", 3),
            json!("x"),
            edit_of("t2", 4),
        ],
        &["t1", "t2"],
    );
    let edits = kept_edits(raw).unwrap();
    let ids: Vec<&str> = edits
        .iter()
        .map(|e| e["toolCallId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["t1", "t2"]);
    assert_eq!(edits[0]["seq"], json!(1));
}

#[test]
fn drops_the_edits_key_when_no_edit_is_kept_or_edits_is_not_a_list() {
    assert_eq!(
        kept_edits(session_with_edits(vec![edit_of("orphan", 1)], &["t1"])),
        None
    );
    let mut raw = tool_session(vec![call_part("t1")]);
    raw["edits"] = json!({"t1": edit_of("t1", 1)});
    assert_eq!(kept_edits(raw), None);
    assert_eq!(kept_edits(session_with_edits(vec![], &["t1"])), None);
}

#[test]
fn sorts_the_edits_by_seq_and_keeps_the_last_200() {
    let ids: Vec<String> = (0..205).map(|i| format!("t{i}")).collect();
    let calls: Vec<&str> = ids.iter().map(String::as_str).collect();
    let edits: Vec<Value> = (0..205)
        .rev()
        .map(|i| edit_of(&format!("t{i}"), i))
        .collect();
    let kept = kept_edits(session_with_edits(edits, &calls)).unwrap();
    assert_eq!(kept.len(), 200);
    assert_eq!(kept[0]["seq"], json!(5));
    assert_eq!(kept[199]["seq"], json!(204));
}

#[test]
fn keeps_edits_of_equal_seq_in_the_order_they_came() {
    let kept = kept_edits(session_with_edits(
        vec![edit_of("b", 1), edit_of("a", 1), edit_of("c", 0)],
        &["a", "b", "c"],
    ))
    .unwrap();
    let ids: Vec<&str> = kept
        .iter()
        .map(|e| e["toolCallId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["c", "b", "a"]);
}

#[test]
fn drops_the_edits_of_a_tool_call_that_the_trim_to_400_messages_removed() {
    let mut messages: Vec<Value> =
        vec![json!({"id": "old", "role": "assistant", "parts": [call_part("gone")]})];
    messages.extend((0..400).map(|i| json!({"id": format!("m{i}"), "role": "user", "parts": []})));
    let mut raw = session_of(messages);
    raw["edits"] = json!([edit_of("gone", 1)]);
    assert_eq!(kept_edits(raw), None);
}

#[test]
fn lists_the_tool_calls_of_dynamic_and_tool_parts_that_have_a_string_id() {
    let messages = vec![
        json!({"id": "m1", "role": "assistant", "parts": [
            {"type": "dynamic-tool", "toolCallId": "a"},
            {"type": "tool-read-file", "toolCallId": "b"},
            {"type": "tool-read-file", "toolCallId": 5},
            {"type": "tool-read-file"},
            {"type": "text", "toolCallId": "c"},
            {"type": "toolbox", "toolCallId": "d"},
        ]}),
        json!({"id": "m2", "role": "user", "parts": [{"type": "dynamic-tool", "toolCallId": "a"}, {"type": "tool-x", "toolCallId": ""}]}),
    ];
    let mut ids: Vec<String> = tool_call_ids_of(&messages).into_iter().collect();
    ids.sort();
    assert_eq!(ids, ["", "a", "b"]);
    assert!(tool_call_ids_of(&[]).is_empty());
}

#[test]
fn summarizes_a_session_without_its_messages_and_edits_and_counts_its_messages() {
    let mut raw = tool_session(vec![call_part("t1")]);
    raw["workspaceId"] = json!("w1");
    raw["edits"] = json!([edit_of("t1", 1)]);
    let mut saved = normalized(raw);
    saved["messageCount"] = json!(99);
    let summary = chat_summary(&saved);
    assert_eq!(
        keys_of(&summary),
        [
            "id",
            "title",
            "createdAt",
            "updatedAt",
            "messageCount",
            "workspaceId"
        ]
    );
    assert_eq!(summary["messageCount"], json!(2));
    assert_eq!(summary["title"], json!("Tools"));
    assert_eq!(chat_summary(&session_of(vec![]))["messageCount"], json!(0));
}

#[test]
fn holds_the_size_limits_of_the_ts_module() {
    assert_eq!(CHAT_SESSION_MAX_BYTES, 512 * 1024);
    assert_eq!(CHAT_TOTAL_MAX_BYTES, 16 * 1024 * 1024);
    assert_eq!(CHAT_SESSIONS_MAX, 500);
    assert_eq!(CHAT_EDIT_TEXT_MAX, 64 * 1024);
    assert_eq!(CHAT_TITLE_MAX, 120);
}
