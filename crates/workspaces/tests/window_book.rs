#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_workspaces::PanePlacementZone;
use ostia_workspaces::window_book::{
    DetachedSlot, LANDING_CLAIM_MS, LANDING_GIVE_MS, Landing, Landings, MAIN_SLOT, ReturnPlan,
    ScreenPoint, WindowBook, WindowSize, bounds_at, clamp_bounds, crosses_sandbox, merge_snapshots,
    parse_point, plan_return, split_snapshot, without_origin,
};
use ostia_workspaces::workspace_snapshot::model::{
    AppSnapshot, PanePlacement, SnapshotWorkspace, WindowBounds,
};
use ostia_workspaces::workspace_snapshot::{
    handoff_pane_ids, parse_handoff, parse_pane_drop, parse_snapshot,
};
use serde_json::{Value, json};

const BOUNDS: WindowBounds = WindowBounds {
    x: 100,
    y: 50,
    width: 900,
    height: 600,
};

fn bounds(x: i64, y: i64, width: i64, height: i64) -> WindowBounds {
    WindowBounds {
        x,
        y,
        width,
        height,
    }
}

fn workspace_json(id: &str, pane_id: &str) -> Value {
    json!({
        "id": id,
        "name": id,
        "kind": "terminal",
        "workDir": format!("/home/u/{id}"),
        "activePaneId": pane_id,
        "root": {"type": "pane", "id": pane_id, "title": "zsh", "kind": "terminal"}
    })
}

fn with(base: Value, extra: Value) -> Value {
    let mut out = base;
    for (key, value) in extra.as_object().unwrap() {
        out.as_object_mut()
            .unwrap()
            .insert(key.clone(), value.clone());
    }
    out
}

fn workspace_with(id: &str, pane_id: &str, extra: Value) -> Value {
    with(workspace_json(id, pane_id), extra)
}

fn snapshot_json(workspaces: &[Value], extra: Value) -> Value {
    let active = workspaces
        .first()
        .map(|w| w["id"].clone())
        .unwrap_or(Value::Null);
    with(
        json!({
            "v": 1,
            "savedAt": "t0",
            "activeWorkspaceId": active,
            "workspaces": workspaces,
            "groups": []
        }),
        extra,
    )
}

fn snap_with(workspaces: &[Value], extra: Value) -> AppSnapshot {
    parse_snapshot(&snapshot_json(workspaces, extra)).unwrap()
}

fn snap(workspaces: &[Value]) -> AppSnapshot {
    snap_with(workspaces, json!({}))
}

fn bounds_json(b: WindowBounds) -> Value {
    json!({"x": b.x, "y": b.y, "width": b.width, "height": b.height})
}

fn handoff(raw: Value) -> SnapshotWorkspace {
    parse_handoff(&raw).unwrap()
}

fn slot(id: &str, snapshot: AppSnapshot) -> DetachedSlot {
    DetachedSlot {
        id: id.to_owned(),
        bounds: BOUNDS,
        snapshot,
    }
}

fn j<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn ids(workspaces: &[SnapshotWorkspace]) -> Vec<String> {
    workspaces.iter().map(|w| w.id.clone()).collect()
}

fn reparsed(book: &WindowBook) -> AppSnapshot {
    parse_snapshot(&j(&book.merged("t"))).unwrap()
}

#[test]
fn keeps_the_main_window_at_the_top_level_and_each_detached_window_in_windows() {
    let merged = merge_snapshots(
        Some(&snap(&[workspace_json("w1", "pane-1")])),
        &[slot("d1", snap(&[workspace_json("w2", "pane-2")]))],
        "t1",
    );
    assert_eq!(ids(&merged.workspaces), ["w1"]);
    assert_eq!(
        j(&merged.windows),
        json!([{
            "id": "d1",
            "bounds": bounds_json(BOUNDS),
            "activeWorkspaceId": "w2",
            "workspaces": [workspace_json("w2", "pane-2")]
        }])
    );
    assert_eq!(merged.saved_at, "t1");
}

#[test]
fn drops_a_detached_window_that_holds_no_workspace() {
    let merged = merge_snapshots(None, &[slot("d1", snap(&[]))], "t");
    assert!(merged.windows.is_empty());
    assert!(merged.workspaces.is_empty());
}

#[test]
fn keeps_each_windows_left_panel_apart() {
    let merged = merge_snapshots(
        Some(&snap_with(
            &[workspace_json("w1", "pane-1")],
            json!({"leftPanel": "files"}),
        )),
        &[
            slot(
                "d1",
                snap_with(
                    &[workspace_json("w2", "pane-2")],
                    json!({"leftPanel": "files"}),
                ),
            ),
            slot("d2", snap(&[workspace_json("w3", "pane-3")])),
        ],
        "t1",
    );
    assert_eq!(j(&merged.left_panel), json!("files"));
    let panels: Vec<Value> = merged.windows.iter().map(|w| j(&w.left_panel)).collect();
    assert_eq!(panels, [json!("files"), Value::Null]);
    let split = split_snapshot(Some(&merged));
    let detached: Vec<Value> = split
        .detached
        .iter()
        .map(|d| j(&d.snapshot.left_panel))
        .collect();
    assert_eq!(detached, [json!("files"), Value::Null]);
}

#[test]
fn keeps_each_windows_right_panel_apart() {
    let merged = merge_snapshots(
        Some(&snap_with(
            &[workspace_json("w1", "pane-1")],
            json!({"rightPanel": "graphs"}),
        )),
        &[
            slot(
                "d1",
                snap_with(
                    &[workspace_json("w2", "pane-2")],
                    json!({"rightPanel": "keeper"}),
                ),
            ),
            slot("d2", snap(&[workspace_json("w3", "pane-3")])),
        ],
        "t1",
    );
    assert_eq!(merged.right_panel.as_deref(), Some("graphs"));
    let panels: Vec<Option<&str>> = merged
        .windows
        .iter()
        .map(|w| w.right_panel.as_deref())
        .collect();
    assert_eq!(panels, [Some("keeper"), None]);
    let split = split_snapshot(Some(&merged));
    let detached: Vec<Option<&str>> = split
        .detached
        .iter()
        .map(|d| d.snapshot.right_panel.as_deref())
        .collect();
    assert_eq!(detached, [Some("keeper"), None]);
}

#[test]
fn round_trips_through_split_snapshot() {
    let merged = merge_snapshots(
        Some(&snap(&[workspace_json("w1", "pane-1")])),
        &[slot("d1", snap(&[workspace_json("w2", "pane-2")]))],
        "t1",
    );
    let split = split_snapshot(Some(&merged));
    let main = split.main.unwrap();
    assert_eq!(ids(&main.workspaces), ["w1"]);
    assert!(main.windows.is_empty());
    assert_eq!(split.detached.len(), 1);
    assert_eq!(ids(&split.detached[0].snapshot.workspaces), ["w2"]);
}

#[test]
fn splits_no_file_into_nothing() {
    let split = split_snapshot(None);
    assert!(split.main.is_none());
    assert!(split.detached.is_empty());
}

#[test]
fn does_not_let_one_window_save_over_another_windows_workspaces() {
    let mut book = WindowBook::new(None);
    book.open("d1", BOUNDS);
    book.save("d1", snap(&[workspace_json("w2", "pane-2")]));
    book.save(MAIN_SLOT, snap(&[workspace_json("w1", "pane-1")]));
    let merged = book.merged("t");
    assert_eq!(ids(&merged.workspaces), ["w1"]);
    assert_eq!(ids(&merged.windows[0].workspaces), ["w2"]);
}

#[test]
fn moves_a_workspace_between_windows_without_duplicating_it() {
    let mut book = WindowBook::new(Some(&snap(&[
        workspace_json("w1", "pane-1"),
        workspace_json("w2", "pane-2"),
    ])));
    book.open("d1", BOUNDS);
    book.move_workspace(
        &handoff(workspace_with("w2", "pane-2", json!({"groupId": "g1"}))),
        MAIN_SLOT,
        "d1",
    );
    let merged = book.merged("t");
    assert_eq!(ids(&merged.workspaces), ["w1"]);
    assert_eq!(
        j(&merged.windows[0].workspaces),
        json!([workspace_json("w2", "pane-2")])
    );
    assert_eq!(merged.windows[0].active_workspace_id.as_deref(), Some("w2"));

    book.move_workspace(&handoff(workspace_json("w2", "pane-2")), "d1", MAIN_SLOT);
    book.drop_slot("d1");
    let back = book.merged("t");
    assert_eq!(ids(&back.workspaces), ["w1", "w2"]);
    assert_eq!(back.active_workspace_id.as_deref(), Some("w2"));
    assert!(back.windows.is_empty());
}

#[test]
fn keeps_the_hibernated_mark_of_a_pane_carried_by_a_handoff() {
    let mut book = WindowBook::new(None);
    book.open("d1", BOUNDS);
    let mut moving = workspace_json("w2", "pane-2");
    moving["root"]["resume"] = json!({"agent": "claude", "id": "abc"});
    moving["root"]["hibernated"] = json!(true);
    book.move_workspace(&handoff(moving), MAIN_SLOT, "d1");
    let merged = j(&book.merged("t"));
    let root = &merged["windows"][0]["workspaces"][0]["root"];
    assert_eq!(root["id"], "pane-2");
    assert_eq!(root["hibernated"], true);
}

#[test]
fn keeps_the_lock_of_a_pane_carried_by_a_handoff() {
    let mut book = WindowBook::new(None);
    book.open("d1", BOUNDS);
    let mut moving = workspace_json("w2", "pane-2");
    moving["root"]["locked"] = json!(true);
    book.move_workspace(&handoff(moving), MAIN_SLOT, "d1");
    let merged = j(&book.merged("t"));
    let root = &merged["windows"][0]["workspaces"][0]["root"];
    assert_eq!(root["id"], "pane-2");
    assert_eq!(root["locked"], true);
}

#[test]
fn restores_detached_windows_with_their_bounds_from_the_merged_file() {
    let book = WindowBook::new(Some(&snap_with(
        &[workspace_json("w1", "pane-1")],
        json!({"windows": [{
            "id": "d1",
            "bounds": bounds_json(BOUNDS),
            "activeWorkspaceId": "w2",
            "workspaces": [workspace_json("w2", "p2")]
        }]}),
    )));
    let slots: Vec<(String, WindowBounds)> = book
        .slots()
        .iter()
        .map(|s| (s.id.clone(), s.bounds))
        .collect();
    assert_eq!(slots, [("d1".to_owned(), BOUNDS)]);
    assert_eq!(ids(&book.load("d1").unwrap().workspaces), ["w2"]);
    assert_eq!(ids(&book.load(MAIN_SLOT).unwrap().workspaces), ["w1"]);
}

#[test]
fn keeps_the_main_window_bounds_out_of_the_renderer_snapshot_and_in_the_merged_file() {
    let mut book = WindowBook::new(Some(&snap_with(
        &[workspace_json("w1", "pane-1")],
        json!({"bounds": bounds_json(BOUNDS)}),
    )));
    assert_eq!(book.bounds_of(MAIN_SLOT), Some(BOUNDS));
    assert!(book.load(MAIN_SLOT).unwrap().bounds.is_none());

    let moved = bounds(76, 80, 1361, 854);
    book.set_bounds(MAIN_SLOT, moved);
    book.save(
        MAIN_SLOT,
        snap_with(
            &[workspace_json("w1", "pane-1")],
            json!({"bounds": bounds_json(BOUNDS)}),
        ),
    );
    assert_eq!(book.merged("t").bounds, Some(moved));
    assert_eq!(
        WindowBook::new(Some(&reparsed(&book))).bounds_of(MAIN_SLOT),
        Some(moved)
    );
}

#[test]
fn remembers_where_a_workspace_last_was_in_its_own_window() {
    let mut book = WindowBook::new(Some(&snap(&[
        workspace_json("w1", "pane-1"),
        workspace_json("w2", "pane-2"),
    ])));
    book.open("d1", BOUNDS);
    book.move_workspace(&handoff(workspace_json("w2", "pane-2")), MAIN_SLOT, "d1");
    assert_eq!(book.last_detached_bounds("w2"), None);

    let moved = bounds(20, 40, 800, 500);
    book.set_bounds("d1", moved);
    book.move_workspace(&handoff(workspace_json("w2", "pane-2")), "d1", MAIN_SLOT);
    book.drop_slot("d1");
    assert_eq!(book.last_detached_bounds("w2"), Some(moved));
    assert_eq!(
        j(&book.merged("t").detached_bounds),
        json!({"w2": bounds_json(moved)})
    );
    assert_eq!(
        WindowBook::new(Some(&reparsed(&book))).last_detached_bounds("w2"),
        Some(moved)
    );
    assert!(book.load(MAIN_SLOT).unwrap().detached_bounds.is_none());

    book.save(MAIN_SLOT, snap(&[workspace_json("w1", "pane-1")]));
    assert!(book.merged("t").detached_bounds.is_none());
}

#[test]
fn ignores_saves_from_a_slot_that_was_never_opened() {
    let mut book = WindowBook::new(None);
    book.save("ghost", snap(&[workspace_json("w9", "pane-9")]));
    assert!(book.merged("t").windows.is_empty());
}

#[test]
fn ignores_bounds_for_a_slot_that_was_never_opened() {
    let mut book = WindowBook::new(None);
    book.set_bounds("ghost", BOUNDS);
    assert_eq!(book.bounds_of("ghost"), None);
    assert!(book.load("ghost").is_none());
}

#[test]
fn saves_a_detached_window_without_groups() {
    let mut book = WindowBook::new(None);
    book.open("d1", BOUNDS);
    let grouped = snap_with(
        &[workspace_with("w2", "pane-2", json!({"groupId": "g1"}))],
        json!({"groups": [{"id": "g1", "name": "work"}]}),
    );
    assert_eq!(grouped.groups.len(), 1);
    book.save("d1", grouped);
    assert!(book.load("d1").unwrap().groups.is_empty());
}

#[test]
fn hands_the_active_workspace_to_the_first_one_left_when_it_moves_away() {
    let mut book = WindowBook::new(Some(&snap_with(
        &[
            workspace_json("w1", "pane-1"),
            workspace_json("w2", "pane-2"),
        ],
        json!({"activeWorkspaceId": "w1"}),
    )));
    book.open("d1", BOUNDS);
    book.move_workspace(&handoff(workspace_json("w1", "pane-1")), MAIN_SLOT, "d1");
    let main = book.load(MAIN_SLOT).unwrap();
    assert_eq!(main.active_workspace_id.as_deref(), Some("w2"));
    book.move_workspace(&handoff(workspace_json("w2", "pane-2")), MAIN_SLOT, "d1");
    assert_eq!(book.load(MAIN_SLOT).unwrap().active_workspace_id, None);
}

#[test]
fn drops_the_origin_of_a_workspace() {
    let with_origin = handoff(workspace_with(
        "w9",
        "pane-9",
        json!({"origin": {"workspaceId": "w1", "index": 2}}),
    ));
    assert!(with_origin.origin.is_some());
    let bare = without_origin(with_origin);
    assert!(bare.origin.is_none());
    assert_eq!(bare.id, "w9");
}

fn left() -> WindowBounds {
    bounds(0, 0, 1920, 1080)
}

fn right() -> WindowBounds {
    bounds(1920, 0, 1280, 1024)
}

#[test]
fn keeps_a_window_on_the_display_it_mostly_overlaps() {
    let window = bounds(2000, 100, 800, 600);
    assert_eq!(clamp_bounds(window, &[left(), right()]), window);
}

#[test]
fn pulls_a_window_from_a_disconnected_display_onto_the_primary_one() {
    let window = bounds(4000, 100, 800, 600);
    assert_eq!(clamp_bounds(window, &[left()]), bounds(1120, 100, 800, 600));
}

#[test]
fn shrinks_a_window_larger_than_its_display() {
    let window = bounds(1900, -50, 3000, 2000);
    assert_eq!(
        clamp_bounds(window, &[left(), right()]),
        bounds(1920, 0, 1280, 1024)
    );
}

#[test]
fn leaves_the_window_alone_when_there_is_no_display() {
    let window = bounds(4000, 100, 800, 600);
    assert_eq!(clamp_bounds(window, &[]), window);
}

#[test]
fn parses_detached_windows_and_refuses_a_pane_claimed_twice_across_windows() {
    let parsed = parse_snapshot(&snapshot_json(
        &[workspace_json("w1", "pane-1")],
        json!({"windows": [
            {
                "id": "d1",
                "bounds": bounds_json(BOUNDS),
                "activeWorkspaceId": "w2",
                "workspaces": [workspace_json("w2", "p2")]
            },
            {
                "id": "d2",
                "bounds": bounds_json(BOUNDS),
                "activeWorkspaceId": "w3",
                "workspaces": [workspace_json("w3", "pane-1")]
            }
        ]}),
    ))
    .unwrap();
    let windows: Vec<&str> = parsed.windows.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(windows, ["d1"]);
}

#[test]
fn keeps_last_detached_bounds_only_for_workspaces_in_the_file() {
    let mut tiny = bounds_json(BOUNDS);
    tiny["height"] = json!(1);
    let parsed = parse_snapshot(&snapshot_json(
        &[workspace_json("w1", "pane-1")],
        json!({"detachedBounds": {
            "w1": bounds_json(BOUNDS),
            "gone": bounds_json(BOUNDS),
            "w9": tiny
        }}),
    ))
    .unwrap();
    assert_eq!(
        j(&parsed.detached_bounds),
        json!({"w1": bounds_json(BOUNDS)})
    );
}

#[test]
fn keeps_valid_main_window_bounds_and_drops_invalid_ones() {
    let valid =
        parse_snapshot(&snapshot_json(&[], json!({"bounds": bounds_json(BOUNDS)}))).unwrap();
    assert_eq!(valid.bounds, Some(BOUNDS));
    let mut tiny = bounds_json(BOUNDS);
    tiny["width"] = json!(10);
    let dropped = parse_snapshot(&snapshot_json(&[], json!({"bounds": tiny}))).unwrap();
    assert!(dropped.bounds.is_none());
    assert!(!j(&dropped).as_object().unwrap().contains_key("bounds"));
}

#[test]
fn drops_a_window_with_invalid_bounds_or_id() {
    let parsed = parse_snapshot(&snapshot_json(
        &[],
        json!({"windows": [
            {
                "id": "../x",
                "bounds": bounds_json(BOUNDS),
                "activeWorkspaceId": null,
                "workspaces": [workspace_json("w2", "p2")]
            },
            {
                "id": "d2",
                "bounds": {"x": 0, "y": 0, "width": 10, "height": 600},
                "activeWorkspaceId": null,
                "workspaces": [workspace_json("w3", "p3")]
            }
        ]}),
    ))
    .unwrap();
    assert!(parsed.windows.is_empty());
}

#[test]
fn keeps_a_hibernated_mark_from_the_file_only_for_a_pane_that_can_be_resumed() {
    let mut resumable = workspace_json("w1", "pane-1");
    resumable["root"]["resume"] = json!({"agent": "claude", "id": "abc"});
    resumable["root"]["hibernated"] = json!(true);
    let mut plain = workspace_json("w2", "pane-2");
    plain["root"]["hibernated"] = json!(true);
    let parsed = j(&snap(&[resumable, plain]));
    let first = &parsed["workspaces"][0]["root"];
    assert_eq!(first["id"], "pane-1");
    assert_eq!(first["hibernated"], true);
    assert!(!parsed["workspaces"][1].to_string().contains("hibernated"));
}

#[test]
fn keeps_the_hibernated_mark_of_a_pane_with_a_resume_token() {
    let mut w = workspace_json("w1", "pane-1");
    w["root"]["resume"] = json!({"agent": "claude", "id": "abc", "cwd": "/w/tree"});
    w["root"]["hibernated"] = json!(true);
    let parsed = j(&handoff(w));
    let root = &parsed["root"];
    assert_eq!(root["id"], "pane-1");
    assert_eq!(root["hibernated"], true);
    assert_eq!(
        root["resume"],
        json!({"agent": "claude", "id": "abc", "cwd": "/w/tree"})
    );
}

#[test]
fn carries_the_project_folder_through_a_move_and_into_the_merged_file() {
    let moving = handoff(workspace_with(
        "w2",
        "pane-2",
        json!({"projectDir": "~/code/web"}),
    ));
    assert_eq!(moving.project_dir.as_deref(), Some("~/code/web"));
    let mut book = WindowBook::new(None);
    book.open("d1", BOUNDS);
    book.move_workspace(&moving, MAIN_SLOT, "d1");
    let parsed = reparsed(&book);
    assert_eq!(
        parsed.windows[0].workspaces[0].project_dir.as_deref(),
        Some("~/code/web")
    );
}

#[test]
fn refuses_a_malformed_workspace() {
    assert!(parse_handoff(&json!({"id": "w1", "root": {"type": "bogus"}})).is_none());
    assert!(parse_handoff(&json!("w1")).is_none());
}

#[test]
fn lists_every_pane_id_in_the_workspace() {
    let w = workspace_with(
        "w1",
        "a",
        json!({"root": {
            "type": "split",
            "id": "split-1",
            "direction": "horizontal",
            "sizes": [1, 1],
            "children": [
                {"type": "pane", "id": "a", "title": "zsh", "kind": "terminal"},
                {
                    "type": "tabs",
                    "id": "tabs-1",
                    "activeId": "b",
                    "children": [
                        {"type": "pane", "id": "b", "title": "zsh", "kind": "terminal"},
                        {"type": "pane", "id": "c", "title": "zsh", "kind": "terminal"}
                    ]
                }
            ]
        }}),
    );
    assert_eq!(handoff_pane_ids(&handoff(w)), ["a", "b", "c"]);
}

fn origin_json() -> Value {
    json!({
        "workspaceId": "w1",
        "index": 2,
        "groupId": "g1",
        "beside": {"paneId": "pane-1", "zone": "center"}
    })
}

#[test]
fn travels_with_a_handoff_and_survives_a_restart_of_the_detached_window() {
    let moving = handoff(workspace_with(
        "w9",
        "pane-9",
        json!({"origin": origin_json()}),
    ));
    assert_eq!(j(&moving.origin), origin_json());
    let mut book = WindowBook::new(None);
    book.open("d1", BOUNDS);
    book.move_workspace(&moving, MAIN_SLOT, "d1");
    let reloaded = WindowBook::new(Some(&reparsed(&book)));
    assert_eq!(
        j(&reloaded.load("d1").unwrap().workspaces[0].origin),
        origin_json()
    );
}

#[test]
fn drops_a_malformed_origin_and_clamps_its_index() {
    let missing = handoff(workspace_with("w9", "p", json!({"origin": {"index": 1}})));
    assert!(missing.origin.is_none());
    let clamped = handoff(workspace_with(
        "w9",
        "p",
        json!({"origin": {
            "workspaceId": "w1",
            "index": -4,
            "beside": {"paneId": "p1", "zone": "up"}
        }}),
    ));
    assert_eq!(j(&clamped.origin), json!({"workspaceId": "w1", "index": 0}));
}

fn moved_workspace() -> SnapshotWorkspace {
    handoff(workspace_with(
        "w9",
        "pane-9",
        json!({"origin": {
            "workspaceId": "w1",
            "index": 1,
            "beside": {"paneId": "pane-1", "zone": "right"}
        }}),
    ))
}

fn none(_: &str) -> bool {
    false
}

#[test]
fn sends_a_moved_pane_back_to_the_window_that_still_holds_its_workspace() {
    let moved = moved_workspace();
    let plan = plan_return(
        &moved,
        "d",
        "m",
        |id| (id == "w1").then(|| "m".to_owned()),
        none,
    );
    assert_eq!(
        plan,
        ReturnPlan {
            window_id: "m".to_owned(),
            workspace: moved
        }
    );
}

#[test]
fn rejoins_a_workspace_that_now_lives_in_another_detached_window() {
    let plan = plan_return(
        &moved_workspace(),
        "d",
        "m",
        |id| (id == "w1").then(|| "e".to_owned()),
        none,
    );
    assert_eq!(plan.window_id, "e");
}

#[test]
fn keeps_the_place_of_a_pane_whose_workspace_is_gone_but_never_rejoins_it() {
    let plan = plan_return(&moved_workspace(), "d", "m", |_| None, none);
    assert_eq!(plan.window_id, "m");
    assert_eq!(
        j(&plan.workspace.origin),
        json!({"workspaceId": "w9", "index": 1})
    );
}

#[test]
fn never_merges_a_pane_into_or_out_of_a_sandboxed_workspace() {
    let plan = plan_return(
        &moved_workspace(),
        "d",
        "m",
        |_| Some("m".to_owned()),
        |id| id == "w1",
    );
    assert_eq!(plan.workspace.origin.unwrap().workspace_id, "w9");
}

#[test]
fn returns_a_whole_workspace_to_its_old_place_in_the_main_window() {
    let whole = handoff(workspace_with(
        "w1",
        "pane-1",
        json!({"origin": {"workspaceId": "w1", "index": 3}}),
    ));
    assert_eq!(
        plan_return(&whole, "d", "m", |_| None, none),
        ReturnPlan {
            window_id: "m".to_owned(),
            workspace: whole
        }
    );
}

#[test]
fn returns_a_workspace_with_no_origin_to_the_main_window_unchanged() {
    let plain = handoff(workspace_json("w5", "pane-5"));
    let plan = plan_return(&plain, "d", "m", |_| Some("e".to_owned()), none);
    assert_eq!(plan.window_id, "m");
    assert!(plan.workspace.origin.is_none());
}

#[test]
fn does_not_rejoin_the_window_the_workspace_came_from() {
    let plan = plan_return(
        &moved_workspace(),
        "d",
        "m",
        |id| (id == "w1").then(|| "d".to_owned()),
        none,
    );
    assert_eq!(plan.window_id, "m");
    assert_eq!(plan.workspace.origin.unwrap().workspace_id, "w9");
}

#[test]
fn keeps_the_group_of_the_origin_when_a_pane_goes_to_the_main_window() {
    let grouped = handoff(workspace_with(
        "w9",
        "pane-9",
        json!({"origin": {"workspaceId": "w1", "index": 4, "groupId": "g2"}}),
    ));
    let plan = plan_return(&grouped, "d", "m", |_| None, none);
    assert_eq!(
        j(&plan.workspace.origin),
        json!({"workspaceId": "w9", "index": 4, "groupId": "g2"})
    );
}

#[test]
fn refuses_moving_a_pane_out_of_a_sandboxed_workspace() {
    assert!(crosses_sandbox(&[Some("w1")], "w9", |id| id == "w1"));
}

#[test]
fn refuses_moving_a_pane_into_a_sandboxed_workspace() {
    assert!(crosses_sandbox(&[Some("w1")], "w9", |id| id == "w9"));
}

#[test]
fn lets_a_sandboxed_workspace_move_whole() {
    assert!(!crosses_sandbox(
        &[Some("w1"), Some("w1"), None],
        "w1",
        |_| true
    ));
}

#[test]
fn ignores_a_pane_with_an_empty_workspace_id() {
    assert!(!crosses_sandbox(&[Some("")], "w9", |_| true));
}

fn areas() -> [WindowBounds; 2] {
    [left(), right()]
}

const SIZE: WindowSize = WindowSize {
    width: 1100,
    height: 760,
};

#[test]
fn opens_the_window_under_the_drop_point_on_the_display_it_is_on() {
    assert_eq!(
        bounds_at(ScreenPoint { x: 2100, y: 100 }, SIZE, &areas()),
        bounds(1980, 84, 1100, 760)
    );
}

#[test]
fn keeps_a_drop_at_a_screen_edge_on_screen() {
    let b = bounds_at(ScreenPoint { x: 1900, y: 1070 }, SIZE, &areas());
    assert!(b.x + b.width <= 1920);
    assert!(b.y + b.height <= 1080);
}

#[test]
fn opens_a_drop_outside_every_display_on_the_nearest_overlap() {
    let b = bounds_at(ScreenPoint { x: 9000, y: 9000 }, SIZE, &areas());
    assert!(areas().iter().any(|a| {
        b.x >= a.x
            && b.y >= a.y
            && b.x + b.width <= a.x + a.width
            && b.y + b.height <= a.y + a.height
    }));
}

#[test]
fn accepts_only_finite_points() {
    assert_eq!(
        parse_point(&json!({"x": 10.4, "y": 20})),
        Some(ScreenPoint { x: 10, y: 20 })
    );
    assert_eq!(parse_point(&json!({"x": f64::NAN, "y": 1})), None);
    assert_eq!(parse_point(&json!({"x": 1})), None);
    assert_eq!(parse_point(&json!(null)), None);
}

#[test]
fn refuses_a_point_past_the_limit_or_of_the_wrong_type() {
    let rows = [
        json!({"x": 100001, "y": 0}),
        json!({"x": 0, "y": -100001}),
        json!({"x": "1", "y": 2}),
        json!({"x": 1, "y": null}),
        json!([1, 2]),
        json!("point"),
    ];
    for row in &rows {
        assert_eq!(parse_point(row), None, "{row}");
    }
    assert_eq!(
        parse_point(&json!({"x": 100000, "y": -100000})),
        Some(ScreenPoint {
            x: 100_000,
            y: -100_000
        })
    );
}

#[test]
fn accepts_a_drop_on_a_pane_with_a_known_zone_only() {
    let drop = json!({"paneId": "p1", "workspaceId": "w1", "placement": {"paneId": "p2", "zone": "right"}});
    let parsed = parse_pane_drop(&drop).unwrap();
    assert_eq!(j(&parsed), drop);
    let mut diagonal = drop.clone();
    diagonal["placement"]["zone"] = json!("diagonal");
    assert!(parse_pane_drop(&diagonal).is_none());
    let mut empty = drop.clone();
    empty["paneId"] = json!("");
    assert!(parse_pane_drop(&empty).is_none());
    assert!(parse_pane_drop(&json!("p1")).is_none());
}

fn landing() -> Landing {
    Landing {
        window_id: "2".to_owned(),
        workspace_id: "w1".to_owned(),
        placement: PanePlacement {
            pane_id: "p2".to_owned(),
            zone: PanePlacementZone::Center,
        },
    }
}

#[test]
fn hands_a_drop_to_the_source_once_claim_then_take() {
    let mut landings = Landings::default();
    landings.record("p1", landing(), 0);
    assert!(landings.pending("p1", 10));
    assert!(landings.claim("p1", 10));
    assert!(!landings.claim("p1", 20));
    assert_eq!(landings.take("p1", 30), Some(landing()));
    assert_eq!(landings.take("p1", 40), None);
}

#[test]
fn never_gives_a_pane_that_was_not_claimed_first() {
    let mut landings = Landings::default();
    landings.record("p1", landing(), 0);
    assert_eq!(landings.take("p1", 10), None);
}

#[test]
fn forgets_a_drop_nobody_claimed_soon_after_so_a_later_cancelled_drag_never_moves_the_pane() {
    let mut landings = Landings::default();
    landings.record("p1", landing(), 0);
    assert!(!landings.claim("p1", LANDING_CLAIM_MS + 1));
}

#[test]
fn lets_the_human_answer_the_unsaved_files_dialog_before_the_claim_runs_out() {
    let mut landings = Landings::default();
    landings.record("p1", landing(), 0);
    landings.claim("p1", 100);
    assert_eq!(landings.take("p1", 100 + LANDING_GIVE_MS + 1), None);
}

#[test]
fn keeps_a_claimed_drop_until_the_give_time_runs_out() {
    let mut landings = Landings::default();
    landings.record("p1", landing(), 0);
    assert!(landings.claim("p1", LANDING_CLAIM_MS));
    assert!(!landings.pending("p1", LANDING_CLAIM_MS + 1));
    assert_eq!(
        landings.take("p1", LANDING_CLAIM_MS + LANDING_GIVE_MS),
        Some(landing())
    );
}

#[test]
fn reports_a_drop_nobody_recorded_as_not_pending() {
    let mut landings = Landings::default();
    assert!(!landings.pending("p1", 0));
    assert!(!landings.claim("p1", 0));
    assert_eq!(landings.take("p1", 0), None);
}
