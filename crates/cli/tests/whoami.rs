#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Stdio;

use ostia_contract::terminal_state::TerminalStateSnapshot;
use ostia_testkit::TestApp;
use serde_json::json;
use tokio::process::Command;

fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ostia"));
    command.env_clear().stdin(Stdio::null());
    command
}

#[tokio::test]
async fn whoami_prints_the_pane_and_its_terminal_state() {
    let test = TestApp::start().unwrap();
    let identity = test.pane("w1", "s1", "p1");
    test.app.terminal_states.push(TerminalStateSnapshot {
        pane_id: identity.pane_id.clone(),
        generation: 1,
        cwd: Some("/work".to_owned()),
        running: true,
        block_count: 0,
        last_exit_code: None,
        remote: None,
    });
    let out = cli()
        .arg("whoami")
        .env("OSTIA_SOCKET", &test.app.socket)
        .env("OSTIA_TOKEN", &identity.token)
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let printed = String::from_utf8(out.stdout).unwrap();
    let expected = json!({
        "externalId": identity.external_id,
        "paneId": "p1",
        "workspaceId": "s1",
        "cwd": "/work",
        "running": true
    });
    assert_eq!(printed.trim_end(), expected.to_string());
}

#[tokio::test]
async fn a_bad_token_fails_with_the_server_message() {
    let test = TestApp::start().unwrap();
    let out = cli()
        .arg("whoami")
        .env("OSTIA_SOCKET", &test.app.socket)
        .env("OSTIA_TOKEN", "bogus")
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("invalid or missing token"));
}

#[tokio::test]
async fn an_app_that_is_gone_is_reported() {
    let out = cli()
        .arg("whoami")
        .env("OSTIA_SOCKET", "/nonexistent/ostia.sock")
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim_end(),
        "ostia: app not reachable at /nonexistent/ostia.sock"
    );
}
