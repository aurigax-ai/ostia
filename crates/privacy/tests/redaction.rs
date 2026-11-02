#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Counting, FAKE, Failing, HARMLESS, MIB, fixture_script, off, on, real_worker};
use ostia_contract::redaction::{
    REDACT_TEXT_MAX, REDACT_TEXTS_MAX, RedactionKindSource, RedactionResult,
};
use ostia_privacy::redaction::{Redactor, ScrollbackRedactor, redact_requested_texts};
use ostia_privacy::redaction_scan::{ScanError, SecretScan, WorkerScan, scan_deadline};
use ostia_privacy::secret_scanner::SCAN_CHUNK_MAX;
use serde_json::{Value, json};

fn kinds_of(result: &RedactionResult) -> Value {
    serde_json::to_value(&result.kinds).unwrap()
}

fn assert_unchanged(result: &RedactionResult, text: &str, context: &str) {
    assert_eq!(result.text, text, "{context}");
    assert_eq!(result.count, 0, "{context}");
    assert_eq!(kinds_of(result), json!({}), "{context}");
}

fn only_kind(kind: &str) -> Value {
    let mut kinds = serde_json::Map::new();
    kinds.insert(kind.to_owned(), json!(1));
    Value::Object(kinds)
}

fn panes(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|(pane, screen)| ((*pane).to_owned(), (*screen).to_owned()))
        .collect()
}

fn live_privacy(shared: &Arc<Mutex<Value>>) -> impl Fn() -> Value + Send + Sync + 'static {
    let shared = Arc::clone(shared);
    move || shared.lock().unwrap().clone()
}

#[tokio::test]
async fn redacts_each_library_secret_by_its_own_kind() {
    let cases: Vec<(&str, &str, &str)> = vec![
        ("an AWS access key id", &FAKE.aws_access_key_id, "aws"),
        ("a classic GitHub token", &FAKE.github_classic, "github"),
        (
            "a fine-grained GitHub token",
            &FAKE.github_fine_grained,
            "github",
        ),
        ("a GitLab token", &FAKE.gitlab, "gitlab"),
        ("a Slack token", &FAKE.slack_bot, "slack"),
        ("a legacy OpenAI key", &FAKE.openai_legacy, "openai"),
        ("an OpenAI project key", &FAKE.openai_project, "openai"),
        ("an Anthropic key", &FAKE.anthropic, "anthropic"),
        ("a Stripe live key", &FAKE.stripe_live, "stripe"),
        ("a Stripe restricted key", &FAKE.stripe_restricted, "stripe"),
        ("an npm token", &FAKE.npm, "npm"),
        ("a PEM private key", &FAKE.private_key, "privatekey"),
        ("a URL with a password", &FAKE.basic_auth_url, "basicauth"),
        (
            "a database URL with a password",
            &FAKE.postgres_url,
            "database-connection-string",
        ),
    ];
    let redactor = on();
    for (name, secret, kind) in cases {
        let result = redactor
            .redact(&format!("before {secret} after"))
            .await
            .unwrap();
        assert_eq!(
            result.text,
            format!("before [redacted:{kind}] after"),
            "{name}"
        );
        assert_eq!(result.count, 1, "{name}");
        assert_eq!(kinds_of(&result), only_kind(kind), "{name}");
    }
}

#[tokio::test]
async fn redacts_the_whole_aws_secret_key_and_keeps_its_name() {
    let result = on()
        .redact(&format!(
            "aws_secret_access_key = {}\nregion = us-east-1",
            FAKE.aws_secret_key
        ))
        .await
        .unwrap();
    assert_eq!(
        result.text,
        "aws_secret_access_key = [redacted:aws]\nregion = us-east-1"
    );
}

#[tokio::test]
async fn redacts_the_kinds_the_library_lacks() {
    let text = [
        format!("jwt {}", FAKE.jwt),
        format!("google {}", FAKE.google_api_key),
        format!("Authorization: Bearer {}", FAKE.bearer),
        "DB_PASSWORD=hunter2hunter2".to_owned(),
    ]
    .join("\n");
    let result = on().redact(&text).await.unwrap();
    assert_eq!(
        result.text,
        [
            "jwt [redacted:jwt]",
            "google [redacted:google-api-key]",
            "Authorization: Bearer [redacted:authorization]",
            "DB_PASSWORD=[redacted:assignment]",
        ]
        .join("\n")
    );
    assert_eq!(result.count, 4);
}

#[tokio::test]
async fn names_a_token_by_its_own_kind_when_it_is_also_the_value_of_an_assignment() {
    let result = on()
        .redact(&format!("GITHUB_TOKEN={}", FAKE.github_classic))
        .await
        .unwrap();
    assert_eq!(result.text, "GITHUB_TOKEN=[redacted:github]");
}

#[tokio::test]
async fn leaves_harmless_text_alone() {
    let cases: Vec<(&str, &str)> = vec![
        ("gitSha", HARMLESS.git_sha),
        ("sha256", HARMLESS.sha256),
        ("uuid", HARMLESS.uuid),
        ("longPath", HARMLESS.long_path),
        ("base64", &HARMLESS.base64),
        ("prose", HARMLESS.prose),
    ];
    let redactor = on();
    for (name, text) in cases {
        let input = format!("see {text} here");
        let result = redactor.redact(&input).await.unwrap();
        assert_unchanged(&result, &input, name);
    }
}

#[tokio::test]
async fn leaves_ordinary_shell_output_and_code_alone() {
    let text = [
        "On branch main".to_owned(),
        format!("commit {} (HEAD -> main)", HARMLESS.git_sha),
        "const password = await prompt(\"Password: \")".to_owned(),
        "export function verifyToken(token: string): boolean {".to_owned(),
        format!("-rw-r--r-- 1 u u 4096 Oct  1 12:00 {}", HARMLESS.long_path),
    ]
    .join("\n");
    assert_eq!(on().redact(&text).await.unwrap().text, text);
}

#[tokio::test]
async fn cannot_be_switched_off_by_a_comment_in_the_text() {
    let text = format!(
        "/* secretlint-disable */\n{}\n/* secretlint-enable */",
        FAKE.github_classic
    );
    let result = on().redact(&text).await.unwrap();
    assert!(!result.text.contains(&FAKE.github_classic));
}

#[tokio::test]
async fn gives_the_same_text_when_run_on_its_own_output() {
    let text = [
        format!("GITHUB_TOKEN={}", FAKE.github_classic),
        format!("password=\"{}\"", FAKE.bearer),
        FAKE.basic_auth_url.clone(),
        FAKE.private_key.clone(),
        format!("aws_secret_access_key = {}", FAKE.aws_secret_key),
    ]
    .join("\n");
    let redactor = on();
    let once = redactor.redact(&text).await.unwrap();
    assert_eq!(once.count, 5);
    let twice = redactor.redact(&once.text).await.unwrap();
    assert_unchanged(&twice, &once.text, "second run");
}

#[tokio::test]
async fn changes_nothing_while_the_setting_is_off_and_preview_still_shows_what_it_would_do() {
    let text = format!("token {}", FAKE.github_classic);
    let redactor = off();
    assert_unchanged(&redactor.redact(&text).await.unwrap(), &text, "redact");
    assert_eq!(
        redactor.preview(&text).await.unwrap().text,
        "token [redacted:github]"
    );
}

#[tokio::test]
async fn applies_the_patterns_of_the_human_and_ignores_an_invalid_one() {
    let custom = Redactor::new(
        || json!({"redaction": {"patterns": ["ACME-[0-9]{6}", "(a+)+b", "ACME-["]}}),
        real_worker(),
    );
    let result = custom.redact("ticket ACME-123456 aaaaab").await.unwrap();
    assert_eq!(result.text, "ticket [redacted:custom] aaaaab");
    assert_eq!(kinds_of(&result), json!({"custom": 1}));
}

#[tokio::test]
async fn reads_the_settings_again_on_every_call() {
    let privacy = Arc::new(Mutex::new(json!({"redaction": {"enabled": false}})));
    let live = Redactor::new(live_privacy(&privacy), real_worker());
    let text = format!("x {}", FAKE.npm);
    assert_eq!(live.redact(&text).await.unwrap().count, 0);
    *privacy.lock().unwrap() = json!({"redaction": {"enabled": true}});
    assert_eq!(live.redact(&text).await.unwrap().count, 1);
}

#[tokio::test]
async fn lists_the_library_rules_as_kinds_without_the_comment_filter_then_its_own() {
    let scan = real_worker();
    let redactor = Redactor::new(|| Value::Null, scan.clone());
    let kinds = redactor.kinds().await.unwrap();
    let library: Vec<String> = kinds
        .iter()
        .filter(|k| k.source == RedactionKindSource::Library)
        .map(|k| k.kind.clone())
        .collect();
    let expected: Vec<String> = scan
        .library_kinds()
        .await
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
    assert_eq!(library, expected);
    for kind in ["aws", "github", "privatekey", "basicauth"] {
        assert!(library.iter().any(|k| k == kind), "{kind}");
    }
    assert!(!library.iter().any(|k| k == "filter-comments"));
    let aws = kinds.iter().find(|k| k.kind == "aws").unwrap();
    assert!(aws.detects.iter().any(|d| d == "AWSSecretAccessKey"));
    let own: Vec<&str> = kinds
        .iter()
        .filter(|k| k.source == RedactionKindSource::Ostia)
        .map(|k| k.kind.as_str())
        .collect();
    assert_eq!(
        own,
        ["jwt", "google-api-key", "authorization", "assignment"]
    );
}

#[tokio::test]
async fn fails_instead_of_passing_text_through_when_the_scan_fails() {
    let broken = Redactor::new(|| Value::Null, Failing);
    let error = broken.redact("anything").await.unwrap_err();
    assert!(error.to_string().contains("scan failed"));
}

#[tokio::test]
async fn fails_closed_on_every_way_in_when_the_scan_fails() {
    let broken = Redactor::new(|| Value::Null, Failing);
    assert!(broken.preview("anything").await.is_err());
    assert!(broken.text("anything").await.is_err());
    let requested = redact_requested_texts(&broken, &json!(["a", "b"])).await;
    assert!(requested.unwrap().is_err());
}

#[tokio::test]
async fn fails_closed_when_the_worker_program_is_missing() {
    let missing = WorkerScan::new(fixture_script("no-such-worker.mjs"), scan_deadline);
    let redactor = Redactor::new(|| Value::Null, missing.clone());
    assert!(redactor.redact("anything").await.is_err());
    missing.close().await;
}

#[tokio::test]
async fn does_not_scan_empty_text() {
    let counting = Counting::default();
    let redactor = Redactor::new(|| Value::Null, counting.clone());
    assert_unchanged(&redactor.redact("").await.unwrap(), "", "redact");
    assert_unchanged(&redactor.preview("").await.unwrap(), "", "preview");
    assert!(counting.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn does_not_scan_while_the_setting_is_off_but_preview_does() {
    let counting = Counting::default();
    let redactor = Redactor::new(
        || json!({"redaction": {"enabled": false}}),
        counting.clone(),
    );
    redactor.redact("one").await.unwrap();
    assert!(counting.seen.lock().unwrap().is_empty());
    redactor.preview("two").await.unwrap();
    assert_eq!(*counting.seen.lock().unwrap(), ["two"]);
}

#[test]
fn keys_its_settings_by_the_parsed_redaction_settings() {
    let privacy = Arc::new(Mutex::new(Value::Null));
    let redactor = Redactor::new(live_privacy(&privacy), Counting::default());
    assert_eq!(redactor.settings_key(), r#"{"enabled":true,"patterns":[]}"#);
    *privacy.lock().unwrap() =
        json!({"redaction": {"enabled": false, "patterns": ["a", "a", "", 1, "b"]}});
    assert_eq!(
        redactor.settings_key(),
        r#"{"enabled":false,"patterns":["a","b"]}"#
    );
}

#[tokio::test]
async fn redacts_each_text_of_a_renderer_request() {
    let redactor = on();
    let results = redact_requested_texts(&redactor, &json!(["plain", format!("k {}", FAKE.npm)]))
        .await
        .unwrap()
        .unwrap();
    let texts: Vec<&str> = results.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, ["plain", "k [redacted:npm]"]);
}

#[tokio::test]
async fn refuses_a_request_that_is_not_a_bounded_list_of_strings() {
    let redactor = Redactor::new(|| Value::Null, Counting::default());
    let too_many = Value::Array(vec![json!("a"); REDACT_TEXTS_MAX + 1]);
    let too_long = json!(["a".repeat(REDACT_TEXT_MAX + 1)]);
    let requests = [
        ("a string", json!("text")),
        ("a number in the list", json!([1])),
        ("too many texts", too_many),
        ("too much text", too_long),
    ];
    for (name, request) in requests {
        assert!(
            redact_requested_texts(&redactor, &request).await.is_none(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn counts_the_size_of_a_request_in_utf16_units_not_bytes() {
    let counting = Counting::default();
    let redactor = Redactor::new(|| Value::Null, counting.clone());
    let accepted = json!(["é".repeat(REDACT_TEXT_MAX / 2 + 1)]);
    assert!(redact_requested_texts(&redactor, &accepted).await.is_some());
    let refused = json!(["😀".repeat(REDACT_TEXT_MAX / 2 + 1)]);
    assert!(redact_requested_texts(&redactor, &refused).await.is_none());
}

#[tokio::test]
async fn redacts_the_serialized_screen_and_keeps_its_colors() {
    let screen = format!(
        "\x1b[32m$\x1b[0m export NPM_TOKEN={}\r\n\x1b[1mdone\x1b[0m\r\n",
        FAKE.npm
    );
    let mut redact = ScrollbackRedactor::new(on());
    let out = redact
        .redact(&panes(&[("p1", &screen), ("p2", "plain\r\n")]))
        .await
        .unwrap();
    assert_eq!(
        out,
        panes(&[
            (
                "p1",
                "\x1b[32m$\x1b[0m export NPM_TOKEN=[redacted:npm]\r\n\x1b[1mdone\x1b[0m\r\n"
            ),
            ("p2", "plain\r\n"),
        ])
    );
}

#[tokio::test]
async fn returns_the_screens_unchanged_while_the_setting_is_off() {
    let screen = format!(
        "\x1b[32m$\x1b[0m export NPM_TOKEN={}\r\n\x1b[1mdone\x1b[0m\r\n",
        FAKE.npm
    );
    let mut redact = ScrollbackRedactor::new(off());
    let by_pane = panes(&[("p1", &screen)]);
    assert_eq!(redact.redact(&by_pane).await.unwrap(), by_pane);
}

#[tokio::test]
async fn scans_a_pane_again_only_when_its_screen_or_the_settings_changed() {
    let privacy = Arc::new(Mutex::new(Value::Null));
    let counting = Counting::default();
    let mut redact =
        ScrollbackRedactor::new(Redactor::new(live_privacy(&privacy), counting.clone()));
    redact
        .redact(&panes(&[("p1", "one"), ("p2", "two")]))
        .await
        .unwrap();
    redact
        .redact(&panes(&[("p1", "one"), ("p2", "two changed")]))
        .await
        .unwrap();
    assert_eq!(
        *counting.seen.lock().unwrap(),
        ["one", "two", "two changed"]
    );
    *privacy.lock().unwrap() = json!({"redaction": {"patterns": ["ACME-[0-9]{4}"]}});
    redact.redact(&panes(&[("p1", "one")])).await.unwrap();
    assert_eq!(counting.seen.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn forgets_a_pane_that_is_gone_and_scans_it_again_when_it_returns() {
    let counting = Counting::default();
    let mut redact = ScrollbackRedactor::new(Redactor::new(|| Value::Null, counting.clone()));
    redact.redact(&panes(&[("p1", "one")])).await.unwrap();
    redact.redact(&panes(&[("p2", "two")])).await.unwrap();
    redact.redact(&panes(&[("p1", "one")])).await.unwrap();
    assert_eq!(*counting.seen.lock().unwrap(), ["one", "two", "one"]);
}

struct FailsOnce {
    calls: Arc<Mutex<u32>>,
}

impl SecretScan for FailsOnce {
    async fn scan(
        &self,
        _text: &str,
    ) -> Result<Vec<ostia_contract::redaction::SecretSpan>, ScanError> {
        let mut calls = self.calls.lock().unwrap();
        *calls += 1;
        if *calls == 1 {
            return Err(ScanError::Failed("scan failed".to_owned()));
        }
        Ok(Vec::new())
    }

    async fn library_kinds(
        &self,
    ) -> Result<Vec<ostia_contract::redaction::RedactionKindInfo>, ScanError> {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn returns_the_error_of_a_failed_scan_and_stores_nothing_for_the_pane() {
    let calls = Arc::new(Mutex::new(0));
    let mut redact = ScrollbackRedactor::new(Redactor::new(
        || Value::Null,
        FailsOnce {
            calls: Arc::clone(&calls),
        },
    ));
    let by_pane = panes(&[("p1", "one")]);
    assert!(redact.redact(&by_pane).await.is_err());
    assert_eq!(redact.redact(&by_pane).await.unwrap(), by_pane);
    assert_eq!(*calls.lock().unwrap(), 2);
}

#[tokio::test]
async fn fails_closed_within_its_deadline_when_a_pattern_of_the_human_never_finishes() {
    let worker = WorkerScan::new(fixture_script("scan-hang.mjs"), |_| {
        Duration::from_millis(400)
    });
    let redactor = Redactor::new(
        || json!({"redaction": {"patterns": ["[a-z]+Z"]}}),
        worker.clone(),
    );
    let started = std::time::Instant::now();
    let error = redactor.redact(&"a".repeat(8 * MIB)).await.unwrap_err();
    assert_eq!(error.to_string(), "scan timed out");
    assert!(started.elapsed() < Duration::from_secs(3));
    worker.close().await;
}

#[tokio::test]
async fn reads_a_text_longer_than_one_chunk_through_the_redactor() {
    let filler = "filler line\n".repeat(SCAN_CHUNK_MAX.div_ceil(12));
    let text = format!("{filler}{}\n{filler}{}\n", FAKE.gitlab, FAKE.gitlab);
    let result = on().redact(&text).await.unwrap();
    assert_eq!(result.count, 2);
    assert!(!result.text.contains(&FAKE.gitlab));
}
