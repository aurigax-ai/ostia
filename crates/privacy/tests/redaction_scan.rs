#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{FAKE, HARMLESS, MIB, fill, fixture_script, real_worker};
use ostia_privacy::redaction::Redactor;
use ostia_privacy::redaction_scan::{
    SecretScan, WorkerScan, redaction_worker_script, scan_deadline,
};
use serde_json::{Value, json};

const BUDGET: Duration = if cfg!(target_os = "macos") {
    Duration::from_secs(30)
} else {
    Duration::from_secs(5)
};

fn huge() -> String {
    "a".repeat(8 * MIB)
}

fn stalling_patterns() -> Value {
    json!({"redaction": {"patterns": ["[a-z]+Z"]}})
}

fn fixed_deadline(millis: u64) -> impl Fn(usize) -> Duration + Send + Sync + 'static {
    move |_| Duration::from_millis(millis)
}

fn start_ticker(gaps: &Arc<Mutex<Vec<Duration>>>) -> tokio::task::JoinHandle<()> {
    let gaps = Arc::clone(gaps);
    tokio::spawn(async move {
        let mut last = Instant::now();
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        loop {
            tick.tick().await;
            let now = Instant::now();
            gaps.lock().unwrap().push(now - last);
            last = now;
        }
    })
}

#[test]
fn stays_in_the_project_folder_when_unpackaged() {
    assert_eq!(
        redaction_worker_script(Path::new("/home/u/ostia")),
        Path::new("/home/u/ostia/out/redaction-lint/worker.js")
    );
}

#[test]
fn gives_two_seconds_to_empty_text_and_six_more_for_each_mib() {
    assert_eq!(scan_deadline(0), Duration::from_millis(2000));
    assert_eq!(scan_deadline(MIB / 2), Duration::from_millis(5000));
    assert_eq!(scan_deadline(MIB), Duration::from_millis(8000));
    assert_eq!(scan_deadline(MIB + 1), Duration::from_millis(8001));
}

#[test]
fn never_gives_more_than_twenty_seconds() {
    assert_eq!(scan_deadline(3 * MIB), Duration::from_millis(20_000));
    assert_eq!(scan_deadline(4 * MIB), Duration::from_millis(20_000));
    assert_eq!(scan_deadline(1000 * MIB), Duration::from_millis(20_000));
}

#[tokio::test]
async fn fails_closed_within_its_deadline_when_the_worker_never_answers() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-hang.mjs"),
        fixed_deadline(400),
    );
    let redactor = Redactor::new(stalling_patterns, worker.clone());
    let started = Instant::now();
    let error = redactor.redact(&huge()).await.unwrap_err();
    assert_eq!(error.to_string(), "scan timed out");
    assert!(started.elapsed() < Duration::from_secs(3));
    worker.close().await;
}

#[tokio::test]
async fn serves_the_next_scan_with_a_fresh_worker_after_one_timed_out() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-hang-large.mjs"),
        |length| {
            if length > 1000 {
                Duration::from_millis(300)
            } else {
                Duration::from_millis(5000)
            }
        },
    );
    let error = worker.scan(&huge()).await.unwrap_err();
    assert_eq!(error.to_string(), "scan timed out");
    let spans = worker.scan(&format!("k {}", FAKE.npm)).await.unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].kind, "npm");
    worker.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_main_event_loop_responsive_while_a_slow_scan_runs() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-hang.mjs"),
        fixed_deadline(1500),
    );
    let gaps = Arc::new(Mutex::new(Vec::new()));
    let ticker = start_ticker(&gaps);
    let error = worker.scan(&huge()).await.unwrap_err();
    assert_eq!(error.to_string(), "scan timed out");
    ticker.abort();
    worker.close().await;
    let gaps = gaps.lock().unwrap();
    assert!(gaps.len() > 20);
    assert!(gaps.iter().max().unwrap() < &Duration::from_millis(250));
}

#[tokio::test]
async fn answers_queued_scans_in_order() {
    let redactor = Redactor::new(|| Value::Null, real_worker());
    let middle = format!("x {}", FAKE.npm);
    let (first, second, third) = tokio::join!(
        redactor.redact("a"),
        redactor.redact(&middle),
        redactor.redact("b"),
    );
    let counts = [
        first.unwrap().count,
        second.unwrap().count,
        third.unwrap().count,
    ];
    assert_eq!(counts, [0, 1, 0]);
}

#[tokio::test]
async fn rejects_the_running_scan_and_every_waiting_scan_when_closed() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-hang.mjs"),
        fixed_deadline(60_000),
    );
    let scans: Vec<_> = (0..3)
        .map(|n| {
            let worker = worker.clone();
            tokio::spawn(async move { worker.scan(&format!("text {n}")).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    worker.close().await;
    for scan in scans {
        let error = scan.await.unwrap().unwrap_err();
        assert_eq!(error.to_string(), "scan closed");
    }
}

#[tokio::test]
async fn fails_the_scan_when_the_worker_exits() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-exit.mjs"),
        fixed_deadline(5000),
    );
    let error = worker.scan("anything").await.unwrap_err();
    assert_eq!(error.to_string(), "scan worker exited");
    worker.close().await;
}

#[tokio::test]
async fn fails_the_scan_with_the_error_text_of_the_worker() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-error.mjs"),
        fixed_deadline(5000),
    );
    let error = worker.scan("anything").await.unwrap_err();
    assert_eq!(error.to_string(), "rule exploded");
    worker.close().await;
}

#[tokio::test]
async fn ignores_a_reply_for_another_scan_and_times_out() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-wrong-id.mjs"),
        fixed_deadline(300),
    );
    let error = worker.scan("anything").await.unwrap_err();
    assert_eq!(error.to_string(), "scan timed out");
    worker.close().await;
}

#[tokio::test]
async fn fails_the_scan_when_the_worker_program_does_not_exist() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("no-such-worker.mjs"),
        fixed_deadline(5000),
    );
    assert!(worker.scan("anything").await.is_err());
    worker.close().await;
}

#[tokio::test]
async fn fails_a_scan_started_after_close() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-hang.mjs"),
        fixed_deadline(5000),
    );
    worker.close().await;
    assert!(worker.scan("anything").await.is_err());
}

const ADVERSARIAL: [(&str, &str); 14] = [
    ("one letter", "a"),
    ("JWT prefixes", "eyJ"),
    ("JWT parts with no end", "eyJhbGciOiJIUzI1NiJ9."),
    ("key prefixes", "sk-"),
    ("token prefixes", "ghp_"),
    ("AWS prefixes", "AKIA"),
    ("private key headers", "-----BEGIN RSA PRIVATE KEY-----\n"),
    ("URL user parts", "https://a:"),
    ("assignment names", "password="),
    ("secret names", "passwordtokensecret"),
    ("authorization headers", "Authorization: Bearer "),
    ("quotes after a name", "token: \""),
    ("blank lines", "\n"),
    ("spaces", " "),
];

#[tokio::test]
async fn reads_1_mib_of_adversarial_text_without_stalling() {
    let worker = real_worker();
    let custom = Redactor::new(
        || json!({"redaction": {"patterns": ["ACME-[A-Za-z0-9]{32}"]}}),
        worker.clone(),
    );
    for (name, unit) in ADVERSARIAL {
        let text = fill(unit, MIB);
        let started = Instant::now();
        custom.redact(&text).await.unwrap();
        assert!(started.elapsed() < BUDGET, "{name}");
    }
    worker.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn settles_within_its_deadline_on_1_mib_made_to_stall_an_open_ended_pattern_never_blocking_main()
 {
    let worker = real_worker();
    let custom = Redactor::new(
        || json!({"redaction": {"patterns": ["[a-z]+Z", "x[0-9]{1,64}y"]}}),
        worker.clone(),
    );
    let gaps = Arc::new(Mutex::new(Vec::new()));
    let ticker = start_ticker(&gaps);
    let mut outcomes = Vec::new();
    let started = Instant::now();
    for text in [fill("a", MIB), fill("x1", MIB)] {
        match custom.redact(&text).await {
            Ok(result) => {
                assert_eq!(result.count, 0);
                outcomes.push("spans");
            }
            Err(error) => {
                assert_eq!(error.to_string(), "scan timed out");
                outcomes.push("timed out");
            }
        }
    }
    let elapsed = started.elapsed();
    ticker.abort();
    worker.close().await;
    assert!(elapsed < 2 * scan_deadline(MIB) + Duration::from_secs(4));
    assert!(gaps.lock().unwrap().iter().max().unwrap() < &Duration::from_millis(500));
    if !cfg!(target_os = "macos") {
        assert_eq!(outcomes, ["spans", "spans"]);
    }
}

#[tokio::test]
async fn reads_1_mib_of_mixed_terminal_output_with_secrets_without_stalling() {
    let block = [
        format!("export GITHUB_TOKEN={}", FAKE.github_classic),
        format!("commit {}", HARMLESS.git_sha),
        FAKE.private_key.clone(),
        HARMLESS.long_path.to_owned(),
        format!(
            "curl -H \"Authorization: Bearer {}\" {}/v1",
            FAKE.bearer, FAKE.basic_auth_url
        ),
    ]
    .join("\n");
    let worker = WorkerScan::new(common::node(), common::real_worker_script(), |_| BUDGET);
    let timed = Redactor::new(|| Value::Null, worker.clone());
    timed.redact(&block).await.unwrap();
    let started = Instant::now();
    let result = timed
        .redact(&fill(&format!("{block}\n"), MIB))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    worker.close().await;
    assert!(elapsed < BUDGET);
    assert!(!result.text.contains(&FAKE.github_classic));
    assert!(result.count > 1000);
}

#[tokio::test]
async fn gives_the_worker_an_empty_environment() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("scan-env.mjs"),
        fixed_deadline(5000),
    );
    let error = worker.scan("anything").await.unwrap_err();
    assert_eq!(error.to_string(), "");
    worker.close().await;
}

#[tokio::test]
async fn refuses_a_runtime_path_that_is_not_absolute() {
    let worker = WorkerScan::new("node", common::real_worker_script(), fixed_deadline(5000));
    let error = worker.scan("anything").await.unwrap_err();
    assert_eq!(error.to_string(), "scan runtime path is not absolute");
    worker.close().await;
}

#[tokio::test]
async fn refuses_to_run_when_the_runtime_is_missing() {
    let worker = WorkerScan::new(
        "/no/such/dir/node",
        common::real_worker_script(),
        fixed_deadline(5000),
    );
    let error = worker.scan("anything").await.unwrap_err();
    assert_eq!(error.to_string(), "scan runtime is missing");
    worker.close().await;
}

#[tokio::test]
async fn names_the_build_step_when_the_worker_script_is_missing() {
    let worker = WorkerScan::new(
        common::node(),
        fixture_script("no-such-worker.mjs"),
        fixed_deadline(5000),
    );
    let error = worker.scan("anything").await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("pnpm run build:redaction-lint-worker")
    );
    worker.close().await;
}

#[tokio::test]
async fn scans_text_with_line_and_paragraph_separators_and_keeps_the_worker() {
    let worker = real_worker();
    let text = format!("a\u{2028}b\u{2029}c {}", FAKE.npm);
    let spans = worker.scan(&text).await.unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].kind, "npm");
    let again = worker.scan(&format!("k {}", FAKE.npm)).await.unwrap();
    assert_eq!(again.len(), 1);
    worker.close().await;
}
