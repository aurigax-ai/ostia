#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::{
    AttentionState, LifecycleEvent, NotificationEntry, NotificationKind, NotificationPost,
    WorkspaceLiveState, notification_kind_of,
};
use serde_json::{Value, json, to_string, to_value};

#[test]
fn keeps_each_known_notification_kind() {
    for kind in ["waiting", "approval", "done", "error", "message"] {
        let read = notification_kind_of(&json!(kind));
        assert_eq!(to_value(read).unwrap(), json!(kind), "kind {kind}");
    }
}

#[test]
fn reads_an_unknown_or_non_string_kind_as_message() {
    let rows: [Value; 11] = [
        json!("Done"),
        json!("done "),
        json!(""),
        json!("info"),
        json!(null),
        json!(3),
        json!(true),
        json!(["done"]),
        json!({"kind": "done"}),
        json!(["waiting", "error"]),
        json!(1.5),
    ];
    for row in rows {
        assert_eq!(
            notification_kind_of(&row),
            NotificationKind::Message,
            "row {row}"
        );
    }
}

#[test]
fn writes_workspace_and_attention_states_as_lowercase_words() {
    let live = [
        (WorkspaceLiveState::Idle, "idle"),
        (WorkspaceLiveState::Working, "working"),
        (WorkspaceLiveState::Waiting, "waiting"),
        (WorkspaceLiveState::Done, "done"),
        (WorkspaceLiveState::Error, "error"),
    ];
    for (state, word) in live {
        assert_eq!(to_value(state).unwrap(), json!(word), "live {word}");
    }
    let attention = [
        (AttentionState::None, "none"),
        (AttentionState::Working, "working"),
        (AttentionState::Waiting, "waiting"),
        (AttentionState::Done, "done"),
        (AttentionState::Error, "error"),
    ];
    for (state, word) in attention {
        assert_eq!(to_value(state).unwrap(), json!(word), "attention {word}");
    }
}

#[test]
fn writes_a_notification_entry_in_ts_field_order_and_omits_absent_fields() {
    let bare = NotificationEntry {
        id: "n1".to_owned(),
        ts: "2026-01-01T00:00:00.000Z".to_owned(),
        kind: NotificationKind::Approval,
        title: "Allow?".to_owned(),
        body: None,
        from: "agent".to_owned(),
        pane_id: None,
        ext_id: None,
        panel_path: None,
    };
    assert_eq!(
        to_string(&bare).unwrap(),
        r#"{"id":"n1","ts":"2026-01-01T00:00:00.000Z","kind":"approval","title":"Allow?","from":"agent"}"#
    );
    let full = NotificationEntry {
        body: Some("run ls".to_owned()),
        pane_id: Some("p1".to_owned()),
        ext_id: Some("ext".to_owned()),
        panel_path: Some("panel/a".to_owned()),
        ..bare
    };
    assert_eq!(
        to_string(&full).unwrap(),
        r#"{"id":"n1","ts":"2026-01-01T00:00:00.000Z","kind":"approval","title":"Allow?","body":"run ls","from":"agent","paneId":"p1","extId":"ext","panelPath":"panel/a"}"#
    );
}

#[test]
fn writes_a_notification_post_with_camel_case_names_and_omits_an_absent_body() {
    let post = NotificationPost {
        pane_id: "p1".to_owned(),
        kind: NotificationKind::Done,
        title: "Finished".to_owned(),
        body: None,
        desktop: true,
    };
    assert_eq!(
        to_string(&post).unwrap(),
        r#"{"paneId":"p1","kind":"done","title":"Finished","desktop":true}"#
    );
    let with_body = NotificationPost {
        body: Some("all green".to_owned()),
        ..post
    };
    assert_eq!(
        to_string(&with_body).unwrap(),
        r#"{"paneId":"p1","kind":"done","title":"Finished","body":"all green","desktop":true}"#
    );
}

#[test]
fn writes_each_lifecycle_event_with_a_kebab_case_type_and_camel_case_fields() {
    let rows: Vec<(LifecycleEvent, Value)> = vec![
        (
            LifecycleEvent::PaneCreated {
                workspace_id: "w1".to_owned(),
                pane_id: "p1".to_owned(),
            },
            json!({"type": "pane-created", "workspaceId": "w1", "paneId": "p1"}),
        ),
        (
            LifecycleEvent::PaneClosed {
                workspace_id: "w1".to_owned(),
                pane_id: "p1".to_owned(),
            },
            json!({"type": "pane-closed", "workspaceId": "w1", "paneId": "p1"}),
        ),
        (
            LifecycleEvent::WorkspaceAdded {
                workspace_id: "w1".to_owned(),
                work_dir: "/work".to_owned(),
            },
            json!({"type": "workspace-added", "workspaceId": "w1", "workDir": "/work"}),
        ),
        (
            LifecycleEvent::WorkspaceClosed {
                workspace_id: "w1".to_owned(),
            },
            json!({"type": "workspace-closed", "workspaceId": "w1"}),
        ),
        (
            LifecycleEvent::WorkspaceActivated {
                workspace_id: "w1".to_owned(),
            },
            json!({"type": "workspace-activated", "workspaceId": "w1"}),
        ),
        (
            LifecycleEvent::WorkspaceState {
                workspace_id: "w1".to_owned(),
                state: WorkspaceLiveState::Working,
            },
            json!({"type": "workspace-state", "workspaceId": "w1", "state": "working"}),
        ),
    ];
    for (event, expected) in rows {
        assert_eq!(to_value(&event).unwrap(), expected, "row {expected}");
    }
}

#[test]
fn writes_a_pane_attention_event_and_omits_an_absent_message() {
    let bare = LifecycleEvent::PaneAttention {
        pane_id: "p1".to_owned(),
        state: AttentionState::Waiting,
        message: None,
    };
    assert_eq!(
        to_string(&bare).unwrap(),
        r#"{"type":"pane-attention","paneId":"p1","state":"waiting"}"#
    );
    let with_message = LifecycleEvent::PaneAttention {
        pane_id: "p1".to_owned(),
        state: AttentionState::None,
        message: Some("needs input".to_owned()),
    };
    assert_eq!(
        to_string(&with_message).unwrap(),
        r#"{"type":"pane-attention","paneId":"p1","state":"none","message":"needs input"}"#
    );
}
