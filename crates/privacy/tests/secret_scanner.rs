#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::HashSet;
use std::process::Command;

use common::{FAKE, MIB, fill, real_worker, repo_root, span};
use ostia_privacy::redaction_scan::SecretScan;
use ostia_privacy::secret_scanner::{LintMessage, SCAN_CHUNK_MAX, kind_of_rule, spans_of};
use serde_json::{Value, json};

const RULE_ID: &str = "@secretlint/secretlint-rule-demo";
const TEXT: &str = "name = ABCDEFGHIJKLMNOP tail";

fn message(range: (usize, usize), data: Value) -> LintMessage {
    LintMessage {
        rule_id: RULE_ID.to_owned(),
        range,
        data,
    }
}

#[test]
fn names_a_kind_after_its_rule_package() {
    assert_eq!(kind_of_rule("@secretlint/secretlint-rule-github"), "github");
    assert_eq!(
        kind_of_rule("@secretlint/secretlint-rule-database-connection-string"),
        "database-connection-string"
    );
    assert_eq!(kind_of_rule("Some Other_Rule!"), "some-other-rule");
}

#[test]
fn falls_back_to_secret_when_no_name_is_left() {
    assert_eq!(kind_of_rule("@secretlint/secretlint-rule-"), "secret");
    assert_eq!(kind_of_rule("!!!"), "secret");
    assert_eq!(kind_of_rule(""), "secret");
}

#[test]
fn cuts_a_kind_at_48_characters_after_trimming_hyphens() {
    let long = format!("{}-bcd", "a".repeat(47));
    assert_eq!(kind_of_rule(&long), format!("{}-", "a".repeat(47)));
    assert_eq!(kind_of_rule("--Mixed__Case--"), "mixed-case");
}

#[tokio::test]
async fn has_a_unique_placeholder_safe_kind_for_every_rule() {
    let kinds: Vec<String> = real_worker()
        .library_kinds()
        .await
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
    assert!(kinds.len() > 20);
    assert_eq!(kinds.iter().collect::<HashSet<_>>().len(), kinds.len());
    for kind in &kinds {
        let mut chars = kind.chars();
        let first = chars.next().unwrap();
        assert!(
            first.is_ascii_lowercase() || first.is_ascii_digit(),
            "{kind}"
        );
        assert!(kind.len() <= 48, "{kind}");
        assert!(
            chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "{kind}"
        );
    }
}

#[tokio::test]
async fn lists_the_messages_each_rule_can_report() {
    let kinds = real_worker().library_kinds().await.unwrap();
    let aws = kinds.iter().find(|k| k.kind == "aws").unwrap();
    assert!(aws.detects.iter().any(|d| d == "AWSSecretAccessKey"));
    assert!(!kinds.iter().any(|k| k.kind == "filter-comments"));
}

#[test]
fn uses_the_reported_range_when_the_reported_value_lies_inside_it() {
    assert_eq!(
        spans_of(TEXT, &message((7, 23), json!({"PREFIX": "ABCDEFGH"})), 0),
        [span(7, 23, "demo")]
    );
}

#[test]
fn moves_a_range_that_has_the_length_of_the_value_but_starts_at_the_name() {
    assert_eq!(
        spans_of(
            TEXT,
            &message((0, 16), json!({"KEY": "ABCDEFGHIJKLMNOP"})),
            100
        ),
        [span(107, 123, "demo")]
    );
}

#[test]
fn adds_a_reported_value_that_runs_past_the_range_and_never_drops_the_range() {
    assert_eq!(
        spans_of(
            TEXT,
            &message((7, 12), json!({"KEY": "CDEFGHIJKLMNOP tail"})),
            0
        ),
        [span(7, 12, "demo"), span(9, 28, "demo")]
    );
}

#[test]
fn ignores_reported_data_that_is_not_in_the_text() {
    assert_eq!(
        spans_of(
            TEXT,
            &message((7, 23), json!({"FILE_NAME": "secrets.json"})),
            0
        ),
        [span(7, 23, "demo")]
    );
}

#[test]
fn keeps_the_range_the_moved_span_and_the_longer_value_when_all_three_exist() {
    let data = json!({"KEY": "ABCDEFGHIJKLMNOP", "MORE": "CDEFGHIJKLMNOP tail"});
    assert_eq!(
        spans_of(TEXT, &message((0, 16), data), 0),
        [
            span(0, 16, "demo"),
            span(7, 23, "demo"),
            span(9, 28, "demo")
        ]
    );
}

#[test]
fn ignores_reported_values_shorter_than_eight_characters_and_data_that_is_not_an_object() {
    assert_eq!(
        spans_of(TEXT, &message((0, 7), json!({"KEY": "ABCDEFG"})), 0),
        [span(0, 7, "demo")]
    );
    for data in [
        Value::Null,
        json!("ABCDEFGHIJKLMNOP"),
        json!(["ABCDEFGHIJKLMNOP"]),
    ] {
        assert_eq!(
            spans_of(TEXT, &message((7, 23), data.clone()), 0),
            [span(7, 23, "demo")],
            "{data}"
        );
    }
}

#[test]
fn ignores_a_reported_value_of_another_type() {
    assert_eq!(
        spans_of(
            TEXT,
            &message((7, 23), json!({"KEY": 12_345_678_901_u64})),
            0
        ),
        [span(7, 23, "demo")]
    );
}

#[tokio::test]
async fn reports_the_exact_place_of_each_secret() {
    let text = format!("a {} b {}", FAKE.github_classic, FAKE.npm);
    let spans = real_worker().scan(&text).await.unwrap();
    let found: Vec<(&str, &str)> = spans
        .iter()
        .map(|s| (s.kind.as_str(), &text[s.start..s.end]))
        .collect();
    assert_eq!(
        found,
        [
            ("github", FAKE.github_classic.as_str()),
            ("npm", FAKE.npm.as_str())
        ]
    );
}

#[tokio::test]
async fn covers_the_whole_aws_secret_key_not_the_range_the_rule_reports() {
    let text = format!("AWS_SECRET_ACCESS_KEY=\"{}\"", FAKE.aws_secret_key);
    let spans = real_worker().scan(&text).await.unwrap();
    let found: Vec<&str> = spans.iter().map(|s| &text[s.start..s.end]).collect();
    assert_eq!(found, [FAKE.aws_secret_key.as_str()]);
}

#[tokio::test]
async fn reads_text_longer_than_one_chunk_with_the_right_offsets() {
    let filler = "filler line\n".repeat(SCAN_CHUNK_MAX.div_ceil(12));
    let text = format!("{filler}{}\n{filler}{}\n", FAKE.gitlab, FAKE.gitlab);
    let spans = real_worker().scan(&text).await.unwrap();
    assert_eq!(spans.len(), 2);
    for found in &spans {
        assert_eq!(&text[found.start..found.end], FAKE.gitlab);
    }
}

#[tokio::test]
async fn finds_nothing_in_empty_text() {
    assert!(real_worker().scan("").await.unwrap().is_empty());
}

#[tokio::test]
async fn reports_byte_offsets_for_text_with_characters_beyond_one_byte() {
    let text = format!("é😀 日本語 {} fin", FAKE.github_classic);
    let spans = real_worker().scan(&text).await.unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(&text[spans[0].start..spans[0].end], FAKE.github_classic);
}

#[tokio::test]
async fn reports_byte_offsets_in_a_second_chunk_after_multibyte_text() {
    let filler = "é line\n".repeat(SCAN_CHUNK_MAX.div_ceil(7));
    let text = format!("{filler}{}\n", FAKE.gitlab);
    let spans = real_worker().scan(&text).await.unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(&text[spans[0].start..spans[0].end], FAKE.gitlab);
}

#[tokio::test]
async fn reads_1_mib_of_one_letter_without_a_span() {
    let spans = real_worker().scan(&fill("a", MIB)).await.unwrap();
    assert!(spans.is_empty());
}

#[test]
fn detects_a_secret_with_the_node_the_scan_runs_on() {
    let probe = repo_root().join("test/fixtures/secrets/electronProbe.mjs");
    let output = Command::new("node")
        .arg(probe)
        .arg(&FAKE.github_classic)
        .output()
        .unwrap();
    assert!(output.status.success());
    let reported: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reported, json!(["@secretlint/secretlint-rule-github"]));
}

#[test]
fn prints_no_matched_text_in_the_debug_output_of_a_message() {
    let message = ostia_privacy::secret_scanner::LintMessage {
        rule_id: "rule".to_owned(),
        range: (0, 7),
        data: serde_json::json!({"found": "hunter2"}),
    };
    assert!(!format!("{message:?}").contains("hunter2"));
}
