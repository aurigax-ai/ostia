#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_agents::origin_agents::{
    OriginRules, REFERENCE_NOTE_MAX, REFERENCE_TEXT_MAX, ReferenceRelay, WindowReports,
    origin_agent_owner, origin_agents, parse_reference_request, reaches_target, summary_of,
    workspace_of_pane,
};
use ostia_contract::windows_api::WindowWorkspaceReport;
use serde_json::{Value, json};

const MAIN: &str = "win-main";
const DETACHED: &str = "win-detached";
const OTHER: &str = "win-other";

fn workspace(id: &str, extra: Value) -> Value {
    let mut base = json!({
        "id": id,
        "name": id,
        "workDir": "/home/u/api",
        "state": "idle",
        "unreadAt": 0,
        "panes": []
    });
    for (key, value) in extra.as_object().unwrap() {
        base.as_object_mut()
            .unwrap()
            .insert(key.clone(), value.clone());
    }
    base
}

fn home_workspace() -> Value {
    workspace(
        "w-home",
        json!({
            "name": "api",
            "panes": [
                {"id": "agent-1", "title": "fix login", "agent": "claude", "state": "waiting", "cwd": "/home/u/api"},
                {"id": "shell-1", "title": "zsh"},
                {"id": "manager-1", "title": "manager", "agent": "other", "state": "working"}
            ]
        }),
    )
}

fn elsewhere_workspace() -> Value {
    workspace(
        "w-elsewhere",
        json!({"panes": [{"id": "agent-2", "title": "codex", "agent": "codex", "state": "working"}]}),
    )
}

fn moved_workspace() -> Value {
    workspace(
        "w-moved",
        json!({"origin": "w-home", "panes": [{"id": "browser-1", "title": "localhost"}]}),
    )
}

fn typed(value: Value) -> WindowWorkspaceReport {
    serde_json::from_value(value).unwrap()
}

fn reports(over: Vec<(&str, Vec<Value>)>) -> WindowReports {
    let mut table: Vec<(String, Vec<Value>)> = vec![
        (
            MAIN.to_owned(),
            vec![home_workspace(), elsewhere_workspace()],
        ),
        (DETACHED.to_owned(), vec![moved_workspace()]),
    ];
    for (key, list) in over {
        match table.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = list,
            None => table.push((key.to_owned(), list)),
        }
    }
    table
        .into_iter()
        .map(|(key, list)| (key, list.into_iter().map(typed).collect()))
        .collect()
}

type Check = Box<dyn Fn(&str) -> bool>;
type Owner = Box<dyn Fn(&str) -> Option<String>>;

struct Rules {
    sandboxed: Check,
    scratch: Check,
    owner: Owner,
}

impl OriginRules for Rules {
    fn is_sandboxed(&self, workspace_id: &str) -> bool {
        (self.sandboxed)(workspace_id)
    }

    fn is_scratch(&self, workspace_id: &str) -> bool {
        (self.scratch)(workspace_id)
    }

    fn is_manager_pane(&self, pane_id: &str) -> bool {
        pane_id == "manager-1"
    }

    fn owner_of_pane(&self, pane_id: &str) -> Option<String> {
        (self.owner)(pane_id)
    }
}

fn default_owner(pane_id: &str) -> Option<String> {
    match pane_id {
        "agent-1" | "shell-1" | "manager-1" | "agent-2" => Some(MAIN.to_owned()),
        "browser-1" => Some(DETACHED.to_owned()),
        _ => None,
    }
}

fn rules() -> Rules {
    Rules {
        sandboxed: Box::new(|_| false),
        scratch: Box::new(|_| false),
        owner: Box::new(default_owner),
    }
}

fn agent_1_owned_by(window: &'static str) -> Owner {
    Box::new(move |pane_id| {
        if pane_id == "agent-1" {
            Some(window.to_owned())
        } else {
            Some(MAIN.to_owned())
        }
    })
}

fn agents(
    reports: &WindowReports,
    rules: &Rules,
    window: &str,
    workspace_id: Value,
) -> Option<Value> {
    origin_agents(reports, rules, window, &workspace_id)
        .map(|found| serde_json::to_value(found).unwrap())
}

fn target_ids(found: &Value) -> Vec<String> {
    found["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| target["paneId"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn lists_only_the_agent_panes_of_the_workspace_the_callers_workspace_came_from() {
    assert_eq!(
        agents(&reports(vec![]), &rules(), DETACHED, json!("w-moved")),
        Some(json!({
            "workspaceId": "w-home",
            "workspaceName": "api",
            "targets": [{
                "paneId": "agent-1",
                "title": "fix login",
                "agent": "claude",
                "state": "waiting",
                "cwd": "/home/u/api"
            }]
        }))
    );
}

#[test]
fn answers_nothing_for_a_workspace_the_callers_window_does_not_hold() {
    let all = reports(vec![]);
    assert_eq!(agents(&all, &rules(), OTHER, json!("w-moved")), None);
    assert_eq!(agents(&all, &rules(), MAIN, json!("w-moved")), None);
    assert_eq!(agents(&all, &rules(), DETACHED, json!("w-home")), None);
}

#[test]
fn answers_nothing_for_a_workspace_without_an_origin_or_whose_origin_is_itself() {
    let whole = workspace("w-whole", json!({"origin": "w-whole"}));
    let all = reports(vec![(
        DETACHED,
        vec![whole, workspace("w-plain", json!({}))],
    )]);
    assert_eq!(agents(&all, &rules(), DETACHED, json!("w-whole")), None);
    assert_eq!(agents(&all, &rules(), DETACHED, json!("w-plain")), None);
    assert_eq!(agents(&all, &rules(), DETACHED, json!(42)), None);
}

#[test]
fn answers_nothing_once_the_origin_workspace_is_closed() {
    let all = reports(vec![(MAIN, vec![elsewhere_workspace()])]);
    assert_eq!(agents(&all, &rules(), DETACHED, json!("w-moved")), None);
}

#[test]
fn answers_nothing_when_either_side_is_sandboxed_or_scratch() {
    let all = reports(vec![]);
    for id in ["w-home", "w-moved"] {
        let sandboxed = Rules {
            sandboxed: Box::new(move |w| w == id),
            ..rules()
        };
        let scratch = Rules {
            scratch: Box::new(move |w| w == id),
            ..rules()
        };
        assert_eq!(
            agents(&all, &sandboxed, DETACHED, json!("w-moved")),
            None,
            "sandboxed {id}"
        );
        assert_eq!(
            agents(&all, &scratch, DETACHED, json!("w-moved")),
            None,
            "scratch {id}"
        );
    }
}

#[test]
fn finds_the_origin_workspace_in_whichever_other_window_holds_it() {
    let all = reports(vec![
        (MAIN, vec![elsewhere_workspace()]),
        (OTHER, vec![home_workspace()]),
    ]);
    let owners = Rules {
        owner: agent_1_owned_by(OTHER),
        ..rules()
    };
    let found = agents(&all, &owners, DETACHED, json!("w-moved")).unwrap();
    assert_eq!(target_ids(&found), vec!["agent-1".to_owned()]);
    assert_eq!(
        origin_agent_owner(&all, &owners, DETACHED, "w-moved", "agent-1"),
        Some(OTHER.to_owned())
    );
}

#[test]
fn drops_a_pane_the_reporting_window_does_not_own() {
    let forged = Rules {
        owner: agent_1_owned_by(OTHER),
        ..rules()
    };
    let found = agents(&reports(vec![]), &forged, DETACHED, json!("w-moved")).unwrap();
    assert_eq!(found["targets"], json!([]));
}

#[test]
fn names_the_window_that_owns_an_agent_pane_of_the_origin_workspace() {
    assert_eq!(
        origin_agent_owner(&reports(vec![]), &rules(), DETACHED, "w-moved", "agent-1"),
        Some(MAIN.to_owned())
    );
}

#[test]
fn refuses_a_plain_shell_the_manager_pane_and_a_pane_of_another_workspace() {
    for pane_id in ["shell-1", "manager-1", "agent-2", "ghost"] {
        assert_eq!(
            origin_agent_owner(&reports(vec![]), &rules(), DETACHED, "w-moved", pane_id),
            None,
            "{pane_id}"
        );
    }
}

#[test]
fn refuses_a_sender_that_does_not_hold_the_workspace_it_names() {
    let all = reports(vec![]);
    assert_eq!(
        origin_agent_owner(&all, &rules(), OTHER, "w-moved", "agent-1"),
        None
    );
    assert_eq!(
        origin_agent_owner(&all, &rules(), DETACHED, "w-elsewhere", "agent-2"),
        None
    );
}

#[test]
fn reaches_a_pane_of_the_senders_own_window() {
    assert!(reaches_target(
        &reports(vec![]),
        &rules(),
        MAIN,
        "shell-1",
        "agent-2"
    ));
}

#[test]
fn reaches_an_agent_of_the_origin_workspace_from_a_pane_that_left_it() {
    assert!(reaches_target(
        &reports(vec![]),
        &rules(),
        DETACHED,
        "browser-1",
        "agent-1"
    ));
}

#[test]
fn refuses_another_windows_pane_outside_the_origin_workspace_and_plain_shells_in_it() {
    let all = reports(vec![]);
    assert!(!reaches_target(
        &all,
        &rules(),
        DETACHED,
        "browser-1",
        "agent-2"
    ));
    assert!(!reaches_target(
        &all,
        &rules(),
        DETACHED,
        "browser-1",
        "shell-1"
    ));
}

#[test]
fn refuses_a_source_pane_the_sender_does_not_own_or_has_not_reported() {
    assert!(!reaches_target(
        &reports(vec![]),
        &rules(),
        OTHER,
        "browser-1",
        "agent-1"
    ));
    assert!(!reaches_target(
        &reports(vec![(DETACHED, vec![])]),
        &rules(),
        DETACHED,
        "browser-1",
        "agent-1"
    ));
    assert_eq!(workspace_of_pane(&reports(vec![]), MAIN, "browser-1"), None);
}

#[test]
fn refuses_the_origins_agents_to_a_sandboxed_sender() {
    let sandboxed = Rules {
        sandboxed: Box::new(|w| w == "w-moved"),
        ..rules()
    };
    assert!(!reaches_target(
        &reports(vec![]),
        &sandboxed,
        DETACHED,
        "browser-1",
        "agent-1"
    ));
}

#[test]
fn summary_of_keeps_agents_states_folders_and_the_origin_out_of_the_list_every_window_gets() {
    let mut with_origin = home_workspace();
    with_origin["origin"] = json!("w-x");
    let summary = serde_json::to_value(summary_of(&typed(with_origin))).unwrap();
    assert_eq!(
        summary,
        json!({
            "id": "w-home",
            "name": "api",
            "workDir": "/home/u/api",
            "state": "idle",
            "unreadAt": 0,
            "panes": [
                {"id": "agent-1", "title": "fix login"},
                {"id": "shell-1", "title": "zsh"},
                {"id": "manager-1", "title": "manager"}
            ]
        })
    );
}

fn parsed(raw: Value) -> Option<Value> {
    parse_reference_request(&raw).map(|request| serde_json::to_value(request).unwrap())
}

#[test]
fn keeps_the_workspace_pane_and_text_and_clips_the_note_to_one_short_line() {
    let note = format!("  look\n at   this {}", "x".repeat(200));
    let request = parsed(json!({
        "workspaceId": "w-moved",
        "paneId": "agent-1",
        "text": "@/tmp/ostia-reports-1/capture-1.md ",
        "note": note,
        "extra": true
    }))
    .unwrap();
    let clipped = request["note"].as_str().unwrap().to_owned();
    assert_eq!(clipped.chars().count(), REFERENCE_NOTE_MAX);
    assert!(clipped.starts_with("look at this x"));
    assert_eq!(
        request,
        json!({
            "workspaceId": "w-moved",
            "paneId": "agent-1",
            "text": "@/tmp/ostia-reports-1/capture-1.md ",
            "note": clipped
        })
    );
}

#[test]
fn refuses_a_request_without_ids_or_text_or_with_text_past_the_cap() {
    let base = json!({"workspaceId": "w-moved", "paneId": "agent-1", "text": "hi"});
    let with = |key: &str, value: Value| {
        let mut changed = base.clone();
        changed[key] = value;
        changed
    };
    assert_eq!(parsed(Value::Null), None);
    assert_eq!(parsed(with("workspaceId", json!(""))), None);
    assert_eq!(parsed(with("paneId", json!(7))), None);
    assert_eq!(parsed(with("text", json!(""))), None);
    assert_eq!(
        parsed(with("text", json!("x".repeat(REFERENCE_TEXT_MAX + 1)))),
        None
    );
    assert_eq!(parsed(base.clone()), Some(base));
}

#[test]
fn drops_any_flag_that_would_submit_the_reference() {
    let base = json!({"workspaceId": "w-moved", "paneId": "agent-1", "text": "hi"});
    let mut flagged = base.clone();
    flagged["pointedByHuman"] = json!(true);
    flagged["enter"] = json!(true);
    assert_eq!(parsed(flagged), Some(base));
}

type Sent = Arc<Mutex<Vec<(String, Value)>>>;

fn relay_with(reply: Duration, accept: bool) -> (ReferenceRelay, Sent) {
    let sent: Sent = Arc::default();
    let log = Arc::clone(&sent);
    let relay = ReferenceRelay::new(
        move |window_id: &str, insert| {
            log.lock()
                .unwrap()
                .push((window_id.to_owned(), serde_json::to_value(insert).unwrap()));
            accept
        },
        reply,
    );
    (relay, sent)
}

fn relay() -> (ReferenceRelay, Sent) {
    relay_with(Duration::from_millis(1000), true)
}

fn request() -> ostia_contract::windows_api::OriginReferenceRequest {
    parse_reference_request(&json!({
        "workspaceId": "w-moved",
        "paneId": "agent-1",
        "text": "@/tmp/r.md ",
        "note": "look"
    }))
    .unwrap()
}

fn request_id(sent: &Sent) -> Value {
    sent.lock().unwrap()[0].1["requestId"].clone()
}

#[tokio::test(start_paused = true)]
async fn sends_the_insert_only_to_the_owning_window_and_resolves_with_its_answer() {
    let (relay, sent) = relay();
    let result = relay.forward(MAIN, request());
    assert_eq!(sent.lock().unwrap().len(), 1);
    {
        let log = sent.lock().unwrap();
        assert_eq!(log[0].0, MAIN);
        assert_eq!(log[0].1["paneId"], "agent-1");
        assert_eq!(log[0].1["text"], "@/tmp/r.md ");
        assert_eq!(log[0].1["note"], "look");
        assert!(log[0].1.get("workspaceId").is_none());
    }
    relay.answer(MAIN, &request_id(&sent), &json!(true));
    assert!(result.await);
}

#[tokio::test(start_paused = true)]
async fn hands_the_owning_window_the_pane_text_and_note_only_nothing_that_submits() {
    let (relay, sent) = relay();
    let _pending = relay.forward(MAIN, request());
    let insert = sent.lock().unwrap()[0].1.clone();
    assert_eq!(
        insert,
        json!({
            "requestId": insert["requestId"],
            "paneId": "agent-1",
            "text": "@/tmp/r.md ",
            "note": "look"
        })
    );
}

#[tokio::test(start_paused = true)]
async fn ignores_an_answer_from_a_window_that_was_not_asked() {
    let (relay, sent) = relay();
    let result = relay.forward(MAIN, request());
    let id = request_id(&sent);
    relay.answer(DETACHED, &id, &json!(true));
    relay.answer(MAIN, &json!("reference-nope"), &json!(true));
    relay.answer(MAIN, &id, &json!(false));
    assert!(!result.await);
}

#[tokio::test(start_paused = true)]
async fn answers_not_inserted_when_the_owner_never_replies_is_gone_or_closes() {
    let (relay, _sent) = relay();
    let silent = relay.forward(MAIN, request());
    tokio::time::advance(Duration::from_millis(1000)).await;
    assert!(!silent.await);

    let closing = relay.forward(MAIN, request());
    relay.window_closed(MAIN);
    assert!(!closing.await);

    let (gone, _) = relay_with(Duration::from_millis(1000), false);
    assert!(!gone.forward(MAIN, request()).await);
}

#[tokio::test(start_paused = true)]
async fn takes_only_the_first_answer_to_a_request() {
    let (relay, sent) = relay();
    let result = relay.forward(MAIN, request());
    let id = request_id(&sent);
    relay.answer(MAIN, &id, &json!(false));
    relay.answer(MAIN, &id, &json!(true));
    assert!(!result.await);
}
