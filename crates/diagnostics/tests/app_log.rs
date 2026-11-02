#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use ostia_diagnostics::app_log::{
    AppLog, AppLogOptions, FileAppLog, LOG_FIELD_MAX_CHARS, LogFields, format_entry,
    redact_secrets, rotate_log_files, rotated_name,
};
use regex::Regex;
use serde_json::{Value, json};
use tempfile::TempDir;

fn fields(value: Value) -> LogFields {
    LogFields::try_from(value).unwrap()
}

fn names_in(dir: &TempDir) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn hides_key_value_secrets_bearer_tokens_and_long_opaque_strings() {
    let blob = "a1B2".repeat(12);
    let text = [
        "OSTIA_TOKEN=abc123def456".to_owned(),
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig".to_owned(),
        "url https://x.test/cb?access_token=s3cr3t&page=2".to_owned(),
        "key sk-proj-ABCDEFGHIJKLMNOP".to_owned(),
        "gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345".to_owned(),
        format!("blob {blob}"),
        "\"password\": \"hunter2\"".to_owned(),
    ]
    .join("\n");
    let out = redact_secrets(&text);
    for secret in [
        "abc123def456",
        "eyJhbGciOiJIUzI1NiJ9",
        "s3cr3t",
        "sk-proj-ABCDEFGHIJKLMNOP",
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        "a1B2a1B2a1B2a1B2a1B2",
        "hunter2",
    ] {
        assert!(!out.contains(secret), "{secret} is still in {out}");
    }
    assert!(out.contains("page=2"));
}

#[test]
fn keeps_ordinary_error_text_and_stack_frames() {
    let text = "TypeError: x is undefined\n    at DiffView (index-BCk7BOBV.js:12:3)";
    assert_eq!(redact_secrets(text), text);
}

#[test]
fn writes_the_event_and_quotes_values_with_spaces_or_newlines_on_one_line() {
    let line = format_entry(
        "renderer-error",
        &fields(json!({
            "window": 3,
            "message": "boom here",
            "stack": "a\nb",
            "skipped": null,
        })),
    );
    assert_eq!(
        line,
        "renderer-error window=3 message=\"boom here\" stack=\"a\\nb\""
    );
    assert!(!line.contains('\n'));
}

#[test]
fn clips_long_values_and_redacts_them() {
    let message = format!("token=zzz {}", "y ".repeat(LOG_FIELD_MAX_CHARS));
    let line = format_entry("x", &fields(json!({ "message": message })));
    assert!(!line.contains("zzz"));
    assert!(line.chars().count() < LOG_FIELD_MAX_CHARS + 100);
    assert!(line.contains("more)"));
}

#[test]
fn shifts_archives_and_keeps_only_the_configured_number_of_files() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("main.log");
    for generation in 1..=4 {
        fs::write(&file, format!("gen{generation}")).unwrap();
        rotate_log_files(&file, 3).unwrap();
    }
    assert_eq!(names_in(&dir), ["main.1.log", "main.2.log"]);
    assert_eq!(fs::read_to_string(rotated_name(&file, 1)).unwrap(), "gen4");
    assert_eq!(fs::read_to_string(rotated_name(&file, 2)).unwrap(), "gen3");
}

#[test]
fn appends_redacted_entries_to_the_file() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("logs").join("main.log");
    let log = FileAppLog::create(file.clone(), AppLogOptions::default());
    log.info("app-start", &fields(json!({ "version": "0.0.9" })));
    log.error(
        "renderer-error",
        &fields(json!({ "message": "failed with OSTIA_TOKEN=abcdef123456" })),
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        Regex::new(r"\[info\]\s+app-start version=0\.0\.9")
            .unwrap()
            .is_match(&text),
        "{text}"
    );
    assert!(
        Regex::new(r#"\[error\]\s+renderer-error message="failed with OSTIA_TOKEN=\[redacted\]""#)
            .unwrap()
            .is_match(&text),
        "{text}"
    );
    assert_eq!(mode_of(&file) & 0o077, 0);
}

#[test]
fn rotates_at_the_size_cap_and_keeps_three_files_at_most() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("main.log");
    let log = FileAppLog::create(
        file.clone(),
        AppLogOptions {
            max_bytes: Some(2048),
            keep: Some(3),
        },
    );
    for i in 0..200 {
        log.info(
            "pty-reap",
            &fields(json!({ "pane": format!("p-{i}"), "reason": "grace-expired" })),
        );
    }
    assert_eq!(names_in(&dir), ["main.1.log", "main.2.log", "main.log"]);
    assert!(fs::metadata(&file).unwrap().len() < 2048 + 200);
    assert!(fs::read_to_string(&file).unwrap().contains("pane=p-199"));
    assert!(!rotated_name(&file, 3).exists());
}

#[test]
fn accepts_only_scalar_field_values() {
    assert!(LogFields::try_from(json!({"a": "x", "b": 1, "c": true, "d": null})).is_ok());
    assert!(LogFields::try_from(json!({"a": ["token=abcdef123456"]})).is_err());
    assert!(LogFields::try_from(json!({"a": {"b": 1}})).is_err());
    assert!(LogFields::try_from(json!(["a"])).is_err());
}
