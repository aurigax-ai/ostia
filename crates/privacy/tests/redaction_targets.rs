#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{FAKE, Failing, off, on};
use ostia_contract::assist::AssistPoint;
use ostia_privacy::redaction::Redactor;
use ostia_privacy::redaction_targets::{redact_assist_request, redact_chat_session};
use serde_json::{Value, json};

fn mark_of(kind: &str) -> String {
    format!("[redacted:{kind}]")
}

#[tokio::test]
async fn redacts_the_text_and_tool_results_of_a_chat_request_and_its_context() {
    let secret = &FAKE.github_classic;
    let mark = mark_of("github");
    let request = json!({
        "messages": [
            {"role": "user", "content": format!("why does {secret} fail")},
            {
                "role": "assistant",
                "content": "reading",
                "tools": [
                    {"id": "c1", "name": "read_file", "input": {"path": ".env"}, "state": "done", "output": secret},
                    {"id": "c2", "name": "read_file", "input": {}, "state": "error", "error": format!("bad {secret}")},
                ],
            },
        ],
        "context": [{"kind": "output", "label": "Output", "text": format!("$ echo {secret}")}],
    });
    let (out, count) = redact_assist_request(AssistPoint::Chat, &request, &on())
        .await
        .unwrap();
    assert!(!out.to_string().contains(secret.as_str()));
    assert_eq!(
        out["messages"][0]["content"],
        json!(format!("why does {mark} fail"))
    );
    assert_eq!(out["messages"][1]["tools"][0]["output"], json!(mark));
    assert_eq!(
        out["messages"][1]["tools"][0]["input"],
        json!({"path": ".env"})
    );
    assert_eq!(
        out["messages"][1]["tools"][1]["error"],
        json!(format!("bad {mark}"))
    );
    assert_eq!(out["context"][0]["text"], json!(format!("$ echo {mark}")));
    assert_eq!(count, 4);
}

#[tokio::test]
async fn redacts_the_draft_history_and_context_of_a_terminal_request() {
    let secret = &FAKE.github_classic;
    let mark = mark_of("github");
    let request = json!({
        "line": format!("curl -H \"x: {secret}\""),
        "cwd": "/home/u/proj",
        "history": [{"command": format!("export T={secret}"), "exitCode": 0}],
        "context": [{"label": "git", "text": secret}],
    });
    let (out, count) = redact_assist_request(AssistPoint::Terminal, &request, &on())
        .await
        .unwrap();
    assert_eq!(
        out,
        json!({
            "line": format!("curl -H \"x: {mark}\""),
            "cwd": "/home/u/proj",
            "history": [{"command": format!("export T={mark}"), "exitCode": 0}],
            "context": [{"label": "git", "text": mark}],
        })
    );
    assert_eq!(count, 3);
}

#[tokio::test]
async fn redacts_the_code_around_the_cursor_of_a_completion_request() {
    let secret = &FAKE.github_classic;
    let request = json!({
        "path": "/p/a.ts",
        "language": "typescript",
        "prefix": format!("const key = '{secret}'\n"),
        "suffix": format!("// {secret}"),
        "neighbors": [{"path": "/p/b.ts", "text": secret}],
    });
    let (out, _) = redact_assist_request(AssistPoint::Completion, &request, &on())
        .await
        .unwrap();
    assert!(!out.to_string().contains(secret.as_str()));
    assert_eq!(out["path"], json!("/p/a.ts"));
    assert_eq!(out["neighbors"][0]["path"], json!("/p/b.ts"));
}

#[tokio::test]
async fn redacts_a_prompt_draft_and_a_command_query() {
    let secret = &FAKE.github_classic;
    let mark = mark_of("github");
    let redactor = on();
    let input = redact_assist_request(
        AssistPoint::Input,
        &json!({"text": secret, "tasks": ["typos"]}),
        &redactor,
    )
    .await
    .unwrap();
    assert_eq!(input.0, json!({"text": mark, "tasks": ["typos"]}));
    let command = redact_assist_request(
        AssistPoint::Command,
        &json!({"query": format!("use {secret}")}),
        &redactor,
    )
    .await
    .unwrap();
    assert_eq!(command, (json!({"query": format!("use {mark}")}), 1));
}

#[tokio::test]
async fn returns_the_request_as_it_was_while_the_setting_is_off() {
    let secret = &FAKE.github_classic;
    let original = json!({
        "messages": [{"role": "user", "content": format!("why does {secret} fail")}],
        "context": [{"kind": "output", "label": "Output", "text": secret}],
    });
    let result = redact_assist_request(AssistPoint::Chat, &original, &off())
        .await
        .unwrap();
    assert_eq!(result, (original, 0));
}

#[tokio::test]
async fn adds_no_output_or_error_to_a_tool_that_has_none() {
    let request = json!({
        "messages": [{
            "role": "assistant",
            "content": "reading",
            "tools": [{"id": "c1", "name": "read_file", "input": {}, "state": "running"}],
        }],
        "context": [],
    });
    let (out, count) = redact_assist_request(AssistPoint::Chat, &request, &on())
        .await
        .unwrap();
    assert_eq!(out, request);
    assert_eq!(count, 0);
}

#[tokio::test]
async fn fails_closed_when_the_scan_fails_for_a_request() {
    let broken = Redactor::new(|| Value::Null, Failing);
    for point in [
        AssistPoint::Input,
        AssistPoint::Command,
        AssistPoint::Completion,
        AssistPoint::Terminal,
        AssistPoint::Chat,
    ] {
        let request = json!({
            "text": "a", "query": "a", "prefix": "a", "suffix": "a", "line": "a",
            "messages": [{"role": "user", "content": "a"}],
            "context": [],
        });
        assert!(
            redact_assist_request(point, &request, &broken)
                .await
                .is_err(),
            "{point:?}"
        );
    }
}

fn session() -> Value {
    let secret = &FAKE.stripe_live;
    json!({
        "id": "s1",
        "title": format!("About {secret}"),
        "createdAt": 1,
        "updatedAt": 2,
        "messageCount": 2,
        "messages": [
            {
                "id": "m1",
                "role": "user",
                "parts": [{"type": "text", "text": format!("my key is {secret}")}],
                "metadata": {"context": [{"kind": "file", "label": ".env", "text": format!("STRIPE={secret}")}]},
            },
            {
                "id": "m2",
                "role": "assistant",
                "parts": [
                    {"type": "text", "text": "Looking."},
                    {
                        "type": "dynamic-tool",
                        "toolName": "read_file",
                        "toolCallId": "c1",
                        "state": "output-available",
                        "input": {"path": ".env"},
                        "output": {"path": ".env", "content": format!("STRIPE={secret}"), "lines": 1},
                    },
                ],
            },
        ],
    })
}

#[tokio::test]
async fn redacts_what_the_human_sent_and_what_tools_returned_and_keeps_the_shape() {
    let saved = redact_chat_session(&session(), &on()).await.unwrap();
    assert!(!saved.to_string().contains(FAKE.stripe_live.as_str()));
    assert_eq!(
        saved["messages"][0]["parts"][0]["text"],
        json!("my key is [redacted:stripe]")
    );
    assert_eq!(
        saved["messages"][0]["metadata"]["context"][0]["text"],
        json!("STRIPE=[redacted:stripe]")
    );
    assert_eq!(
        saved["messages"][1]["parts"][1]["input"],
        json!({"path": ".env"})
    );
    assert_eq!(
        saved["messages"][1]["parts"][1]["output"],
        json!({"path": ".env", "content": "STRIPE=[redacted:stripe]", "lines": 1})
    );
    assert_eq!(saved["messages"][1]["parts"][0]["text"], json!("Looking."));
    assert_eq!(saved["title"], json!("About [redacted:stripe]"));
}

#[tokio::test]
async fn saves_the_session_as_it_is_while_the_setting_is_off() {
    assert_eq!(
        redact_chat_session(&session(), &off()).await.unwrap(),
        session()
    );
}

#[tokio::test]
async fn leaves_the_text_of_an_assistant_part_alone_and_redacts_its_error_text() {
    let secret = &FAKE.stripe_live;
    let input = json!({
        "id": "s1", "title": "t", "createdAt": 1, "updatedAt": 2, "messageCount": 1,
        "messages": [{
            "id": "m1",
            "role": "assistant",
            "parts": [
                {"type": "text", "text": format!("I saw {secret}")},
                {"type": "dynamic-tool", "state": "output-error", "errorText": format!("bad {secret}")},
            ],
        }],
    });
    let saved = redact_chat_session(&input, &on()).await.unwrap();
    assert_eq!(
        saved["messages"][0]["parts"][0]["text"],
        json!(format!("I saw {secret}"))
    );
    assert_eq!(
        saved["messages"][0]["parts"][1]["errorText"],
        json!("bad [redacted:stripe]")
    );
}

fn nested(levels: usize, leaf: &str) -> Value {
    let mut value = json!(leaf);
    for _ in 0..levels {
        value = json!({"a": value});
    }
    value
}

#[tokio::test]
async fn redacts_tool_output_down_to_nine_levels_and_leaves_what_lies_deeper() {
    let secret = &FAKE.stripe_live;
    let session_with = |levels: usize| {
        json!({
            "id": "s1", "title": "t", "createdAt": 1, "updatedAt": 2, "messageCount": 1,
            "messages": [{
                "id": "m1",
                "role": "assistant",
                "parts": [{"type": "dynamic-tool", "state": "output-available", "output": nested(levels, secret)}],
            }],
        })
    };
    let redactor = on();
    let reached = redact_chat_session(&session_with(9), &redactor)
        .await
        .unwrap();
    assert!(!reached.to_string().contains(secret.as_str()));
    let beyond = redact_chat_session(&session_with(10), &redactor)
        .await
        .unwrap();
    assert_eq!(beyond, session_with(10));
}

#[tokio::test]
async fn fails_closed_when_the_scan_fails_for_a_session() {
    let broken = Redactor::new(|| Value::Null, Failing);
    assert!(redact_chat_session(&session(), &broken).await.is_err());
}
