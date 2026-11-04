#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use ostia_agents::chat_sessions::{
    CHAT_EDIT_TEXT_MAX, ChatSaveResult, ChatSessionStore, ChatSessionStoreOptions,
};
use ostia_testkit::fixture_text;
use serde_json::{Value, json};
use tempfile::TempDir;

fn msg(i: usize, role: &str, text: &str) -> Value {
    json!({
        "id": format!("m{i}"),
        "role": role,
        "parts": [{"type": "text", "text": text}],
        "metadata": {"createdAt": i},
    })
}

fn session(id: &str, updated_at: i64, messages: Vec<Value>) -> Value {
    json!({
        "id": id,
        "workspaceId": "w1",
        "title": format!("Session {id}"),
        "createdAt": 1,
        "updatedAt": updated_at,
        "model": "fake · big",
        "messageCount": messages.len(),
        "messages": messages,
    })
}

fn store_in(dir: &Path) -> ChatSessionStore {
    ChatSessionStore::new(ChatSessionStoreOptions::new(dir.to_path_buf()))
}

fn store_with(dir: &Path, limits: impl FnOnce(&mut ChatSessionStoreOptions)) -> ChatSessionStore {
    let mut options = ChatSessionStoreOptions::new(dir.to_path_buf());
    limits(&mut options);
    ChatSessionStore::new(options)
}

fn saved_of(result: ChatSaveResult) -> (Value, usize, Vec<String>) {
    match result {
        ChatSaveResult::Saved {
            summary,
            trimmed_messages,
            evicted,
        } => (summary, trimmed_messages, evicted),
        ChatSaveResult::Failed { error } => panic!("save failed: {error}"),
    }
}

fn ids_of(summaries: &[Value]) -> Vec<String> {
    summaries
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect()
}

fn texts_of(session: &Value) -> Vec<String> {
    session["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["parts"][0]["text"].as_str().unwrap().to_owned())
        .collect()
}

fn tool_call(id: &str) -> Value {
    json!({
        "type": "dynamic-tool",
        "toolName": "edit_file",
        "toolCallId": id,
        "state": "output-available",
        "input": {},
        "output": {"added": 1, "removed": 1},
    })
}

fn edit(tool_call_id: &str, seq: i64, text: &str) -> Value {
    json!({
        "toolCallId": tool_call_id,
        "path": "/home/u/p/a.ts",
        "root": "/home/u/p",
        "existed": true,
        "outside": false,
        "symlink": false,
        "auto": true,
        "state": "applied",
        "version": "a".repeat(64),
        "seq": seq,
        "decisions": ["accepted", "rejected", "bogus"],
        "before": text,
        "after": format!("{text}!"),
    })
}

#[test]
fn saves_a_session_privately_and_lists_it_newest_first_without_messages() {
    let dir = TempDir::new().unwrap();
    let store = store_in(dir.path());
    store
        .save(&session(
            "a",
            10,
            vec![msg(1, "user", "hi"), msg(2, "assistant", "hello")],
        ))
        .unwrap();
    store
        .save(&session("b", 20, vec![msg(1, "user", "yo")]))
        .unwrap();
    let listed = store.list();
    let pairs: Vec<(String, i64)> = listed
        .iter()
        .map(|s| {
            (
                s["id"].as_str().unwrap().to_owned(),
                s["messageCount"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(pairs, vec![("b".to_owned(), 1), ("a".to_owned(), 2)]);
    assert!(listed[0].get("messages").is_none());
    assert_eq!(texts_of(&store.get("a").unwrap()), vec!["hi", "hello"]);
    let mode = fs::metadata(dir.path().join("a.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn keeps_future_part_types_such_as_tool_calls_intact() {
    let dir = TempDir::new().unwrap();
    let store = store_in(dir.path());
    let tool = json!({
        "type": "tool-ls",
        "toolCallId": "t1",
        "state": "output-available",
        "output": {"n": 1},
    });
    let done = json!({"type": "text", "text": "done"});
    store
        .save(&session(
            "a",
            1,
            vec![
                msg(1, "user", "list"),
                json!({"id": "m2", "role": "assistant", "parts": [tool.clone(), done.clone()]}),
            ],
        ))
        .unwrap();
    let got = store.get("a").unwrap();
    assert_eq!(got["messages"][1]["parts"], json!([tool, done]));
}

#[test]
fn trims_the_oldest_turns_of_a_session_over_its_cap_and_marks_it_trimmed() {
    let dir = TempDir::new().unwrap();
    let store = store_with(dir.path(), |o| o.session_max_bytes = 2000);
    let messages: Vec<Value> = (0..10)
        .map(|i| {
            msg(
                i,
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("{i}-{}", "x".repeat(300)),
            )
        })
        .collect();
    let (_, trimmed, _) = saved_of(store.save(&session("a", 1, messages)).unwrap());
    assert!(trimmed > 0);
    let got = store.get("a").unwrap();
    assert_eq!(got["trimmed"], json!(true));
    assert_eq!(got["messages"][0]["role"], json!("user"));
    let last = got["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["id"], json!("m9"));
    assert!(fs::read(dir.path().join("a.json")).unwrap().len() <= 2000);
}

#[test]
fn trims_a_long_session_to_the_cap_and_starts_it_on_a_user_turn() {
    let dir = TempDir::new().unwrap();
    let store = store_with(dir.path(), |o| o.session_max_bytes = 20_000);
    let messages: Vec<Value> = (0..400)
        .map(|i| {
            msg(
                i,
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("{i}-{}", "x".repeat(2000)),
            )
        })
        .collect();
    let (summary, trimmed, _) = saved_of(store.save(&session("big", 1, messages)).unwrap());
    assert!(trimmed > 380);
    assert!(fs::read(dir.path().join("big.json")).unwrap().len() <= 20_000);
    assert_eq!(
        store.get("big").unwrap()["messages"][0]["role"],
        json!("user")
    );
    let kept = summary["messageCount"].as_u64().unwrap();
    assert!((8..=9).contains(&kept), "kept {kept}");
}

#[test]
fn keeps_what_undo_needs_for_each_edit_without_texts_past_the_cap_or_for_calls_no_longer_in_it() {
    let dir = TempDir::new().unwrap();
    let store = store_in(dir.path());
    let messages = vec![
        msg(1, "user", "edit it"),
        json!({"id": "m2", "role": "assistant", "parts": [tool_call("e1"), tool_call("e2")]}),
    ];
    let mut duplicate = edit("e1", 4, "dup");
    duplicate["version"] = json!("not-a-hash");
    let mut raw = session("a", 1, messages);
    raw["edits"] = json!([
        edit("e2", 2, &"x".repeat(CHAT_EDIT_TEXT_MAX + 1)),
        edit("e1", 1, "small"),
        edit("gone", 3, "orphan"),
        duplicate,
    ]);
    store.save(&raw).unwrap();
    let got = store.get("a").unwrap();
    let saved = got["edits"].as_array().unwrap();
    let called: Vec<&str> = saved
        .iter()
        .map(|e| e["toolCallId"].as_str().unwrap())
        .collect();
    assert_eq!(called, vec!["e1", "e2"]);
    assert_eq!(saved[0]["before"], json!("small"));
    assert_eq!(saved[0]["after"], json!("small!"));
    assert_eq!(saved[0]["decisions"], json!(["accepted", "rejected", null]));
    assert_eq!(saved[0]["state"], json!("applied"));
    assert!(saved[1].get("before").is_none());
    assert!(saved[1].get("after").is_none());
    assert!(store.list()[0].get("edits").is_none());
}

#[test]
fn drops_the_edits_of_turns_it_trims() {
    let dir = TempDir::new().unwrap();
    let store = store_with(dir.path(), |o| o.session_max_bytes = 2000);
    let messages = vec![
        msg(0, "user", &"x".repeat(900)),
        json!({
            "id": "m1",
            "role": "assistant",
            "parts": [{"type": "dynamic-tool", "toolName": "write_file", "toolCallId": "old", "state": "x"}],
        }),
        msg(2, "user", &"y".repeat(900)),
        msg(3, "assistant", "done"),
    ];
    let mut raw = session("a", 1, messages);
    raw["edits"] = json!([{
        "toolCallId": "old",
        "path": "/home/u/p/a.ts",
        "root": "/home/u/p",
        "existed": false,
        "outside": false,
        "symlink": false,
        "auto": false,
        "state": "applied",
        "version": null,
        "seq": 1,
        "decisions": [],
    }]);
    store.save(&raw).unwrap();
    let got = store.get("a").unwrap();
    assert_eq!(got["messages"][0]["id"], json!("m2"));
    assert!(got.get("edits").is_none());
}

#[test]
fn evicts_the_least_recently_updated_sessions_over_the_total_cap_never_the_one_saved() {
    let dir = TempDir::new().unwrap();
    let store = store_with(dir.path(), |o| o.max_sessions = 2);
    store
        .save(&session("old", 1, vec![msg(1, "user", "a")]))
        .unwrap();
    store
        .save(&session("mid", 2, vec![msg(1, "user", "b")]))
        .unwrap();
    let (_, _, evicted) = saved_of(
        store
            .save(&session("new", 0, vec![msg(1, "user", "c")]))
            .unwrap(),
    );
    assert_eq!(evicted, vec!["old"]);
    let mut left = ids_of(&store.list());
    left.sort();
    assert_eq!(left, vec!["mid", "new"]);
}

#[test]
fn evicts_by_total_bytes_oldest_first_until_the_folder_fits() {
    let dir = TempDir::new().unwrap();
    let store = store_with(dir.path(), |o| o.total_max_bytes = 1500);
    let text = "z".repeat(300);
    store
        .save(&session("one", 1, vec![msg(1, "user", &text)]))
        .unwrap();
    store
        .save(&session("two", 2, vec![msg(1, "user", &text)]))
        .unwrap();
    let (_, _, evicted) = saved_of(
        store
            .save(&session("three", 3, vec![msg(1, "user", &text)]))
            .unwrap(),
    );
    assert_eq!(evicted, vec!["one"]);
    let total: u64 = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    assert!(total <= 1500, "total {total}");
}

#[test]
fn renames_deletes_and_refuses_ids_that_could_escape_the_folder() {
    let dir = TempDir::new().unwrap();
    let store = store_in(dir.path());
    store
        .save(&session("a", 1, vec![msg(1, "user", "hi")]))
        .unwrap();
    let renamed = store.rename("a", "  Deploy   notes ").unwrap().unwrap();
    assert_eq!(renamed["title"], json!("Deploy notes"));
    assert_eq!(store.rename("a", "   ").unwrap(), None);
    let mut escaping = session("a", 1, vec![]);
    escaping["id"] = json!("../x");
    assert_eq!(
        store.save(&escaping).unwrap(),
        ChatSaveResult::Failed {
            error: "invalid-session".to_owned()
        }
    );
    assert_eq!(store.get("../a"), None);
    assert!(store.remove("a").unwrap());
    assert!(!store.remove("a").unwrap());
    assert_eq!(store.list(), Vec::<Value>::new());
}

#[test]
fn refuses_ids_with_a_path_in_every_call_and_touches_no_file_outside_the_folder() {
    let dir = TempDir::new().unwrap();
    let inner = dir.path().join("sessions");
    let store = store_in(&inner);
    fs::write(dir.path().join("x.json"), "{}").unwrap();
    assert_eq!(store.get("../x"), None);
    assert_eq!(store.rename("../x", "t").unwrap(), None);
    assert!(!store.remove("../x").unwrap());
    assert!(dir.path().join("x.json").exists());
}

#[test]
fn lists_nothing_before_the_folder_exists_and_skips_files_that_are_not_sessions() {
    let dir = TempDir::new().unwrap();
    let inner = dir.path().join("sessions");
    let store = store_in(&inner);
    assert_eq!(store.list(), Vec::<Value>::new());
    store
        .save(&session("a", 1, vec![msg(1, "user", "hi")]))
        .unwrap();
    fs::write(inner.join("notes.txt"), "x").unwrap();
    fs::write(inner.join("broken.json"), "{not json").unwrap();
    fs::write(
        inner.join("other.json"),
        json!(session("zzz", 1, vec![])).to_string(),
    )
    .unwrap();
    assert_eq!(ids_of(&store.list()), vec!["a"]);
    assert_eq!(store.get("broken"), None);
    assert_eq!(store.get("other"), None);
}

#[test]
fn creates_the_folder_privately_when_it_saves() {
    let dir = TempDir::new().unwrap();
    let inner = dir.path().join("deep").join("sessions");
    let store = store_in(&inner);
    store
        .save(&session("a", 1, vec![msg(1, "user", "hi")]))
        .unwrap();
    let mode = fs::metadata(&inner).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
}

#[test]
fn reads_a_session_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let input: Value =
        serde_json::from_str(&fixture_text("rust/chat-session-input.json").unwrap()).unwrap();
    let written = fixture_text("rust/chat-session-saved.json").unwrap();
    let dir = TempDir::new().unwrap();
    let store = store_in(dir.path());
    let (summary, trimmed, evicted) = saved_of(store.save(&input).unwrap());
    assert_eq!(trimmed, 0);
    assert_eq!(evicted, Vec::<String>::new());
    assert_eq!(
        fs::read_to_string(dir.path().join("chat-1.json")).unwrap(),
        written
    );
    let expected: Value = serde_json::from_str(&written).unwrap();
    assert_eq!(store.get("chat-1").unwrap(), expected);
    assert_eq!(summary["messageCount"], json!(3));
    assert!(summary.get("edits").is_none());

    let other = TempDir::new().unwrap();
    fs::write(other.path().join("chat-1.json"), &written).unwrap();
    assert_eq!(store_in(other.path()).get("chat-1").unwrap(), expected);
}

#[test]
fn reduces_a_raw_session_to_what_the_ts_normalizer_keeps() {
    let dir = TempDir::new().unwrap();
    let store = store_in(dir.path());
    let input: Value =
        serde_json::from_str(&fixture_text("rust/chat-session-input.json").unwrap()).unwrap();
    store.save(&input).unwrap();
    let got = store.get("chat-1").unwrap();
    assert_eq!(got["title"], json!("Deploy notes"));
    assert_eq!(got["messageCount"], json!(3));
    assert!(got.get("extra").is_none());
    let ids: Vec<&str> = got["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["m1", "m0", "m2"]);
    assert_eq!(
        got["messages"][0]["parts"],
        json!([{"type": "text", "text": "list é 日本語 😀 \"q\" \\ \t"}])
    );
    assert_eq!(got["messages"][0]["metadata"]["model"], json!("m"));
    assert_eq!(got["edits"].as_array().unwrap().len(), 1);
    assert_eq!(got["edits"][0]["seq"], json!(2));
}
