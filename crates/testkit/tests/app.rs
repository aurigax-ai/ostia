#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use ostia_app::cap_filter;
use ostia_base::WorkspaceId;
use ostia_contract::capabilities::Capability;
use ostia_control::discovery::{control_info_path, read_control_socket};
use ostia_control::{AuthedConn, PaneIdentity};
use ostia_park::ParkInput;
use ostia_testkit::{TestApp, fixture_text};
use serde_json::json;

#[tokio::test]
async fn the_app_serves_whoami_on_its_own_socket_and_data_folder() {
    let test = TestApp::start().unwrap();
    assert!(test.app.socket.to_string_lossy().contains("ostia-rs-"));
    let mode = fs::metadata(&test.app.socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let identity = test.pane("w1", "s1", "p1");
    let client = test.client(&identity.token).await.unwrap();
    let who = client.request("whoami", None).await.unwrap();
    assert_eq!(who["paneId"], json!("p1"));
    let info = control_info_path(&test.host);
    assert!(info.to_string_lossy().contains("/ostia-rs/control.json"));
    assert_eq!(read_control_socket(&info), Some(test.app.socket.clone()));
}

#[tokio::test]
async fn stop_removes_the_socket_and_the_info_file() {
    let test = TestApp::start().unwrap();
    let info = control_info_path(&test.host);
    let socket = test.app.socket.clone();
    let TestApp {
        app, host: _host, ..
    } = test;
    app.stop();
    assert!(!socket.exists());
    assert!(!info.exists());
}

#[tokio::test]
async fn the_activity_extension_lists_and_forgets_parked_sessions_over_the_socket() {
    let test = TestApp::start().unwrap();
    test.app
        .parked
        .park(ParkInput {
            workspace_id: WorkspaceId::new("w1"),
            resume: json!({"agent": "claude", "id": "s1", "cwd": "/home/u"}),
            title: "export".to_owned(),
            title_pinned: false,
            summary: None,
        })
        .unwrap();
    test.app
        .parked
        .park(ParkInput {
            workspace_id: WorkspaceId::new("w1"),
            resume: json!({"agent": "agy", "id": "s2"}),
            title: "hidden".to_owned(),
            title_pinned: false,
            summary: None,
        })
        .unwrap();
    let activity = test.app.registry.register_extension("activity");
    let client = test.client(&activity.token).await.unwrap();
    let list = json!({"workspaceId": "w1"});
    let listed = client.request("ext.parkedList", Some(&list)).await.unwrap();
    assert_eq!(listed["ok"], json!(true));
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["sessionId"], json!("s1"));
    assert_eq!(items[0]["folder"], json!("/home/u"));
    let id = items[0]["id"].clone();
    let forget = json!({"id": id});
    assert_eq!(
        client
            .request("ext.parkedForget", Some(&forget))
            .await
            .unwrap(),
        json!({"ok": true})
    );
    assert_eq!(
        client
            .request("ext.parkedForget", Some(&forget))
            .await
            .unwrap(),
        json!({"ok": false, "error": "unknown-parked"})
    );
    assert_eq!(
        client
            .request("ext.parkedList", Some(&json!({})))
            .await
            .unwrap(),
        json!({"ok": false, "error": "invalid-params"})
    );
}

#[tokio::test]
async fn another_extension_gets_the_activity_only_answer() {
    let test = TestApp::start().unwrap();
    let other = test.app.registry.register_extension("other");
    let client = test.client(&other.token).await.unwrap();
    let answer = client
        .request("ext.parkedList", Some(&json!({"workspaceId": "w1"})))
        .await
        .unwrap();
    assert_eq!(answer, json!({"ok": false, "error": "activity-only"}));
}

#[test]
fn a_ts_fixture_is_readable_from_a_rust_test() {
    assert!(fixture_text("ports/net-tcp.txt").unwrap().contains("sl"));
}

#[tokio::test]
async fn a_sandboxed_workspace_cannot_use_all_workspaces_until_its_setting_is_ported() {
    let test = TestApp::start().unwrap();
    let inside = test.pane("w1", "s1", "p1");
    let outside = test.pane("w1", "s2", "p2");
    test.app.sandboxes.enable(WorkspaceId::new("s1"));
    let filter = cap_filter(test.app.registry.clone(), test.app.sandboxes.clone());
    let conn = |identity: &PaneIdentity| AuthedConn {
        external_id: identity.external_id.clone(),
        pane_id: identity.pane_id.clone(),
        workspace_id: identity.workspace_id.clone(),
        script_session: None,
    };
    assert!(!filter(&conn(&inside), Capability::AllWorkspaces));
    assert!(filter(&conn(&inside), Capability::ReadBoard));
    assert!(filter(&conn(&outside), Capability::AllWorkspaces));
}
