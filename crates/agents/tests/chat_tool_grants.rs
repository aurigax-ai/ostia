#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use ostia_agents::chat_tool_grants::{CHAT_TOOL_GRANTS_MAX, ChatToolGrants};
use ostia_testkit::fixture_text;
use serde_json::{Value, json};
use tempfile::TempDir;

fn grants_in(base: &TempDir) -> (ChatToolGrants, std::path::PathBuf) {
    let file = base.path().join("data").join("chat-tool-grants.json");
    (ChatToolGrants::new(file.clone()), file)
}

#[test]
fn keeps_an_always_allowed_tool_in_a_private_file_and_reads_it_back() {
    let base = TempDir::new().unwrap();
    let (grants, file) = grants_in(&base);
    assert!(grants.add(&json!("mcp__fake__echo")).unwrap());
    assert!(grants.add(&json!("read-outside")).unwrap());
    assert!(grants.add(&json!("open_url")).unwrap());
    let mode = fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    assert_eq!(
        ChatToolGrants::new(file).list(),
        vec!["mcp__fake__echo", "read-outside", "open_url"]
    );
}

#[test]
fn never_keeps_a_tool_a_card_could_not_grant() {
    let keys: [Value; 7] = [
        json!("propose_command"),
        json!("edit_file"),
        json!("write_file"),
        json!("read_file"),
        json!("rm_rf"),
        json!(""),
        json!(42),
    ];
    for key in keys {
        let base = TempDir::new().unwrap();
        let (grants, file) = grants_in(&base);
        assert!(!grants.add(&key).unwrap(), "{key}");
        assert_eq!(grants.list(), Vec::<String>::new(), "{key}");
        assert!(!file.exists(), "{key}");
    }
}

#[test]
fn drops_keys_a_hand_edit_added_that_a_card_could_never_grant() {
    let base = TempDir::new().unwrap();
    let path = base.path().join("hand.json");
    fs::write(
        &path,
        json!({"keys": ["open_file", "propose_command", "write_file", 7]}).to_string(),
    )
    .unwrap();
    assert_eq!(ChatToolGrants::new(path).list(), vec!["open_file"]);
}

#[test]
fn removes_a_grant_so_the_next_load_no_longer_has_it() {
    let base = TempDir::new().unwrap();
    let (grants, file) = grants_in(&base);
    grants.add(&json!("open_file")).unwrap();
    assert!(grants.remove(&json!("open_file")).unwrap());
    assert!(!grants.remove(&json!("open_file")).unwrap());
    assert_eq!(ChatToolGrants::new(file).list(), Vec::<String>::new());
}

#[test]
fn refuses_a_repeat_and_a_remove_of_something_that_is_not_text() {
    let base = TempDir::new().unwrap();
    let (grants, _) = grants_in(&base);
    assert!(grants.add(&json!("open_url")).unwrap());
    assert!(!grants.add(&json!("open_url")).unwrap());
    assert!(!grants.remove(&json!(7)).unwrap());
    assert!(!grants.remove(&Value::Null).unwrap());
    assert_eq!(grants.list(), vec!["open_url"]);
}

#[test]
fn reads_nothing_from_a_missing_or_malformed_file_and_dedupes_and_caps_a_stored_list() {
    let base = TempDir::new().unwrap();
    assert_eq!(
        ChatToolGrants::new(base.path().join("missing.json")).list(),
        Vec::<String>::new()
    );
    let cases = [
        "{not json".to_owned(),
        "null".to_owned(),
        json!({"keys": "open_file"}).to_string(),
        json!({"other": ["open_file"]}).to_string(),
    ];
    for (i, text) in cases.iter().enumerate() {
        let path = base.path().join(format!("bad{i}.json"));
        fs::write(&path, text).unwrap();
        assert_eq!(
            ChatToolGrants::new(path).list(),
            Vec::<String>::new(),
            "{text}"
        );
    }
    let many: Vec<String> = (0..CHAT_TOOL_GRANTS_MAX + 10)
        .map(|i| format!("mcp__s__t{i}"))
        .chain(["open_url".to_owned(), "open_url".to_owned()])
        .collect();
    let path = base.path().join("many.json");
    fs::write(&path, json!({"keys": many}).to_string()).unwrap();
    let list = ChatToolGrants::new(path).list();
    assert_eq!(list.len(), CHAT_TOOL_GRANTS_MAX);
    assert_eq!(list[0], "mcp__s__t0");
    let twice = base.path().join("twice.json");
    fs::write(
        &twice,
        json!({"keys": ["open_url", "open_file", "open_url"]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        ChatToolGrants::new(twice).list(),
        vec!["open_url", "open_file"]
    );
}

#[test]
fn refuses_a_grant_past_the_cap() {
    let base = TempDir::new().unwrap();
    let (grants, file) = grants_in(&base);
    for i in 0..CHAT_TOOL_GRANTS_MAX {
        assert!(grants.add(&json!(format!("mcp__s__t{i}"))).unwrap(), "{i}");
    }
    assert!(!grants.add(&json!("open_url")).unwrap());
    assert_eq!(grants.list().len(), CHAT_TOOL_GRANTS_MAX);
    assert!(grants.remove(&json!("mcp__s__t0")).unwrap());
    assert!(grants.add(&json!("open_url")).unwrap());
    assert_eq!(ChatToolGrants::new(file).list().len(), CHAT_TOOL_GRANTS_MAX);
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let before = fixture_text("rust/chat-tool-grants-before.json").unwrap();
    let after = fixture_text("rust/chat-tool-grants-after.json").unwrap();
    let base = TempDir::new().unwrap();
    let (grants, file) = grants_in(&base);
    grants.add(&json!("open_file")).unwrap();
    grants.add(&json!("read-outside")).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
    grants.add(&json!("mcp__fake__echo")).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), after);

    let loaded = TempDir::new().unwrap();
    let (_, file) = grants_in(&loaded);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, &before).unwrap();
    let grants = ChatToolGrants::new(file.clone());
    assert_eq!(grants.list(), vec!["open_file", "read-outside"]);
    assert!(grants.add(&json!("mcp__fake__echo")).unwrap());
    assert_eq!(fs::read_to_string(&file).unwrap(), after);
}
