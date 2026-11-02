#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::pty_api::{
    HumanInputSource, KeptLink, PaneActivity, PtyAttachResult, PtyRole, PtySpawnOptions,
    ShellHistoryEntry,
};
use serde_json::json;

#[test]
fn attach_result_carries_a_cursor_and_dropped_flag_opts_allow_a_role() {
    let r: PtyAttachResult = serde_json::from_value(json!({
        "created": true, "buffer": "", "cursor": 0, "dropped": false
    }))
    .unwrap();
    let o: PtySpawnOptions = serde_json::from_value(json!({
        "cols": 80, "rows": 24, "role": "observer", "sinceCursor": 5
    }))
    .unwrap();
    assert_eq!(r.cursor, 0);
    assert_eq!(o.role, Some(PtyRole::Observer));
    assert_eq!(o.since_cursor, Some(5));
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({"created": true, "buffer": "", "cursor": 0, "dropped": false})
    );
}

#[test]
fn spawn_options_leave_out_what_is_unset_and_read_every_field() {
    let minimal: PtySpawnOptions = serde_json::from_value(json!({"cols": 80, "rows": 24})).unwrap();
    assert_eq!(minimal.role, None);
    assert_eq!(
        serde_json::to_value(&minimal).unwrap(),
        json!({"cols": 80, "rows": 24})
    );
    let full = json!({
        "cwd": "/tmp", "cols": 120, "rows": 40, "role": "owner", "sinceCursor": 9,
        "ostiaPrompt": {"separator": "none", "sameLine": true},
        "workspaceId": "w1", "hostToken": "t", "attachOnly": true
    });
    let parsed: PtySpawnOptions = serde_json::from_value(full.clone()).unwrap();
    assert_eq!(parsed.role, Some(PtyRole::Owner));
    assert_eq!(serde_json::to_value(&parsed).unwrap(), full);
}

#[test]
fn refuses_a_role_that_is_not_owner_or_observer() {
    let bad =
        serde_json::from_value::<PtySpawnOptions>(json!({"cols": 80, "rows": 24, "role": "admin"}));
    assert!(bad.is_err());
}

#[test]
fn attach_result_reads_every_optional_field_and_keeps_its_order() {
    let full = json!({
        "created": false, "buffer": "x", "cursor": 12, "dropped": true,
        "blockSeqBase": 3, "shell": "/bin/zsh", "sandboxed": true, "sandboxStamp": "s",
        "host": false, "cols": 80, "rows": 24, "held": true, "kept": true,
        "link": "reconnecting", "reattached": true, "agentRunning": false,
        "cwdMissing": true, "markNonce": "n"
    });
    let parsed: PtyAttachResult = serde_json::from_value(full.clone()).unwrap();
    assert_eq!(
        serde_json::to_string(&parsed).unwrap(),
        serde_json::to_string(&full).unwrap()
    );
}

#[test]
fn attach_result_refuses_an_up_link_and_a_held_false() {
    let base = json!({"created": true, "buffer": "", "cursor": 0, "dropped": false});
    for (field, value) in [("link", json!("up")), ("held", json!(false))] {
        let mut raw = base.clone();
        raw[field] = value.clone();
        assert!(
            serde_json::from_value::<PtyAttachResult>(raw).is_err(),
            "{field}: {value}"
        );
    }
}

#[test]
fn names_the_input_source_and_the_link_states_as_strings() {
    assert_eq!(
        serde_json::to_value(HumanInputSource::Key).unwrap(),
        json!("key")
    );
    assert_eq!(
        serde_json::to_value(HumanInputSource::Paste).unwrap(),
        json!("paste")
    );
    assert_eq!(serde_json::to_value(KeptLink::Up).unwrap(), json!("up"));
    assert_eq!(
        serde_json::to_value(KeptLink::Reconnecting).unwrap(),
        json!("reconnecting")
    );
    assert_eq!(
        serde_json::to_value(KeptLink::Failed).unwrap(),
        json!("failed")
    );
}

#[test]
fn writes_pane_activity_and_a_history_entry_with_null_fields() {
    let activity = PaneActivity {
        program: None,
        agent_running: false,
    };
    assert_eq!(
        serde_json::to_value(&activity).unwrap(),
        json!({"program": null, "agentRunning": false})
    );
    let entry = ShellHistoryEntry {
        command: "ls".to_owned(),
        time: None,
    };
    assert_eq!(
        serde_json::to_value(&entry).unwrap(),
        json!({"command": "ls", "time": null})
    );
}
