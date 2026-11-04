#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;
use std::sync::LazyLock;

use ostia_agents::chat_sessions::{ChatSaveResult, ChatSessionStore, ChatSessionStoreOptions};
use ostia_agents::chat_sessions_ipc::{SAVE_FILE_MAX, safe_name, save_file_content, save_redacted};
use ostia_contract::redaction::{RedactionKindInfo, SecretSpan};
use ostia_privacy::redaction::Redactor;
use ostia_privacy::redaction_scan::{
    ScanError, SecretScan, WorkerScan, redaction_worker_script, scan_deadline,
};
use serde_json::{Value, json};
use tempfile::TempDir;

static ANTHROPIC: LazyLock<String> = LazyLock::new(|| {
    format!(
        "sk-ant-api03-{}AA",
        "aB3dE5gH7jK9mN1pQ_-".repeat(5)[..93].to_owned()
    )
});

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn node() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .unwrap()
}

fn worker() -> WorkerScan {
    WorkerScan::new(node(), redaction_worker_script(&repo_root()), scan_deadline)
}

fn on() -> Redactor<WorkerScan> {
    Redactor::new(|| Value::Null, worker())
}

fn off() -> Redactor<WorkerScan> {
    Redactor::new(|| json!({"redaction": {"enabled": false}}), worker())
}

struct Failing;

impl SecretScan for Failing {
    async fn scan(&self, _text: &str) -> Result<Vec<SecretSpan>, ScanError> {
        Err(ScanError::Failed("scan failed".to_owned()))
    }

    async fn library_kinds(&self) -> Result<Vec<RedactionKindInfo>, ScanError> {
        Ok(Vec::new())
    }
}

fn session() -> Value {
    json!({
        "id": "chat-1",
        "title": "Keys",
        "createdAt": 1,
        "updatedAt": 2,
        "messages": [{
            "id": "m1",
            "role": "user",
            "parts": [{"type": "text", "text": format!("is {} valid", *ANTHROPIC)}],
            "metadata": {
                "context": [{"kind": "output", "label": "Output", "text": format!("KEY={}", *ANTHROPIC)}],
            },
        }],
    })
}

fn store_in(dir: &TempDir) -> ChatSessionStore {
    ChatSessionStore::new(ChatSessionStoreOptions::new(dir.path().to_path_buf()))
}

#[tokio::test]
async fn writes_the_session_file_without_the_secret() {
    let dir = TempDir::new().unwrap();
    let store = store_in(&dir);
    let res = save_redacted(&store, &session(), &on()).await.unwrap();
    assert!(matches!(res, ChatSaveResult::Saved { .. }));
    let file = fs::read_to_string(dir.path().join("chat-1.json")).unwrap();
    assert!(!file.contains(ANTHROPIC.as_str()));
    assert!(file.contains("is [redacted:anthropic] valid"));
    let got = store.get("chat-1").unwrap();
    assert_eq!(
        got["messages"][0]["metadata"]["context"][0]["text"],
        json!("KEY=[redacted:anthropic]")
    );
}

#[tokio::test]
async fn writes_the_session_as_it_is_while_the_setting_is_off() {
    let dir = TempDir::new().unwrap();
    let store = store_in(&dir);
    save_redacted(&store, &session(), &off()).await.unwrap();
    let file = fs::read_to_string(dir.path().join("chat-1.json")).unwrap();
    assert!(file.contains(&format!("is {} valid", *ANTHROPIC)));
}

#[tokio::test]
async fn writes_nothing_when_redaction_fails() {
    let dir = TempDir::new().unwrap();
    let store = store_in(&dir);
    let redactor = Redactor::new(|| Value::Null, Failing);
    let res = save_redacted(&store, &session(), &redactor).await.unwrap();
    assert_eq!(
        res,
        ChatSaveResult::Failed {
            error: "redaction-failed".to_owned()
        }
    );
    assert_eq!(store.get("chat-1"), None);
    assert!(!dir.path().join("chat-1.json").exists());
}

#[tokio::test]
async fn still_refuses_an_invalid_session() {
    let dir = TempDir::new().unwrap();
    let store = store_in(&dir);
    let redactor = Redactor::new(|| Value::Null, Failing);
    let res = save_redacted(&store, &json!({"id": "x"}), &redactor)
        .await
        .unwrap();
    assert_eq!(
        res,
        ChatSaveResult::Failed {
            error: "invalid-session".to_owned()
        }
    );
}

#[test]
fn names_a_saved_file_without_separators_control_characters_or_reserved_characters() {
    let cases = [
        (json!("Deploy notes.md"), "chat.md", "Deploy notes.md"),
        (
            json!("a/b\\c:d*e?f\"g<h>i|j.md"),
            "chat.md",
            "a-b-c-d-e-f-g-h-i-j.md",
        ),
        (json!("../x.md"), "chat.md", "..-x.md"),
        (
            json!("tab\there\u{7}bell\u{1f}.txt"),
            "chat.md",
            "tab-here-bell-.txt",
        ),
        (json!("日本語 😀.md"), "chat.md", "日本語 😀.md"),
    ];
    for (raw, fallback, expected) in cases {
        assert_eq!(safe_name(&raw, fallback), expected, "{raw}");
    }
}

#[test]
fn falls_back_when_the_name_is_not_text_or_is_blank() {
    let cases = [
        json!(null),
        json!(7),
        json!(["a.md"]),
        json!({"name": "a"}),
        json!(""),
        json!("   "),
        json!("\u{feff}\u{a0}\u{2003}"),
    ];
    for raw in cases {
        assert_eq!(safe_name(&raw, "snippet.txt"), "snippet.txt", "{raw}");
    }
}

#[test]
fn cuts_a_name_to_120_units_after_it_trims_it() {
    let long = "a".repeat(130);
    assert_eq!(safe_name(&json!(long), "x"), "a".repeat(120));
    let padded = format!("  {}  ", "b".repeat(10));
    assert_eq!(safe_name(&json!(padded), "x"), "b".repeat(10));
    let spaced = format!("{}{}", " ".repeat(5), "c".repeat(130));
    assert_eq!(safe_name(&json!(spaced), "x").chars().count(), 120);
}

#[test]
fn takes_file_content_that_is_text_within_the_cap_and_refuses_the_rest() {
    assert_eq!(SAVE_FILE_MAX, 5 * 1024 * 1024);
    assert_eq!(save_file_content(&json!("echo hi")), Some("echo hi"));
    assert_eq!(save_file_content(&json!("")), Some(""));
    let edge = "x".repeat(SAVE_FILE_MAX);
    assert_eq!(save_file_content(&json!(edge)), Some(edge.as_str()));
    let over = "x".repeat(SAVE_FILE_MAX + 1);
    assert_eq!(save_file_content(&json!(over)), None);
    assert_eq!(save_file_content(&json!(7)), None);
    assert_eq!(save_file_content(&Value::Null), None);
    assert_eq!(save_file_content(&json!(["x"])), None);
}

#[test]
fn counts_the_content_cap_in_utf16_units() {
    let wide = "😀".repeat(SAVE_FILE_MAX / 2);
    assert_eq!(save_file_content(&json!(wide)), Some(wide.as_str()));
    let over = format!("{}x", "😀".repeat(SAVE_FILE_MAX / 2));
    assert_eq!(save_file_content(&json!(over)), None);
}
