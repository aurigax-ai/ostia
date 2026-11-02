#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_session_info::{
    AgentSessionInfo, claude_session_info, codex_session_info, format_tokens,
};
use serde_json::{Value, json};

fn line(value: Value) -> String {
    value.to_string()
}

fn text(value: &str) -> Option<String> {
    Some(value.to_owned())
}

#[test]
fn reads_the_title_model_context_size_folder_and_branch_of_the_main_thread() {
    let info = claude_session_info(&[
        line(json!({ "type": "permission-mode", "permissionMode": "acceptEdits" })),
        line(json!({ "type": "ai-title", "aiTitle": "Resume tokens" })),
        line(json!({ "type": "user", "cwd": "/w", "gitBranch": "main", "version": "2.3.0" })),
        line(json!({
            "type": "assistant",
            "cwd": "/w",
            "effort": "high",
            "message": {
                "model": "claude-opus-5-5",
                "usage": {
                    "input_tokens": 10,
                    "cache_creation_input_tokens": 2000,
                    "cache_read_input_tokens": 56000
                }
            }
        })),
        line(json!({
            "type": "assistant",
            "isSidechain": true,
            "message": { "model": "claude-haiku-4-5", "usage": { "input_tokens": 999999 } }
        })),
        "{\"type\":\"assistant\", broken".to_owned(),
    ]);
    assert_eq!(
        info,
        AgentSessionInfo {
            title: text("Resume tokens"),
            model: text("claude-opus-5-5"),
            context_tokens: Some(58010),
            context_window: None,
            cwd: text("/w"),
            branch: text("main"),
            version: text("2.3.0"),
            mode: text("acceptEdits"),
            effort: text("high"),
        }
    );
}

#[test]
fn prefers_a_title_the_human_set_over_the_generated_one() {
    let info = claude_session_info(&[
        line(json!({ "type": "ai-title", "aiTitle": "Generated" })),
        line(json!({ "type": "custom-title", "customTitle": "Mine" })),
        line(json!({ "type": "ai-title", "aiTitle": "Newer generated" })),
    ]);
    assert_eq!(info.title, text("Mine"));
}

#[test]
fn reads_the_model_folder_branch_and_context_use_against_the_window() {
    let info = codex_session_info(&[
        line(json!({
            "type": "session_meta",
            "payload": { "cwd": "/w", "cli_version": "0.157.0", "git": { "branch": "dev" } }
        })),
        line(json!({
            "type": "turn_context",
            "payload": {
                "model": "gpt-5.4",
                "cwd": "/w/app",
                "effort": "medium",
                "approval_policy": "on-request"
            }
        })),
        line(json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "model_context_window": 272000,
                    "last_token_usage": { "input_tokens": 41000 }
                }
            }
        })),
    ]);
    assert_eq!(
        info,
        AgentSessionInfo {
            title: None,
            model: text("gpt-5.4"),
            context_tokens: Some(41000),
            context_window: Some(272000),
            cwd: text("/w/app"),
            branch: text("dev"),
            version: text("0.157.0"),
            mode: text("on-request"),
            effort: text("medium"),
        }
    );
}

#[test]
fn shortens_large_counts() {
    assert_eq!(format_tokens(950), "950");
    assert_eq!(format_tokens(58010), "58.0k");
    assert_eq!(format_tokens(1_250_000), "1.25M");
}

#[test]
fn keeps_the_last_good_value_and_cuts_long_text_as_ts_does() {
    let long = "x".repeat(300);
    let path = format!("/{}", "p".repeat(5000));
    let info = claude_session_info(&[
        line(json!({ "type": "user", "cwd": path, "gitBranch": long, "version": "  1.0  " })),
        line(json!({ "type": "user", "cwd": "   ", "gitBranch": 5, "version": "" })),
        line(json!({
            "type": "assistant",
            "message": { "model": 3, "usage": { "input_tokens": -1, "cache_read_input_tokens": 7.4 } }
        })),
        "   ".to_owned(),
        "[1,2]".to_owned(),
    ]);
    assert_eq!(
        info.cwd.as_deref().map(|cwd| cwd.chars().count()),
        Some(4096)
    );
    assert_eq!(info.branch.as_deref().map(|b| b.chars().count()), Some(200));
    assert_eq!(info.version, text("1.0"));
    assert_eq!(info.model, None);
    assert_eq!(info.context_tokens, Some(7));
}

#[test]
fn leaves_the_context_unset_when_no_usage_count_is_valid_and_ignores_other_entry_types() {
    let info = claude_session_info(&[
        line(json!({
            "type": "assistant",
            "message": { "usage": { "input_tokens": "5", "cache_read_input_tokens": -2 } }
        })),
        line(json!({ "type": "summary", "cwd": "/ignored", "gitBranch": "ignored" })),
    ]);
    assert_eq!(info.context_tokens, None);
    assert_eq!(info.cwd, None);
    assert_eq!(info.branch, None);
}

#[test]
fn codex_skips_entries_with_no_payload_and_keeps_earlier_values() {
    let info = codex_session_info(&[
        line(json!({ "type": "session_meta", "payload": { "cwd": "/a", "context_window": 1000 } })),
        line(json!({ "type": "turn_context" })),
        line(json!({ "type": "event_msg", "payload": { "type": "token_count", "info": null } })),
        line(json!({ "type": "event_msg", "payload": { "type": "other", "info": {} } })),
        line(json!({
            "type": "event_msg",
            "payload": { "type": "token_count", "info": { "last_token_usage": { "input_tokens": "x" } } }
        })),
    ]);
    assert_eq!(info.cwd, text("/a"));
    assert_eq!(info.context_window, Some(1000));
    assert_eq!(info.context_tokens, None);
}
