#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::WorkspaceId;
use ostia_base::clock::Clock;
use ostia_park::{PARKED_PER_WORKSPACE_MAX, ParkInput, ParkResult, ParkedRecord, ParkedStore};
use serde_json::{Value, json};
use tempfile::TempDir;

fn file_in() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("parked-sessions.json");
    (dir, file)
}

fn claude(id: &str) -> Value {
    json!({"agent": "claude", "id": id, "cwd": "/home/u/api"})
}

fn input(workspace: &str, resume: Value, title: &str) -> ParkInput {
    ParkInput {
        workspace_id: WorkspaceId::new(workspace),
        resume,
        title: title.to_owned(),
        title_pinned: false,
        summary: None,
    }
}

fn fixed(now: i64) -> Clock {
    Arc::new(move || now)
}

fn parked(result: ParkResult) -> (ParkedRecord, bool) {
    match result {
        ParkResult::Parked { record, updated } => (*record, updated),
        other => panic!("expected a parked record, got {other:?}"),
    }
}

fn w(id: &str) -> WorkspaceId {
    WorkspaceId::new(id)
}

#[test]
fn keeps_one_record_per_session_and_updates_it_in_place() {
    let (_dir, file) = file_in();
    let store = ParkedStore::with_clock(file, fixed(1));
    let (first, updated_first) = parked(store.park(input("w1", claude("s1"), "export")).unwrap());
    let (again, updated_again) = parked(
        store
            .park(ParkInput {
                summary: Some("stopped at the retry test".to_owned()),
                ..input("w1", claude("s1"), "export")
            })
            .unwrap(),
    );
    assert_eq!(first.id, again.id);
    assert!(!updated_first);
    assert!(updated_again);
    let listed = store.list(&w("w1"));
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].summary.as_deref(),
        Some("stopped at the retry test")
    );
}

#[test]
fn never_stores_the_launch_the_human_typed() {
    let (_dir, file) = file_in();
    let store = ParkedStore::new(file.clone());
    let typed = json!({"agent": "claude", "id": "s1", "cwd": "/home/u/api", "typed": {"env": [{"name": "FOO", "value": "x"}], "flags": ["--model", "x"]}});
    store.park(input("w1", typed, "export")).unwrap();
    assert!(!fs::read_to_string(&file).unwrap().contains("typed"));
    assert!(
        !serde_json::to_string(&store.list(&w("w1")))
            .unwrap()
            .contains("FOO")
    );
}

#[test]
fn refilters_a_record_it_reads_from_disk_dropping_flags_and_ids_it_does_not_allow() {
    let (_dir, file) = file_in();
    fs::write(
        &file,
        json!({
            "v": 1,
            "items": [
                {
                    "id": "abcdefghij",
                    "workspaceId": "w1",
                    "resume": {"agent": "claude", "id": "s1", "cwd": "/home/u/api", "args": ["--dangerously-skip-permissions", "--model", "opus"]},
                    "title": "export",
                    "parkedAt": 5
                },
                {"id": "BAD", "workspaceId": "w1", "resume": {"agent": "claude", "id": "s2"}, "title": "t", "parkedAt": 1},
                {"id": "klmnopqrst", "workspaceId": "w1", "resume": {"agent": "claude", "id": "--bad"}, "title": "t", "parkedAt": 1}
            ]
        })
        .to_string(),
    )
    .unwrap();
    let items = ParkedStore::new(file).list(&w("w1"));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].resume.args, ["--model", "opus"]);
}

#[test]
fn ignores_a_file_of_another_format() {
    let (_dir, file) = file_in();
    fs::write(&file, r#"{"v":2,"items":[]}"#).unwrap();
    assert!(ParkedStore::new(file).list(&w("w1")).is_empty());
}

#[test]
fn writes_the_file_0600_and_reloads_it() {
    let (_dir, file) = file_in();
    let store = ParkedStore::with_clock(file.clone(), fixed(9));
    store.park(input("w1", claude("s1"), "export")).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let reloaded = &ParkedStore::new(file).list(&w("w1"))[0];
    assert_eq!(reloaded.title, "export");
    assert_eq!(reloaded.parked_at.as_i64(), Some(9));
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let (_dir, file) = file_in();
    fs::copy(fixture("parked-sessions-before.json"), &file).unwrap();
    let store = ParkedStore::new(file.clone());
    let first = &store.list(&w("w1"));
    assert_eq!(first.len(), 2);
    let pinned = first.iter().find(|record| record.title_pinned).unwrap();
    assert_eq!(pinned.title, "export é");
    assert_eq!(pinned.resume.args, ["--model", "opus"]);
    let gone = first.iter().find(|record| record.title == "gone").unwrap();
    assert!(store.remove(&gone.id).unwrap());
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("parked-sessions-after.json")).unwrap()
    );
}

#[test]
fn keeps_a_fractional_time_and_treats_optional_fields_as_ts_does() {
    let (_dir, file) = file_in();
    let record = |id: &str, extra: Value| {
        let mut base = json!({
            "id": id,
            "workspaceId": "w1",
            "resume": {"agent": "claude", "id": id},
            "title": "t",
            "parkedAt": 1.5
        });
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    };
    let items = json!([
        record("aaaaaaaaaa", json!({})),
        record("bbbbbbbbbb", json!({"summary": ""})),
        record("cccccccccc", json!({"summary": 5})),
        record("dddddddddd", json!({"summary": null})),
        record("eeeeeeeeee", json!({"titlePinned": false})),
        record("ffffffffff", json!({"parkedAt": "soon"})),
    ]);
    fs::write(&file, json!({"v": 1, "items": items}).to_string()).unwrap();
    let store = ParkedStore::new(file.clone());
    let ids: Vec<String> = store
        .list(&w("w1"))
        .into_iter()
        .map(|record| record.id)
        .collect();
    assert_eq!(ids, ["aaaaaaaaaa", "bbbbbbbbbb", "eeeeeeeeee"]);
    let kept = store.get("bbbbbbbbbb").unwrap();
    assert_eq!(kept.summary, None);
    assert_eq!(kept.parked_at.as_f64(), Some(1.5));
    assert!(!store.get("eeeeeeeeee").unwrap().title_pinned);
    store.remove("aaaaaaaaaa").unwrap();
    let written = fs::read_to_string(&file).unwrap();
    assert!(written.contains("\"parkedAt\": 1.5"));
    assert!(!written.contains("summary"));
    assert!(!written.contains("titlePinned"));
}

#[test]
fn caps_a_workspace_at_the_limit_and_still_updates_a_parked_session() {
    let (_dir, file) = file_in();
    let store = ParkedStore::new(file);
    for index in 0..PARKED_PER_WORKSPACE_MAX {
        parked(
            store
                .park(input("w1", claude(&format!("s{index}")), "t"))
                .unwrap(),
        );
    }
    assert_eq!(
        store.park(input("w1", claude("extra"), "t")).unwrap(),
        ParkResult::TooMany
    );
    parked(store.park(input("w1", claude("s3"), "t2")).unwrap());
    parked(store.park(input("w2", claude("extra"), "t")).unwrap());
}

#[test]
fn keeps_whether_the_human_named_the_tab_and_drops_it_when_they_did_not() {
    let (_dir, file) = file_in();
    let store = ParkedStore::new(file.clone());
    store
        .park(ParkInput {
            title_pinned: true,
            ..input("w1", claude("a"), "mine")
        })
        .unwrap();
    store.park(input("w1", claude("b"), "auto")).unwrap();
    let listed = store.list(&w("w1"));
    let by_title = |title: &str| listed.iter().find(|record| record.title == title).unwrap();
    assert!(by_title("mine").title_pinned);
    assert!(!by_title("auto").title_pinned);
    let text = fs::read_to_string(&file).unwrap();
    assert_eq!(text.matches("titlePinned").count(), 1);
}

#[test]
fn lists_newest_first_and_only_the_workspace_asked_for() {
    let (_dir, file) = file_in();
    let now = Arc::new(AtomicI64::new(0));
    let ticking = Arc::clone(&now);
    let store = ParkedStore::with_clock(
        file,
        Arc::new(move || ticking.fetch_add(1, Ordering::Relaxed) + 1),
    );
    store.park(input("w1", claude("a"), "a")).unwrap();
    store.park(input("w2", claude("b"), "b")).unwrap();
    store.park(input("w1", claude("c"), "c")).unwrap();
    let titles: Vec<String> = store
        .list(&w("w1"))
        .into_iter()
        .map(|record| record.title)
        .collect();
    assert_eq!(titles, ["c", "a"]);
}

#[test]
fn removes_a_record_and_settles_the_one_of_a_session_that_started_again() {
    let (_dir, file) = file_in();
    let store = ParkedStore::new(file);
    let (a, _) = parked(store.park(input("w1", claude("a"), "a")).unwrap());
    store.park(input("w1", claude("b"), "b")).unwrap();
    let mut seen = store.subscribe();
    assert_eq!(store.settle(&w("w1"), "claude", "a").unwrap(), 1);
    assert_eq!(store.settle(&w("w1"), "codex", "b").unwrap(), 0);
    assert_eq!(store.settle(&w("w2"), "claude", "b").unwrap(), 0);
    assert!(!store.remove(&a.id).unwrap());
    let titles: Vec<String> = store
        .list(&w("w1"))
        .into_iter()
        .map(|record| record.title)
        .collect();
    assert_eq!(titles, ["b"]);
    assert_eq!(seen.try_recv().unwrap(), w("w1"));
    assert!(seen.try_recv().is_err());
}

#[test]
fn collapses_the_title_and_the_summary_to_one_line_and_cuts_them() {
    let (_dir, file) = file_in();
    let store = ParkedStore::new(file);
    let (record, _) = parked(
        store
            .park(ParkInput {
                summary: Some(format!("first\nsecond {}", "x".repeat(400))),
                ..input("w1", claude("s1"), "a\nb")
            })
            .unwrap(),
    );
    assert_eq!(record.title, "a b");
    let summary = record.summary.unwrap();
    assert_eq!(summary.chars().count(), 160);
    assert!(!summary.contains('\n'));
}
