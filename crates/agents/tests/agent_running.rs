#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_agents::agent_running::AgentRunningPanes;
use ostia_panes::pane_names::PaneNames;
use ostia_terminal::local_prompt::PromptOwner;
use ostia_workspaces::workspace_snapshot::model::AppSnapshot;
use ostia_workspaces::workspace_snapshot::parse_snapshot;
use serde_json::{Value, json};

fn book() -> AgentRunningPanes {
    AgentRunningPanes::new(PaneNames::new(), || {})
}

fn pane(id: &str, extra: Value) -> Value {
    let mut base = json!({
        "type": "pane",
        "id": id,
        "title": id,
        "kind": "terminal",
        "resume": {"agent": "claude", "id": "tok-1"}
    });
    for (key, value) in extra.as_object().unwrap() {
        base.as_object_mut()
            .unwrap()
            .insert(key.clone(), value.clone());
    }
    base
}

fn plain(id: &str) -> Value {
    pane(id, json!({}))
}

fn without_resume(id: &str) -> Value {
    let mut value = plain(id);
    value.as_object_mut().unwrap().remove("resume");
    value
}

fn tabbed(children: Vec<Value>) -> Value {
    let first = children[0]["id"].clone();
    json!({
        "id": "w1",
        "name": "w",
        "kind": "terminal",
        "workDir": "/w",
        "root": {"type": "tabs", "id": "t1", "activeId": first, "children": children},
        "activePaneId": first
    })
}

fn snapshot_of(workspace: Value, windows: Value) -> AppSnapshot {
    let mut raw = json!({
        "v": 1,
        "savedAt": "t0",
        "activeWorkspaceId": "w1",
        "groups": [],
        "workspaces": [workspace]
    });
    if !windows.is_null() {
        raw["windows"] = windows;
    }
    parse_snapshot(&raw).unwrap()
}

fn snapshot(panes: Vec<Value>, detached: Vec<Value>) -> AppSnapshot {
    let windows = if detached.is_empty() {
        Value::Null
    } else {
        let sizes: Vec<Value> = detached.iter().map(|_| json!(1)).collect();
        json!([{
            "id": "d1",
            "bounds": {"x": 0, "y": 0, "width": 800, "height": 600},
            "activeWorkspaceId": "w2",
            "workspaces": [{
                "id": "w2",
                "name": "d",
                "kind": "terminal",
                "workDir": "/d",
                "root": {
                    "type": "split",
                    "id": "s1",
                    "direction": "horizontal",
                    "sizes": sizes,
                    "children": detached
                }
            }]
        }])
    };
    snapshot_of(tabbed(panes), windows)
}

fn collect_running(node: &Value, out: &mut Vec<String>) {
    match node {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("pane")
                && map.get("agentRunning") == Some(&json!(true))
            {
                out.push(map["id"].as_str().unwrap().to_owned());
            }
            for value in map.values() {
                collect_running(value, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_running(item, out);
            }
        }
        _ => {}
    }
}

fn running_ids(snapshot: &AppSnapshot) -> Vec<String> {
    let mut ids = Vec::new();
    collect_running(&serde_json::to_value(snapshot).unwrap(), &mut ids);
    ids.sort();
    ids
}

fn ids(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn marks_a_pane_the_renderer_reported_running_with_the_renderer_saving_it_without_the_mark() {
    let book = book();
    book.report("a", true, true);
    let marked = book.mark(&snapshot(vec![plain("a"), plain("b")], vec![]));
    assert_eq!(running_ids(&marked), ids(&["a"]));
}

#[test]
fn marks_a_pane_inside_a_split_tab() {
    let book = book();
    book.report("c", true, true);
    let split = json!({
        "type": "split",
        "id": "s1",
        "direction": "horizontal",
        "sizes": [1, 1],
        "children": [plain("b"), plain("c")]
    });
    let saved = snapshot_of(tabbed(vec![plain("a"), split]), Value::Null);
    assert_eq!(running_ids(&book.mark(&saved)), ids(&["c"]));
}

#[test]
fn keeps_the_mark_after_ostia_took_the_shell_away_whatever_the_renderer_saves_later() {
    let book = book();
    book.report("a", true, true);
    book.report("a", false, false);
    let marked = book.mark(&snapshot(vec![plain("a")], vec![]));
    assert_eq!(running_ids(&marked), ids(&["a"]));
}

#[test]
fn clears_the_mark_when_the_agent_ends_while_its_pane_is_attached() {
    let book = book();
    book.report("a", true, true);
    book.report("a", false, true);
    let marked = book.mark(&snapshot(vec![plain("a")], vec![]));
    assert_eq!(running_ids(&marked), ids(&[]));
}

#[test]
fn ksh_c103_says_a_kept_agent_still_runs_at_reattach_only_while_its_shell_is_not_in_the_foreground()
{
    let book = book();
    book.seed(Some(&snapshot(
        vec![pane("a", json!({"agentRunning": true})), plain("b")],
        vec![],
    )));
    let owner = |foreground: &str, sandboxed: bool| PromptOwner {
        foreground: foreground.to_owned(),
        shell: "/bin/bash".to_owned(),
        sandboxed,
    };
    assert!(book.still_running("a", &owner("claude", false)));
    assert!(!book.still_running("a", &owner("bash", false)));
    assert!(book.still_running("a", &owner("", false)));
    assert!(book.still_running("a", &owner("bwrap", true)));
    assert!(!book.still_running("b", &owner("claude", false)));
}

#[test]
fn clears_the_mark_when_the_shell_itself_ended() {
    let book = book();
    book.report("a", true, true);
    book.shell_ended("a");
    let marked = book.mark(&snapshot(vec![plain("a")], vec![]));
    assert_eq!(running_ids(&marked), ids(&[]));
}

#[test]
fn ignores_a_running_report_from_a_window_that_is_not_attached_to_the_pane() {
    let book = book();
    book.report("a", true, false);
    let marked = book.mark(&snapshot(vec![plain("a")], vec![]));
    assert_eq!(running_ids(&marked), ids(&[]));
}

#[test]
fn never_marks_a_hibernated_pane_so_auto_resume_leaves_it_asleep() {
    let book = book();
    book.report("a", true, true);
    book.report("a", false, false);
    let marked = book.mark(&snapshot(
        vec![pane("a", json!({"hibernated": true}))],
        vec![],
    ));
    assert_eq!(running_ids(&marked), ids(&[]));
}

#[test]
fn never_marks_a_pane_without_a_resume_token() {
    let book = book();
    book.report("a", true, true);
    let marked = book.mark(&snapshot(vec![without_resume("a")], vec![]));
    assert_eq!(running_ids(&marked), ids(&[]));
}

#[test]
fn carries_the_saved_marks_of_every_window_across_a_restart_until_they_are_cleared() {
    let book = book();
    book.seed(Some(&snapshot(
        vec![pane("a", json!({"agentRunning": true})), plain("b")],
        vec![pane("c", json!({"agentRunning": true})), plain("d")],
    )));
    let fresh = snapshot(vec![plain("a"), plain("b")], vec![plain("c"), plain("d")]);
    assert_eq!(running_ids(&book.mark(&fresh)), ids(&["a", "c"]));
    book.report("c", false, true);
    assert_eq!(running_ids(&book.mark(&fresh)), ids(&["a"]));
}

#[test]
fn says_which_panes_had_a_running_agent_when_ostia_last_saved() {
    let book = book();
    book.seed(Some(&snapshot(
        vec![pane("a", json!({"agentRunning": true})), plain("b")],
        vec![],
    )));
    assert!(book.has("a"));
    assert!(!book.has("b"));
}

#[test]
fn asks_for_a_save_only_when_the_set_changes() {
    let changes = Arc::new(AtomicUsize::new(0));
    let book = {
        let changes = Arc::clone(&changes);
        AgentRunningPanes::new(PaneNames::new(), move || {
            changes.fetch_add(1, Ordering::SeqCst);
        })
    };
    book.report("a", true, true);
    book.report("a", true, true);
    book.report("a", false, false);
    book.shell_ended("b");
    assert_eq!(changes.load(Ordering::SeqCst), 1);
    book.shell_ended("a");
    assert_eq!(changes.load(Ordering::SeqCst), 2);
}

#[test]
fn a_bus_name_is_dropped_when_the_pty_exits_even_if_the_pane_never_reported_an_agent() {
    let names = PaneNames::new();
    let book = AgentRunningPanes::new(names.clone(), || {});
    names.claim_name("b", &json!("worker"), None);
    book.shell_ended("b");
    assert_eq!(names.pane_named("worker"), None);
}
