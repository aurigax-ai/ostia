#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use ostia_base::Host;
use ostia_cli::hooks::offline_attention::{
    STATE_VERBS, message_from_stdin, offline_attention, save_attention_offline,
};
use ostia_testkit::temp_host;
use serde_json::{Value, json};
use tempfile::TempDir;

fn state_file(token_file: &Path) -> std::path::PathBuf {
    let mut name = token_file.as_os_str().to_owned();
    name.push(".state");
    name.into()
}

fn saved(token_file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(state_file(token_file)).unwrap()).unwrap()
}

fn stdin(text: &str) -> impl FnMut() -> String {
    let text = text.to_owned();
    move || text.clone()
}

#[test]
fn ksh_c85_writes_what_a_claude_hook_reports_into_the_kept_pane_state_file() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("token");
    fs::write(state_file(&token_file), "").unwrap();
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let payload =
        json!({"notification_type": "permission_prompt", "message": "Run rm?"}).to_string();
    assert!(
        save_attention_offline(
            &["claude-hook", "Notification"],
            &mut stdin(&payload),
            &host
        )
        .unwrap()
    );
    assert_eq!(
        saved(&token_file),
        json!({"state": "waiting", "message": "Run rm?"})
    );
    assert!(save_attention_offline(&["claude-hook", "Stop"], &mut stdin("{}"), &host).unwrap());
    assert_eq!(saved(&token_file)["state"], "done");
}

#[test]
fn writes_a_codex_question_and_its_answer_into_the_kept_pane_state_file() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("codex-question-token");
    fs::write(state_file(&token_file), "").unwrap();
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let ask = json!({
        "tool_name": "request_user_input",
        "tool_input": {"questions": [{"question": "Which database?"}]},
    })
    .to_string();
    assert!(
        save_attention_offline(&["codex-hook", "PreToolUse"], &mut stdin(&ask), &host).unwrap()
    );
    assert_eq!(
        saved(&token_file),
        json!({"state": "waiting", "message": "Which database?"})
    );
    let answered = json!({"tool_name": "request_user_input"}).to_string();
    assert!(
        save_attention_offline(&["codex-hook", "PostToolUse"], &mut stdin(&answered), &host)
            .unwrap()
    );
    assert_eq!(saved(&token_file)["state"], "working");
}

fn host_with_token_file_in(dir: TempDir, mut host: Host, file: &Path) -> (TempDir, Host) {
    host.env.insert(
        "OSTIA_TOKEN_FILE".to_owned(),
        file.to_string_lossy().into_owned(),
    );
    (dir, host)
}

#[test]
fn rejects_an_unknown_hook_event_without_reading_stdin() {
    let reads = Cell::new(0);
    let mut read = || {
        reads.set(reads.get() + 1);
        "{}".to_owned()
    };
    assert!(
        offline_attention(&["claude-hook", "Nope"], &mut read)
            .unwrap()
            .is_none()
    );
    assert!(
        offline_attention(&["codex-hook", "Nope"], &mut read)
            .unwrap()
            .is_none()
    );
    assert_eq!(reads.get(), 0);
}

#[test]
fn ksh_c85_writes_what_the_codex_hooks_report_through_the_state_verb_and_clears_on_clear() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("codex-token");
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let payload = json!({"tool_name": "shell"}).to_string();
    assert!(
        save_attention_offline(&["state", "waiting", "-"], &mut stdin(&payload), &host).unwrap()
    );
    assert_eq!(
        saved(&token_file),
        json!({"state": "waiting", "message": "Needs your permission to use shell"})
    );
    assert!(save_attention_offline(&["state", "clear"], &mut stdin(""), &host).unwrap());
    assert_eq!(fs::read_to_string(state_file(&token_file)).unwrap(), "");
}

#[test]
fn does_not_take_the_codex_stop_flag_for_a_message() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("codex-stop-token");
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let stop = json!({"session_id": "s-1", "last_assistant_message": "done"}).to_string();
    assert!(
        save_attention_offline(&["state", "done", "--stop"], &mut stdin(&stop), &host).unwrap()
    );
    assert_eq!(saved(&token_file), json!({"state": "done"}));
}

#[test]
fn leaves_the_file_alone_when_a_hook_has_nothing_to_report_and_handles_nothing_else() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("quiet-token");
    fs::write(state_file(&token_file), r#"{"state":"working"}"#).unwrap();
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let idle = json!({"notification_type": "idle_prompt"}).to_string();
    assert!(
        save_attention_offline(&["claude-hook", "Notification"], &mut stdin(&idle), &host).unwrap()
    );
    assert_eq!(
        fs::read_to_string(state_file(&token_file)).unwrap(),
        r#"{"state":"working"}"#
    );
    assert!(!save_attention_offline(&["whoami"], &mut stdin(""), &host).unwrap());
    assert!(
        !save_attention_offline(&["state", "done", "--pane", "other"], &mut stdin(""), &host)
            .unwrap()
    );
    assert!(
        offline_attention(&["state", "bogus"], &mut stdin(""))
            .unwrap()
            .is_none()
    );
}

#[test]
fn does_nothing_in_a_pane_that_is_not_kept() {
    let (_dir, host) = temp_host().unwrap();
    assert!(!save_attention_offline(&["state", "done"], &mut stdin(""), &host).unwrap());
}

#[test]
fn takes_a_message_from_stdin_as_the_hooks_send_it() {
    let table: [(&str, &str); 8] = [
        ("  plain words \n", "plain words"),
        ("", ""),
        (r#"{"message":"Run rm?"}"#, "Run rm?"),
        (r#"{"message":"Run rm?","tool_name":"shell"}"#, "Run rm?"),
        (
            r#"{"tool_name":"shell"}"#,
            "Needs your permission to use shell",
        ),
        (
            r#"{"message":7,"tool_name":"shell"}"#,
            "Needs your permission to use shell",
        ),
        (r#"{"other":1}"#, ""),
        ("{not json", "{not json"),
    ];
    for (raw, expected) in table {
        assert_eq!(message_from_stdin(raw), expected, "{raw:?}");
    }
}

#[test]
fn lists_the_state_verbs_it_accepts() {
    assert_eq!(
        STATE_VERBS,
        ["waiting", "done", "working", "error", "clear"]
    );
}

#[test]
fn keeps_a_literal_state_message_and_reads_stdin_only_for_a_dash() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("literal-token");
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let reads = Cell::new(0);
    let mut read = || {
        reads.set(reads.get() + 1);
        String::new()
    };
    assert!(save_attention_offline(&["state", "error", "Build failed"], &mut read, &host).unwrap());
    assert_eq!(reads.get(), 0);
    assert_eq!(
        saved(&token_file),
        json!({"state": "error", "message": "Build failed"})
    );
    assert!(save_attention_offline(&["state", "working", "-"], &mut read, &host).unwrap());
    assert_eq!(reads.get(), 1);
    assert_eq!(saved(&token_file), json!({"state": "working"}));
}

#[test]
fn writes_the_state_file_readable_by_its_owner_only() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("mode-token");
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    assert!(save_attention_offline(&["state", "done"], &mut stdin(""), &host).unwrap());
    let mode = fs::metadata(state_file(&token_file))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn reports_false_when_the_state_file_cannot_be_written() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("missing-folder").join("token");
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    assert!(!save_attention_offline(&["state", "done"], &mut stdin(""), &host).unwrap());
}

#[test]
fn raises_the_flag_error_when_pane_has_no_value() {
    let (dir, host) = temp_host().unwrap();
    let token_file = dir.path().join("flag-token");
    let (_keep, host) = host_with_token_file_in(dir, host, &token_file);
    let error =
        save_attention_offline(&["state", "done", "--pane"], &mut stdin(""), &host).unwrap_err();
    assert_eq!(error.to_string(), "--pane needs a value");
    assert!(offline_attention(&["state", "done", "--pane"], &mut stdin("")).is_err());
}
