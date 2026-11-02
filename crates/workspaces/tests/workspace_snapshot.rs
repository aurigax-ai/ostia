#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::host::{Host, Platform};
use ostia_workspaces::workspace_snapshot::{
    handoff_pane_ids, load_snapshot, parse_handoff, parse_pane_drop, parse_snapshot, save_snapshot,
    snapshot_path,
};
use serde_json::{Value, json};
use tempfile::TempDir;

fn host_in(dir: &Path) -> Host {
    let env: BTreeMap<String, String> = [("XDG_DATA_HOME", dir.join("data"))]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_string_lossy().into_owned()))
        .collect();
    Host {
        env,
        home: dir.join("home"),
        cwd: dir.to_path_buf(),
        platform: Platform::current(),
    }
}

fn temp_host() -> (TempDir, Host) {
    let dir = TempDir::new().unwrap();
    let host = host_in(dir.path());
    (dir, host)
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn snap() -> Value {
    json!({
        "v": 1,
        "savedAt": "2026-08-06T00:00:00.000Z",
        "activeWorkspaceId": "s1",
        "workspaces": [
            {
                "id": "s1",
                "name": "terminal",
                "kind": "terminal",
                "workDir": "/home/u/proj",
                "activePaneId": "pane-1",
                "root": {"type": "pane", "id": "pane-1", "title": "zsh", "kind": "terminal", "cwd": "/home/u/proj"}
            }
        ],
        "groups": []
    })
}

fn merged(base: &Value, extra: Value) -> Value {
    let mut out = base.clone();
    let target = out.as_object_mut().unwrap();
    for (key, value) in extra.as_object().unwrap() {
        target.insert(key.clone(), value.clone());
    }
    out
}

fn without(base: &Value, keys: &[&str]) -> Value {
    let mut out = base.clone();
    for key in keys {
        out.as_object_mut().unwrap().shift_remove(*key);
    }
    out
}

fn snap_with(extra: Value) -> Value {
    merged(&snap(), extra)
}

fn ws0() -> Value {
    snap()["workspaces"][0].clone()
}

fn pane0() -> Value {
    ws0()["root"].clone()
}

fn empty_ws() -> Value {
    without(&ws0(), &["root", "activePaneId"])
}

fn parsed(raw: &Value) -> Option<Value> {
    parse_snapshot(raw).map(|snapshot| serde_json::to_value(&snapshot).unwrap())
}

fn with_ws(workspace: Value) -> Value {
    snap_with(json!({"workspaces": [workspace]}))
}

fn root_snap(root: Value) -> Value {
    with_ws(merged(&ws0(), json!({"root": root})))
}

fn root_of(raw: &Value) -> Option<Value> {
    parsed(raw)?.pointer("/workspaces/0/root").cloned()
}

fn pane_with(extra: Value) -> Option<Value> {
    root_of(&root_snap(merged(&pane0(), extra)))
}

fn workspaces_of(raw: &Value) -> Value {
    parsed(raw).unwrap()["workspaces"].clone()
}

fn has(value: &Value, key: &str) -> bool {
    value.get(key).is_some()
}

fn contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e
            .iter()
            .all(|(key, want)| a.get(key).is_some_and(|got| contains(got, want))),
        (Value::Array(a), Value::Array(e)) => {
            a.len() == e.len() && a.iter().zip(e).all(|(got, want)| contains(got, want))
        }
        _ => actual == expected,
    }
}

fn term(id: &str) -> Value {
    json!({"type": "pane", "id": id, "title": "zsh", "kind": "terminal"})
}

fn split_of(a: &str, b: &str) -> Value {
    json!({
        "type": "split",
        "id": "split-1",
        "direction": "horizontal",
        "children": [term(a), term(b)],
        "sizes": [1, 1]
    })
}

fn ids_of(children: &Value) -> Vec<String> {
    children
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect()
}

fn text_of(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

fn big_snapshot_with_workspaces(count: usize) -> Value {
    let workspaces: Vec<Value> = (0..count)
        .map(|i| {
            json!({
                "id": format!("w{i}"),
                "name": "x",
                "kind": "terminal",
                "workDir": "/tmp",
                "activePaneId": format!("p{i}"),
                "root": term(&format!("p{i}"))
            })
        })
        .collect();
    snap_with(json!({"workspaces": workspaces, "activeWorkspaceId": "w0"}))
}

fn window_json(id: &str, workspace: &str, pane: &str) -> Value {
    json!({
        "id": id,
        "bounds": {"x": 0, "y": 0, "width": 800, "height": 600},
        "activeWorkspaceId": workspace,
        "workspaces": [{
            "id": workspace,
            "name": "x",
            "kind": "terminal",
            "workDir": "/tmp",
            "activePaneId": pane,
            "root": term(pane)
        }]
    })
}

#[test]
fn keeps_a_well_formed_extension_id_and_drops_anything_else() {
    assert_eq!(
        parsed(&snap_with(json!({"rightPanel": "graphs"}))).unwrap()["rightPanel"],
        "graphs"
    );
    let too_long = "x".repeat(41);
    let bad = [
        json!(""),
        json!("Graphs"),
        json!("a b"),
        json!(too_long),
        json!(7),
        json!(null),
    ];
    for value in bad {
        let result = parsed(&snap_with(json!({"rightPanel": value.clone()}))).unwrap();
        assert!(!has(&result, "rightPanel"), "{value}");
    }
}

#[test]
fn right_side_panel_keeps_it_per_detached_window() {
    let window = |panel: Value| {
        let mut window = window_json("d1", "w2", "pane-2");
        window["rightPanel"] = panel;
        window
    };
    let kept = parsed(&snap_with(json!({"windows": [window(json!("keeper"))]}))).unwrap();
    assert_eq!(kept["windows"][0]["rightPanel"], "keeper");
    let dropped = parsed(&snap_with(json!({"windows": [window(json!("No!"))]}))).unwrap();
    assert!(!has(&dropped["windows"][0], "rightPanel"));
}

#[test]
fn keeps_a_known_left_panel_and_drops_anything_else() {
    assert_eq!(
        parsed(&snap_with(json!({"leftPanel": "files"}))).unwrap()["leftPanel"],
        "files"
    );
    for bad in [json!("git"), json!(true)] {
        let result = parsed(&snap_with(json!({"leftPanel": bad.clone()}))).unwrap();
        assert!(!has(&result, "leftPanel"), "{bad}");
    }
}

#[test]
fn left_side_panel_keeps_it_per_detached_window() {
    let window = |panel: Value| {
        let mut window = window_json("d1", "w2", "pane-2");
        window["leftPanel"] = panel;
        window
    };
    let kept = parsed(&snap_with(json!({"windows": [window(json!("files"))]}))).unwrap();
    assert_eq!(kept["windows"][0]["leftPanel"], "files");
    let dropped = parsed(&snap_with(json!({"windows": [window(json!("x"))]}))).unwrap();
    assert!(!has(&dropped["windows"][0], "leftPanel"));
}

#[test]
fn accepts_a_well_formed_snapshot() {
    assert_eq!(parsed(&snap()).unwrap(), snap());
}

#[test]
fn keeps_a_chat_pane_with_its_session_id() {
    let chat = json!({
        "type": "pane", "id": "pane-2", "title": "Deploy notes", "kind": "chat", "chatSessionId": "c1"
    });
    let mut root = split_of("pane-1", "pane-3");
    root["children"] = json!([pane0(), chat.clone()]);
    let root = root_of(&root_snap(root)).unwrap();
    assert_eq!(root["children"][1], chat);
}

#[test]
fn ssh_c64_never_restores_a_remote_file_path() {
    let remote = json!({
        "type": "pane", "id": "pane-2", "title": "app.conf", "kind": "editor",
        "filePath": "remote://abcdef012345/srv/app/app.conf"
    });
    let mut root = split_of("pane-1", "pane-3");
    root["children"] = json!([pane0(), remote]);
    let root = root_of(&root_snap(root)).unwrap();
    assert_eq!(
        root["children"][1],
        json!({"type": "pane", "id": "pane-2", "title": "app.conf", "kind": "editor"})
    );
}

#[test]
fn rejects_a_snapshot_written_by_a_different_schema_version() {
    assert!(parsed(&snap_with(json!({"v": 2}))).is_none());
}

#[test]
fn rejects_a_non_object() {
    assert!(parsed(&json!(null)).is_none());
    assert!(parsed(&json!("nope")).is_none());
}

#[test]
fn keeps_an_empty_workspace_as_a_snapshot_with_no_workspaces_and_no_active_workspace() {
    assert_eq!(
        parsed(&snap_with(json!({"workspaces": []}))).unwrap(),
        json!({
            "v": 1,
            "savedAt": snap()["savedAt"],
            "activeWorkspaceId": null,
            "workspaces": [],
            "groups": []
        })
    );
}

#[test]
fn keeps_valid_groups_with_members_and_drops_bad_empty_or_dangling_ones() {
    let mut first = ws0();
    first["groupId"] = json!("g1");
    let second = merged(&empty_ws(), json!({"id": "s2", "groupId": "g-missing"}));
    let third = merged(
        &empty_ws(),
        json!({"id": "s3", "groupId": "g1", "pinned": true}),
    );
    let result = parsed(&snap_with(json!({
        "workspaces": [first, second, third],
        "groups": [
            {"id": "g1", "name": "  api  ", "color": "mauve", "collapsed": true},
            {"id": "g1", "name": "duplicate"},
            {"id": "g2", "name": "no members"},
            {"id": "g3", "name": "   "},
            "junk"
        ]
    })))
    .unwrap();
    assert_eq!(
        result["groups"],
        json!([{"id": "g1", "name": "api", "collapsed": true}])
    );
    let group_ids: Vec<Value> = result["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.get("groupId").cloned().unwrap_or(Value::Null))
        .collect();
    assert_eq!(group_ids, vec![json!("g1"), Value::Null, Value::Null]);
}

#[test]
fn keeps_a_panes_agent_resume_token_and_drops_a_malformed_one() {
    let with_resume = |resume: Value| pane_with(json!({"resume": resume})).unwrap();
    assert!(contains(
        &with_resume(json!({"agent": "claude", "id": "abc-1"})),
        &json!({"resume": {"agent": "claude", "id": "abc-1"}})
    ));
    assert!(contains(
        &with_resume(json!({"agent": "claude", "id": "abc-1", "cwd": "/w/tree"})),
        &json!({"resume": {"agent": "claude", "id": "abc-1", "cwd": "/w/tree"}})
    ));
    assert!(!has(
        &with_resume(json!({"agent": "claude", "id": "x; rm -rf ~"})),
        "resume"
    ));
    let saved = json!({
        "agent": "codex",
        "id": "abc-1",
        "args": ["-m", "gpt-5", "-c", "x.api_key=\"k\""],
        "env": {"GL_ISSUE": "685", "OPENAI_API_KEY": "k"}
    });
    let root = with_resume(saved);
    assert!(contains(
        &root,
        &json!({"resume": {"agent": "codex", "id": "abc-1", "args": ["-m", "gpt-5"]}})
    ));
    assert!(root.pointer("/resume/env").is_none());
}

#[test]
fn keeps_the_typed_launch_of_a_stored_resume_and_filters_it_again_on_read() {
    let stored = json!({
        "agent": "claude",
        "id": "abc-1",
        "typed": {
            "args": ["--dangerously-skip-permissions", "--model", "opus", "--bogus", "--add-dir", "/w"],
            "env": {"GL_ISSUE": "685", "OPENAI_API_KEY": "k", "PATH": "/x", "OSTIA_X": "1"}
        }
    });
    let root = pane_with(json!({"resume": stored})).unwrap();
    assert_eq!(
        root.pointer("/resume/typed").unwrap(),
        &json!({
            "args": ["--dangerously-skip-permissions", "--add-dir=/w"],
            "env": {"GL_ISSUE": "685"}
        })
    );
    let failed = pane_with(json!({
        "resumeFailed": {
            "resume": {"agent": "codex", "id": "d-1", "typed": {"args": ["--yolo"]}},
            "exitCode": 2
        }
    }))
    .unwrap();
    assert_eq!(
        failed.pointer("/resumeFailed/resume/typed").unwrap(),
        &json!({"args": ["--yolo"]})
    );
    let empty = pane_with(json!({
        "resume": {"agent": "claude", "id": "abc-1", "typed": {"args": ["--bogus"]}}
    }))
    .unwrap();
    assert!(empty.pointer("/resume/typed").is_none());
}

#[test]
fn keeps_a_view_pane_by_name_and_drops_one_without_a_valid_view_name() {
    let with_view = |view_name: Option<Value>| {
        let mut pane = json!({"type": "pane", "id": "pane-1", "title": "Board", "kind": "view"});
        if let Some(name) = view_name {
            pane["viewName"] = name;
        }
        root_of(&root_snap(pane))
    };
    assert_eq!(
        with_view(Some(json!("board"))).unwrap(),
        json!({"type": "pane", "id": "pane-1", "title": "Board", "kind": "view", "viewName": "board"})
    );
    assert!(with_view(Some(json!("../../etc/passwd"))).is_none());
    assert!(with_view(None).is_none());
}

#[test]
fn keeps_the_agent_running_mark_only_on_a_pane_with_a_valid_resume_token() {
    let resume = json!({"agent": "claude", "id": "abc-1"});
    let root = pane_with(json!({"resume": resume.clone(), "agentRunning": true})).unwrap();
    assert!(contains(&root, &json!({"agentRunning": true})));
    assert!(!has(
        &pane_with(json!({"agentRunning": true})).unwrap(),
        "agentRunning"
    ));
    assert!(!has(
        &pane_with(json!({"resume": resume.clone(), "agentRunning": true, "hibernated": true}))
            .unwrap(),
        "agentRunning"
    ));
    assert!(!has(
        &pane_with(json!({"resume": resume, "agentRunning": "yes"})).unwrap(),
        "agentRunning"
    ));
}

#[test]
fn keeps_a_kept_awake_mark_only_on_a_pane_that_has_a_resume_token() {
    let resume = json!({"agent": "claude", "id": "abc-1"});
    let root = pane_with(json!({"resume": resume.clone(), "keepAwake": true})).unwrap();
    assert!(contains(&root, &json!({"keepAwake": true})));
    assert!(!has(
        &pane_with(json!({"keepAwake": true})).unwrap(),
        "keepAwake"
    ));
    assert!(!has(
        &pane_with(json!({"resume": resume, "keepAwake": "yes"})).unwrap(),
        "keepAwake"
    ));
}

#[test]
fn rsm_c17_keeps_a_failed_resume_token_as_data_never_running_and_only_without_a_live_token() {
    let failed = json!({"resume": {"agent": "claude", "id": "dead-1"}, "exitCode": 1});
    let root = pane_with(json!({"resumeFailed": failed.clone(), "agentRunning": true})).unwrap();
    assert!(contains(&root, &json!({"resumeFailed": failed.clone()})));
    assert!(!has(&root, "agentRunning"));
    assert!(!has(
        &pane_with(json!({
            "resume": {"agent": "claude", "id": "abc-1"},
            "resumeFailed": failed.clone()
        }))
        .unwrap(),
        "resumeFailed"
    ));
    assert!(!has(
        &pane_with(json!({
            "resumeFailed": {"resume": {"agent": "claude", "id": "$(id)"}, "exitCode": 1}
        }))
        .unwrap(),
        "resumeFailed"
    ));
    assert!(!has(
        &pane_with(json!({
            "resumeFailed": {"resume": failed["resume"].clone(), "exitCode": "rm -rf"}
        }))
        .unwrap(),
        "resumeFailed"
    ));
}

#[test]
fn keeps_a_renamed_pane_pinned_only_when_the_mark_is_true() {
    let root = pane_with(json!({"title": "worker", "titlePinned": true})).unwrap();
    assert!(contains(
        &root,
        &json!({"title": "worker", "titlePinned": true})
    ));
    assert!(!has(
        &pane_with(json!({"titlePinned": "yes"})).unwrap(),
        "titlePinned"
    ));
}

#[test]
fn keeps_the_default_title_mark_only_on_a_terminal_pane_and_only_when_it_is_true() {
    let root = pane_with(json!({"defaultTitle": true})).unwrap();
    assert!(contains(
        &root,
        &json!({"title": "zsh", "defaultTitle": true})
    ));
    assert!(!has(&pane_with(json!({})).unwrap(), "defaultTitle"));
    assert!(!has(
        &pane_with(json!({"defaultTitle": "yes"})).unwrap(),
        "defaultTitle"
    ));
    assert!(!has(
        &pane_with(
            json!({"kind": "editor", "filePath": "/home/u/proj/a.ts", "defaultTitle": true})
        )
        .unwrap(),
        "defaultTitle"
    ));
}

#[test]
fn keeps_a_tab_stack_and_repairs_an_unknown_shown_tab() {
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-9",
        "children": [term("pane-1"), term("pane-2")]
    });
    let root = root_of(&root_snap(tabs)).unwrap();
    assert!(contains(
        &root,
        &json!({"type": "tabs", "activeId": "pane-1"})
    ));
}

#[test]
fn unwraps_a_one_tab_stack_also_when_its_only_tab_is_a_split_tab() {
    let one = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-1", "children": [term("pane-1")]
    });
    let root = root_of(&root_snap(one.clone())).unwrap();
    assert!(contains(&root, &json!({"type": "pane", "id": "pane-1"})));
    let mut lone = one;
    lone["children"] = json!([split_of("pane-1", "pane-2")]);
    let root = root_of(&root_snap(lone)).unwrap();
    assert!(contains(&root, &json!({"type": "split", "id": "split-1"})));
}

#[test]
fn keeps_a_split_tab_with_its_name_and_a_shown_pane_inside_it() {
    let mut named = split_of("pane-2", "pane-3");
    named["name"] = json!("  api  ");
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-3",
        "children": [term("pane-1"), named]
    });
    let root = root_of(&root_snap(tabs)).unwrap();
    assert!(contains(
        &root,
        &json!({"type": "tabs", "activeId": "pane-3"})
    ));
    assert!(contains(
        &root["children"][1],
        &json!({"type": "split", "name": "api", "sizes": [1, 1]})
    ));
}

#[test]
fn keeps_a_collapsed_mark_only_on_a_pane_inside_a_tab_and_only_when_it_is_true() {
    let pane = |id: &str, collapsed: Value| {
        let mut pane = term(id);
        pane["collapsed"] = collapsed;
        pane
    };
    let mut inner = split_of("pane-2", "pane-3");
    inner["children"] = json!([pane("pane-2", json!(true)), pane("pane-3", json!("yes"))]);
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-1",
        "children": [pane("pane-1", json!(true)), inner]
    });
    let root = root_of(&root_snap(tabs)).unwrap();
    let in_tab = &root["children"][1];
    assert!(contains(
        &in_tab["children"][0],
        &json!({"collapsed": true})
    ));
    assert!(!has(&in_tab["children"][1], "collapsed"));
    let mut outside = split_of("pane-1", "pane-2");
    outside["children"] = json!([pane("pane-1", json!(true)), pane("pane-2", json!(true))]);
    let top = root_of(&root_snap(outside)).unwrap();
    assert!(!has(&top["children"][0], "collapsed"));
}

#[test]
fn keeps_a_folded_mark_only_on_a_split_tab_and_only_when_it_is_true() {
    let mut folded_pane = term("pane-1");
    folded_pane["folded"] = json!(true);
    let mut folded_split = split_of("pane-2", "pane-3");
    folded_split["folded"] = json!(true);
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-1",
        "children": [folded_pane, folded_split]
    });
    let root = root_of(&root_snap(tabs)).unwrap();
    assert!(!has(&root["children"][0], "folded"));
    assert!(contains(&root["children"][1], &json!({"folded": true})));
    let mut loose = split_of("pane-1", "pane-2");
    loose["folded"] = json!("yes");
    assert!(!has(&root_of(&root_snap(loose)).unwrap(), "folded"));
}

#[test]
fn drops_a_bad_split_tab_name_and_repairs_the_shown_pane_to_the_first_pane() {
    let mut named = split_of("pane-2", "pane-3");
    named["name"] = json!("a\u{7}b");
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-9",
        "children": [named, term("pane-1")]
    });
    let root = root_of(&root_snap(tabs)).unwrap();
    assert!(contains(
        &root,
        &json!({"type": "tabs", "activeId": "pane-2"})
    ));
    assert!(!has(&root["children"][0], "name"));
}

#[test]
fn rejects_a_tab_stack_inside_a_split_tab_and_keeps_a_name_only_on_a_split_tab() {
    let inner = json!({
        "type": "tabs", "id": "tabs-4", "activeId": "pane-2",
        "children": [term("pane-2"), term("pane-3")]
    });
    let mut nested = split_of("pane-4", "pane-5");
    nested["children"] = json!([term("pane-4"), inner]);
    let bad = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-1",
        "children": [term("pane-1"), nested]
    });
    assert_eq!(workspaces_of(&root_snap(bad)), json!([]));
    let mut plain = split_of("pane-1", "pane-2");
    plain["name"] = json!("api");
    assert!(!has(&root_of(&root_snap(plain)).unwrap(), "name"));
}

#[test]
fn accepts_a_split_tab_in_a_handoff() {
    let mut named = split_of("pane-2", "pane-3");
    named["name"] = json!("api");
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-2",
        "children": [term("pane-1"), named]
    });
    let workspace = merged(&ws0(), json!({"activePaneId": "pane-2", "root": tabs}));
    let result = serde_json::to_value(parse_handoff(&workspace).unwrap()).unwrap();
    assert!(contains(
        &result["root"],
        &json!({"type": "tabs", "activeId": "pane-2"})
    ));
    assert!(contains(
        &result["root"]["children"][1],
        &json!({"name": "api"})
    ));
}

#[test]
fn keeps_a_description_and_pin_and_drops_a_description_that_is_not_text() {
    let kept = parsed(&with_ws(merged(
        &ws0(),
        json!({"description": "  PR #7  ", "pinned": true}),
    )))
    .unwrap();
    assert!(contains(
        &kept["workspaces"][0],
        &json!({"description": "PR #7", "pinned": true})
    ));
    let bad = parsed(&with_ws(merged(
        &ws0(),
        json!({"description": 42, "pinned": "yes"}),
    )))
    .unwrap();
    assert!(!has(&bad["workspaces"][0], "description"));
    assert!(!has(&bad["workspaces"][0], "pinned"));
}

#[test]
fn keeps_an_empty_workspace_no_layout_and_a_user_given_name() {
    let empty = empty_ws();
    let result = parsed(&with_ws(merged(
        &empty,
        json!({"customName": " payments "}),
    )))
    .unwrap();
    assert_eq!(
        result["workspaces"],
        json!([merged(&empty, json!({"customName": "payments"}))])
    );
    assert_eq!(result["activeWorkspaceId"], empty["id"]);
}

#[test]
fn never_restores_a_scratch_workspace_from_disk_but_lets_one_move_between_windows() {
    let scratch = json!({
        "id": "s2", "name": "Scratch", "kind": "scratch",
        "workDir": "/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa",
        "activePaneId": "pane-2", "root": term("pane-2")
    });
    let result = parsed(&snap_with(json!({"workspaces": [ws0(), scratch.clone()]}))).unwrap();
    assert_eq!(ids_of(&result["workspaces"]), vec!["s1"]);
    let handoff = serde_json::to_value(parse_handoff(&scratch).unwrap()).unwrap();
    assert_eq!(handoff["kind"], "scratch");
}

fn retired_with_root(root: Value, active: &str) -> Option<Value> {
    let raw = snap_with(json!({"workspaces": [{
        "id": "s1", "name": "x", "kind": "terminal", "workDir": "/tmp",
        "activePaneId": active, "root": root
    }]}));
    parsed(&raw)?.pointer("/workspaces/0").cloned()
}

fn named_term(id: &str) -> Value {
    json!({"type": "pane", "id": id, "title": id, "kind": "terminal"})
}

fn retired(id: &str) -> Value {
    json!({"type": "pane", "id": id, "title": id, "kind": "retired-kind"})
}

#[test]
fn retired_kind_leaves_a_workspace_whose_only_pane_it_was_without_a_layout() {
    let workspace = retired_with_root(retired("a"), "a").unwrap();
    assert_eq!(workspace["id"], "s1");
    assert!(!has(&workspace, "root"));
    assert!(!has(&workspace, "activePaneId"));
}

#[test]
fn retired_kind_is_dropped_from_a_split_which_collapses_around_the_pane_left_and_keeps_the_other_panes()
 {
    let split = |children: Value, sizes: Value| json!({"type": "split", "id": "sp", "direction": "horizontal", "children": children, "sizes": sizes});
    let two = retired_with_root(
        split(json!([named_term("a"), retired("b")]), json!([1, 1])),
        "a",
    )
    .unwrap();
    assert!(contains(&two["root"], &json!({"type": "pane", "id": "a"})));
    let three = retired_with_root(
        split(
            json!([named_term("a"), retired("b"), named_term("c")]),
            json!([1, 5, 3]),
        ),
        "a",
    )
    .unwrap();
    assert!(contains(
        &three["root"],
        &json!({"type": "split", "sizes": [1, 3]})
    ));
    assert_eq!(ids_of(&three["root"]["children"]), vec!["a", "c"]);
}

#[test]
fn retired_kind_is_dropped_from_a_tab_stack_which_keeps_the_tabs_that_remain() {
    let tabs =
        |children: Value| json!({"type": "tabs", "id": "t", "children": children, "activeId": "b"});
    let kept = retired_with_root(
        tabs(json!([named_term("a"), retired("b"), named_term("c")])),
        "a",
    )
    .unwrap();
    assert!(contains(
        &kept["root"],
        &json!({"type": "tabs", "activeId": "a"})
    ));
    let single = retired_with_root(tabs(json!([retired("a"), named_term("b")])), "b").unwrap();
    assert!(contains(
        &single["root"],
        &json!({"type": "pane", "id": "b"})
    ));
}

#[test]
fn retired_kind_does_not_rescue_a_layout_that_is_malformed_in_another_way() {
    let root = json!({
        "type": "split", "id": "sp", "direction": "horizontal",
        "children": [named_term("a"), 5]
    });
    assert!(retired_with_root(root, "a").is_none());
}

#[test]
fn drops_a_workspace_that_reuses_a_pane_id_already_claimed_by_another_workspace() {
    let dup = json!({
        "id": "s2", "name": "x", "kind": "terminal", "workDir": "/tmp",
        "activePaneId": "pane-1", "root": term("pane-1")
    });
    let result = parsed(&snap_with(json!({"workspaces": [ws0(), dup]}))).unwrap();
    assert_eq!(ids_of(&result["workspaces"]), vec!["s1"]);
}

#[test]
fn drops_a_workspace_whose_split_has_no_children() {
    let empty = json!({
        "type": "split", "id": "split-1", "direction": "horizontal", "children": [], "sizes": []
    });
    assert_eq!(workspaces_of(&root_snap(empty)), json!([]));
}

#[test]
fn rebuilds_sizes_that_do_not_match_the_child_count() {
    let mut root = split_of("pane-1", "pane-2");
    root["sizes"] = json!([1]);
    let root = root_of(&root_snap(root)).unwrap();
    assert_eq!(root["sizes"], json!([1, 1]));
}

#[test]
fn falls_back_to_the_first_workspace_when_active_workspace_id_names_a_dropped_workspace() {
    let result = parsed(&snap_with(json!({"activeWorkspaceId": "ghost"}))).unwrap();
    assert_eq!(result["activeWorkspaceId"], "s1");
}

#[test]
fn falls_back_to_the_first_pane_when_active_pane_id_is_not_in_the_tree() {
    let raw = with_ws(merged(
        &ws0(),
        json!({"activePaneId": "pane-99", "root": split_of("pane-1", "pane-2")}),
    ));
    assert_eq!(
        parsed(&raw).unwrap()["workspaces"][0]["activePaneId"],
        "pane-1"
    );
}

#[test]
fn rejects_a_tree_nested_past_the_depth_cap() {
    let mut root = term("pane-0");
    for i in 1..=40 {
        root = json!({
            "type": "split",
            "id": format!("split-{i}"),
            "direction": "horizontal",
            "children": [root, term(&format!("pane-{i}"))],
            "sizes": [1, 1]
        });
    }
    assert_eq!(workspaces_of(&root_snap(root)), json!([]));
}

#[test]
fn keeps_editor_and_browser_panes_with_their_reopen_targets() {
    let root = json!({
        "type": "split", "id": "split-1", "direction": "vertical",
        "children": [
            {"type": "pane", "id": "pane-1", "title": "a.ts", "kind": "editor", "filePath": "/p/a.ts"},
            {"type": "pane", "id": "pane-2", "title": "localhost", "kind": "browser", "url": "http://x/"}
        ],
        "sizes": [2, 1]
    });
    let raw = with_ws(merged(
        &ws0(),
        json!({"activePaneId": "pane-1", "root": root}),
    ));
    let root = root_of(&raw).unwrap();
    assert!(contains(
        &root["children"][0],
        &json!({"kind": "editor", "filePath": "/p/a.ts"})
    ));
    assert!(contains(
        &root["children"][1],
        &json!({"kind": "browser", "url": "http://x/"})
    ));
}

fn saved(host: &Host, raw: &Value) {
    save_snapshot(host, &parse_snapshot(raw).unwrap()).unwrap();
}

fn loaded(host: &Host) -> Option<Value> {
    load_snapshot(host).map(|snapshot| serde_json::to_value(&snapshot).unwrap())
}

#[test]
fn round_trips_a_snapshot_through_disk() {
    let (_dir, host) = temp_host();
    saved(&host, &snap());
    assert_eq!(loaded(&host).unwrap(), snap());
}

#[test]
fn returns_null_when_nothing_was_ever_saved() {
    let (_dir, host) = temp_host();
    assert!(loaded(&host).is_none());
}

#[test]
fn round_trips_an_empty_workspace_so_a_restart_restores_zero_workspaces() {
    let (_dir, host) = temp_host();
    let empty = json!({
        "v": 1, "savedAt": "x", "activeWorkspaceId": null, "workspaces": [], "groups": []
    });
    saved(&host, &empty);
    assert_eq!(loaded(&host).unwrap(), empty);
}

#[test]
fn returns_null_rather_than_throwing_when_the_file_on_disk_is_corrupt() {
    let (_dir, host) = temp_host();
    saved(&host, &snap());
    fs::write(snapshot_path(&host), "{ not json").unwrap();
    assert!(loaded(&host).is_none());
}

#[test]
fn validates_on_load_so_a_hand_edited_file_cannot_inject_a_bogus_tree() {
    let (_dir, host) = temp_host();
    saved(&host, &snap());
    fs::write(
        snapshot_path(&host),
        serde_json::to_string(&snap_with(json!({"v": 99}))).unwrap(),
    )
    .unwrap();
    assert!(loaded(&host).is_none());
}

fn browser_snapshot(root: Value) -> Value {
    merged(
        &snap(),
        json!({"workspaces": [merged(&ws0(), json!({"activePaneId": "b1", "root": root}))]}),
    )
}

fn browser_pane(extra: Value) -> Value {
    merged(
        &json!({"type": "pane", "id": "b1", "title": "site", "kind": "browser", "url": "http://x/"}),
        extra,
    )
}

#[test]
fn keeps_the_shared_profile_of_a_browser_pane_through_a_save_and_restore() {
    let root = root_of(&browser_snapshot(browser_pane(
        json!({"browserProfile": "shared"}),
    )))
    .unwrap();
    assert!(contains(
        &root,
        &json!({"kind": "browser", "browserProfile": "shared"})
    ));
}

#[test]
fn treats_a_missing_or_unknown_profile_as_isolated_by_leaving_it_out() {
    let rows = [
        None,
        Some(json!("isolated")),
        Some(json!("persist")),
        Some(json!(7)),
        Some(json!({"shared": true})),
    ];
    for row in rows {
        let extra = row
            .clone()
            .map_or_else(|| json!({}), |value| json!({"browserProfile": value}));
        let root = root_of(&browser_snapshot(browser_pane(extra))).unwrap();
        assert!(!has(&root, "browserProfile"), "{row:?}");
    }
}

#[test]
fn never_carries_a_profile_on_a_pane_that_is_not_a_browser() {
    let root = root_of(&browser_snapshot(json!({
        "type": "pane", "id": "b1", "title": "zsh", "kind": "terminal", "browserProfile": "shared"
    })))
    .unwrap();
    assert!(!has(&root, "browserProfile"));
}

#[test]
fn keeps_a_moving_pane_on_the_profile_it_had_handoff_to_another_window() {
    let handoff = |root: Value| {
        let workspace = merged(&ws0(), json!({"activePaneId": "b1", "root": root}));
        serde_json::to_value(parse_handoff(&workspace).unwrap()).unwrap()
    };
    let shared = handoff(browser_pane(json!({"browserProfile": "shared"})));
    let isolated = handoff(browser_pane(json!({})));
    assert!(contains(
        &shared["root"],
        &json!({"browserProfile": "shared"})
    ));
    assert!(!has(&isolated["root"], "browserProfile"));
}

fn restored(pane: Value) -> Value {
    let root = merged(&json!({"id": "b1"}), pane);
    root_of(&browser_snapshot(root)).unwrap()
}

fn browser_kind() -> Value {
    json!({"type": "pane", "title": "site", "kind": "browser", "url": "http://x/"})
}

#[test]
fn keeps_the_device_a_browser_pane_was_in_through_a_save_and_restore() {
    let device =
        json!({"preset": "responsive", "width": 600, "height": 900, "dpr": 2, "zoom": "actual"});
    let root = restored(merged(
        &browser_kind(),
        json!({"browserDevice": device.clone()}),
    ));
    assert!(contains(&root, &json!({"browserDevice": device})));
}

#[test]
fn restores_a_preset_from_the_data_keeping_only_its_orientation_and_zoom() {
    let device =
        json!({"preset": "iphone-se", "width": 900, "height": 100, "dpr": 7, "zoom": "fit"});
    let root = restored(merged(&browser_kind(), json!({"browserDevice": device})));
    assert!(contains(
        &root,
        &json!({"browserDevice": {"preset": "iphone-se", "width": 667, "height": 375, "dpr": 2, "zoom": "fit"}})
    ));
}

#[test]
fn drops_a_device_that_is_not_one_or_on_a_pane_that_is_not_a_browser() {
    let rows = [
        json!(true),
        json!("iphone-se"),
        json!({"preset": "responsive"}),
        json!({"width": "x"}),
    ];
    for device in rows {
        let root = restored(merged(
            &browser_kind(),
            json!({"browserDevice": device.clone()}),
        ));
        assert!(!has(&root, "browserDevice"), "{device}");
    }
    let terminal = json!({"type": "pane", "title": "zsh", "kind": "terminal"});
    let device =
        json!({"preset": "responsive", "width": 600, "height": 900, "dpr": 1, "zoom": "fit"});
    let root = restored(merged(&terminal, json!({"browserDevice": device})));
    assert!(!has(&root, "browserDevice"));
}

#[test]
fn reads_a_file_the_ts_code_wrote_and_writes_the_same_bytes_as_the_ts_code() {
    let (_dir, host) = temp_host();
    let path = snapshot_path(&host);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::copy(fixture("workspace-snapshot-before.json"), &path).unwrap();
    let snapshot = load_snapshot(&host).unwrap();
    save_snapshot(&host, &snapshot).unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        fs::read(fixture("workspace-snapshot-after.json")).unwrap()
    );
}

#[test]
fn the_snapshot_path_is_workspaces_json_in_the_app_data_folder() {
    let (_dir, host) = temp_host();
    assert_eq!(
        snapshot_path(&host),
        host.app_data_dir().join("workspaces.json")
    );
}

#[test]
fn rejects_a_snapshot_whose_version_is_not_the_number_one_or_whose_workspaces_are_not_a_list() {
    for raw in [
        snap_with(json!({"v": "1"})),
        snap_with(json!({"v": null})),
        snap_with(json!({"workspaces": {}})),
        snap_with(json!({"workspaces": null})),
        without(&snap(), &["v"]),
        without(&snap(), &["workspaces"]),
    ] {
        assert!(parsed(&raw).is_none(), "{raw}");
    }
}

#[test]
fn accepts_a_version_written_with_a_fraction_part_as_js_does() {
    let raw: Value =
        serde_json::from_str(r#"{"v": 1.0, "savedAt": "t", "workspaces": [], "groups": []}"#)
            .unwrap();
    assert_eq!(parsed(&raw).unwrap()["savedAt"], "t");
}

#[test]
fn uses_an_empty_saved_at_when_it_is_not_text_and_keeps_the_key_order_of_the_ts_object() {
    let result = parsed(&snap_with(json!({
        "savedAt": 5, "leftPanel": "files", "rightPanel": "graphs",
        "bounds": {"x": 1, "y": 2, "width": 300, "height": 400}
    })))
    .unwrap();
    assert_eq!(result["savedAt"], "");
    let keys: Vec<&str> = result
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "v",
            "savedAt",
            "activeWorkspaceId",
            "workspaces",
            "groups",
            "leftPanel",
            "rightPanel",
            "bounds"
        ]
    );
}

#[test]
fn rounds_bounds_like_js_and_refuses_ones_outside_the_limits() {
    let bounds = |x: f64, y: f64, w: f64, h: f64| {
        parsed(&snap_with(
            json!({"bounds": {"x": x, "y": y, "width": w, "height": h}}),
        ))
        .unwrap()
        .get("bounds")
        .cloned()
    };
    assert_eq!(
        bounds(10.6, -20.5, 1280.4, 799.5).unwrap(),
        json!({"x": 11, "y": -20, "width": 1280, "height": 800})
    );
    assert_eq!(
        bounds(-0.4, 0.0, 100.0, 100.0).unwrap(),
        json!({"x": 0, "y": 0, "width": 100, "height": 100})
    );
    assert_eq!(
        bounds(-100_000.0, 100_000.0, 100_000.0, 100_000.0).unwrap(),
        json!({"x": -100_000, "y": 100_000, "width": 100_000, "height": 100_000})
    );
    assert!(bounds(0.0, 0.0, 99.0, 100.0).is_none());
    assert!(bounds(0.0, 0.0, 100.0, 99.9).is_none());
    assert!(bounds(100_001.0, 0.0, 800.0, 600.0).is_none());
    assert!(bounds(0.0, -100_001.0, 800.0, 600.0).is_none());
    assert!(bounds(0.0, 0.0, 100_001.0, 600.0).is_none());
    let text = parsed(&snap_with(
        json!({"bounds": {"x": "1", "y": 0, "width": 800, "height": 600}}),
    ))
    .unwrap();
    assert!(!has(&text, "bounds"));
    let missing = parsed(&snap_with(
        json!({"bounds": {"x": 1, "y": 0, "width": 800}}),
    ))
    .unwrap();
    assert!(!has(&missing, "bounds"));
}

#[test]
fn keeps_detached_bounds_only_for_known_workspaces_with_valid_bounds() {
    let good = json!({"x": 5, "y": 5, "width": 640, "height": 480});
    let small = json!({"x": 5, "y": 5, "width": 50, "height": 480});
    let kept = parsed(&snap_with(json!({"detachedBounds": {
        "s1": good, "ghost": good, "also": small
    }})))
    .unwrap();
    assert_eq!(kept["detachedBounds"], json!({"s1": good}));
    let none = parsed(&snap_with(
        json!({"detachedBounds": {"ghost": good, "s1": small}}),
    ))
    .unwrap();
    assert!(!has(&none, "detachedBounds"));
    let not_object = parsed(&snap_with(json!({"detachedBounds": [good]}))).unwrap();
    assert!(!has(&not_object, "detachedBounds"));
}

#[test]
fn counts_a_window_workspace_as_known_for_detached_bounds() {
    let good = json!({"x": 5, "y": 5, "width": 640, "height": 480});
    let result = parsed(&snap_with(json!({
        "windows": [window_json("d1", "w2", "pane-2")],
        "detachedBounds": {"w2": good}
    })))
    .unwrap();
    assert_eq!(result["detachedBounds"], json!({"w2": good}));
}

#[test]
fn keeps_the_first_window_for_an_id_and_drops_windows_with_a_bad_id_bounds_or_no_workspaces() {
    let mut no_bounds = window_json("d4", "w5", "pane-5");
    no_bounds.as_object_mut().unwrap().shift_remove("bounds");
    let mut no_workspaces = window_json("d5", "w6", "pane-6");
    no_workspaces["workspaces"] = json!([]);
    let mut not_list = window_json("d6", "w7", "pane-7");
    not_list["workspaces"] = json!("x");
    let long_id = "d".repeat(41);
    let forty_id = "d".repeat(40);
    let result = parsed(&snap_with(json!({"windows": [
        window_json("d1", "w2", "pane-2"),
        window_json("d1", "w3", "pane-3"),
        window_json("bad id!", "w4", "pane-4"),
        window_json("", "w8", "pane-8"),
        window_json(&long_id, "w9", "pane-9"),
        window_json(&forty_id, "w10", "pane-10"),
        no_bounds,
        no_workspaces,
        not_list,
        "junk"
    ]})))
    .unwrap();
    assert_eq!(ids_of(&result["windows"]), vec!["d1".to_owned(), forty_id]);
    assert_eq!(result["windows"][0]["workspaces"][0]["id"], "w2");
}

#[test]
fn drops_a_window_workspace_that_reuses_a_pane_or_workspace_id_of_the_main_list() {
    let result = parsed(&snap_with(json!({"windows": [
        window_json("d1", "w2", "pane-1"),
        window_json("d2", "s1", "pane-3"),
        window_json("d3", "w4", "pane-4")
    ]})))
    .unwrap();
    assert_eq!(ids_of(&result["windows"]), vec!["d3"]);
}

#[test]
fn never_restores_a_scratch_workspace_inside_a_window() {
    let mut window = window_json("d1", "w2", "pane-2");
    window["workspaces"][0]["kind"] = json!("scratch");
    let result = parsed(&snap_with(json!({"windows": [window]}))).unwrap();
    assert!(!has(&result, "windows"));
}

#[test]
fn keeps_at_most_sixteen_windows() {
    let windows: Vec<Value> = (0..20)
        .map(|i| window_json(&format!("d{i}"), &format!("w{i}"), &format!("p{i}")))
        .collect();
    let mut raw = snap_with(json!({"windows": windows}));
    raw["workspaces"][0]["id"] = json!("main");
    let result = parsed(&raw).unwrap();
    assert_eq!(result["windows"].as_array().unwrap().len(), 16);
}

#[test]
fn keeps_at_most_thirty_two_workspaces_and_gives_the_windows_what_is_left() {
    let top = parsed(&big_snapshot_with_workspaces(40)).unwrap();
    assert_eq!(top["workspaces"].as_array().unwrap().len(), 32);
    assert_eq!(top["workspaces"][31]["id"], "w31");
    let mut raw = big_snapshot_with_workspaces(31);
    let mut window = window_json("d1", "x0", "px0");
    window["workspaces"] = json!([
        window["workspaces"][0].clone(),
        merged(
            &window["workspaces"][0],
            json!({"id": "x1", "activePaneId": "px1", "root": term("px1")})
        ),
        merged(
            &window["workspaces"][0],
            json!({"id": "x2", "activePaneId": "px2", "root": term("px2")})
        )
    ]);
    raw["windows"] = json!([window]);
    let result = parsed(&raw).unwrap();
    assert_eq!(
        result["windows"][0]["workspaces"].as_array().unwrap().len(),
        1
    );
    let full = {
        let mut raw = big_snapshot_with_workspaces(32);
        raw["windows"] = json!([window_json("d1", "x0", "px0")]);
        parsed(&raw).unwrap()
    };
    assert!(!has(&full, "windows"));
}

#[test]
fn drops_a_second_workspace_with_the_same_id() {
    let again = merged(
        &ws0(),
        json!({"root": term("pane-7"), "activePaneId": "pane-7"}),
    );
    let result = parsed(&snap_with(json!({"workspaces": [ws0(), again]}))).unwrap();
    assert_eq!(result["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(result["workspaces"][0]["root"]["id"], "pane-1");
}

#[test]
fn drops_a_workspace_that_has_no_id_or_is_not_an_object() {
    let result = parsed(&snap_with(json!({"workspaces": [
        without(&ws0(), &["id"]),
        merged(&ws0(), json!({"id": ""})),
        merged(&ws0(), json!({"id": 5})),
        "junk",
        null
    ]})))
    .unwrap();
    assert_eq!(result["workspaces"], json!([]));
    assert_eq!(result["activeWorkspaceId"], Value::Null);
}

#[test]
fn drops_a_workspace_whose_root_is_not_a_layout_and_keeps_one_with_no_root_key() {
    assert_eq!(
        workspaces_of(&with_ws(merged(&ws0(), json!({"root": null})))),
        json!([])
    );
    assert_eq!(
        workspaces_of(&with_ws(merged(&ws0(), json!({"root": "pane"})))),
        json!([])
    );
    let result = parsed(&with_ws(merged(
        &empty_ws(),
        json!({"activePaneId": "pane-1"}),
    )))
    .unwrap();
    assert!(!has(&result["workspaces"][0], "activePaneId"));
}

#[test]
fn drops_a_workspace_that_uses_one_pane_id_twice() {
    assert_eq!(
        workspaces_of(&root_snap(split_of("pane-1", "pane-1"))),
        json!([])
    );
}

#[test]
fn fills_in_the_defaults_of_a_workspace_with_missing_or_unknown_fields() {
    let result = parsed(&snap_with(json!({"workspaces": [
        {"id": "a"},
        {"id": "b", "name": "", "kind": "bogus", "workDir": ""},
        {"id": "c", "name": 5, "kind": 5, "workDir": 5}
    ]})))
    .unwrap();
    for workspace in result["workspaces"].as_array().unwrap() {
        assert_eq!(workspace["name"], "workspace", "{workspace}");
        assert_eq!(workspace["kind"], "terminal", "{workspace}");
        assert_eq!(workspace["workDir"], "~", "{workspace}");
    }
}

#[test]
fn cuts_a_custom_name_after_trimming_at_one_hundred_and_twenty_units() {
    let name = |raw: Value| {
        parsed(&with_ws(merged(&empty_ws(), json!({"customName": raw})))).unwrap()["workspaces"][0]
            .get("customName")
            .cloned()
    };
    assert_eq!(name(json!("a".repeat(200))), Some(json!("a".repeat(120))));
    let spaced = format!("{} b", "a".repeat(119));
    assert_eq!(
        name(json!(spaced)),
        Some(json!(format!("{} ", "a".repeat(119))))
    );
    assert_eq!(name(json!("😀".repeat(61))), Some(json!("😀".repeat(60))));
    assert_eq!(name(json!("   ")), None);
    assert_eq!(name(json!(7)), None);
}

#[test]
fn keeps_a_project_folder_cut_at_4096_units_and_drops_an_empty_or_non_text_one() {
    let dir = |raw: Value| {
        parsed(&with_ws(merged(&empty_ws(), json!({"projectDir": raw})))).unwrap()["workspaces"][0]
            .get("projectDir")
            .cloned()
    };
    let long = "/p".repeat(3000);
    let cut = long[..4096].to_owned();
    assert_eq!(dir(json!(long)), Some(json!(cut)));
    assert_eq!(dir(json!("/home/u/proj")), Some(json!("/home/u/proj")));
    assert_eq!(dir(json!("")), None);
    assert_eq!(dir(json!(3)), None);
}

#[test]
fn keeps_the_anchored_mark_only_when_it_is_true() {
    let anchored = |raw: Value| {
        parsed(&with_ws(merged(&ws0(), json!({"anchored": raw})))).unwrap()["workspaces"][0]
            .get("anchored")
            .cloned()
    };
    assert_eq!(anchored(json!(true)), Some(json!(true)));
    assert_eq!(anchored(json!(false)), None);
    assert_eq!(anchored(json!("yes")), None);
}

#[test]
fn clamps_the_origin_index_and_keeps_a_valid_group_and_placement_in_it() {
    let origin = |raw: Value| {
        parsed(&with_ws(merged(&ws0(), json!({"origin": raw})))).unwrap()["workspaces"][0]
            .get("origin")
            .cloned()
    };
    for (index, want) in [
        (json!(5000), 1000),
        (json!(-3), 0),
        (json!(7), 7),
        (json!(2.5), 0),
        (json!("x"), 0),
        (json!(null), 0),
    ] {
        let got = origin(json!({"workspaceId": "w0", "index": index.clone()})).unwrap();
        assert_eq!(got, json!({"workspaceId": "w0", "index": want}), "{index}");
    }
    let full = origin(json!({
        "workspaceId": "w0", "index": 2, "groupId": "g0",
        "beside": {"paneId": "p0", "zone": "bottom"}
    }))
    .unwrap();
    assert_eq!(
        full,
        json!({"workspaceId": "w0", "index": 2, "groupId": "g0", "beside": {"paneId": "p0", "zone": "bottom"}})
    );
    let loose = origin(json!({
        "workspaceId": "w0", "groupId": "", "beside": {"paneId": "p0", "zone": "middle"}
    }))
    .unwrap();
    assert_eq!(loose, json!({"workspaceId": "w0", "index": 0}));
    assert!(origin(json!({"index": 1})).is_none());
    assert!(origin(json!({"workspaceId": "", "index": 1})).is_none());
    assert!(origin(json!("w0")).is_none());
}

#[test]
fn reads_an_origin_index_written_with_a_fraction_part_as_a_whole_number() {
    let raw: Value = serde_json::from_str(
        r#"{"v":1,"savedAt":"t","workspaces":[{"id":"a","origin":{"workspaceId":"w0","index":7.0}}],"groups":[]}"#,
    )
    .unwrap();
    assert_eq!(parsed(&raw).unwrap()["workspaces"][0]["origin"]["index"], 7);
}

#[test]
fn drops_a_group_name_after_cutting_it_at_sixty_units_and_trimming_again() {
    let name = format!("{} {}", "a".repeat(59), "b".repeat(5));
    let mut member = ws0();
    member["groupId"] = json!("g1");
    let result = parsed(&snap_with(json!({
        "workspaces": [member],
        "groups": [{"id": "g1", "name": name}]
    })))
    .unwrap();
    assert_eq!(result["groups"][0]["name"], "a".repeat(59));
}

#[test]
fn keeps_a_group_color_only_from_the_known_list_and_collapsed_only_when_true() {
    let mut member = ws0();
    member["groupId"] = json!("g1");
    let group = |color: Value, collapsed: Value| {
        parsed(&snap_with(json!({
            "workspaces": [member.clone()],
            "groups": [{"id": "g1", "name": "api", "color": color, "collapsed": collapsed}]
        })))
        .unwrap()["groups"][0]
            .clone()
    };
    assert_eq!(
        group(json!("teal"), json!(true)),
        json!({"id": "g1", "name": "api", "color": "teal", "collapsed": true})
    );
    assert_eq!(
        group(json!("mauve"), json!("yes")),
        json!({"id": "g1", "name": "api"})
    );
    for color in [
        "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink",
    ] {
        assert_eq!(group(json!(color), json!(false))["color"], color);
    }
}

#[test]
fn keeps_at_most_thirty_two_groups_and_ignores_groups_that_are_not_a_list() {
    let groups: Vec<Value> = (0..40)
        .map(|i| json!({"id": format!("g{i}"), "name": format!("group {i}")}))
        .collect();
    let workspaces: Vec<Value> = (0..32)
        .map(|i| {
            json!({
                "id": format!("w{i}"), "name": "x", "kind": "terminal", "workDir": "/tmp",
                "groupId": format!("g{}", i + 8)
            })
        })
        .collect();
    let result = parsed(&snap_with(
        json!({"workspaces": workspaces, "groups": groups}),
    ))
    .unwrap();
    assert_eq!(result["groups"].as_array().unwrap().len(), 24);
    assert_eq!(result["workspaces"][23]["groupId"], "g31");
    assert!(!has(&result["workspaces"][24], "groupId"));
    let not_list = parsed(&snap_with(json!({"groups": {"id": "g1", "name": "x"}}))).unwrap();
    assert_eq!(not_list["groups"], json!([]));
}

#[test]
fn keeps_the_pinned_mark_over_a_group_membership() {
    let mut pinned = ws0();
    pinned["groupId"] = json!("g1");
    pinned["pinned"] = json!(true);
    let result = parsed(&snap_with(json!({
        "workspaces": [pinned],
        "groups": [{"id": "g1", "name": "api"}]
    })))
    .unwrap();
    assert!(!has(&result["workspaces"][0], "groupId"));
    assert_eq!(result["groups"], json!([]));
}

#[test]
fn keeps_at_most_sixty_four_panes_in_a_workspace() {
    let flat = |count: usize| {
        let children: Vec<Value> = (0..count).map(|i| term(&format!("p{i}"))).collect();
        let sizes: Vec<Value> = (0..count).map(|_| json!(1)).collect();
        json!({"type": "split", "id": "sp", "direction": "horizontal", "children": children, "sizes": sizes})
    };
    assert_eq!(
        root_of(&root_snap(flat(64))).unwrap()["children"]
            .as_array()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(workspaces_of(&root_snap(flat(65))), json!([]));
}

#[test]
fn copies_optional_pane_strings_only_when_they_are_non_empty_text() {
    let terminal = pane_with(json!({"cwd": "", "url": 5, "filePath": "/a/b"})).unwrap();
    assert!(!has(&terminal, "cwd"));
    assert!(!has(&terminal, "url"));
    assert_eq!(terminal["filePath"], "/a/b");
    let with_url = pane_with(json!({"url": "http://x/", "cwd": "/w"})).unwrap();
    assert!(contains(
        &with_url,
        &json!({"url": "http://x/", "cwd": "/w"})
    ));
}

#[test]
fn keeps_a_chat_session_id_only_on_a_chat_pane_and_an_agent_session_id_only_on_an_agent_pane() {
    let both = json!({"chatSessionId": "c1", "agentSessionId": "a1"});
    let terminal = pane_with(both.clone()).unwrap();
    assert!(!has(&terminal, "chatSessionId"));
    assert!(!has(&terminal, "agentSessionId"));
    let chat = pane_with(merged(&both, json!({"kind": "chat"}))).unwrap();
    assert_eq!(chat["chatSessionId"], "c1");
    assert!(!has(&chat, "agentSessionId"));
    let agent = pane_with(merged(&both, json!({"kind": "agent"}))).unwrap();
    assert_eq!(agent["agentSessionId"], "a1");
    assert!(!has(&agent, "chatSessionId"));
}

#[test]
fn uses_the_id_as_the_title_when_the_title_is_not_text_and_keeps_an_empty_title() {
    let no_title = pane_with(json!({"title": 5})).unwrap();
    assert_eq!(no_title["title"], "pane-1");
    let empty = pane_with(json!({"title": ""})).unwrap();
    assert_eq!(empty["title"], "");
}

#[test]
fn refuses_a_pane_with_no_kind_or_a_non_text_kind_and_a_pane_with_no_id() {
    for pane in [
        without(&pane0(), &["kind"]),
        merged(&pane0(), json!({"kind": 5})),
        without(&pane0(), &["id"]),
        merged(&pane0(), json!({"id": ""})),
        merged(&pane0(), json!({"type": "widget"})),
    ] {
        assert_eq!(workspaces_of(&root_snap(pane.clone())), json!([]), "{pane}");
    }
}

#[test]
fn keeps_a_view_type_only_on_an_editor_pane_and_only_when_it_is_a_view_type() {
    let editor = |view: Value| {
        pane_with(json!({"kind": "editor", "filePath": "/a.md", "viewType": view})).unwrap()
    };
    assert_eq!(editor(json!("default"))["viewType"], "default");
    assert_eq!(editor(json!("ext.preview"))["viewType"], "ext.preview");
    for bad in [json!("Bad Type"), json!("nodot"), json!(""), json!(5)] {
        assert!(!has(&editor(bad.clone()), "viewType"), "{bad}");
    }
    let terminal = pane_with(json!({"viewType": "default"})).unwrap();
    assert!(!has(&terminal, "viewType"));
}

#[test]
fn keeps_a_view_name_on_any_pane_only_when_it_matches_the_view_name_pattern() {
    let named = |name: Value| pane_with(json!({"viewName": name})).unwrap();
    assert_eq!(named(json!("board"))["viewName"], "board");
    let forty = "a".repeat(40);
    assert_eq!(named(json!(forty))["viewName"], "a".repeat(40));
    for bad in [
        json!("a".repeat(41)),
        json!("Board"),
        json!("-board"),
        json!("board\n"),
        json!(""),
        json!(5),
    ] {
        assert!(!has(&named(bad.clone()), "viewName"), "{bad}");
    }
}

#[test]
fn keeps_the_locked_mark_only_when_it_is_true() {
    assert_eq!(pane_with(json!({"locked": true})).unwrap()["locked"], true);
    assert!(!has(
        &pane_with(json!({"locked": "yes"})).unwrap(),
        "locked"
    ));
    assert!(!has(
        &pane_with(json!({"locked": false})).unwrap(),
        "locked"
    ));
}

#[test]
fn keeps_a_hibernated_mark_only_with_a_resume_token_and_never_with_the_running_mark() {
    let resume = json!({"agent": "claude", "id": "abc-1"});
    let asleep = pane_with(json!({"resume": resume.clone(), "hibernated": true})).unwrap();
    assert_eq!(asleep["hibernated"], true);
    assert!(!has(&asleep, "agentRunning"));
    assert!(!has(
        &pane_with(json!({"hibernated": true})).unwrap(),
        "hibernated"
    ));
    assert!(!has(
        &pane_with(json!({"resume": resume, "hibernated": "yes"})).unwrap(),
        "hibernated"
    ));
}

#[test]
fn keeps_a_failed_resume_only_for_an_exit_code_from_one_to_255() {
    let failed = |code: Value| {
        pane_with(json!({
            "resumeFailed": {"resume": {"agent": "claude", "id": "dead-1"}, "exitCode": code}
        }))
        .unwrap()
    };
    for kept in [json!(1), json!(255)] {
        assert!(has(&failed(kept.clone()), "resumeFailed"), "{kept}");
    }
    for dropped in [
        json!(0),
        json!(256),
        json!(-1),
        json!(1.5),
        json!(null),
        json!("1"),
    ] {
        assert!(!has(&failed(dropped.clone()), "resumeFailed"), "{dropped}");
    }
}

#[test]
fn writes_the_pane_fields_in_the_order_the_ts_code_builds_them() {
    let pane = pane_with(json!({
        "cwd": "/w", "filePath": "/a", "url": "http://x/", "viewName": "board",
        "resume": {"agent": "claude", "id": "abc-1"}, "agentRunning": true, "keepAwake": true,
        "locked": true, "titlePinned": true, "defaultTitle": true,
        "title": "t"
    }))
    .unwrap();
    let keys: Vec<&str> = pane
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "type",
            "id",
            "title",
            "kind",
            "cwd",
            "filePath",
            "url",
            "viewName",
            "resume",
            "agentRunning",
            "keepAwake",
            "locked",
            "defaultTitle",
            "titlePinned"
        ]
    );
}

#[test]
fn keeps_a_split_direction_of_vertical_and_reads_anything_else_as_horizontal() {
    for (direction, want) in [
        (json!("vertical"), "vertical"),
        (json!("horizontal"), "horizontal"),
        (json!("diagonal"), "horizontal"),
        (json!(5), "horizontal"),
    ] {
        let mut split = split_of("pane-1", "pane-2");
        split["direction"] = direction.clone();
        assert_eq!(
            root_of(&root_snap(split)).unwrap()["direction"],
            want,
            "{direction}"
        );
    }
    let mut no_direction = split_of("pane-1", "pane-2");
    no_direction
        .as_object_mut()
        .unwrap()
        .shift_remove("direction");
    assert_eq!(
        root_of(&root_snap(no_direction)).unwrap()["direction"],
        "horizontal"
    );
}

#[test]
fn keeps_sizes_that_are_positive_finite_numbers_and_rebuilds_the_rest() {
    let sized = |sizes: Value| {
        let mut split = split_of("pane-1", "pane-2");
        split["sizes"] = sizes;
        root_of(&root_snap(split)).unwrap()["sizes"].clone()
    };
    assert_eq!(sized(json!([2, 1])), json!([2, 1]));
    assert_eq!(sized(json!([1.5, 2])), json!([1.5, 2]));
    for bad in [
        json!([0, 1]),
        json!([-1, 1]),
        json!(["1", 1]),
        json!([null, 1]),
        json!([1, 1, 1]),
        json!("1,1"),
        json!(null),
    ] {
        assert_eq!(sized(bad.clone()), json!([1, 1]), "{bad}");
    }
}

#[test]
fn rebuilds_every_size_to_one_when_a_pane_was_dropped_and_the_sizes_were_bad() {
    let split = json!({
        "type": "split", "id": "sp", "direction": "horizontal",
        "children": [named_term("a"), retired("b"), named_term("c")],
        "sizes": [1, 0, 3]
    });
    let root = root_of(&root_snap(split)).unwrap();
    assert_eq!(root["sizes"], json!([1, 1]));
}

#[test]
fn keeps_a_split_with_one_pane_unless_a_pane_was_dropped_or_it_sits_in_a_tab() {
    let lone = json!({
        "type": "split", "id": "sp", "direction": "vertical",
        "children": [term("pane-1")], "sizes": [4]
    });
    let root = root_of(&root_snap(lone.clone())).unwrap();
    assert!(contains(&root, &json!({"type": "split", "sizes": [4]})));
    let tabs = json!({
        "type": "tabs", "id": "tabs-3", "activeId": "pane-1",
        "children": [lone, term("pane-2")]
    });
    let root = root_of(&root_snap(tabs)).unwrap();
    assert!(contains(
        &root["children"][0],
        &json!({"type": "pane", "id": "pane-1"})
    ));
}

#[test]
fn refuses_a_tab_stack_with_no_tabs_or_with_a_child_that_is_not_a_pane_or_split() {
    let tabs =
        |children: Value| json!({"type": "tabs", "id": "t", "activeId": "a", "children": children});
    for bad in [
        tabs(json!([])),
        tabs(json!("x")),
        tabs(json!([term("a"), 5])),
        tabs(json!([term("a"), {"type": "widget", "id": "w"}])),
    ] {
        assert_eq!(workspaces_of(&root_snap(bad.clone())), json!([]), "{bad}");
    }
    let all_retired = tabs(json!([retired("a"), retired("b")]));
    let workspace = retired_with_root(all_retired, "a").unwrap();
    assert!(!has(&workspace, "root"));
}

#[test]
fn keeps_the_shown_tab_when_it_is_a_pane_inside_a_split_tab() {
    let tabs = json!({
        "type": "tabs", "id": "t", "activeId": "pane-3",
        "children": [term("pane-1"), split_of("pane-2", "pane-3")]
    });
    assert_eq!(root_of(&root_snap(tabs)).unwrap()["activeId"], "pane-3");
}

#[test]
fn reads_a_pane_drop_with_its_placement_and_ignores_other_keys() {
    let drop = json!({
        "workspaceId": "w1", "extra": 1,
        "placement": {"zone": "left", "paneId": "p2", "x": 1},
        "paneId": "p1"
    });
    let result = serde_json::to_value(parse_pane_drop(&drop).unwrap()).unwrap();
    assert_eq!(
        result,
        json!({"paneId": "p1", "workspaceId": "w1", "placement": {"paneId": "p2", "zone": "left"}})
    );
    for zone in ["left", "right", "top", "bottom", "center"] {
        let drop = json!({"paneId": "p1", "workspaceId": "w1", "placement": {"paneId": "p2", "zone": zone}});
        assert!(parse_pane_drop(&drop).is_some(), "{zone}");
    }
}

#[test]
fn refuses_a_pane_drop_with_a_missing_or_malformed_part() {
    let good =
        json!({"paneId": "p1", "workspaceId": "w1", "placement": {"paneId": "p2", "zone": "left"}});
    let rows = [
        without(&good, &["paneId"]),
        without(&good, &["workspaceId"]),
        without(&good, &["placement"]),
        merged(&good, json!({"paneId": ""})),
        merged(&good, json!({"workspaceId": 5})),
        merged(&good, json!({"placement": "left"})),
        merged(
            &good,
            json!({"placement": {"paneId": "p2", "zone": "middle"}}),
        ),
        merged(&good, json!({"placement": {"paneId": "p2", "zone": 5}})),
        merged(&good, json!({"placement": {"paneId": "", "zone": "left"}})),
        merged(&good, json!({"placement": {"zone": "left"}})),
        json!("drop"),
        json!(null),
    ];
    for row in rows {
        assert!(parse_pane_drop(&row).is_none(), "{row}");
    }
}

#[test]
fn counts_an_id_in_utf16_units_against_the_limit_of_256() {
    let drop = |id: &str| json!({"paneId": id, "workspaceId": "w1", "placement": {"paneId": "p2", "zone": "top"}});
    assert!(parse_pane_drop(&drop(&"a".repeat(256))).is_some());
    assert!(parse_pane_drop(&drop(&"a".repeat(257))).is_none());
    assert!(parse_pane_drop(&drop(&"é".repeat(256))).is_some());
    assert!(parse_pane_drop(&drop(&"😀".repeat(128))).is_some());
    assert!(parse_pane_drop(&drop(&"😀".repeat(129))).is_none());
}

#[test]
fn lists_the_pane_ids_of_a_handoff_in_tree_order_and_none_without_a_layout() {
    let inner = json!({
        "type": "split", "id": "sp", "direction": "horizontal",
        "children": [term("b"), term("c")], "sizes": [1, 1]
    });
    let tabs = json!({
        "type": "tabs", "id": "t", "activeId": "a",
        "children": [term("a"), inner]
    });
    let workspace = merged(&ws0(), json!({"activePaneId": "a", "root": tabs}));
    let handoff = parse_handoff(&workspace).unwrap();
    assert_eq!(handoff_pane_ids(&handoff), vec!["a", "b", "c"]);
    let empty = parse_handoff(&empty_ws()).unwrap();
    assert!(handoff_pane_ids(&empty).is_empty());
}

#[test]
fn reads_a_handoff_without_groups_and_with_its_own_claims() {
    let mut member = ws0();
    member["groupId"] = json!("g1");
    let handoff = serde_json::to_value(parse_handoff(&member).unwrap()).unwrap();
    assert!(!has(&handoff, "groupId"));
    assert!(parse_handoff(&json!(null)).is_none());
    assert!(parse_handoff(&without(&ws0(), &["id"])).is_none());
    assert!(parse_handoff(&merged(&ws0(), json!({"root": split_of("p", "p")}))).is_none());
}

#[test]
fn keeps_the_text_of_a_snapshot_free_of_a_resume_environment() {
    let raw = pane_with(json!({"resume": {
        "agent": "codex", "id": "abc-1", "env": {"OPENAI_API_KEY": "sk-secret"},
        "typed": {"env": [{"name": "FOO", "value": "bar"}]}
    }}))
    .unwrap();
    let text = text_of(&raw);
    assert!(!text.contains("sk-secret"), "{text}");
}
