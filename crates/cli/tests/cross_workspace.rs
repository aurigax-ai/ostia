#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use futures_util::StreamExt;
use ostia_cli::common::cross_workspace::{
    CommandFlags, WorkspaceRow, build_command_call, parse_command_flags, pick_workspace,
    resolve_workspace_ref,
};
use ostia_rpc::{
    CONTROL_MESSAGE_MAX, Client, FrameCodec, Incoming, classify, encode_frame, parse_body,
    success_body,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio_util::codec::FramedRead;

fn row(workspace_id: &str, name: &str) -> WorkspaceRow {
    WorkspaceRow {
        workspace_id: workspace_id.to_owned(),
        name: name.to_owned(),
        custom_name: None,
    }
}

fn named(workspace_id: &str, name: &str, custom_name: &str) -> WorkspaceRow {
    WorkspaceRow {
        custom_name: Some(custom_name.to_owned()),
        ..row(workspace_id, name)
    }
}

fn rows() -> Vec<WorkspaceRow> {
    vec![
        row("w1", "main"),
        row("w2", "research"),
        row("w3", "dup"),
        row("w4", "dup"),
    ]
}

fn picked(rows: &[WorkspaceRow], reference: &str) -> String {
    pick_workspace(rows, reference).unwrap()
}

fn refusal(rows: &[WorkspaceRow], reference: &str) -> String {
    match pick_workspace(rows, reference) {
        Err(err) => err.to_string(),
        Ok(id) => panic!("expected a refusal for {reference:?}, got {id}"),
    }
}

fn flags(argv: &[&str]) -> CommandFlags {
    parse_command_flags(argv).unwrap()
}

fn flag_refusal(argv: &[&str]) -> String {
    match parse_command_flags(argv) {
        Err(err) => err.to_string(),
        Ok(parsed) => panic!("expected a refusal for {argv:?}, got {parsed:?}"),
    }
}

fn words(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn call(id: &str, parsed: &CommandFlags, workspace: Option<&str>) -> Value {
    build_command_call(id, parsed, workspace).unwrap()
}

#[test]
fn takes_an_id_as_is_and_a_name_that_only_one_workspace_has() {
    assert_eq!(picked(&rows(), "w2"), "w2");
    assert_eq!(picked(&rows(), "research"), "w2");
}

#[test]
fn prefers_an_id_over_a_workspace_that_happens_to_be_named_like_it() {
    let mut with_clash = rows();
    with_clash.push(row("w9", "w1"));
    assert_eq!(picked(&with_clash, "w1"), "w1");
}

#[test]
fn refuses_an_ambiguous_name_naming_the_ids_and_an_unknown_one() {
    assert!(
        refusal(&rows(), "dup").contains("matches 2 workspaces: w3 (dup), w4 (dup)"),
        "ambiguous name"
    );
    assert!(
        refusal(&rows(), "nope").contains("no workspace 'nope'"),
        "unknown name"
    );
}

fn shown_names() -> Vec<WorkspaceRow> {
    vec![
        row("wf-1", "home"),
        named("wf-2", "home", "W-one"),
        named("wf-3", "home", "W-two"),
        named("wf-4", "repo", "twin"),
        named("wf-5", "other", "twin"),
    ]
}

#[test]
fn finds_a_workspace_by_the_name_shown_in_the_rail() {
    assert_eq!(picked(&shown_names(), "W-two"), "wf-3");
    assert_eq!(picked(&shown_names(), "W-one"), "wf-2");
}

#[test]
fn matches_the_shown_name_before_the_folder_name() {
    assert_eq!(picked(&shown_names(), "home"), "wf-1");
}

#[test]
fn falls_back_to_the_folder_name_when_no_shown_name_matches() {
    assert_eq!(picked(&shown_names(), "repo"), "wf-4");
}

#[test]
fn lists_every_candidate_with_its_folder_when_the_shown_name_is_taken_twice() {
    assert_eq!(
        refusal(&shown_names(), "twin"),
        "workspace name 'twin' matches 2 workspaces: wf-4 (twin, folder repo), wf-5 (twin, folder other); pass the id"
    );
}

#[test]
fn pulls_workspace_two_spellings_out_and_keeps_the_rest_in_order() {
    assert_eq!(
        flags(&["{\"a\":1}", "--workspace", "w2"]),
        CommandFlags {
            workspace: Some("w2".to_owned()),
            rest: words(&["{\"a\":1}"]),
        }
    );
    assert_eq!(
        flags(&["--workspace=w2"]),
        CommandFlags {
            workspace: Some("w2".to_owned()),
            rest: Vec::new(),
        }
    );
    assert_eq!(
        flags(&[]),
        CommandFlags {
            workspace: None,
            rest: Vec::new(),
        }
    );
}

#[test]
fn refuses_workspace_without_a_value() {
    for argv in [&["--workspace"][..], &["--workspace="][..]] {
        assert!(
            flag_refusal(argv).contains("--workspace needs a value"),
            "{argv:?}"
        );
    }
}

#[test]
fn keeps_unknown_flags_in_the_rest() {
    assert_eq!(
        flags(&["--verbose", "{}", "--workspace", "w2", "--other=1"]).rest,
        words(&["--verbose", "{}", "--other=1"])
    );
}

#[test]
fn sends_no_target_and_no_args_for_a_bare_command() {
    assert_eq!(
        call("tab.new", &flags(&[]), None).to_string(),
        json!({"id": "tab.new"}).to_string()
    );
}

#[test]
fn targets_the_resolved_workspace_without_a_pane_so_the_app_picks_that_workspace_pane() {
    assert_eq!(
        call("tab.new", &flags(&["--workspace", "x"]), Some("w2")).to_string(),
        json!({"id": "tab.new", "target": {"workspaceId": "w2", "paneId": null}}).to_string()
    );
}

#[test]
fn sends_the_json_argument_before_the_target_in_that_key_order() {
    assert_eq!(
        call(
            "tab.new",
            &flags(&["{\"a\":1}", "--workspace", "x"]),
            Some("w2")
        )
        .to_string(),
        json!({"id": "tab.new", "args": {"a": 1}, "target": {"workspaceId": "w2", "paneId": null}})
            .to_string()
    );
}

#[test]
fn sends_a_json_null_argument_and_ignores_an_empty_one() {
    assert_eq!(
        call("tab.new", &flags(&["null"]), None).to_string(),
        json!({"id": "tab.new", "args": null}).to_string()
    );
    assert_eq!(
        call("tab.new", &flags(&[""]), None).to_string(),
        json!({"id": "tab.new"}).to_string()
    );
}

#[test]
fn refuses_an_argument_that_is_not_json() {
    assert!(build_command_call("tab.new", &flags(&["{oops"]), None).is_err());
}

#[test]
fn leaves_the_target_out_for_an_empty_resolved_workspace() {
    assert_eq!(
        call("tab.new", &flags(&[]), Some("")).to_string(),
        json!({"id": "tab.new"}).to_string()
    );
}

#[test]
fn treats_an_empty_shown_name_as_missing_and_uses_the_folder_name() {
    let rows = vec![named("w1", "home", ""), row("w2", "other")];
    assert_eq!(picked(&rows, "home"), "w1");
}

#[test]
fn names_the_folder_only_for_a_candidate_whose_shown_name_differs() {
    let rows = vec![
        named("a", "same", "same"),
        named("b", "folder", "shown"),
        row("c", "shown"),
        row("d", "shown"),
    ];
    assert_eq!(
        refusal(&rows, "shown"),
        "workspace name 'shown' matches 3 workspaces: b (shown, folder folder), c (shown), d (shown); pass the id"
    );
}

type Answers = Vec<Value>;

async fn answer(stream: UnixStream, rows: Answers) {
    let (read, mut write) = stream.into_split();
    let mut frames = FramedRead::new(read, FrameCodec::new(CONTROL_MESSAGE_MAX));
    while let Some(Ok(body)) = frames.next().await {
        let Ok(message) = parse_body(&body) else {
            break;
        };
        let Incoming::Request { id, method, .. } = classify(message) else {
            continue;
        };
        let result = if method == "workspace.list" {
            Value::Array(rows.clone())
        } else {
            Value::Null
        };
        if write
            .write_all(&encode_frame(&success_body(&id, result)))
            .await
            .is_err()
        {
            break;
        }
    }
}

async fn client_with(rows: Answers) -> (TempDir, Client) {
    let dir = TempDir::new().unwrap();
    let socket: PathBuf = dir.path().join("app.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(answer(stream, rows.clone()));
        }
    });
    let client = Client::connect(&socket).await.unwrap();
    (dir, client)
}

#[tokio::test]
async fn resolves_a_reference_against_the_workspace_list_the_app_returns() {
    let (_dir, client) = client_with(vec![
        json!({"workspaceId": "w1", "name": "main"}),
        json!({"workspaceId": "w2", "name": "home", "customName": "Research"}),
    ])
    .await;
    assert_eq!(
        resolve_workspace_ref(&client, "Research").await.unwrap(),
        "w2"
    );
    assert_eq!(resolve_workspace_ref(&client, "w1").await.unwrap(), "w1");
}

#[tokio::test]
async fn reports_an_unknown_reference_from_the_workspace_list_the_app_returns() {
    let (_dir, client) = client_with(vec![json!({"workspaceId": "w1", "name": "main"})]).await;
    let err = resolve_workspace_ref(&client, "nope").await.unwrap_err();
    assert!(
        err.to_string()
            .contains("no workspace 'nope' (see: ostia workspace list)"),
        "{err}"
    );
}
