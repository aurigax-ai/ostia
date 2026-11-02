#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::host::{Host, Platform};
use ostia_workspaces::saved_scrollback::{
    RestoreOutcome, SCROLLBACK_CAP_BYTES, SavedScrollback, scrollback_path, scrollback_to_save,
    trim_scrollback,
};
use ostia_workspaces::workspace_snapshot::snapshot_path;
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

fn entries(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(id, data)| ((*id).to_owned(), (*data).to_owned()))
        .collect()
}

fn none_unsaved(_: &str) -> bool {
    false
}

fn write_scrollback(host: &Host, text: &str) {
    let path = scrollback_path(host);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn stored(host: &Host) -> Value {
    serde_json::from_str(&fs::read_to_string(scrollback_path(host)).unwrap()).unwrap()
}

fn pending(store: &SavedScrollback) -> Vec<(String, String)> {
    store.pending_restored_scrollback()
}

#[test]
fn caps_scrollback_at_131072_bytes() {
    assert_eq!(SCROLLBACK_CAP_BYTES, 131_072);
}

#[test]
fn keeps_the_global_scrollback_file_in_the_app_data_folder() {
    let (_dir, host) = temp_host();
    assert_eq!(
        scrollback_path(&host),
        host.app_data_dir().join("scrollback.json")
    );
}

#[test]
fn leaves_scrollback_under_the_cap_unchanged() {
    let data = "a\nb\nc";
    assert_eq!(trim_scrollback(data, SCROLLBACK_CAP_BYTES), data);
    let exact = "x".repeat(SCROLLBACK_CAP_BYTES);
    assert_eq!(trim_scrollback(&exact, SCROLLBACK_CAP_BYTES), exact);
}

#[test]
fn trims_scrollback_to_the_line_start_after_the_cut() {
    let data = "aaaa\nbbbb\ncccc\n";
    assert_eq!(trim_scrollback(data, 7), "cccc\n");
}

#[test]
fn trims_scrollback_at_an_escape_that_comes_before_the_next_newline() {
    let data = "aaaaaaaa\u{1b}[31mred\nrest";
    assert_eq!(trim_scrollback(data, 14), "\u{1b}[31mred\nrest");
}

#[test]
fn trims_scrollback_at_the_newline_when_it_comes_before_the_next_escape() {
    let data = "aaaaaaaa\nbb\u{1b}[0m";
    assert_eq!(trim_scrollback(data, 8), "bb\u{1b}[0m");
}

#[test]
fn trims_scrollback_at_the_plain_cut_when_there_is_no_newline_or_escape() {
    let data = "abcdefghij";
    assert_eq!(trim_scrollback(data, 4), "ghij");
}

#[test]
fn counts_the_cap_in_utf16_units() {
    let data = "😀😀😀😀";
    assert_eq!(trim_scrollback(data, 4), "😀😀");
}

#[test]
fn drops_empty_dangerous_and_unsaved_panes_when_choosing_what_to_save() {
    let by_pane = entries(&[
        ("p1", "one"),
        ("p2", ""),
        ("__proto__", "x"),
        ("prototype", "y"),
        ("constructor", "z"),
        ("p3", "three"),
        ("p4", "four"),
    ]);
    let kept = scrollback_to_save(&by_pane, &|id| id == "p3");
    assert_eq!(kept, entries(&[("p1", "one"), ("p4", "four")]));
}

#[test]
fn trims_each_pane_it_chooses_to_save() {
    let long = format!("{}\nlast line\n", "x".repeat(SCROLLBACK_CAP_BYTES + 50));
    let kept = scrollback_to_save(&entries(&[("p1", &long)]), &none_unsaved);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].1, "last line\n");
}

#[test]
fn keeps_at_most_64_panes_and_does_not_count_the_ones_it_skipped() {
    let mut by_pane = entries(&[("skip-a", ""), ("skip-b", "text")]);
    for index in 0..70 {
        by_pane.push((format!("p{index}"), "data".to_owned()));
    }
    let kept = scrollback_to_save(&by_pane, &|id| id == "skip-b");
    assert_eq!(kept.len(), 64);
    assert_eq!(kept[0].0, "p0");
    assert_eq!(kept[63].0, "p63");
}

#[test]
fn keeps_the_order_of_the_panes_it_saves() {
    let by_pane = entries(&[("z", "1"), ("a", "2"), ("m", "3")]);
    let kept = scrollback_to_save(&by_pane, &none_unsaved);
    let ids: Vec<&str> = kept.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["z", "a", "m"]);
}

#[tokio::test]
async fn saves_the_chosen_scrollback_to_the_global_file() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    store
        .save_scrollback(
            &entries(&[("p1", "one"), ("p2", ""), ("p3", "three")]),
            &|id| id == "p3",
        )
        .await
        .unwrap();
    assert_eq!(stored(&host), json!({"p1": "one"}));
}

#[tokio::test]
async fn saves_an_empty_record_when_no_pane_has_scrollback() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    store
        .save_scrollback(&entries(&[("p1", "")]), &none_unsaved)
        .await
        .unwrap();
    assert_eq!(stored(&host), json!({}));
}

#[tokio::test]
async fn runs_saves_in_the_order_they_were_started() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let first = store.save_scrollback(&entries(&[("p1", "first")]), &none_unsaved);
    let second = store.save_scrollback(&entries(&[("p1", "second")]), &none_unsaved);
    let third = store.save_scrollback(&entries(&[("p1", "third")]), &none_unsaved);
    third.await.unwrap();
    second.await.unwrap();
    first.await.unwrap();
    assert_eq!(stored(&host), json!({"p1": "third"}));
}

#[tokio::test]
async fn takes_the_data_to_save_when_the_save_starts() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let mut by_pane = entries(&[("p1", "before")]);
    let pending_save = store.save_scrollback(&by_pane, &none_unsaved);
    by_pane[0].1 = "after".to_owned();
    pending_save.await.unwrap();
    assert_eq!(stored(&host), json!({"p1": "before"}));
}

#[tokio::test]
async fn reports_a_failed_write_and_lets_the_next_save_run() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let blocker = host.app_data_dir();
    fs::create_dir_all(blocker.parent().unwrap()).unwrap();
    fs::write(&blocker, "not a folder").unwrap();
    let failed = store
        .save_scrollback(&entries(&[("p1", "one")]), &none_unsaved)
        .await;
    assert!(failed.is_err());
    fs::remove_file(&blocker).unwrap();
    store
        .save_scrollback(&entries(&[("p1", "two")]), &none_unsaved)
        .await
        .unwrap();
    assert_eq!(stored(&host), json!({"p1": "two"}));
}

#[test]
fn reports_none_when_there_is_no_scrollback_file() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::None);
    assert!(pending(&store).is_empty());
}

#[test]
fn reports_failed_when_the_scrollback_file_is_not_a_record() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    for (row, text) in [
        ("array", "[\"a\"]"),
        ("null", "null"),
        ("string", "\"text\""),
        ("number", "7"),
        ("broken json", "{\"p1\": "),
        ("empty file", ""),
    ] {
        write_scrollback(&host, text);
        assert_eq!(
            store.load_restored_scrollback(),
            RestoreOutcome::Failed,
            "{row}"
        );
        assert!(pending(&store).is_empty(), "{row}");
    }
}

#[test]
fn restores_only_non_empty_text_for_safe_pane_ids() {
    let (_dir, host) = temp_host();
    write_scrollback(
        &host,
        &json!({
            "p1": "one",
            "p2": "",
            "p3": 7,
            "p4": null,
            "p5": ["x"],
            "__proto__": "bad",
            "constructor": "bad",
            "prototype": "bad",
            "p6": "six"
        })
        .to_string(),
    );
    let store = SavedScrollback::new(host);
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::Ok);
    assert_eq!(pending(&store), entries(&[("p1", "one"), ("p6", "six")]));
}

#[test]
fn reports_ok_with_nothing_pending_for_an_empty_record() {
    let (_dir, host) = temp_host();
    write_scrollback(&host, "{}");
    let store = SavedScrollback::new(host);
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::Ok);
    assert!(pending(&store).is_empty());
}

#[test]
fn clears_what_was_pending_before_it_loads_again() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    store.stash_scrollback("old", "stashed");
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::None);
    assert!(pending(&store).is_empty());
    store.stash_scrollback("old", "stashed");
    write_scrollback(&host, "[]");
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::Failed);
    assert!(pending(&store).is_empty());
    store.stash_scrollback("old", "stashed");
    write_scrollback(&host, &json!({"p1": "one"}).to_string());
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::Ok);
    assert_eq!(pending(&store), entries(&[("p1", "one")]));
}

#[test]
fn hands_out_restored_scrollback_once() {
    let (_dir, host) = temp_host();
    write_scrollback(&host, &json!({"p1": "one"}).to_string());
    let store = SavedScrollback::new(host);
    store.load_restored_scrollback();
    assert_eq!(store.take_restored_scrollback("p1"), Some("one".to_owned()));
    assert_eq!(store.take_restored_scrollback("p1"), None);
    assert_eq!(store.take_restored_scrollback("missing"), None);
    assert!(pending(&store).is_empty());
}

#[test]
fn stashes_scrollback_trimmed_to_the_cap() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    let long = format!("{}\nlast line\n", "x".repeat(SCROLLBACK_CAP_BYTES + 50));
    store.stash_scrollback("p1", &long);
    assert_eq!(
        store.take_restored_scrollback("p1"),
        Some("last line\n".to_owned())
    );
}

#[test]
fn ignores_a_stash_of_empty_text_or_a_dangerous_pane_id() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    store.stash_scrollback("p1", "kept");
    store.stash_scrollback("p1", "");
    store.stash_scrollback("__proto__", "x");
    store.stash_scrollback("prototype", "x");
    store.stash_scrollback("constructor", "x");
    assert_eq!(pending(&store), entries(&[("p1", "kept")]));
}

#[test]
fn replaces_stashed_scrollback_for_the_same_pane() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    store.stash_scrollback("p1", "first");
    store.stash_scrollback("p2", "other");
    store.stash_scrollback("p1", "second");
    assert_eq!(
        pending(&store),
        entries(&[("p1", "second"), ("p2", "other")])
    );
}

#[test]
fn drops_restored_scrollback_for_one_pane() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    store.stash_scrollback("p1", "one");
    store.stash_scrollback("p2", "two");
    store.drop_restored_scrollback("p1");
    store.drop_restored_scrollback("missing");
    assert_eq!(pending(&store), entries(&[("p2", "two")]));
}

#[test]
fn gives_a_copy_of_the_pending_scrollback() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    store.stash_scrollback("p1", "one");
    let mut copy = pending(&store);
    copy.clear();
    assert_eq!(pending(&store), entries(&[("p1", "one")]));
}

#[test]
fn shares_the_pending_scrollback_between_clones() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    let other = store.clone();
    store.stash_scrollback("p1", "one");
    assert_eq!(other.take_restored_scrollback("p1"), Some("one".to_owned()));
    assert!(pending(&store).is_empty());
}

#[tokio::test]
async fn clears_the_snapshot_the_scrollback_and_the_pending_text() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    store
        .save_scrollback(&entries(&[("p1", "one")]), &none_unsaved)
        .await
        .unwrap();
    fs::write(snapshot_path(&host), "{}").unwrap();
    store.stash_scrollback("p2", "two");
    store.clear_persisted().await.unwrap();
    assert!(!scrollback_path(&host).exists());
    assert!(!snapshot_path(&host).exists());
    assert!(pending(&store).is_empty());
}

#[tokio::test]
async fn clears_when_nothing_was_saved() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    store.clear_persisted().await.unwrap();
    assert!(!scrollback_path(&host).exists());
    assert!(!snapshot_path(&host).exists());
}

#[tokio::test]
async fn removes_the_files_and_the_pending_text_when_clearing_starts() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    store
        .save_scrollback(&entries(&[("p1", "one")]), &none_unsaved)
        .await
        .unwrap();
    fs::write(snapshot_path(&host), "{}").unwrap();
    store.stash_scrollback("p2", "two");
    let clearing = store.clear_persisted();
    assert!(!scrollback_path(&host).exists());
    assert!(!snapshot_path(&host).exists());
    assert!(pending(&store).is_empty());
    clearing.await.unwrap();
}

#[tokio::test]
async fn never_writes_a_save_that_started_before_clearing() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let early = store.save_scrollback(&entries(&[("p1", "one")]), &none_unsaved);
    let clearing = store.clear_persisted();
    early.await.unwrap();
    clearing.await.unwrap();
    assert!(!scrollback_path(&host).exists());
}

#[tokio::test]
async fn writes_a_save_that_started_after_clearing() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let early = store.save_scrollback(&entries(&[("p1", "early")]), &none_unsaved);
    let clearing = store.clear_persisted();
    let late = store.save_scrollback(&entries(&[("p1", "late")]), &none_unsaved);
    early.await.unwrap();
    clearing.await.unwrap();
    late.await.unwrap();
    assert_eq!(stored(&host), json!({"p1": "late"}));
}

#[tokio::test]
async fn writes_the_same_bytes_as_the_ts_store_and_reads_them_back() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let input: Value =
        serde_json::from_str(&fs::read_to_string(fixture("scrollback-input.json")).unwrap())
            .unwrap();
    let by_pane: Vec<(String, String)> = input
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, data)| (id.clone(), data.as_str().unwrap().to_owned()))
        .collect();
    store
        .save_scrollback(&by_pane, &|id| id == "p3")
        .await
        .unwrap();
    let expected = fs::read(fixture("scrollback-saved.json")).unwrap();
    assert_eq!(fs::read(scrollback_path(&host)).unwrap(), expected);

    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::Ok);
    let saved: Value = serde_json::from_slice(&expected).unwrap();
    let wanted: Vec<(String, String)> = saved
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, data)| (id.clone(), data.as_str().unwrap().to_owned()))
        .collect();
    assert_eq!(pending(&store), wanted);
}

#[tokio::test]
async fn never_writes_text_that_a_clear_during_the_snapshot_removed() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host.clone());
    let clearer = store.clone();
    let clear_while_reading = move |_: &str| {
        drop(clearer.clear_persisted());
        false
    };
    store
        .save_scrollback(&entries(&[("p1", "cleared text")]), &clear_while_reading)
        .await
        .unwrap();
    assert!(!scrollback_path(&host).exists());
}

#[test]
fn reports_an_error_instead_of_panicking_without_a_runtime() {
    let (_dir, host) = temp_host();
    let store = SavedScrollback::new(host);
    let saving = store.save_scrollback(&entries(&[("p1", "one")]), &none_unsaved);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    assert!(runtime.block_on(saving).is_err());
}

#[test]
fn keeps_every_pane_when_one_text_holds_a_lone_surrogate_escape() {
    let (_dir, host) = temp_host();
    write_scrollback(&host, r#"{"p1":"one","p2":"a\ud83d","p3":"three"}"#);
    let store = SavedScrollback::new(host);
    assert_eq!(store.load_restored_scrollback(), RestoreOutcome::Ok);
    assert_eq!(
        pending(&store),
        entries(&[("p1", "one"), ("p2", "a\u{fffd}"), ("p3", "three")])
    );
}
