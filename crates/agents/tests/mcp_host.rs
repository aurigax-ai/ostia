#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ostia_agents::mcp_host::{
    McpExtensionOutput, McpHost, McpHostDeps, format_call_result, server_secrets, set_mcp_secret,
};
use ostia_contract::chat_tools::{
    ChatToolSettings, McpServerSettings, McpServerState, McpServerStatus, parse_mcp_server,
};
use ostia_testkit::repo_root;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

type Secrets = Arc<Mutex<BTreeMap<String, String>>>;
type Servers = Arc<Mutex<Vec<McpServerSettings>>>;
type Updates = Arc<Mutex<Vec<Vec<McpServerStatus>>>>;

fn node() -> String {
    let path = std::env::var_os("PATH").unwrap();
    std::env::split_paths(&path)
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn fake_server_path() -> PathBuf {
    repo_root().join("test/fixtures/mcp/fake-server.mjs")
}

fn server(overrides: Value) -> McpServerSettings {
    let mut raw = json!({
        "name": "fake",
        "enabled": true,
        "command": [node(), fake_server_path().to_string_lossy()],
        "env": {},
        "secrets": [],
        "disabledTools": [],
    });
    for (key, value) in overrides.as_object().unwrap() {
        raw[key] = value.clone();
    }
    parse_mcp_server(&raw).unwrap()
}

fn secret_key(server: &str, key: &str) -> String {
    format!("{server}/{key}")
}

struct Rig {
    host: McpHost,
    servers: Servers,
    secrets: Secrets,
    updates: Updates,
}

impl Rig {
    fn set_servers(&self, next: Vec<McpServerSettings>) {
        *self.servers.lock() = next;
    }
}

fn start_with(initial: Vec<McpServerSettings>, secrets: Secrets) -> Rig {
    let servers: Servers = Arc::new(Mutex::new(initial));
    let updates: Updates = Arc::new(Mutex::new(Vec::new()));
    let listed = Arc::clone(&servers);
    let looked_up = Arc::clone(&secrets);
    let seen = Arc::clone(&updates);
    let mut deps = McpHostDeps::new(
        move || listed.lock().clone(),
        move |server, key| looked_up.lock().get(&secret_key(server, key)).cloned(),
        move |status| seen.lock().push(status),
    );
    deps.connect_timeout = Duration::from_secs(10);
    Rig {
        host: McpHost::new(deps),
        servers,
        secrets,
        updates,
    }
}

fn start(initial: Vec<McpServerSettings>) -> Rig {
    start_with(initial, Secrets::default())
}

async fn wait_for(host: &McpHost, name: &str, state: McpServerState) -> McpServerStatus {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let status = host.status().into_iter().find(|s| s.name == name);
        if let Some(status) = &status
            && status.state == state
        {
            return status.clone();
        }
        assert!(
            Instant::now() < deadline,
            "timed out; last {:?}",
            status.map(|s| (s.state, s.error))
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn tool_names(status: &McpServerStatus) -> Vec<&str> {
    status.tools.iter().map(|t| t.name.as_str()).collect()
}

async fn ready(rig: &Rig) {
    rig.host.refresh();
    wait_for(&rig.host, "fake", McpServerState::Ready).await;
}

#[tokio::test]
async fn stays_idle_until_refreshed_then_connects_and_lists_the_tools() {
    let rig = start(vec![server(json!({}))]);
    assert_eq!(rig.host.status()[0].state, McpServerState::Idle);
    rig.host.refresh();
    let ready = wait_for(&rig.host, "fake", McpServerState::Ready).await;
    assert_eq!(
        tool_names(&ready),
        vec!["echo", "env", "fail", "slow", "exit"]
    );
    assert_eq!(ready.tools[0].input_schema["type"], json!("object"));
    rig.host.close_all();
}

#[tokio::test]
async fn calls_a_tool_reports_a_tool_error_and_refuses_a_tool_the_human_turned_off() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    assert_eq!(
        rig.host
            .call(
                &json!("c1"),
                &json!("fake"),
                &json!("echo"),
                &json!({"text": "hi"})
            )
            .await,
        Ok("echo: hi".to_owned())
    );
    assert_eq!(
        rig.host
            .call(&json!("c2"), &json!("fake"), &json!("fail"), &json!({}))
            .await,
        Err("boom".to_owned())
    );
    rig.set_servers(vec![server(json!({"disabledTools": ["echo"]}))]);
    assert!(
        rig.host
            .call(
                &json!("c3"),
                &json!("fake"),
                &json!("echo"),
                &json!({"text": "hi"})
            )
            .await
            .is_err()
    );
    assert!(
        rig.host
            .call(&json!("bad id!"), &json!("fake"), &json!("env"), &json!({}))
            .await
            .is_err()
    );
    rig.host.close_all();
}

#[tokio::test]
async fn gives_the_server_only_its_env_and_secrets_not_the_parent_environment() {
    let secrets = Secrets::default();
    secrets
        .lock()
        .insert(secret_key("fake", "API_TOKEN"), "s3cret".to_owned());
    let rig = start_with(
        vec![server(
            json!({"env": {"PLAIN": "visible"}, "secrets": ["API_TOKEN"]}),
        )],
        secrets,
    );
    ready(&rig).await;
    for (id, name, expected) in [
        ("e1", "PLAIN", "visible"),
        ("e2", "API_TOKEN", "s3cret"),
        ("e3", "PATH", "(unset)"),
        ("e4", "HOME", "(unset)"),
    ] {
        assert_eq!(
            rig.host
                .call(
                    &json!(id),
                    &json!("fake"),
                    &json!("env"),
                    &json!({"name": name})
                )
                .await,
            Ok(expected.to_owned()),
            "{name}"
        );
    }
    assert_eq!(rig.host.status()[0].secrets_set, vec!["API_TOKEN"]);
    rig.host.close_all();
}

#[tokio::test]
async fn cancels_an_in_flight_call() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    let host = rig.host.clone();
    let pending = tokio::spawn(async move {
        host.call(
            &json!("slow1"),
            &json!("fake"),
            &json!("slow"),
            &json!({"ms": 5000}),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    rig.host.cancel(&json!("slow1"));
    assert_eq!(pending.await.unwrap(), Err("cancelled".to_owned()));
    rig.host.close_all();
}

#[tokio::test]
async fn shows_an_error_when_the_server_exits_or_cannot_start() {
    let rig = start(vec![
        server(json!({})),
        server(json!({"name": "missing", "command": ["/nonexistent/ostia-mcp-server"]})),
    ]);
    rig.host.refresh();
    wait_for(&rig.host, "fake", McpServerState::Ready).await;
    let missing = wait_for(&rig.host, "missing", McpServerState::Error).await;
    assert!(missing.error.is_some_and(|text| !text.is_empty()));
    let host = rig.host.clone();
    let exit = tokio::spawn(async move {
        host.call(&json!("x1"), &json!("fake"), &json!("exit"), &json!({}))
            .await
    });
    let exited = wait_for(&rig.host, "fake", McpServerState::Error).await;
    assert!(exited.error.is_some_and(|text| !text.is_empty()));
    let _ = exit.await;
    rig.host.close_all();
}

#[tokio::test]
async fn drops_a_server_the_human_turned_off() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    rig.set_servers(vec![server(json!({"enabled": false}))]);
    let status = rig.host.refresh();
    assert_eq!(status[0].state, McpServerState::Off);
    assert!(status[0].tools.is_empty());
    assert!(
        rig.host
            .call(
                &json!("o1"),
                &json!("fake"),
                &json!("echo"),
                &json!({"text": "x"})
            )
            .await
            .is_err()
    );
}

struct SecretRig {
    settings: ChatToolSettings,
    host: McpHost,
    store: Arc<Mutex<BTreeMap<String, String>>>,
}

fn secret_rig() -> SecretRig {
    let configured = server(json!({"secrets": ["TOKEN"]}));
    let rig = start(vec![configured.clone()]);
    SecretRig {
        settings: ChatToolSettings {
            mcp_servers: vec![configured],
            skill_folders: Vec::new(),
        },
        host: rig.host,
        store: rig.secrets,
    }
}

fn store_secret(rig: &SecretRig, server: Value, key: Value, value: Value) -> Result<(), String> {
    let store = Arc::clone(&rig.store);
    set_mcp_secret(
        &rig.settings,
        &rig.host,
        move |namespace, name, value| {
            let mut data = store.lock();
            match value {
                Some(text) => data.insert(secret_key(namespace, name), text.to_owned()),
                None => data.remove(&secret_key(namespace, name)),
            };
            Ok(())
        },
        &server,
        &key,
        &value,
    )
}

#[tokio::test]
async fn stores_only_secrets_the_human_declared_on_a_configured_server() {
    let rig = secret_rig();
    assert_eq!(
        store_secret(&rig, json!("fake"), json!("TOKEN"), json!("v")),
        Ok(())
    );
    assert_eq!(
        rig.store.lock().get(&secret_key("fake", "TOKEN")),
        Some(&"v".to_owned())
    );
    assert!(store_secret(&rig, json!("fake"), json!("OTHER"), json!("v")).is_err());
    assert!(store_secret(&rig, json!("nope"), json!("TOKEN"), json!("v")).is_err());
    assert!(store_secret(&rig, json!("fake"), json!("__proto__"), json!("v")).is_err());
    assert_eq!(
        store_secret(&rig, json!("fake"), json!("TOKEN"), Value::Null),
        Ok(())
    );
    assert_eq!(rig.store.lock().get(&secret_key("fake", "TOKEN")), None);
    rig.host.close_all();
}

#[tokio::test]
async fn names_the_refusal_of_a_secret_that_cannot_be_stored() {
    let rig = secret_rig();
    let cases = [
        (json!("nope"), json!("TOKEN"), json!("v"), "unknown-server"),
        (json!(7), json!("TOKEN"), json!("v"), "unknown-server"),
        (json!("fake"), json!("OTHER"), json!("v"), "unknown-secret"),
        (json!("fake"), json!(5), json!("v"), "unknown-secret"),
        (json!("fake"), json!("TOKEN"), json!(5), "invalid-value"),
        (json!("fake"), json!("TOKEN"), json!(false), "invalid-value"),
    ];
    for (server, key, value, error) in cases {
        assert_eq!(
            store_secret(&rig, server.clone(), key.clone(), value.clone()),
            Err(error.to_owned()),
            "{server} {key} {value}"
        );
    }
    assert!(rig.store.lock().is_empty());
    rig.host.close_all();
}

#[tokio::test]
async fn passes_on_the_error_of_a_secret_store_that_refuses() {
    let rig = secret_rig();
    let result = set_mcp_secret(
        &rig.settings,
        &rig.host,
        |_, _, _| Err("encryption-unavailable".to_owned()),
        &json!("fake"),
        &json!("TOKEN"),
        &json!("v"),
    );
    assert_eq!(result, Err("encryption-unavailable".to_owned()));
    rig.host.close_all();
}

#[test]
fn joins_text_names_other_content_and_clips() {
    assert_eq!(
        format_call_result(&json!({
            "content": [
                {"type": "text", "text": "a"},
                {"type": "image", "data": "x", "mimeType": "image/png"},
            ]
        })),
        Ok("a\n[image omitted]".to_owned())
    );
    assert_eq!(
        format_call_result(&json!({"content": [], "structuredContent": {"n": 1}})),
        Ok("{\"n\":1}".to_owned())
    );
}

#[test]
fn formats_every_kind_of_content_item() {
    let cases = [
        (
            json!({"content": [{"type": "resource", "resource": {"uri": "file:///a", "text": "body"}}]}),
            Ok("body"),
        ),
        (
            json!({"content": [{"type": "resource", "resource": {"uri": "file:///a"}}]}),
            Ok("[resource file:///a]"),
        ),
        (
            json!({"content": [{"type": "resource", "resource": {}}]}),
            Ok("[resource ]"),
        ),
        (
            json!({"content": [{"type": "resource_link", "uri": "file:///b"}]}),
            Ok("[resource file:///b]"),
        ),
        (
            json!({"content": [{"type": "resource_link"}]}),
            Ok("[resource ]"),
        ),
        (
            json!({"content": [{"type": "audio", "data": "x"}]}),
            Ok("[audio omitted]"),
        ),
        (
            json!({"content": [{"type": "text", "text": 5}, "junk", null, {"type": 5}, {"type": "resource", "resource": "x"}]}),
            Ok(""),
        ),
        (
            json!({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}),
            Ok("a\nb"),
        ),
        (json!({"content": "nope"}), Ok("")),
        (json!({}), Ok("")),
        (json!(null), Ok("")),
        (json!("text"), Ok("")),
        (json!({"toolResult": {"k": [1]}}), Ok("{\"k\":[1]}")),
        (
            json!({"structuredContent": {"a": 1}, "toolResult": 2}),
            Ok("{\"a\":1}"),
        ),
        (
            json!({"content": [{"type": "text", "text": "kept"}], "structuredContent": {"a": 1}}),
            Ok("kept"),
        ),
    ];
    for (raw, expected) in cases {
        assert_eq!(
            format_call_result(&raw),
            expected.map(str::to_owned).map_err(str::to_owned),
            "{raw}"
        );
    }
}

#[test]
fn turns_an_error_result_into_a_clipped_error() {
    assert_eq!(
        format_call_result(
            &json!({"isError": true, "content": [{"type": "text", "text": "boom"}]})
        ),
        Err("boom".to_owned())
    );
    assert_eq!(
        format_call_result(&json!({"isError": true, "content": []})),
        Err("failed".to_owned())
    );
    assert_eq!(
        format_call_result(&json!({"isError": "true", "content": [{"type": "text", "text": "x"}]})),
        Ok("x".to_owned())
    );
    let long = "e".repeat(5000);
    let Err(error) =
        format_call_result(&json!({"isError": true, "content": [{"type": "text", "text": long}]}))
    else {
        panic!("expected an error")
    };
    assert_eq!(error.len(), 1000);
}

#[test]
fn clips_the_output_at_the_tool_output_limit_in_utf16_units() {
    let long = "a".repeat(40_000);
    let Ok(output) = format_call_result(&json!({"content": [{"type": "text", "text": long}]}))
    else {
        panic!("expected output")
    };
    assert_eq!(output.len(), 32_000);
    let wide = "😀".repeat(20_000);
    let Ok(output) = format_call_result(&json!({"content": [{"type": "text", "text": wide}]}))
    else {
        panic!("expected output")
    };
    assert_eq!(output.chars().count(), 16_000);
}

#[test]
fn collects_only_the_secrets_that_are_set() {
    let settings = server(json!({"secrets": ["A", "B", "C"]}));
    let found = server_secrets(&settings, &|name, key| {
        assert_eq!(name, "fake");
        (key != "B").then(|| format!("v-{key}"))
    });
    assert_eq!(
        found,
        BTreeMap::from([
            ("A".to_owned(), "v-A".to_owned()),
            ("C".to_owned(), "v-C".to_owned()),
        ])
    );
    let empty = server_secrets(&server(json!({})), &|_, _| Some("x".to_owned()));
    assert!(empty.is_empty());
}

#[tokio::test]
async fn tells_the_listener_each_change_of_state() {
    let rig = start(vec![server(json!({}))]);
    rig.host.refresh();
    wait_for(&rig.host, "fake", McpServerState::Ready).await;
    let updates = rig.updates.lock().clone();
    assert_eq!(
        updates.first().unwrap()[0].state,
        McpServerState::Connecting
    );
    assert_eq!(updates.last().unwrap()[0].state, McpServerState::Ready);
    let before = updates.len();
    rig.host.notify();
    assert_eq!(rig.updates.lock().len(), before + 1);
    rig.host.close_all();
}

#[tokio::test]
async fn reports_a_disabled_server_as_off_and_a_http_server_by_its_transport() {
    let rig = start(vec![
        server(json!({"enabled": false})),
        server(json!({"name": "web", "command": null, "url": "http://127.0.0.1:9/mcp"})),
    ]);
    let status = rig.host.status();
    assert_eq!(status[0].state, McpServerState::Off);
    assert_eq!(
        serde_json::to_value(status[1].transport).unwrap(),
        json!("http")
    );
    assert_eq!(status[1].state, McpServerState::Idle);
}

#[tokio::test]
async fn reconnects_a_server_when_a_secret_changes() {
    let rig = start(vec![server(json!({"secrets": ["API_TOKEN"]}))]);
    ready(&rig).await;
    rig.secrets
        .lock()
        .insert(secret_key("fake", "API_TOKEN"), "first".to_owned());
    rig.host.refresh();
    wait_for(&rig.host, "fake", McpServerState::Ready).await;
    assert_eq!(
        rig.host
            .call(
                &json!("r1"),
                &json!("fake"),
                &json!("env"),
                &json!({"name": "API_TOKEN"})
            )
            .await,
        Ok("first".to_owned())
    );
    rig.secrets
        .lock()
        .insert(secret_key("fake", "API_TOKEN"), "second".to_owned());
    rig.host.refresh();
    wait_for(&rig.host, "fake", McpServerState::Ready).await;
    assert_eq!(
        rig.host
            .call(
                &json!("r2"),
                &json!("fake"),
                &json!("env"),
                &json!({"name": "API_TOKEN"})
            )
            .await,
        Ok("second".to_owned())
    );
    rig.host.close_all();
}

#[tokio::test]
async fn reconnect_starts_a_fresh_connection() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    let status = rig.host.reconnect("fake");
    assert_eq!(status[0].state, McpServerState::Connecting);
    wait_for(&rig.host, "fake", McpServerState::Ready).await;
    rig.host.close_all();
}

#[tokio::test]
async fn refuses_a_call_with_a_bad_call_id_or_a_server_that_is_not_connected() {
    let rig = start(vec![server(json!({}))]);
    let cases = [
        (json!(5), json!("fake"), json!("echo"), "invalid call"),
        (json!(""), json!("fake"), json!("echo"), "invalid call"),
        (json!("a b"), json!("fake"), json!("echo"), "invalid call"),
        (
            json!("x".repeat(129)),
            json!("fake"),
            json!("echo"),
            "invalid call",
        ),
        (json!("ok"), json!(1), json!("echo"), "invalid call"),
        (json!("ok"), json!("fake"), json!(null), "invalid call"),
        (
            json!("ok"),
            json!("fake"),
            json!("echo"),
            "This MCP server is not connected.",
        ),
        (
            json!("ok"),
            json!("nope"),
            json!("echo"),
            "This MCP server is not connected.",
        ),
    ];
    for (id, server, tool, error) in cases {
        assert_eq!(
            rig.host.call(&id, &server, &tool, &json!({})).await,
            Err(error.to_owned()),
            "{id} {server} {tool}"
        );
    }
    ready(&rig).await;
    assert_eq!(
        rig.host
            .call(
                &json!("a-b_C9"),
                &json!("fake"),
                &json!("echo"),
                &json!({"text": "ok"})
            )
            .await,
        Ok("echo: ok".to_owned())
    );
    assert_eq!(
        rig.host
            .call(&json!("t1"), &json!("fake"), &json!("missing"), &json!({}))
            .await,
        Err("This MCP tool is turned off.".to_owned())
    );
    rig.host.close_all();
}

#[tokio::test]
async fn sends_empty_arguments_when_the_input_is_not_an_object() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    for input in [json!(null), json!("text"), json!([1]), json!(5)] {
        assert_eq!(
            rig.host
                .call(&json!("n1"), &json!("fake"), &json!("echo"), &input)
                .await,
            Ok("echo: ".to_owned()),
            "{input}"
        );
    }
    rig.host.close_all();
}

#[tokio::test]
async fn ends_a_call_that_takes_longer_than_the_call_timeout() {
    let servers: Servers = Arc::new(Mutex::new(vec![server(json!({}))]));
    let listed = Arc::clone(&servers);
    let mut deps = McpHostDeps::new(move || listed.lock().clone(), |_, _| None, |_| {});
    deps.connect_timeout = Duration::from_secs(10);
    deps.call_timeout = Duration::from_millis(300);
    let host = McpHost::new(deps);
    host.refresh();
    wait_for(&host, "fake", McpServerState::Ready).await;
    let result = host
        .call(
            &json!("s1"),
            &json!("fake"),
            &json!("slow"),
            &json!({"ms": 5000}),
        )
        .await;
    let Err(error) = result else {
        panic!("expected a timeout")
    };
    assert_ne!(error, "cancelled");
    assert!(!error.is_empty());
    assert!(error.len() <= 240);
    host.close_all();
}

#[tokio::test]
async fn cancel_ignores_an_unknown_call_and_a_value_that_is_not_text() {
    let rig = start(vec![server(json!({}))]);
    rig.host.cancel(&json!("nothing"));
    rig.host.cancel(&json!(5));
    rig.host.cancel(&Value::Null);
}

#[tokio::test]
async fn close_all_cancels_the_calls_and_drops_every_server() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    let host = rig.host.clone();
    let pending = tokio::spawn(async move {
        host.call(
            &json!("slow2"),
            &json!("fake"),
            &json!("slow"),
            &json!({"ms": 5000}),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    rig.host.close_all();
    assert_eq!(pending.await.unwrap(), Err("cancelled".to_owned()));
    assert_eq!(rig.host.status()[0].state, McpServerState::Idle);
}

#[tokio::test]
async fn tests_a_server_without_keeping_it_connected() {
    let rig = start(vec![
        server(json!({})),
        server(json!({"name": "missing", "command": ["/nonexistent/ostia-mcp-server"]})),
    ]);
    assert_eq!(rig.host.test(&json!("fake")).await, Ok(5));
    assert_eq!(rig.host.status()[0].state, McpServerState::Idle);
    assert_eq!(
        rig.host.test(&json!("nope")).await,
        Err("unknown-server".to_owned())
    );
    assert_eq!(
        rig.host.test(&json!(5)).await,
        Err("unknown-server".to_owned())
    );
    let Err(error) = rig.host.test(&json!("missing")).await else {
        panic!("expected a failure")
    };
    assert!(!error.is_empty());
    assert!(error.len() <= 240);
    assert!(!error.contains('\n'));
    assert_eq!(rig.host.status()[1].state, McpServerState::Idle);
}

#[tokio::test]
async fn lists_only_ready_servers_and_their_tools_that_are_turned_on_for_extensions() {
    let rig = start(vec![
        server(json!({"disabledTools": ["exit", "slow"]})),
        server(json!({"name": "off", "enabled": false})),
    ]);
    assert!(rig.host.servers_for_extensions().is_empty());
    ready(&rig).await;
    let listed = rig.host.servers_for_extensions();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "fake");
    assert_eq!(listed[0].state, McpServerState::Ready);
    assert_eq!(listed[0].tools, vec!["echo", "env", "fail"]);
    rig.host.close_all();
}

#[tokio::test]
async fn calls_a_tool_for_an_extension_and_keeps_the_structured_result() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    let plain = rig
        .host
        .call_for_extension(&json!("fake"), &json!("echo"), &json!({"text": "hi"}), None)
        .await;
    assert_eq!(
        plain,
        Ok(McpExtensionOutput {
            text: "echo: hi".to_owned(),
            structured: None
        })
    );
    let structured = rig
        .host
        .call_for_extension(
            &json!("fake"),
            &json!("echo"),
            &json!({"text": "hi", "structured": true}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(structured.text, "echo: hi");
    assert_eq!(
        structured.structured.map(Value::Object),
        Some(json!({"echoed": "hi"}))
    );
    assert_eq!(
        rig.host
            .call_for_extension(&json!("fake"), &json!("fail"), &json!({}), None)
            .await,
        Err("boom".to_owned())
    );
    rig.host.close_all();
}

#[tokio::test]
async fn refuses_an_extension_call_that_is_not_two_names() {
    let rig = start(vec![server(json!({}))]);
    for (server, tool) in [
        (json!(1), json!("echo")),
        (json!("fake"), json!(null)),
        (json!(null), json!(null)),
    ] {
        assert_eq!(
            rig.host
                .call_for_extension(&server, &tool, &json!({}), None)
                .await,
            Err("invalid call".to_owned()),
            "{server} {tool}"
        );
    }
}

#[tokio::test]
async fn connects_a_server_for_an_extension_call_that_arrives_first() {
    let rig = start(vec![server(json!({}))]);
    let output = rig
        .host
        .call_for_extension(
            &json!("fake"),
            &json!("echo"),
            &json!({"text": "first"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(output.text, "echo: first");
    rig.host.close_all();
}

#[tokio::test]
async fn refuses_an_extension_call_to_a_server_that_is_off_or_unknown() {
    let rig = start(vec![server(json!({"enabled": false}))]);
    for name in ["fake", "nope"] {
        assert_eq!(
            rig.host
                .call_for_extension(&json!(name), &json!("echo"), &json!({}), None)
                .await,
            Err("This MCP server is not connected.".to_owned()),
            "{name}"
        );
    }
}

#[tokio::test]
async fn cancels_an_extension_call_when_its_token_fires() {
    let rig = start(vec![server(json!({}))]);
    ready(&rig).await;
    let token = CancellationToken::new();
    let host = rig.host.clone();
    let signal = token.clone();
    let pending = tokio::spawn(async move {
        host.call_for_extension(
            &json!("fake"),
            &json!("slow"),
            &json!({"ms": 5000}),
            Some(signal),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    token.cancel();
    assert_eq!(pending.await.unwrap(), Err("cancelled".to_owned()));
    rig.host.close_all();
}
