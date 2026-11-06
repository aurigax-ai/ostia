#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::FutureExt;
use ostia_approvals::script_token_requests::{ReachListing, ReachWorkspace};
use ostia_approvals::script_token_usage::{
    ConnectionSource, Last24h, PaneTitle, ScriptTokenUsageLog, USAGE_KEEP, UsageCall,
    UsageLogOptions, UsageLookups, usage_view,
};
use ostia_contract::script_tokens::{
    ScriptTokenCall, ScriptTokenCallOutcome as Outcome, ScriptTokenCallTarget,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const HOUR: i64 = 3_600_000;
const START: i64 = 1_791_720_000_000;

struct Env {
    _dir: TempDir,
    file: PathBuf,
    clock: Arc<AtomicI64>,
}

impl Env {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("script-token-usage.json");
        Self {
            _dir: dir,
            file,
            clock: Arc::new(AtomicI64::new(START)),
        }
    }

    fn options(&self) -> UsageLogOptions {
        let clock = Arc::clone(&self.clock);
        UsageLogOptions {
            now: Arc::new(move || clock.load(Ordering::SeqCst)),
            flush_ms: 60_000,
            ..UsageLogOptions::default()
        }
    }

    fn log(&self) -> ScriptTokenUsageLog {
        ScriptTokenUsageLog::new(self.file.clone(), self.options())
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn stored(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.file).unwrap()).unwrap()
    }

    fn stored_keys(&self) -> Vec<String> {
        self.stored().as_object().unwrap().keys().cloned().collect()
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn call(method: &str, outcome: Outcome) -> UsageCall {
    UsageCall {
        method: method.to_owned(),
        target: ScriptTokenCallTarget::default(),
        outcome,
        code: None,
    }
}

fn aimed(method: &str, workspace: Option<&str>, pane: Option<&str>, outcome: Outcome) -> UsageCall {
    UsageCall {
        target: ScriptTokenCallTarget {
            workspace_id: workspace.map(str::to_owned),
            pane_id: pane.map(str::to_owned),
        },
        ..call(method, outcome)
    }
}

fn pid(value: u32) -> ConnectionSource {
    ConnectionSource { pid: Some(value) }
}

fn methods(calls: &[ScriptTokenCall]) -> Vec<&str> {
    calls.iter().map(|c| c.method.as_str()).collect()
}

fn last24h(calls: u64, refused: u64) -> Last24h {
    Last24h { calls, refused }
}

#[tokio::test]
async fn keeps_the_newest_100_calls_and_drops_the_oldest() {
    let env = Env::new();
    let usage = env.log();
    for i in 0..USAGE_KEEP + 5 {
        env.advance(1_000);
        usage.record("t1", call(&format!("m{i}"), Outcome::Ok));
    }
    let snapshot = usage.usage("t1");
    assert_eq!(snapshot.calls.len(), USAGE_KEEP);
    assert_eq!(snapshot.calls[0].method, format!("m{}", USAGE_KEEP + 4));
    assert_eq!(snapshot.calls.last().unwrap().method, "m5");
    assert_eq!(snapshot.last24h, last24h(USAGE_KEEP as u64 + 5, 0));
}

#[tokio::test]
async fn counts_refused_calls_and_forgets_the_ones_older_than_24_hours() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("pane.read", Outcome::Ok));
    env.advance(25 * HOUR);
    usage.record("t1", call("pane.read", Outcome::OutOfScope));
    usage.record("t1", call("pane.close", Outcome::MissingPermission));
    usage.record(
        "t1",
        UsageCall {
            code: Some("bad-request".to_owned()),
            ..call("x", Outcome::Error)
        },
    );
    assert_eq!(usage.usage("t1").last24h, last24h(3, 2));
    assert_eq!(usage.usage("t1").calls.len(), 4);
}

#[tokio::test]
async fn writes_the_file_later_owner_only_and_unindented_and_reads_it_back_after_a_restart() {
    let env = Env::new();
    let usage = env.log();
    usage.record(
        "t1",
        aimed("pane.read", Some("w1"), Some("p1"), Outcome::Ok),
    );
    assert!(!env.file.exists());
    let pending = usage.flush();
    assert!(!env.file.exists());
    pending.await;
    assert_eq!(
        fs::metadata(&env.file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!fs::read_to_string(&env.file).unwrap().contains('\n'));
    let restarted = env.log().usage("t1");
    assert_eq!(restarted.calls.len(), 1);
    assert_eq!(restarted.calls[0].method, "pane.read");
    assert_eq!(
        restarted.calls[0].target,
        ScriptTokenCallTarget {
            workspace_id: Some("w1".to_owned()),
            pane_id: Some("p1".to_owned()),
        }
    );
    assert_eq!(restarted.calls[0].outcome, Outcome::Ok);
    assert_eq!(restarted.last24h, last24h(1, 0));
}

#[tokio::test]
async fn stores_only_the_fields_it_is_given() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", aimed("pane.input", None, Some("p1"), Outcome::Ok));
    usage.flush().await;
    let mut keys: Vec<String> = env.stored()["t1"]["calls"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(keys, ["at", "method", "outcome", "target"]);
}

#[tokio::test]
async fn clears_a_token_and_its_connections() {
    let env = Env::new();
    let usage = env.log();
    let _held = usage.connected("t1", pid(1));
    usage.record("t1", call("notify", Outcome::Ok));
    usage.record("t2", call("notify", Outcome::Ok));
    usage.clear("t1");
    usage.flush().await;
    let cleared = usage.usage("t1");
    assert!(cleared.calls.is_empty());
    assert!(cleared.connections.is_empty());
    assert_eq!(cleared.last24h, last24h(0, 0));
    assert_eq!(env.stored_keys(), ["t2"]);
}

#[tokio::test]
async fn notes_a_regeneration_without_counting_it_as_a_call_and_drops_the_old_connections() {
    let env = Env::new();
    let usage = env.log();
    let release = usage.connected("t1", pid(7));
    usage.regenerated("t1");
    let after = usage.usage("t1");
    assert_eq!(after.calls.len(), 1);
    assert_eq!(after.calls[0].method, "");
    assert_eq!(after.calls[0].outcome, Outcome::Regenerated);
    assert!(after.connections.is_empty());
    assert_eq!(after.last24h, last24h(0, 0));
    let fresh = usage.connected("t1", ConnectionSource::default());
    release.release();
    assert_eq!(usage.usage("t1").connections, [ConnectionSource::default()]);
    fresh.release();
    assert!(usage.usage("t1").connections.is_empty());
}

#[tokio::test]
async fn counts_each_open_connection_with_its_process() {
    let env = Env::new();
    let usage = env.log();
    let first = usage.connected("t1", pid(41));
    let _second = usage.connected("t1", pid(42));
    assert_eq!(usage.usage("t1").connections, [pid(41), pid(42)]);
    first.release();
    first.release();
    assert_eq!(usage.usage("t1").connections, [pid(42)]);
}

#[tokio::test]
async fn drops_a_call_that_finishes_after_its_token_was_revoked() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("pane.read", Outcome::Ok));
    usage.clear("t1");
    usage.record("t1", call("pane.read", Outcome::Ok));
    usage.regenerated("t1");
    assert!(usage.usage("t1").calls.is_empty());
    usage.flush().await;
    assert_eq!(env.stored(), json!({}));
}

#[tokio::test]
async fn leaves_out_tokens_that_no_longer_exist_when_it_writes() {
    let env = Env::new();
    let usage = ScriptTokenUsageLog::new(
        env.file.clone(),
        UsageLogOptions {
            known: Some(Arc::new(|| HashSet::from(["t2".to_owned()]))),
            ..UsageLogOptions::default()
        },
    );
    usage.record("t1", call("notify", Outcome::Ok));
    usage.record("t2", call("notify", Outcome::Ok));
    usage.flush().await;
    assert_eq!(env.stored_keys(), ["t2"]);
}

#[tokio::test]
async fn writes_at_once_on_close() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("notify", Outcome::Ok));
    usage.close();
    assert_eq!(
        fs::metadata(&env.file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(env.stored_keys(), ["t1"]);
}

#[tokio::test]
async fn writes_nothing_on_close_or_flush_when_nothing_was_loaded() {
    let env = Env::new();
    let usage = env.log();
    usage.close();
    usage.flush().await;
    assert!(!env.file.exists());
}

#[tokio::test(start_paused = true)]
async fn writes_by_itself_after_the_flush_delay_and_only_once_for_many_calls() {
    let env = Env::new();
    let writes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&writes);
    let usage = ScriptTokenUsageLog::new(
        env.file.clone(),
        UsageLogOptions {
            known: Some(Arc::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                HashSet::from(["t1".to_owned()])
            })),
            ..env.options()
        },
    );
    usage.record("t1", call("a", Outcome::Ok));
    tokio::time::sleep(Duration::from_millis(59_000)).await;
    usage.record("t1", call("b", Outcome::Ok));
    assert!(!env.file.exists());
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(env.file.exists());
    assert_eq!(env.stored()["t1"]["calls"].as_array().unwrap().len(), 2);
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn keeps_what_close_wrote_when_an_earlier_write_comes_late() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("a", Outcome::Ok));
    let late = usage.flush();
    usage.record("t1", call("b", Outcome::Ok));
    usage.close();
    late.await;
    assert_eq!(env.stored()["t1"]["calls"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn releases_a_connection_when_its_handle_is_dropped() {
    let env = Env::new();
    let usage = env.log();
    {
        let _held = usage.connected("t1", pid(5));
        assert_eq!(usage.usage("t1").connections, [pid(5)]);
    }
    assert!(usage.usage("t1").connections.is_empty());
}

#[tokio::test]
async fn lets_the_later_row_win_when_two_stored_hours_share_a_slot() {
    let env = Env::new();
    let hour = START / HOUR;
    fs::write(
        &env.file,
        json!({"t1": {"calls": [], "hours": [
            [hour, 4, 1],
            [hour - 23, 2, 2],
            [hour - 24, 9, 9]
        ]}})
        .to_string(),
    )
    .unwrap();
    assert_eq!(env.log().usage("t1").last24h, last24h(2, 2));
}

#[tokio::test]
async fn reads_a_file_the_ts_log_wrote_and_writes_the_same_bytes_as_the_ts_log() {
    let env = Env::new();
    fs::copy(fixture("script-token-usage-before.json"), &env.file).unwrap();
    let usage = env.log();
    let first = usage.usage("t1");
    assert_eq!(methods(&first.calls), ["x", "pane.close", "pane.read"]);
    assert_eq!(first.last24h, last24h(3, 1));
    let second = usage.usage("t2");
    assert_eq!(second.calls.len(), 2);
    assert_eq!(second.calls[0].outcome, Outcome::Regenerated);
    assert_eq!(second.last24h, last24h(1, 1));
    env.advance(2_000 + HOUR);
    usage.record(
        "t1",
        aimed("pane.input", Some("w1"), Some("p1"), Outcome::Ok),
    );
    usage.flush().await;
    assert_eq!(
        fs::read(&env.file).unwrap(),
        fs::read(fixture("script-token-usage-after.json")).unwrap()
    );
}

#[tokio::test]
async fn omits_an_empty_code_and_keeps_a_given_one() {
    let env = Env::new();
    let usage = env.log();
    usage.record(
        "t1",
        UsageCall {
            code: Some(String::new()),
            ..call("a", Outcome::Error)
        },
    );
    usage.record(
        "t1",
        UsageCall {
            code: Some("bad-request".to_owned()),
            ..call("b", Outcome::Error)
        },
    );
    let calls = usage.usage("t1").calls;
    assert_eq!(calls[0].code.as_deref(), Some("bad-request"));
    assert_eq!(calls[1].code, None);
}

#[tokio::test]
async fn stamps_each_call_with_the_clock_as_an_iso_time() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("a", Outcome::Ok));
    env.advance(1_234);
    usage.record("t1", call("b", Outcome::Ok));
    let calls = usage.usage("t1").calls;
    assert_eq!(calls[1].at, "2026-10-11T12:00:00.000Z");
    assert_eq!(calls[0].at, "2026-10-11T12:00:01.234Z");
}

#[tokio::test]
async fn shows_a_connection_without_a_process_id_or_with_id_zero_as_an_empty_source() {
    let env = Env::new();
    let usage = env.log();
    let _a = usage.connected("t1", pid(0));
    let _b = usage.connected("t1", ConnectionSource::default());
    assert_eq!(
        usage.usage("t1").connections,
        [ConnectionSource::default(), ConnectionSource::default()]
    );
}

#[tokio::test]
async fn reuses_an_hour_slot_after_24_hours_instead_of_adding_to_it() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("a", Outcome::OutOfScope));
    env.advance(24 * HOUR);
    usage.record("t1", call("b", Outcome::Ok));
    assert_eq!(usage.usage("t1").last24h, last24h(1, 0));
}

#[tokio::test]
async fn keeps_the_hours_of_the_last_24_hours_when_reading_a_file() {
    let env = Env::new();
    let hour = START / HOUR;
    fs::write(
        &env.file,
        json!({"t1": {"calls": [], "hours": [
            [hour, 4, 1],
            [hour - 23, 2, 2],
            [hour - 25, 9, 9]
        ]}})
        .to_string(),
    )
    .unwrap();
    assert_eq!(env.log().usage("t1").last24h, last24h(6, 3));
}

#[tokio::test]
async fn drops_stored_calls_that_are_not_valid_and_cleans_the_ones_it_keeps() {
    let env = Env::new();
    let good = json!({
        "at": "2026-10-11T11:00:00.000Z",
        "method": "pane.read",
        "target": {"workspaceId": "w1", "paneId": 7, "extra": "x"},
        "outcome": "ok",
        "code": 5,
        "unknown": true
    });
    fs::write(
        &env.file,
        json!({"t1": {"calls": [
            good,
            {"at": "not a time", "method": "m", "target": {}, "outcome": "ok"},
            {"at": 5, "method": "m", "target": {}, "outcome": "ok"},
            {"at": "2026-10-11T11:00:00.000Z", "method": 5, "target": {}, "outcome": "ok"},
            {"at": "2026-10-11T11:00:00.000Z", "method": "m", "target": {}, "outcome": "nope"},
            {"at": "2026-10-11T11:00:00.000Z", "method": "m", "target": {}},
            {"at": "2026-10-11T11:30:00.000Z", "method": "late", "target": null, "outcome": "error", "code": "bad"},
            null,
            "text",
            7
        ], "hours": []}})
        .to_string(),
    )
    .unwrap();
    let calls = env.log().usage("t1").calls;
    assert_eq!(methods(&calls), ["late", "pane.read"]);
    assert_eq!(
        calls[1],
        ScriptTokenCall {
            at: "2026-10-11T11:00:00.000Z".to_owned(),
            method: "pane.read".to_owned(),
            target: ScriptTokenCallTarget {
                workspace_id: Some("w1".to_owned()),
                pane_id: None,
            },
            outcome: Outcome::Ok,
            code: None,
        }
    );
    assert_eq!(calls[0].target, ScriptTokenCallTarget::default());
    assert_eq!(calls[0].code.as_deref(), Some("bad"));
}

#[tokio::test]
async fn keeps_only_the_last_100_stored_calls_and_skips_bad_hour_rows() {
    let env = Env::new();
    let hour = START / HOUR;
    let calls: Vec<Value> = (0..USAGE_KEEP + 7)
        .map(|i| {
            json!({"at": "2026-10-11T11:00:00.000Z", "method": format!("m{i}"), "target": {}, "outcome": "ok"})
        })
        .collect();
    fs::write(
        &env.file,
        json!({"t1": {"calls": calls, "hours": [
            [hour, 1, 0],
            [hour, 1],
            [hour, 1, 0, 0],
            [hour, 1.5, 0],
            "x",
            null
        ]}})
        .to_string(),
    )
    .unwrap();
    let snapshot = env.log().usage("t1");
    assert_eq!(snapshot.calls.len(), USAGE_KEEP);
    assert_eq!(snapshot.calls[0].method, format!("m{}", USAGE_KEEP + 6));
    assert_eq!(snapshot.calls.last().unwrap().method, "m7");
    assert_eq!(snapshot.last24h, last24h(1, 0));
}

#[tokio::test]
async fn starts_empty_when_the_file_is_missing_broken_or_not_an_object() {
    let env = Env::new();
    assert!(env.log().usage("t1").calls.is_empty());
    for text in [
        "{ nope",
        "[]",
        "5",
        "null",
        "{\"t1\": 5}",
        "{\"t1\": {\"calls\": 5, \"hours\": 5}}",
    ] {
        fs::write(&env.file, text).unwrap();
        let snapshot = env.log().usage("t1");
        assert!(snapshot.calls.is_empty(), "{text}");
        assert_eq!(snapshot.last24h, last24h(0, 0), "{text}");
    }
}

#[tokio::test]
async fn removes_a_cleared_token_from_a_file_that_was_read() {
    let env = Env::new();
    fs::copy(fixture("script-token-usage-before.json"), &env.file).unwrap();
    let usage = env.log();
    usage.clear("t1");
    usage.flush().await;
    assert_eq!(env.stored_keys(), ["t2"]);
}

#[tokio::test]
async fn keeps_the_log_of_one_token_apart_from_another() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("a", Outcome::Ok));
    usage.record("t2", call("b", Outcome::OutOfScope));
    assert_eq!(methods(&usage.usage("t1").calls), ["a"]);
    assert_eq!(usage.usage("t2").last24h, last24h(1, 1));
    assert_eq!(usage.usage("t1").last24h, last24h(1, 0));
}

fn listing_of(workspaces: &[(&str, &str)]) -> ReachListing {
    ReachListing {
        workspaces: workspaces
            .iter()
            .map(|(id, name)| ReachWorkspace {
                workspace_id: (*id).to_owned(),
                name: (*name).to_owned(),
                work_dir: "/home/u".to_owned(),
                group_id: None,
            })
            .collect(),
        groups: Vec::new(),
    }
}

fn counting_lookups(
    listing: Result<ReachListing, String>,
    panes: Option<Result<Vec<PaneTitle>, String>>,
) -> (UsageLookups, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let listing_calls = Arc::new(AtomicUsize::new(0));
    let pane_calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&listing_calls);
    let lookups = UsageLookups::new(move || {
        seen.fetch_add(1, Ordering::SeqCst);
        let result = listing.clone();
        async move { result }.boxed()
    });
    let lookups = match panes {
        None => lookups,
        Some(result) => {
            let seen = Arc::clone(&pane_calls);
            lookups.with_panes(move || {
                seen.fetch_add(1, Ordering::SeqCst);
                let result = result.clone();
                async move { result }.boxed()
            })
        }
    };
    (lookups, listing_calls, pane_calls)
}

fn pane_title(id: &str, title: &str) -> PaneTitle {
    PaneTitle {
        pane_id: id.to_owned(),
        title: title.to_owned(),
    }
}

fn names(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn seeded(env: &Env) -> ScriptTokenUsageLog {
    let usage = env.log();
    usage.record(
        "t1",
        aimed("pane.read", Some("w1"), Some("p1"), Outcome::Ok),
    );
    usage.record("t1", aimed("pane.input", Some("w2"), None, Outcome::Ok));
    usage
}

#[tokio::test]
async fn shows_the_usage_with_empty_names_when_there_are_no_lookups() {
    let env = Env::new();
    let usage = seeded(&env);
    let view = usage_view(&usage, "t1", None).await;
    assert_eq!(view.calls.len(), 2);
    assert_eq!(view.last24h, last24h(2, 0));
    assert!(view.names.workspaces.is_empty());
    assert!(view.names.panes.is_empty());
}

#[tokio::test]
async fn names_the_workspaces_and_panes_that_the_calls_aimed_at() {
    let env = Env::new();
    let usage = seeded(&env);
    let (lookups, _, _) = counting_lookups(
        Ok(listing_of(&[
            ("w1", "api"),
            ("w2", "web"),
            ("w3", "unused"),
        ])),
        Some(Ok(vec![
            pane_title("p1", "build"),
            pane_title("p9", "other"),
        ])),
    );
    let view = usage_view(&usage, "t1", Some(&lookups)).await;
    assert_eq!(
        view.names.workspaces,
        names(&[("w1", "api"), ("w2", "web")])
    );
    assert_eq!(view.names.panes, names(&[("p1", "build")]));
}

#[tokio::test]
async fn does_not_ask_for_workspaces_or_panes_that_no_call_aimed_at() {
    let env = Env::new();
    let usage = env.log();
    usage.record("t1", call("notify", Outcome::Ok));
    let (lookups, listing_calls, pane_calls) = counting_lookups(
        Ok(listing_of(&[("w1", "api")])),
        Some(Ok(vec![pane_title("p1", "build")])),
    );
    let view = usage_view(&usage, "t1", Some(&lookups)).await;
    assert!(view.names.workspaces.is_empty());
    assert!(view.names.panes.is_empty());
    assert_eq!(listing_calls.load(Ordering::SeqCst), 0);
    assert_eq!(pane_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn names_workspaces_when_there_is_no_pane_lookup() {
    let env = Env::new();
    let usage = seeded(&env);
    let (lookups, listing_calls, _) = counting_lookups(Ok(listing_of(&[("w1", "api")])), None);
    let view = usage_view(&usage, "t1", Some(&lookups)).await;
    assert_eq!(view.names.workspaces, names(&[("w1", "api")]));
    assert!(view.names.panes.is_empty());
    assert_eq!(listing_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn leaves_names_out_when_a_lookup_fails_and_keeps_the_other_names() {
    let env = Env::new();
    let usage = seeded(&env);
    let (failing_listing, _, _) = counting_lookups(
        Err("down".to_owned()),
        Some(Ok(vec![pane_title("p1", "build")])),
    );
    let view = usage_view(&usage, "t1", Some(&failing_listing)).await;
    assert!(view.names.workspaces.is_empty());
    assert_eq!(view.names.panes, names(&[("p1", "build")]));
    assert_eq!(view.calls.len(), 2);

    let (failing_panes, _, _) = counting_lookups(
        Ok(listing_of(&[("w1", "api")])),
        Some(Err("down".to_owned())),
    );
    let view = usage_view(&usage, "t1", Some(&failing_panes)).await;
    assert_eq!(view.names.workspaces, names(&[("w1", "api")]));
    assert!(view.names.panes.is_empty());
}

#[tokio::test]
async fn carries_the_connections_and_counts_into_the_view() {
    let env = Env::new();
    let usage = seeded(&env);
    let _held = usage.connected("t1", pid(9));
    let view = usage_view(&usage, "t1", None).await;
    assert_eq!(view.connections, [pid(9)]);
    assert_eq!(view.calls[0].method, "pane.input");
}
