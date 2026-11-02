#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_contract::install_method::{
    InstallMethod, ReleaseState, ReplaceAvailability, ReplaceStart, ReplaceState, UpdateRunStart,
    UpdateRunState,
};
use ostia_contract::releases::{ReleaseInfo, UpdateChannel, dmg_asset_name, tarball_asset_name};
use ostia_sync::install_replace::{
    InstallReplacer, InstallReplacerDeps, ReplaceError, ReplaceFn, ReplaceJob,
};
use ostia_sync::release_check::{
    FetchLatestOptions, LatestRelease, RELEASE_API_URL_ENV, RELEASE_CHECK_INTERVAL_MS,
    RELEASE_CHECK_RETRY_MS, ReleaseCheckError, ReleaseCheckResult, ReleaseCheckTrigger,
    ReleaseChecker, ReleaseCheckerDeps, ReleaseEndpoint, ReleaseService, ReleaseServiceDeps,
    dismissed_store_path, fetch_latest_release, load_dismissed, read_check_for_updates,
    read_update_channel, release_endpoint, release_user_agent, save_dismissed,
    spawn_release_schedule,
};
use ostia_sync::update_run::{UpdateRunner, UpdateRunnerDeps};
use serde_json::{Value, json};
use support::{FakeHttp, Reply, eventually, linux_host};
use tempfile::TempDir;

type LogEntry = (ReleaseCheckTrigger, String, Option<String>);
type Logs = Arc<Mutex<Vec<LogEntry>>>;
type LatestFuture = Pin<Box<dyn Future<Output = LatestRelease> + Send>>;
type ReplaceFuture = Pin<Box<dyn Future<Output = Result<(), ReplaceError>> + Send>>;
type OpenFuture = Pin<Box<dyn Future<Output = Option<String>> + Send>>;
type AvailabilityFuture = Pin<Box<dyn Future<Output = Option<ReplaceAvailability>> + Send>>;

const LATEST: &str = "/repos/aurigax-ai/ostia/releases/latest";
const LIST: &str = "/repos/aurigax-ai/ostia/releases?per_page=100";
const APT_COMMAND: &str = "sudo apt update && sudo apt install --only-upgrade ostia";

fn release(version: &str) -> ReleaseInfo {
    ReleaseInfo {
        version: version.to_owned(),
        url: format!("https://github.com/aurigax-ai/ostia/releases/tag/v{version}"),
        dmg_sha256: None,
    }
}

fn found(version: &str) -> LatestRelease {
    LatestRelease::Release(release(version))
}

fn body_with(version: &str, extra: Value) -> Value {
    let mut base = json!({
        "tag_name": format!("v{version}"),
        "html_url": release(version).url,
        "draft": false,
        "prerelease": false,
    });
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn body(version: &str) -> String {
    body_with(version, json!({})).to_string()
}

fn list(items: &[Value]) -> String {
    Value::Array(items.to_vec()).to_string()
}

fn prerelease(version: &str) -> Value {
    body_with(version, json!({"prerelease": true}))
}

fn json_reply(text: impl Into<String>) -> Reply {
    Reply::ok(text.into())
}

struct CheckerRig {
    checker: ReleaseChecker,
    now: Arc<AtomicI64>,
    enabled: Arc<Mutex<bool>>,
    enabled_calls: Arc<AtomicUsize>,
    channel: Arc<Mutex<UpdateChannel>>,
    latest: Arc<Mutex<LatestRelease>>,
    fetched: Arc<Mutex<Vec<UpdateChannel>>>,
    saved: Arc<Mutex<Vec<String>>>,
    changes: Arc<Mutex<Vec<Option<ReleaseInfo>>>>,
    logs: Logs,
}

#[derive(Default)]
struct RigOptions {
    current: Option<&'static str>,
    dismissed: Option<&'static str>,
    disabled: bool,
}

fn checker_rig(options: RigOptions) -> CheckerRig {
    let now = Arc::new(AtomicI64::new(1_000_000));
    let enabled = Arc::new(Mutex::new(!options.disabled));
    let enabled_calls = Arc::new(AtomicUsize::new(0));
    let channel = Arc::new(Mutex::new(UpdateChannel::Stable));
    let latest = Arc::new(Mutex::new(LatestRelease::None));
    let fetched: Arc<Mutex<Vec<UpdateChannel>>> = Arc::default();
    let saved: Arc<Mutex<Vec<String>>> = Arc::default();
    let changes: Arc<Mutex<Vec<Option<ReleaseInfo>>>> = Arc::default();
    let logs: Logs = Arc::default();
    let dismissed = options.dismissed.map(str::to_owned);
    let checker = ReleaseChecker::new(ReleaseCheckerDeps {
        current_version: options.current.unwrap_or("0.2.0").to_owned(),
        fetch_latest: Box::new({
            let latest = Arc::clone(&latest);
            let fetched = Arc::clone(&fetched);
            move |channel| -> LatestFuture {
                fetched.lock().unwrap().push(channel);
                let answer = latest.lock().unwrap().clone();
                Box::pin(async move { answer })
            }
        }),
        now: Arc::new({
            let now = Arc::clone(&now);
            move || now.load(Ordering::SeqCst)
        }),
        enabled: Box::new({
            let enabled = Arc::clone(&enabled);
            let calls = Arc::clone(&enabled_calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                *enabled.lock().unwrap()
            }
        }),
        channel: Box::new({
            let channel = Arc::clone(&channel);
            move || *channel.lock().unwrap()
        }),
        load_dismissed: Box::new(move || dismissed.clone()),
        save_dismissed: Box::new({
            let saved = Arc::clone(&saved);
            move |version| saved.lock().unwrap().push(version.to_owned())
        }),
        on_change: Box::new({
            let changes = Arc::clone(&changes);
            move |pending| changes.lock().unwrap().push(pending.cloned())
        }),
        log: Some(Box::new({
            let logs = Arc::clone(&logs);
            move |trigger: ReleaseCheckTrigger, outcome: &str, latest: Option<&str>| {
                logs.lock()
                    .unwrap()
                    .push((trigger, outcome.to_owned(), latest.map(str::to_owned)));
            }
        })),
    });
    CheckerRig {
        checker,
        now,
        enabled,
        enabled_calls,
        channel,
        latest,
        fetched,
        saved,
        changes,
        logs,
    }
}

impl CheckerRig {
    fn set_latest(&self, latest: LatestRelease) {
        *self.latest.lock().unwrap() = latest;
    }

    fn fetch_count(&self) -> usize {
        self.fetched.lock().unwrap().len()
    }

    fn changes(&self) -> Vec<Option<ReleaseInfo>> {
        self.changes.lock().unwrap().clone()
    }

    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

fn available(version: &str) -> ReleaseCheckResult {
    ReleaseCheckResult::Available {
        release: release(version),
    }
}

fn latest_is(version: &str) -> ReleaseCheckResult {
    ReleaseCheckResult::Latest {
        version: version.to_owned(),
    }
}

#[test]
fn ignores_the_override_in_a_packaged_build_and_checks_automatically() {
    let env = linux_host(&[("OSTIA_RELEASE_API_URL", "http://127.0.0.1:9")]);
    let expected = ReleaseEndpoint {
        base_url: "https://api.github.com".to_owned(),
        automatic: true,
    };
    assert_eq!(release_endpoint(true, &env), expected);
    let with_node_env = linux_host(&[
        ("OSTIA_RELEASE_API_URL", "http://127.0.0.1:9"),
        ("NODE_ENV", "test"),
    ]);
    assert_eq!(release_endpoint(true, &with_node_env), expected);
    assert_eq!(RELEASE_API_URL_ENV, "RELEASE_API_URL");
}

#[test]
fn checks_automatically_in_an_unpackaged_run_only_when_a_test_names_the_server() {
    assert_eq!(
        release_endpoint(false, &linux_host(&[])),
        ReleaseEndpoint {
            base_url: "https://api.github.com".to_owned(),
            automatic: false
        }
    );
    assert_eq!(
        release_endpoint(
            false,
            &linux_host(&[("OSTIA_RELEASE_API_URL", "http://127.0.0.1:9")])
        ),
        ReleaseEndpoint {
            base_url: "http://127.0.0.1:9".to_owned(),
            automatic: true
        }
    );
    assert_eq!(
        release_endpoint(
            false,
            &linux_host(&[("PINE_RELEASE_API_URL", "http://127.0.0.1:8")])
        ),
        ReleaseEndpoint {
            base_url: "https://api.github.com".to_owned(),
            automatic: false
        }
    );
    assert_eq!(
        release_endpoint(false, &linux_host(&[("OSTIA_RELEASE_API_URL", "")])),
        ReleaseEndpoint {
            base_url: "https://api.github.com".to_owned(),
            automatic: false
        }
    );
}

#[test]
fn is_on_unless_the_human_turned_it_off() {
    assert!(read_check_for_updates(&json!({})));
    assert!(read_check_for_updates(&Value::Null));
    assert!(read_check_for_updates(
        &json!({"behavior": {"checkForUpdates": "no"}})
    ));
    assert!(!read_check_for_updates(
        &json!({"behavior": {"checkForUpdates": false}})
    ));
}

#[test]
fn is_stable_unless_the_human_picked_main_or_beta() {
    let channel =
        |value: Value| read_update_channel(&json!({"behavior": {"updateChannel": value}}));
    assert_eq!(channel(json!("main")), UpdateChannel::Main);
    assert_eq!(channel(json!("beta")), UpdateChannel::Beta);
    assert_eq!(channel(json!("nightly")), UpdateChannel::Stable);
    assert_eq!(
        read_update_channel(&json!({"behavior": null})),
        UpdateChannel::Stable
    );
    assert_eq!(read_update_channel(&Value::Null), UpdateChannel::Stable);
}

#[test]
fn names_the_product_and_the_version_in_the_user_agent() {
    assert_eq!(release_user_agent("0.2.0"), "ostia/0.2.0");
}

#[tokio::test]
async fn asks_for_the_channel_the_human_picked() {
    let rig = checker_rig(RigOptions::default());
    *rig.channel.lock().unwrap() = UpdateChannel::Main;
    rig.checker.check(ReleaseCheckTrigger::Manual).await;
    assert_eq!(*rig.fetched.lock().unwrap(), [UpdateChannel::Main]);
}

#[tokio::test]
async fn drops_what_the_old_channel_found_and_checks_again_when_the_channel_changes() {
    let rig = checker_rig(RigOptions::default());
    rig.set_latest(found("0.3.0-main.4"));
    *rig.channel.lock().unwrap() = UpdateChannel::Main;
    rig.checker.settings_changed().await;
    assert_eq!(rig.checker.available(), Some(release("0.3.0-main.4")));

    rig.set_latest(LatestRelease::None);
    *rig.channel.lock().unwrap() = UpdateChannel::Stable;
    rig.checker.settings_changed().await;
    assert_eq!(
        *rig.fetched.lock().unwrap(),
        [UpdateChannel::Main, UpdateChannel::Stable]
    );
    assert_eq!(rig.checker.available(), None);
    assert_eq!(rig.changes(), [Some(release("0.3.0-main.4")), None]);
}

#[tokio::test]
async fn does_not_check_again_when_the_settings_change_but_the_channel_does_not() {
    let rig = checker_rig(RigOptions::default());
    rig.checker.check(ReleaseCheckTrigger::Manual).await;
    rig.checker.settings_changed().await;
    assert_eq!(rig.fetch_count(), 1);
}

#[tokio::test]
async fn clears_the_old_channel_result_without_asking_while_automatic_checks_are_off() {
    let rig = checker_rig(RigOptions {
        disabled: true,
        ..RigOptions::default()
    });
    rig.set_latest(found("0.3.0"));
    rig.checker.check(ReleaseCheckTrigger::Manual).await;
    *rig.channel.lock().unwrap() = UpdateChannel::Main;
    rig.checker.settings_changed().await;
    assert_eq!(rig.fetch_count(), 1);
    assert_eq!(rig.checker.pending(), None);
}

#[tokio::test]
async fn announces_a_strictly_newer_release_once_and_reports_it_as_available() {
    let rig = checker_rig(RigOptions::default());
    rig.set_latest(found("0.3.0"));

    assert_eq!(
        rig.checker.check(ReleaseCheckTrigger::Manual).await,
        available("0.3.0")
    );
    rig.checker.check(ReleaseCheckTrigger::Manual).await;

    assert_eq!(rig.changes(), [Some(release("0.3.0"))]);
    assert_eq!(rig.checker.pending(), Some(release("0.3.0")));
    assert_eq!(
        rig.logs.lock().unwrap()[0],
        (
            ReleaseCheckTrigger::Manual,
            "available".to_owned(),
            Some("0.3.0".to_owned())
        )
    );
}

#[tokio::test]
async fn reports_the_running_version_as_latest_for_the_same_an_older_or_no_release() {
    let rig = checker_rig(RigOptions::default());
    for latest in [found("0.2.0"), found("0.1.9"), LatestRelease::None] {
        rig.set_latest(latest);
        assert_eq!(
            rig.checker.check(ReleaseCheckTrigger::Manual).await,
            latest_is("0.2.0")
        );
    }
    assert!(rig.changes().is_empty());
    assert_eq!(rig.checker.pending(), None);
}

#[test]
fn checks_again_one_hour_after_a_successful_check() {
    assert_eq!(RELEASE_CHECK_INTERVAL_MS, 60 * 60 * 1000);
}

#[tokio::test]
async fn checks_on_the_first_tick_then_not_again_until_an_hour_has_passed() {
    let rig = checker_rig(RigOptions::default());

    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 1);

    rig.enabled_calls.store(0, Ordering::SeqCst);
    rig.advance(60 * 60 * 1000 - 1);
    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 1);
    assert_eq!(rig.enabled_calls.load(Ordering::SeqCst), 0);

    rig.advance(1);
    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 2);
    let triggers: Vec<ReleaseCheckTrigger> = rig
        .logs
        .lock()
        .unwrap()
        .iter()
        .map(|(trigger, _, _)| *trigger)
        .collect();
    assert_eq!(
        triggers,
        [ReleaseCheckTrigger::Auto, ReleaseCheckTrigger::Auto]
    );
}

#[tokio::test]
async fn retries_a_failed_check_after_release_check_retry_ms() {
    let rig = checker_rig(RigOptions::default());
    rig.set_latest(LatestRelease::Error(ReleaseCheckError::Offline));

    rig.checker.tick().await;
    rig.advance(RELEASE_CHECK_RETRY_MS - 1);
    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 1);

    rig.advance(1);
    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 2);
}

#[tokio::test]
async fn never_checks_on_a_tick_while_the_setting_is_off_and_resumes_when_it_is_turned_on() {
    let rig = checker_rig(RigOptions {
        disabled: true,
        ..RigOptions::default()
    });

    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 0);

    *rig.enabled.lock().unwrap() = true;
    rig.checker.tick().await;
    assert_eq!(rig.fetch_count(), 1);
}

#[tokio::test]
async fn counts_a_manual_check_toward_the_hourly_schedule_even_with_the_setting_off() {
    let rig = checker_rig(RigOptions {
        disabled: true,
        ..RigOptions::default()
    });

    rig.checker.check(ReleaseCheckTrigger::Manual).await;
    *rig.enabled.lock().unwrap() = true;
    rig.checker.tick().await;

    assert_eq!(rig.fetch_count(), 1);
}

#[tokio::test]
async fn shares_one_request_between_checks_that_overlap() {
    let rig = checker_rig(RigOptions::default());
    let auto = rig.checker.check(ReleaseCheckTrigger::Auto);
    let manual = rig.checker.check(ReleaseCheckTrigger::Manual);
    let (first, second) = tokio::join!(auto, manual);
    assert_eq!(first, second);
    assert_eq!(rig.fetch_count(), 1);
}

#[tokio::test]
async fn remembers_a_dismissed_version_and_stays_quiet_until_a_newer_one_appears() {
    let rig = checker_rig(RigOptions::default());
    rig.set_latest(found("0.3.0"));
    rig.checker.check(ReleaseCheckTrigger::Auto).await;

    rig.checker.dismiss();
    assert_eq!(*rig.saved.lock().unwrap(), ["0.3.0"]);
    assert_eq!(rig.checker.pending(), None);
    assert_eq!(rig.changes(), [Some(release("0.3.0")), None]);

    assert_eq!(
        rig.checker.check(ReleaseCheckTrigger::Manual).await,
        available("0.3.0")
    );
    assert_eq!(rig.changes().len(), 2);

    rig.set_latest(found("0.4.0"));
    rig.checker.check(ReleaseCheckTrigger::Auto).await;
    assert_eq!(rig.checker.pending(), Some(release("0.4.0")));
    assert_eq!(
        rig.changes(),
        [Some(release("0.3.0")), None, Some(release("0.4.0"))]
    );
}

#[tokio::test]
async fn stays_quiet_about_a_version_dismissed_in_an_earlier_run() {
    let rig = checker_rig(RigOptions {
        dismissed: Some("0.3.0"),
        ..RigOptions::default()
    });
    rig.set_latest(found("0.3.0"));

    rig.checker.check(ReleaseCheckTrigger::Auto).await;

    assert!(rig.changes().is_empty());
    assert_eq!(rig.checker.available(), Some(release("0.3.0")));
    assert_eq!(rig.checker.pending(), None);
}

#[tokio::test]
async fn keeps_the_known_release_when_a_later_check_fails() {
    let rig = checker_rig(RigOptions::default());
    rig.set_latest(found("0.3.0"));
    rig.checker.check(ReleaseCheckTrigger::Auto).await;

    rig.set_latest(LatestRelease::Error(ReleaseCheckError::RateLimited));
    assert_eq!(
        rig.checker.check(ReleaseCheckTrigger::Manual).await,
        ReleaseCheckResult::Error {
            error: ReleaseCheckError::RateLimited
        }
    );

    assert_eq!(rig.checker.pending(), Some(release("0.3.0")));
    assert_eq!(rig.changes(), [Some(release("0.3.0"))]);
}

#[test]
fn does_nothing_on_dismiss_when_no_release_is_known() {
    let rig = checker_rig(RigOptions::default());
    rig.checker.dismiss();
    assert!(rig.saved.lock().unwrap().is_empty());
    assert!(rig.changes().is_empty());
}

#[tokio::test]
async fn logs_the_error_of_a_failed_check_without_a_version() {
    let rig = checker_rig(RigOptions::default());
    rig.set_latest(LatestRelease::Error(ReleaseCheckError::Unavailable));
    rig.checker.check(ReleaseCheckTrigger::Manual).await;
    assert_eq!(
        rig.logs.lock().unwrap()[0],
        (ReleaseCheckTrigger::Manual, "unavailable".to_owned(), None)
    );
}

#[tokio::test(start_paused = true)]
async fn checks_by_itself_shortly_after_startup_and_not_before() {
    let rig = checker_rig(RigOptions::default());
    let _schedule = spawn_release_schedule(&rig.checker);

    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(rig.fetch_count(), 0);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(rig.fetch_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn the_schedule_never_checks_while_the_setting_is_off() {
    let rig = checker_rig(RigOptions {
        disabled: true,
        ..RigOptions::default()
    });
    let _schedule = spawn_release_schedule(&rig.checker);
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(rig.fetch_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn the_schedule_checks_again_about_an_hour_after_a_successful_automatic_check() {
    let started = tokio::time::Instant::now();
    let now: ostia_base::clock::Clock = Arc::new(move || {
        1_000_000 + i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
    });
    let fetched = Arc::new(AtomicUsize::new(0));
    let checker = ReleaseChecker::new(ReleaseCheckerDeps {
        current_version: "0.2.0".to_owned(),
        fetch_latest: Box::new({
            let fetched = Arc::clone(&fetched);
            move |_| -> LatestFuture {
                fetched.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { LatestRelease::None })
            }
        }),
        now,
        enabled: Box::new(|| true),
        channel: Box::new(|| UpdateChannel::Stable),
        load_dismissed: Box::new(|| None),
        save_dismissed: Box::new(|_| {}),
        on_change: Box::new(|_| {}),
        log: None,
    });
    let _schedule = spawn_release_schedule(&checker);

    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(fetched.load(Ordering::SeqCst), 1);

    tokio::time::sleep(Duration::from_millis(
        u64::try_from(RELEASE_CHECK_INTERVAL_MS).unwrap() - 2 * 60_000,
    ))
    .await;
    assert_eq!(fetched.load(Ordering::SeqCst), 1);

    tokio::time::sleep(Duration::from_secs(3 * 60)).await;
    assert_eq!(fetched.load(Ordering::SeqCst), 2);
}

struct Fake {
    github: FakeHttp,
}

async fn fake_github() -> Fake {
    let github = FakeHttp::start().await;
    github.reply_all(Reply::with_status(404, r#"{"message":"Not Found"}"#));
    Fake { github }
}

fn fetch_options(
    github: &FakeHttp,
    channel: UpdateChannel,
    timeout: Option<Duration>,
) -> FetchLatestOptions {
    FetchLatestOptions {
        base_url: github.url.clone(),
        user_agent: "ostia/0.2.0".to_owned(),
        channel,
        beta_asset: None,
        timeout,
    }
}

async fn fetch_from(github: &FakeHttp, channel: UpdateChannel) -> LatestRelease {
    fetch_latest_release(fetch_options(github, channel, None)).await
}

fn unavailable() -> LatestRelease {
    LatestRelease::Error(ReleaseCheckError::Unavailable)
}

#[tokio::test]
async fn lists_the_releases_on_the_main_channel_and_picks_the_highest_main_build_or_release() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(json_reply(list(&[
        prerelease("0.2.1-main.7"),
        body_with("0.2.0", json!({})),
        prerelease("0.2.1-main.12"),
    ])));

    assert_eq!(
        fetch_from(github, UpdateChannel::Main).await,
        found("0.2.1-main.12")
    );

    assert_eq!(github.paths(), [LIST]);
    assert_eq!(github.requests()[0].headers["user-agent"], "ostia/0.2.0");
}

#[tokio::test]
async fn looks_past_a_page_full_of_extension_releases_for_the_newest_app_release() {
    let fake = fake_github().await;
    let github = &fake.github;
    let extension = |n: usize| {
        json!({
            "tag_name": format!("ext/lsp-bash/v1.0.{n}"),
            "html_url": format!("https://github.com/aurigax-ai/ostia/releases/tag/ext%2Flsp-bash%2Fv1.0.{n}"),
            "draft": false,
            "prerelease": false,
        })
    };
    let page: Vec<Value> = (0..100).map(extension).collect();
    let full = json_reply(list(&page));
    github.queue(vec![
        full.clone(),
        full,
        json_reply(list(&[extension(31), body_with("0.2.0", json!({}))])),
    ]);
    assert_eq!(
        fetch_from(github, UpdateChannel::Main).await,
        found("0.2.0")
    );
    assert_eq!(
        github.paths(),
        [
            LIST.to_owned(),
            format!("{LIST}&page=2"),
            format!("{LIST}&page=3")
        ]
    );
}

#[tokio::test]
async fn stops_after_four_pages_of_releases() {
    let fake = fake_github().await;
    let github = &fake.github;
    let extension = |n: usize| {
        json!({
            "tag_name": format!("ext/lsp-bash/v1.0.{n}"),
            "html_url": format!("https://github.com/aurigax-ai/ostia/releases/tag/ext%2Flsp-bash%2Fv1.0.{n}"),
            "draft": false,
            "prerelease": false,
        })
    };
    let page: Vec<Value> = (0..100).map(extension).collect();
    github.reply_all(json_reply(list(&page)));
    assert_eq!(
        fetch_from(github, UpdateChannel::Main).await,
        LatestRelease::None
    );
    assert_eq!(github.paths().len(), 4);
}

#[tokio::test]
async fn never_lets_an_extension_release_stand_for_the_stable_app_release() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(json_reply(
        json!({
            "tag_name": "ext/lsp-bash/v1.0.0",
            "html_url": "https://github.com/aurigax-ai/ostia/releases/tag/ext%2Flsp-bash%2Fv1.0.0",
            "draft": false,
            "prerelease": false,
        })
        .to_string(),
    ));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        unavailable()
    );
}

#[tokio::test]
async fn reports_no_release_on_the_main_channel_for_an_empty_list_and_unavailable_for_a_non_list() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(json_reply("[]"));
    assert_eq!(
        fetch_from(github, UpdateChannel::Main).await,
        LatestRelease::None
    );
    github.reply_all(json_reply(body("0.3.0")));
    assert_eq!(fetch_from(github, UpdateChannel::Main).await, unavailable());
}

#[tokio::test]
async fn asks_for_the_latest_release_of_the_repository_and_sends_only_a_product_user_agent() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(json_reply(body("0.3.0")));

    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        found("0.3.0")
    );

    let requests = github.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LATEST);
    assert_eq!(requests[0].headers["user-agent"], "ostia/0.2.0");
    assert!(!requests[0].headers.contains_key("authorization"));
    assert!(!requests[0].headers.contains_key("cookie"));
    assert_eq!(requests[0].headers["accept"], "application/vnd.github+json");
}

#[tokio::test]
async fn reports_no_release_for_404_a_draft_or_a_prerelease() {
    let fake = fake_github().await;
    let github = &fake.github;
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        LatestRelease::None
    );
    github.reply_all(json_reply(
        body_with("0.3.0", json!({"draft": true})).to_string(),
    ));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        LatestRelease::None
    );
    github.reply_all(json_reply(
        body_with("0.3.0", json!({"prerelease": true})).to_string(),
    ));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        LatestRelease::None
    );
}

#[tokio::test]
async fn reports_a_rate_limit_for_403_and_429() {
    let fake = fake_github().await;
    let github = &fake.github;
    let limited = LatestRelease::Error(ReleaseCheckError::RateLimited);
    github.reply_all(Reply::with_status(
        403,
        r#"{"message":"API rate limit exceeded"}"#,
    ));
    assert_eq!(fetch_from(github, UpdateChannel::Stable).await, limited);
    github.reply_all(Reply::with_status(429, "{}"));
    assert_eq!(fetch_from(github, UpdateChannel::Stable).await, limited);
}

#[tokio::test]
async fn reports_unavailable_for_a_server_error_malformed_json_or_an_untrusted_release_page() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(Reply::with_status(500, "{}"));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        unavailable()
    );
    github.reply_all(json_reply("<html>captive portal</html>"));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        unavailable()
    );
    github.reply_all(json_reply(
        body_with(
            "0.3.0",
            json!({"html_url": "https://evil.example/aurigax-ai/ostia/releases/tag/v0.3.0"}),
        )
        .to_string(),
    ));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        unavailable()
    );
    github.reply_all(json_reply(
        body_with("0.3.0", json!({"body": "x".repeat(1024 * 1024)})).to_string(),
    ));
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        unavailable()
    );
}

#[tokio::test]
async fn refuses_to_follow_a_redirect() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(Reply::Body {
        status: 302,
        body: Vec::new(),
        location: Some(format!("{}/elsewhere", github.url)),
    });
    assert_eq!(
        fetch_from(github, UpdateChannel::Stable).await,
        unavailable()
    );
    assert_eq!(github.requests().len(), 1);
}

#[tokio::test]
async fn reports_offline_when_the_server_never_answers_or_cannot_be_reached() {
    let fake = fake_github().await;
    let github = &fake.github;
    let offline = LatestRelease::Error(ReleaseCheckError::Offline);
    github.reply_all(Reply::Hang);
    assert_eq!(
        fetch_latest_release(fetch_options(
            github,
            UpdateChannel::Stable,
            Some(Duration::from_millis(50))
        ))
        .await,
        offline
    );

    github.close().await;
    assert_eq!(fetch_from(github, UpdateChannel::Stable).await, offline);
}

#[tokio::test]
async fn offers_the_beta_asset_check_to_the_beta_channel_only() {
    let fake = fake_github().await;
    let github = &fake.github;
    let with_tarball = |version: &str| {
        body_with(
            version,
            json!({"prerelease": true, "assets": [{"name": tarball_asset_name(version)}]}),
        )
    };
    github.reply_all(json_reply(list(&[
        body_with(
            "0.3.2-rc.1",
            json!({"prerelease": true, "assets": [{"name": dmg_asset_name("0.3.2-rc.1")}]}),
        ),
        with_tarball("0.3.1-rc.2"),
    ])));
    let mut options = fetch_options(github, UpdateChannel::Beta, None);
    options.beta_asset = Some(tarball_asset_name);
    assert_eq!(fetch_latest_release(options).await, found("0.3.1-rc.2"));
    assert_eq!(github.paths(), [LIST]);
}

#[test]
fn keeps_the_dismissed_version_in_release_check_json_of_the_app_data_folder() {
    let host = linux_host(&[("XDG_DATA_HOME", "/data")]);
    assert_eq!(
        dismissed_store_path(&host),
        Path::new("/data/ostia-rs/release-check.json")
    );
}

#[test]
fn writes_the_dismissed_version_with_the_bytes_the_ts_app_wrote() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("release-check.json");
    save_dismissed(&file, "0.3.0").unwrap();
    let expected = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/rust/release-check-dismissed.json"),
    )
    .unwrap();
    assert_eq!(fs::read(&file).unwrap(), expected);
}

#[test]
fn reads_a_dismissed_version_only_when_it_is_a_valid_version_string() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("release-check.json");
    assert_eq!(load_dismissed(&file), None);
    for (text, expected) in [
        (r#"{"dismissedVersion":"0.3.0"}"#, Some("0.3.0")),
        (r#"{"dismissedVersion":"0.3.1-rc.2"}"#, Some("0.3.1-rc.2")),
        (r#"{"dismissedVersion":"not a version"}"#, None),
        (r#"{"dismissedVersion":3}"#, None),
        (r#"{"dismissedVersion":null}"#, None),
        (r#"{}"#, None),
        ("null", None),
        ("[]", None),
        (r#"{"dismissedVersion":"0.3."#, None),
    ] {
        fs::write(&file, text).unwrap();
        assert_eq!(load_dismissed(&file).as_deref(), expected, "{text}");
    }
}

struct ServiceRig {
    service: ReleaseService,
    settings: Arc<Mutex<Value>>,
    opened_urls: Arc<Mutex<Vec<String>>>,
    info: Arc<Mutex<Vec<(String, Value)>>>,
    terminals: Arc<AtomicUsize>,
    replaced: Arc<Mutex<Vec<ReleaseInfo>>>,
    events: tokio::sync::mpsc::UnboundedReceiver<ReleaseState>,
}

struct ServiceOptions<'a> {
    settings: Value,
    version: &'a str,
    method: InstallMethod,
}

impl Default for ServiceOptions<'_> {
    fn default() -> Self {
        Self {
            settings: json!({}),
            version: "0.2.0",
            method: InstallMethod::Apt,
        }
    }
}

fn register(github: &FakeHttp, data_home: &Path, options: ServiceOptions<'_>) -> ServiceRig {
    let settings = Arc::new(Mutex::new(options.settings));
    let opened_urls: Arc<Mutex<Vec<String>>> = Arc::default();
    let info: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let terminals = Arc::new(AtomicUsize::new(0));
    let replaced: Arc<Mutex<Vec<ReleaseInfo>>> = Arc::default();
    let method = options.method;
    let data_dir = data_home.to_string_lossy().into_owned();
    let host = linux_host(&[
        ("OSTIA_RELEASE_API_URL", github.url.as_str()),
        ("XDG_DATA_HOME", data_dir.as_str()),
    ]);
    let update_runner = UpdateRunner::new(UpdateRunnerDeps {
        method: Box::new(move || method),
        title: Box::new(|| "Update Ostia".to_owned()),
        open_terminal: Box::new({
            let terminals = Arc::clone(&terminals);
            move |_| -> OpenFuture {
                terminals.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Some("pane-1".to_owned()) })
            }
        }),
        host_token: Box::new(|command| format!("token:{command}")),
        on_change: Box::new(|_| {}),
    });
    let replace: ReplaceFn = Arc::new({
        let replaced = Arc::clone(&replaced);
        move |job: ReplaceJob| -> ReplaceFuture {
            replaced.lock().unwrap().push(job.release.clone());
            Box::pin(async { Ok(()) })
        }
    });
    let replacer = InstallReplacer::new(InstallReplacerDeps {
        app_dir: Box::new(|| Some(PathBuf::from("/apps/ostia"))),
        replace,
        on_state: Box::new(|_| {}),
        on_progress: Box::new(|_| {}),
        on_replaced: Box::new(|_| {}),
    });
    let service = ReleaseService::start(ReleaseServiceDeps {
        open_external: Box::new({
            let opened_urls = Arc::clone(&opened_urls);
            move |url| {
                opened_urls.lock().unwrap().push(url.to_owned());
                true
            }
        }),
        read_settings: Box::new({
            let settings = Arc::clone(&settings);
            move || settings.lock().unwrap().clone()
        }),
        log_info: Box::new({
            let info = Arc::clone(&info);
            move |event, fields| info.lock().unwrap().push((event.to_owned(), fields))
        }),
        log_warn: Box::new(|_| {}),
        version: options.version.to_owned(),
        method: Box::new(move || method),
        update_runner,
        replace_availability: Box::new(|| -> AvailabilityFuture {
            Box::pin(async { Some(ReplaceAvailability::Ok) })
        }),
        replacer,
        is_packaged: false,
        host,
    });
    let events = service.subscribe();
    ServiceRig {
        service,
        settings,
        opened_urls,
        info,
        terminals,
        replaced,
        events,
    }
}

fn state(version: Option<&str>) -> ReleaseState {
    ReleaseState {
        release: version.map(release),
        method: InstallMethod::Apt,
        update_command: Some(APT_COMMAND.to_owned()),
        replace: version.map(|_| ReplaceAvailability::Ok),
    }
}

async fn next_event(rig: &mut ServiceRig) -> ReleaseState {
    tokio::time::timeout(Duration::from_secs(15), rig.events.recv())
        .await
        .expect("no release event arrived")
        .expect("the event channel closed")
}

fn no_events(rig: &mut ServiceRig) -> bool {
    rig.events.try_recv().is_err()
}

fn data_home() -> TempDir {
    TempDir::new().unwrap()
}

#[tokio::test]
async fn answers_a_manual_check_with_the_newer_release_and_opens_only_its_validated_page() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    github.reply_all(json_reply(body("0.3.0")));
    let mut rig = register(github, data.path(), ServiceOptions::default());

    assert!(!rig.service.release_open());
    assert_eq!(rig.service.release_check().await, available("0.3.0"));
    assert_eq!(next_event(&mut rig).await, state(Some("0.3.0")));
    assert_eq!(rig.service.release_state().await, state(Some("0.3.0")));
    assert_eq!(rig.service.update_run().await, UpdateRunStart::Opened);
    assert_eq!(rig.terminals.load(Ordering::SeqCst), 1);
    assert_eq!(rig.service.update_run_state(), UpdateRunState::Running);
    assert_eq!(rig.service.install_replace(), ReplaceStart::Started);
    eventually("the replace to finish", || {
        matches!(
            rig.service.install_replace_state(),
            ReplaceState::Done { .. }
        )
    })
    .await;
    assert_eq!(*rig.replaced.lock().unwrap(), [release("0.3.0")]);

    assert!(rig.service.release_open());
    assert_eq!(*rig.opened_urls.lock().unwrap(), [release("0.3.0").url]);
    assert_eq!(github.requests()[0].headers["user-agent"], "ostia/0.2.0");
    assert_eq!(
        rig.info.lock().unwrap().last().unwrap(),
        &(
            "release-check".to_owned(),
            json!({"trigger": "manual", "outcome": "available", "latest": "0.3.0"})
        )
    );
}

#[tokio::test]
async fn answers_latest_for_the_same_an_older_or_no_release_and_an_error_for_a_rate_limit() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let mut rig = register(github, data.path(), ServiceOptions::default());
    github.reply_all(json_reply(body("0.2.0")));
    assert_eq!(rig.service.release_check().await, latest_is("0.2.0"));
    github.reply_all(json_reply(body("0.1.0")));
    assert_eq!(rig.service.release_check().await, latest_is("0.2.0"));
    github.reply_all(Reply::with_status(404, "{}"));
    assert_eq!(rig.service.release_check().await, latest_is("0.2.0"));
    github.reply_all(Reply::with_status(403, "{}"));
    assert_eq!(
        rig.service.release_check().await,
        ReleaseCheckResult::Error {
            error: ReleaseCheckError::RateLimited
        }
    );
    assert!(no_events(&mut rig));
    assert!(rig.opened_urls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn compares_a_local_build_without_its_build_metadata_and_never_sends_the_commit() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let rig = register(
        github,
        data.path(),
        ServiceOptions {
            version: "0.3.0+sha.1a2b3c.dirty",
            ..ServiceOptions::default()
        },
    );
    github.reply_all(json_reply(body("0.3.0")));
    assert_eq!(rig.service.release_check().await, latest_is("0.3.0"));
    github.reply_all(json_reply(body("0.4.0")));
    assert_eq!(rig.service.release_check().await, available("0.4.0"));
    assert_eq!(github.requests()[0].headers["user-agent"], "ostia/0.3.0");
}

#[tokio::test]
async fn offers_a_main_build_on_the_main_channel_and_never_an_older_release_on_stable() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let items = list(&[prerelease("0.3.1-main.9"), body_with("0.3.0", json!({}))]);
    let main = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"updateChannel": "main"}}),
            version: "0.3.1-main.8+sha.1a2b3c",
            method: InstallMethod::Tarball,
        },
    );
    github.reply_all(json_reply(items));
    assert_eq!(
        main.service.release_check().await,
        available("0.3.1-main.9")
    );

    let stable = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"updateChannel": "stable"}}),
            version: "0.3.1-main.9+sha.4d5e6f",
            method: InstallMethod::Tarball,
        },
    );
    github.reply_all(json_reply(body("0.3.0")));
    assert_eq!(
        stable.service.release_check().await,
        latest_is("0.3.1-main.9")
    );
    github.reply_all(json_reply(body("0.3.1")));
    assert_eq!(stable.service.release_check().await, available("0.3.1"));
}

#[tokio::test]
async fn keeps_an_install_from_a_package_manager_or_disk_image_off_the_main_channel() {
    let fake = fake_github().await;
    let github = &fake.github;
    for method in [InstallMethod::Apt, InstallMethod::Brew, InstallMethod::Dmg] {
        let data = data_home();
        github.clear_requests();
        let rig = register(
            github,
            data.path(),
            ServiceOptions {
                settings: json!({"behavior": {"updateChannel": "main"}}),
                method,
                ..ServiceOptions::default()
            },
        );
        github.reply_all(json_reply(body("0.2.0")));
        rig.service.release_check().await;
        assert_eq!(github.paths(), [LATEST], "{method:?}");
    }
}

#[tokio::test]
async fn checks_by_itself_shortly_after_startup_and_not_at_all_while_the_setting_is_off() {
    let fake = fake_github().await;
    let github = &fake.github;
    github.reply_all(json_reply(body("0.3.0")));
    let data = data_home();
    let off = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"checkForUpdates": false}}),
            ..ServiceOptions::default()
        },
    );
    tokio::time::sleep(Duration::from_secs(7)).await;
    assert!(github.requests().is_empty());
    drop(off);

    let other = data_home();
    let mut on = register(github, other.path(), ServiceOptions::default());
    assert_eq!(next_event(&mut on).await, state(Some("0.3.0")));
    assert_eq!(github.requests().len(), 1);
}

#[tokio::test]
async fn saves_a_dismissal_so_the_next_run_stays_quiet_about_that_version() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    github.reply_all(json_reply(body("0.3.0")));
    let mut first = register(github, data.path(), ServiceOptions::default());
    first.service.release_check().await;
    assert_eq!(next_event(&mut first).await, state(Some("0.3.0")));
    first.service.release_dismiss();
    assert_eq!(next_event(&mut first).await, state(None));

    let mut second = register(github, data.path(), ServiceOptions::default());
    assert_eq!(second.service.release_check().await, available("0.3.0"));
    assert_eq!(second.service.release_state().await, state(None));
    assert!(no_events(&mut second));
}

#[tokio::test]
async fn a_newer_release_shows_a_notice_that_opens_its_page_and_stays_skipped_after_a_restart() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    github.reply_all(json_reply(body("0.3.0")));
    let mut first = register(github, data.path(), ServiceOptions::default());
    assert_eq!(next_event(&mut first).await, state(Some("0.3.0")));
    assert_eq!(github.paths(), [LATEST]);
    assert_eq!(github.requests()[0].headers["user-agent"], "ostia/0.2.0");

    assert!(first.service.release_open());
    assert_eq!(*first.opened_urls.lock().unwrap(), [release("0.3.0").url]);
    first.service.release_dismiss();
    assert_eq!(next_event(&mut first).await, state(None));

    let mut second = register(github, data.path(), ServiceOptions::default());
    eventually("the second run to check by itself", || {
        github.requests().len() >= 2
    })
    .await;
    assert_eq!(second.service.release_check().await, available("0.3.0"));
    assert_eq!(second.service.release_state().await, state(None));
    assert!(no_events(&mut second));
}

#[tokio::test]
async fn with_the_automatic_check_off_nothing_is_asked_until_the_human_checks_from_about() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    github.reply_all(json_reply(body("0.3.0")));
    let rig = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"checkForUpdates": false}}),
            ..ServiceOptions::default()
        },
    );
    tokio::time::sleep(Duration::from_secs(7)).await;
    assert!(github.requests().is_empty());

    assert_eq!(rig.service.release_check().await, available("0.3.0"));
    assert_eq!(github.requests().len(), 1);
    assert_eq!(
        *rig.info.lock().unwrap(),
        [(
            "release-check".to_owned(),
            json!({"trigger": "manual", "outcome": "available", "latest": "0.3.0"})
        )]
    );

    assert!(rig.service.release_open());
    assert_eq!(*rig.opened_urls.lock().unwrap(), [release("0.3.0").url]);
}

async fn wait_for_no_release(rig: &ServiceRig) {
    for _ in 0..1000 {
        if rig.service.release_state().await.release.is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the release stayed in the state");
}

#[tokio::test]
async fn a_tarball_install_on_the_main_channel_is_offered_the_newest_main_build_and_stable_again_only_releases()
 {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let rig = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"checkForUpdates": false, "updateChannel": "stable"}}),
            method: InstallMethod::Tarball,
            ..ServiceOptions::default()
        },
    );
    *rig.settings.lock().unwrap() =
        json!({"behavior": {"checkForUpdates": false, "updateChannel": "main"}});
    rig.service.settings_changed();
    github.reply_all(json_reply(list(&[
        prerelease("0.3.1-main.5"),
        body_with("0.3.0", json!({})),
    ])));
    assert_eq!(rig.service.release_check().await, available("0.3.1-main.5"));
    assert_eq!(github.paths(), [LIST]);

    *rig.settings.lock().unwrap() =
        json!({"behavior": {"checkForUpdates": false, "updateChannel": "stable"}});
    rig.service.settings_changed();
    wait_for_no_release(&rig).await;
    github.reply_all(json_reply(body("0.3.0")));
    assert_eq!(rig.service.release_check().await, available("0.3.0"));
    assert_eq!(github.paths().last().map(String::as_str), Some(LATEST));
}

#[tokio::test]
async fn a_dirty_tarball_build_on_the_main_channel_is_offered_only_the_newest_release_and_a_clean_sha_build_still_gets_the_main_build()
 {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let items = list(&[prerelease("0.3.1-main.5"), body_with("0.3.0", json!({}))]);
    let settings = json!({"behavior": {"checkForUpdates": false, "updateChannel": "main"}});

    let dirty = register(
        github,
        data.path(),
        ServiceOptions {
            settings: settings.clone(),
            version: "0.2.0+sha.abc123.dirty",
            method: InstallMethod::Tarball,
        },
    );
    github.reply_all(json_reply(body("0.3.0")));
    assert_eq!(dirty.service.release_check().await, available("0.3.0"));
    assert_eq!(github.paths(), [LATEST]);

    github.clear_requests();
    let clean = register(
        github,
        data.path(),
        ServiceOptions {
            settings,
            version: "0.2.0+sha.abc123",
            method: InstallMethod::Tarball,
        },
    );
    github.reply_all(json_reply(items));
    assert_eq!(
        clean.service.release_check().await,
        available("0.3.1-main.5")
    );
    assert_eq!(github.paths(), [LIST]);
}

#[tokio::test]
async fn a_dmg_or_brew_install_with_beta_on_is_offered_the_newest_release_candidate_that_has_a_dmg()
{
    let fake = fake_github().await;
    let github = &fake.github;
    let dmg = |version: &str| json!({"assets": [{"name": dmg_asset_name(version), "digest": format!("sha256:{}", "ab".repeat(32))}]});
    for method in [InstallMethod::Dmg, InstallMethod::Brew] {
        let data = data_home();
        github.clear_requests();
        let rig = register(
            github,
            data.path(),
            ServiceOptions {
                settings: json!({"behavior": {"checkForUpdates": false, "updateChannel": "beta"}}),
                version: "0.3.0",
                method,
            },
        );
        github.reply_all(json_reply(list(&[
            prerelease("0.3.2-rc.1"),
            body_with(
                "0.3.1-main.4",
                json!({"prerelease": true, "assets": dmg("0.3.1-main.4")["assets"]}),
            ),
            body_with(
                "0.3.1-rc.2",
                json!({"prerelease": true, "assets": dmg("0.3.1-rc.2")["assets"]}),
            ),
            body_with("0.3.0", dmg("0.3.0")),
        ])));
        assert_eq!(
            rig.service.release_check().await,
            ReleaseCheckResult::Available {
                release: ReleaseInfo {
                    dmg_sha256: Some("ab".repeat(32)),
                    ..release("0.3.1-rc.2")
                }
            },
            "{method:?}"
        );
        assert_eq!(github.paths(), [LIST], "{method:?}");
    }
}

#[tokio::test]
async fn a_tarball_install_on_beta_is_offered_the_newest_release_candidate_that_has_a_tarball_never_a_main_build()
 {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let tarball = |version: &str| json!({"assets": [{"name": tarball_asset_name(version)}]});
    let rig = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"checkForUpdates": false, "updateChannel": "beta"}}),
            version: "0.3.0",
            method: InstallMethod::Tarball,
        },
    );
    github.reply_all(json_reply(list(&[
        body_with(
            "0.3.2-rc.1",
            json!({"prerelease": true, "assets": [{"name": "ostia-0.3.2-rc.1-arm64.dmg"}]}),
        ),
        body_with(
            "0.3.2-main.4",
            json!({"prerelease": true, "assets": tarball("0.3.2-main.4")["assets"]}),
        ),
        body_with(
            "0.3.1-rc.2",
            json!({"prerelease": true, "assets": tarball("0.3.1-rc.2")["assets"]}),
        ),
        body_with("0.3.0", tarball("0.3.0")),
    ])));
    assert_eq!(rig.service.release_check().await, available("0.3.1-rc.2"));
    assert_eq!(github.paths(), [LIST]);
}

#[tokio::test]
async fn with_beta_turned_off_a_release_candidate_newer_than_the_latest_release_is_not_offered_as_a_downgrade()
 {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let rig = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"checkForUpdates": false, "updateChannel": "beta"}}),
            version: "0.3.1-rc.2",
            method: InstallMethod::Dmg,
        },
    );
    *rig.settings.lock().unwrap() =
        json!({"behavior": {"checkForUpdates": false, "updateChannel": "stable"}});
    rig.service.settings_changed();
    github.reply_all(json_reply(body("0.3.0")));
    assert_eq!(rig.service.release_check().await, latest_is("0.3.1-rc.2"));
    assert_eq!(github.paths().last().map(String::as_str), Some(LATEST));
    github.reply_all(json_reply(body("0.3.1")));
    assert_eq!(rig.service.release_check().await, available("0.3.1"));
}

#[tokio::test]
async fn an_apt_install_keeps_the_channel_picker_on_stable_and_says_why() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    github.reply_all(json_reply(body("0.3.0")));
    let rig = register(
        github,
        data.path(),
        ServiceOptions {
            settings: json!({"behavior": {"checkForUpdates": false, "updateChannel": "main"}}),
            ..ServiceOptions::default()
        },
    );
    assert_eq!(rig.service.release_check().await, available("0.3.0"));
    assert_eq!(github.paths(), [LATEST]);
}

#[tokio::test]
async fn offers_nothing_to_replace_or_open_before_a_release_is_known() {
    let fake = fake_github().await;
    let github = &fake.github;
    let data = data_home();
    let rig = register(github, data.path(), ServiceOptions::default());
    let none_yet = rig.service.release_state().await;
    assert_eq!(none_yet, state(None));
    assert_eq!(rig.service.install_replace(), ReplaceStart::NoAction);
    assert!(!rig.service.release_open());
    assert_eq!(rig.service.install_replace_state(), ReplaceState::Idle);
    assert_eq!(rig.service.update_run_state(), UpdateRunState::Idle);
}
