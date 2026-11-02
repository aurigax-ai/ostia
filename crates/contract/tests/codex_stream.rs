#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::codex_stream::{codex_notification, codex_turn};
use serde_json::{Value, json};

fn wire(events: Vec<ostia_contract::agent_stream::StreamEvent>) -> Vec<Value> {
    events
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect()
}

fn item(over: Value) -> Value {
    let mut base = json!({ "id": "i1" });
    base.as_object_mut()
        .unwrap()
        .extend(over.as_object().unwrap().clone());
    base
}

fn completed(item: &Value) -> Vec<Value> {
    wire(codex_notification(
        "item/completed",
        &json!({ "threadId": "t", "turnId": "u1", "item": item }),
    ))
}

#[test]
fn maps_turn_start_and_end() {
    assert_eq!(
        wire(codex_notification(
            "turn/started",
            &json!({ "threadId": "t", "turn": { "id": "u1" } })
        )),
        vec![json!({ "type": "turn.started", "turn": "u1" })]
    );
    assert_eq!(
        wire(codex_notification(
            "turn/completed",
            &json!({ "threadId": "t", "turn": { "id": "u1", "status": "interrupted" } })
        )),
        vec![json!({ "type": "turn.ended", "turn": "u1", "status": "interrupted" })]
    );
}

#[test]
fn maps_a_user_message_to_the_prompt_and_an_agent_message_to_text() {
    assert_eq!(
        completed(&item(json!({
            "type": "userMessage",
            "content": [{ "type": "text", "text": "fix it", "text_elements": [] }]
        }))),
        vec![json!({ "type": "prompt", "turn": "u1", "id": "i1", "text": "fix it" })]
    );
    assert_eq!(
        completed(&item(json!({ "type": "agentMessage", "text": "Done." }))),
        vec![json!({ "type": "text", "turn": "u1", "id": "i1", "text": "Done." })]
    );
}

#[test]
fn maps_a_message_delta_to_appended_text() {
    assert_eq!(
        wire(codex_notification(
            "item/agentMessage/delta",
            &json!({ "threadId": "t", "turnId": "u1", "itemId": "i1", "delta": "Hel" })
        )),
        vec![json!({ "type": "text", "turn": "u1", "id": "i1", "text": "Hel", "append": true })]
    );
}

#[test]
fn maps_a_command_to_a_tool_call_streamed_output_and_a_result_with_its_exit_code() {
    let cmd = item(json!({
        "type": "commandExecution",
        "command": "pnpm test",
        "status": "inProgress"
    }));
    assert_eq!(
        wire(codex_notification(
            "item/started",
            &json!({ "threadId": "t", "turnId": "u1", "item": cmd })
        )),
        vec![json!({
            "type": "tool",
            "turn": "u1",
            "id": "i1",
            "kind": "command",
            "name": "shell",
            "input": "pnpm test"
        })]
    );
    assert_eq!(
        wire(codex_notification(
            "item/commandExecution/outputDelta",
            &json!({ "threadId": "t", "turnId": "u1", "itemId": "i1", "delta": "61 passed" })
        )),
        vec![json!({
            "type": "tool.result",
            "turn": "u1",
            "id": "i1",
            "output": "61 passed",
            "append": true
        })]
    );
    let ok = item(json!({
        "type": "commandExecution",
        "command": "pnpm test",
        "status": "completed",
        "aggregatedOutput": "61 passed",
        "exitCode": 0
    }));
    assert_eq!(
        completed(&ok).last().unwrap(),
        &json!({
            "type": "tool.result",
            "turn": "u1",
            "id": "i1",
            "output": "61 passed",
            "exitCode": 0
        })
    );
    let failed = item(json!({
        "type": "commandExecution",
        "command": "pnpm test",
        "status": "failed",
        "aggregatedOutput": "x",
        "exitCode": 2
    }));
    let last = completed(&failed).last().unwrap().clone();
    assert_eq!(last["exitCode"], json!(2));
    assert_eq!(last["isError"], json!(true));
}

#[test]
fn maps_a_file_change_to_one_edit_per_file_with_its_unified_diff() {
    let events = completed(&item(json!({
        "type": "fileChange",
        "status": "completed",
        "changes": [
            { "path": "a.ts", "kind": { "type": "update", "move_path": null }, "diff": "@@ -1 +1 @@\n-a\n+b" },
            { "path": "b.ts", "kind": { "type": "add" }, "diff": "+x" }
        ]
    })));
    let edits: Vec<Value> = events
        .into_iter()
        .filter(|event| event["type"] == "edit")
        .collect();
    assert_eq!(
        edits,
        vec![
            json!({
                "type": "edit",
                "turn": "u1",
                "id": "i1:0",
                "path": "a.ts",
                "change": "update",
                "diff": "@@ -1 +1 @@\n-a\n+b"
            }),
            json!({
                "type": "edit",
                "turn": "u1",
                "id": "i1:1",
                "path": "b.ts",
                "change": "add",
                "diff": "+x"
            }),
        ]
    );
}

#[test]
fn sends_no_edit_for_a_declined_patch() {
    let events = completed(&item(json!({
        "type": "fileChange",
        "status": "declined",
        "changes": [{ "path": "a.ts", "kind": { "type": "add" }, "diff": "+x" }]
    })));
    assert!(events.iter().all(|event| event["type"] != "edit"));
    let last = events.last().unwrap();
    assert_eq!(last["type"], json!("tool.result"));
    assert_eq!(last["isError"], json!(true));
}

#[test]
fn maps_plan_updates_with_their_statuses() {
    assert_eq!(
        wire(codex_notification(
            "turn/plan/updated",
            &json!({
                "threadId": "t",
                "turnId": "u1",
                "explanation": null,
                "plan": [
                    { "step": "Guard", "status": "completed" },
                    { "step": "Push", "status": "inProgress" },
                    { "step": "Note", "status": "pending" }
                ]
            })
        )),
        vec![json!({
            "type": "plan",
            "turn": "u1",
            "id": "plan:u1",
            "items": [
                { "text": "Guard", "status": "done" },
                { "text": "Push", "status": "active" },
                { "text": "Note", "status": "pending" }
            ]
        })]
    );
}

#[test]
fn maps_an_mcp_tool_call_and_its_error_result() {
    let call = item(json!({
        "type": "mcpToolCall",
        "server": "jira",
        "tool": "search",
        "arguments": { "q": "x" },
        "status": "failed",
        "result": null,
        "error": { "message": "denied" }
    }));
    assert_eq!(
        completed(&call),
        vec![
            json!({
                "type": "tool",
                "turn": "u1",
                "id": "i1",
                "kind": "other",
                "name": "jira/search",
                "input": "{\"q\":\"x\"}"
            }),
            json!({
                "type": "tool.result",
                "turn": "u1",
                "id": "i1",
                "output": "denied",
                "isError": true
            }),
        ]
    );
}

#[test]
fn ignores_reasoning_items_and_unrelated_notifications() {
    assert_eq!(
        completed(&item(
            json!({ "type": "reasoning", "summary": [], "content": [] })
        )),
        Vec::<Value>::new()
    );
    assert!(codex_notification("account/updated", &json!({})).is_empty());
}

#[test]
fn turns_a_stored_turn_into_start_items_and_end() {
    assert_eq!(
        wire(codex_turn(&json!({
            "id": "u1",
            "status": "completed",
            "items": [
                item(json!({ "type": "userMessage", "content": [{ "type": "text", "text": "hi", "text_elements": [] }] })),
                item(json!({ "id": "i2", "type": "agentMessage", "text": "hello" }))
            ]
        }))),
        vec![
            json!({ "type": "turn.started", "turn": "u1" }),
            json!({ "type": "prompt", "turn": "u1", "id": "i1", "text": "hi" }),
            json!({ "type": "text", "turn": "u1", "id": "i2", "text": "hello" }),
            json!({ "type": "turn.ended", "turn": "u1", "status": "done" }),
        ]
    );
}

#[test]
fn leaves_an_in_progress_turn_open() {
    assert_eq!(
        wire(codex_turn(
            &json!({ "id": "u1", "status": "inProgress", "items": [] })
        )),
        vec![json!({ "type": "turn.started", "turn": "u1" })]
    );
}

#[test]
fn maps_a_dynamic_tool_call_a_web_search_and_a_failed_tool_with_no_arguments() {
    let dynamic = item(json!({
        "type": "dynamicToolCall",
        "tool": "lookup",
        "arguments": {},
        "status": "completed",
        "success": false,
        "contentItems": [{ "text": "no " }, { "text": "luck" }]
    }));
    assert_eq!(
        completed(&dynamic),
        vec![
            json!({ "type": "tool", "turn": "u1", "id": "i1", "kind": "other", "name": "lookup" }),
            json!({
                "type": "tool.result",
                "turn": "u1",
                "id": "i1",
                "output": "no luck",
                "isError": true
            }),
        ]
    );
    let search = item(json!({
        "type": "webSearch",
        "action": { "url": "https://example.com" }
    }));
    assert_eq!(
        completed(&search),
        vec![
            json!({
                "type": "tool",
                "turn": "u1",
                "id": "i1",
                "kind": "web",
                "name": "web_search",
                "target": "https://example.com"
            }),
            json!({ "type": "tool.result", "turn": "u1", "id": "i1", "output": "" }),
        ]
    );
}

#[test]
fn drops_items_with_no_id_and_empty_deltas() {
    assert!(
        codex_notification(
            "item/completed",
            &json!({ "turnId": "u1", "item": { "type": "agentMessage", "text": "x" } })
        )
        .is_empty()
    );
    assert!(
        codex_notification(
            "item/agentMessage/delta",
            &json!({ "turnId": "u1", "itemId": "i1", "delta": "" })
        )
        .is_empty()
    );
    assert!(codex_notification("turn/started", &json!({ "turn": {} })).is_empty());
}
