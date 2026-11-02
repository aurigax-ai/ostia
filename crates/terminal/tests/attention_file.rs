#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use ostia_contract::attention::KeptAttentionState;
use ostia_terminal::attention_file::{
    SavedAttention, attention_file_for, parse_saved_attention, read_saved_attention,
    write_saved_attention,
};
use serde_json::json;
use tempfile::TempDir;

fn only(state: KeptAttentionState) -> Option<SavedAttention> {
    Some(SavedAttention {
        state,
        message: None,
    })
}

#[test]
fn ksh_c85_keeps_a_state_and_its_message_in_a_0600_file_beside_the_token_file() {
    let dir = TempDir::new().unwrap();
    let token = dir.path().join("token");
    let file = attention_file_for(token.to_str().unwrap());
    assert_eq!(file, dir.path().join("token.state"));
    let saved = SavedAttention {
        state: KeptAttentionState::Waiting,
        message: Some("Needs your permission to use Bash".to_owned()),
    };
    write_saved_attention(&file, Some(&saved)).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(read_saved_attention(&file), Some(saved));
    write_saved_attention(&file, None).unwrap();
    assert_eq!(read_saved_attention(&file), None);
}

#[test]
fn reads_nothing_from_a_missing_file_and_takes_only_a_known_state_and_a_short_message() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        read_saved_attention(&dir.path().join("missing.state")),
        None
    );
    assert_eq!(parse_saved_attention("not json"), None);
    assert_eq!(parse_saved_attention(r#"{"state":"none"}"#), None);
    assert_eq!(
        parse_saved_attention(r#"{"state":"owned","message":"x"}"#),
        None
    );
    assert_eq!(parse_saved_attention("[]"), None);
    assert_eq!(
        parse_saved_attention(&json!({ "state": "done", "message": 7, "extra": true }).to_string()),
        only(KeptAttentionState::Done)
    );
    assert_eq!(
        parse_saved_attention(&json!({ "state": "error", "message": "x".repeat(900) }).to_string()),
        Some(SavedAttention {
            state: KeptAttentionState::Error,
            message: Some("x".repeat(300)),
        })
    );
    let huge = dir.path().join("huge.state");
    fs::write(
        &huge,
        json!({ "state": "done", "message": "y".repeat(10_000) }).to_string(),
    )
    .unwrap();
    assert_eq!(read_saved_attention(&huge), None);
}
