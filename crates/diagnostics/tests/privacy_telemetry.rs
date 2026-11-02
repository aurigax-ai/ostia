#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use ostia_diagnostics::privacy_telemetry::{
    ErrorInput, ErrorSource, InstallContext, ReportContext, TELEMETRY_MESSAGE_MAX,
    TelemetryCategory, TelemetryEndpoint, TelemetrySettings, UsageCounts, any_telemetry_on,
    bucket_count, build_batch, build_error_report, build_usage_report, empty_usage_counts,
    parse_ingest, parse_telemetry_settings, reduce_stack, report_categories, strip_paths,
    without_categories,
};
use regex::Regex;
use serde_json::{Map, Value, json};

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected an object, got {other}"),
    }
}

fn github_token() -> String {
    common::fake("githubClassic")
}

fn context() -> ReportContext {
    let ghp = Regex::new("ghp_[A-Za-z0-9]+").unwrap();
    ReportContext {
        install_id: "install-1".to_owned(),
        context: InstallContext {
            app_version: "1.2.3".to_owned(),
            electron_version: "33.0.0".to_owned(),
            os_name: "linux".to_owned(),
            os_version: "6.1".to_owned(),
            arch: "x64".to_owned(),
            locale: "en".to_owned(),
            channel: "packaged".to_owned(),
        },
        now: Arc::new(|| 1_700_000_000_000),
        new_id: Arc::new(|| "event-1".to_owned()),
        redact: Arc::new(move |text| ghp.replace_all(text, "[redacted]").into_owned()),
    }
}

fn only(on: &[TelemetryCategory]) -> TelemetrySettings {
    let mut settings = TelemetrySettings::default();
    for category in on {
        settings.set(*category, true);
    }
    settings
}

fn frame(rest: Value) -> Value {
    let mut out = json!({"platform": "node", "in_app": true});
    out.as_object_mut().unwrap().extend(object(rest));
    out
}

#[test]
fn has_every_category_off_unless_it_is_exactly_true() {
    assert_eq!(
        parse_telemetry_settings(&Value::Null),
        TelemetrySettings::default()
    );
    assert!(!any_telemetry_on(&parse_telemetry_settings(
        &json!({"errors": "yes", "usage": 1})
    )));
    assert_eq!(
        parse_telemetry_settings(&json!({"errors": true, "agents": true})),
        only(&[TelemetryCategory::Errors, TelemetryCategory::Agents])
    );
}

#[test]
fn leaves_a_category_added_later_off_without_any_stored_value() {
    assert!(
        !parse_telemetry_settings(&json!({"errors": true, "usage": true}))
            .get(TelemetryCategory::Terminal)
    );
}

#[test]
fn turns_the_ingest_host_and_project_key_into_the_batch_url() {
    assert_eq!(
        parse_ingest("https://us.i.posthog.com", "phc_abc"),
        Some(TelemetryEndpoint {
            url: "https://us.i.posthog.com/batch/".to_owned(),
            api_key: "phc_abc".to_owned(),
        })
    );
}

#[test]
fn reads_the_key_from_the_url_for_a_test_override_and_refuses_the_rest() {
    assert_eq!(
        parse_ingest("http://phc_e2e@127.0.0.1:8000", ""),
        Some(TelemetryEndpoint {
            url: "http://127.0.0.1:8000/batch/".to_owned(),
            api_key: "phc_e2e".to_owned(),
        })
    );
    assert_eq!(parse_ingest("", ""), None);
    assert_eq!(parse_ingest("https://us.i.posthog.com", ""), None);
    assert_eq!(parse_ingest("ftp://k@host", ""), None);
    assert_eq!(parse_ingest("https://host/?x=1", "phc_abc"), None);
}

#[test]
fn replaces_absolute_home_and_windows_paths_and_file_urls_keeping_other_text() {
    assert_eq!(
        strip_paths("ENOENT: open '/home/ann/secret notes/x.txt'"),
        "ENOENT: open '<path>'"
    );
    assert_eq!(
        strip_paths("read ~/.ssh/id_rsa failed"),
        "read <path> failed"
    );
    assert_eq!(strip_paths("at C:\\Users\\ann\\app.js"), "at <path>");
    assert_eq!(
        strip_paths("file:///home/ann/app/out/main.js failed"),
        "<path> failed"
    );
    assert_eq!(
        strip_paths("ratio 1/2 and a/b stay"),
        "ratio 1/2 and a/b stay"
    );
}

#[test]
fn keeps_function_names_file_names_and_positions_never_directories() {
    let stack = [
        "TypeError: x is not a function",
        "    at runIt (/home/ann/.local/share/ostia/app/out/main/chunks/app.js:12:5)",
        "    at async Object.<anonymous> (file:///home/ann/proj/out/main/index.js:3:1)",
        "    at node:internal/process/task_queues:95:5",
    ]
    .join("\n");
    let frames = serde_json::to_value(reduce_stack(Some(&stack))).unwrap();
    assert_eq!(
        frames,
        json!([
            frame(json!({"filename": "task_queues", "lineno": 95, "colno": 5})),
            frame(
                json!({"function": "async Object.<anonymous>", "filename": "index.js", "lineno": 3, "colno": 1})
            ),
            frame(json!({"function": "runIt", "filename": "app.js", "lineno": 12, "colno": 5})),
        ])
    );
    assert!(!frames.to_string().contains("ann"));
}

#[test]
fn answers_no_frames_for_a_missing_stack() {
    assert!(reduce_stack(None).is_empty());
}

#[test]
fn is_a_exception_event_with_the_install_context_paths_stripped_and_secrets_redacted() {
    let token = github_token();
    let report = build_error_report(
        &ErrorInput {
            source: ErrorSource::MainException,
            name: "TypeError".to_owned(),
            message: format!("token {token} at /home/ann/x.js"),
            stack: Some("TypeError: boom\n    at f (/home/ann/x.js:1:2)".to_owned()),
            extension: None,
        },
        &context(),
    );
    let mut keys: Vec<&String> = report.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        ["distinct_id", "event", "properties", "timestamp", "uuid"]
    );
    assert_eq!(report["event"], json!("$exception"));
    assert_eq!(report["distinct_id"], json!("install-1"));
    let mut property_keys: Vec<&String> =
        report["properties"].as_object().unwrap().keys().collect();
    property_keys.sort();
    assert_eq!(
        property_keys,
        [
            "$exception_list",
            "$process_person_profile",
            "app_version",
            "arch",
            "channel",
            "electron_version",
            "locale",
            "os_name",
            "os_version",
            "source",
        ]
    );
    let entry = &report["properties"]["$exception_list"][0];
    assert_eq!(entry["type"], json!("TypeError"));
    assert_eq!(entry["value"], json!("token [redacted] at <path>"));
    assert_eq!(
        entry["stacktrace"],
        json!({
            "type": "raw",
            "frames": [frame(json!({"function": "f", "filename": "x.js", "lineno": 1, "colno": 2}))],
        })
    );
    assert!(!report.to_string().contains("ghp_"));
    assert!(!report.to_string().contains("/home"));
    assert_eq!(report_categories(&report), [TelemetryCategory::Errors]);
}

#[test]
fn clips_the_message_and_falls_back_to_error_for_an_odd_name() {
    let report = build_error_report(
        &ErrorInput {
            source: ErrorSource::RendererError,
            name: "not a name".to_owned(),
            message: "x".repeat(5000),
            stack: None,
            extension: None,
        },
        &context(),
    );
    let entry = &report["properties"]["$exception_list"][0];
    assert_eq!(entry["type"], json!("Error"));
    assert_eq!(
        entry["value"].as_str().unwrap().chars().count(),
        TELEMETRY_MESSAGE_MAX
    );
    assert!(entry.get("stacktrace").is_none());
}

#[test]
fn names_the_extension_only_when_given() {
    let report = build_error_report(
        &ErrorInput {
            source: ErrorSource::ExtensionCrashed,
            name: "ExtensionCrashed".to_owned(),
            message: "x".to_owned(),
            stack: None,
            extension: Some("git".to_owned()),
        },
        &context(),
    );
    assert_eq!(report["properties"]["extension"], json!("git"));
}

fn counts() -> UsageCounts {
    let mut counts = empty_usage_counts();
    counts.usage =
        object(json!({"app_starts": 1, "session_minutes": 42, "windows": "1", "restore": "ok"}));
    counts.features = object(json!({"command": {"pane.split": 2}, "input_mode": "editor"}));
    counts.terminal = object(json!({"engine": "ghostty", "shell": {"zsh": 3}}));
    counts.extensions = object(json!({"installed": ["trellis"], "enabled": ["trellis"]}));
    counts.agents = object(json!({"session": {"claude": 1}, "bus_message": 4}));
    counts
}

#[test]
fn namespaces_every_property_by_category_and_carries_only_enabled_categories() {
    let report = build_usage_report(
        &counts(),
        &only(&[
            TelemetryCategory::Usage,
            TelemetryCategory::Features,
            TelemetryCategory::Extensions,
        ]),
        &context(),
    );
    assert_eq!(report["event"], json!("usage"));
    assert_eq!(
        report["properties"],
        json!({
            "app_version": "1.2.3",
            "electron_version": "33.0.0",
            "os_name": "linux",
            "os_version": "6.1",
            "arch": "x64",
            "locale": "en",
            "channel": "packaged",
            "$process_person_profile": false,
            "usage.app_starts": 1,
            "usage.session_minutes": 42,
            "usage.windows": "1",
            "usage.restore": "ok",
            "features.command.pane.split": 2,
            "features.input_mode": "editor",
            "extensions.installed": ["trellis"],
            "extensions.enabled": ["trellis"],
        })
    );
    assert!(!report["properties"].to_string().contains("terminal."));
    assert!(!report["properties"].to_string().contains("agents."));
    assert_eq!(
        report_categories(&report),
        [
            TelemetryCategory::Usage,
            TelemetryCategory::Features,
            TelemetryCategory::Extensions
        ]
    );
}

#[test]
fn drops_a_category_that_was_turned_off_after_the_report_was_queued() {
    let report = build_usage_report(
        &counts(),
        &only(&[TelemetryCategory::Usage, TelemetryCategory::Agents]),
        &context(),
    );
    let trimmed = without_categories(&report, &only(&[TelemetryCategory::Agents])).unwrap();
    assert_eq!(trimmed["properties"]["agents.bus_message"], json!(4));
    assert!(trimmed["properties"].get("usage.app_starts").is_none());
    assert_eq!(
        without_categories(&report, &only(&[TelemetryCategory::Errors])),
        None
    );
}

#[test]
fn buckets_window_and_workspace_counts() {
    let buckets: Vec<&str> = [0, 1, 2, 3, 4, 7, 8, 40].map(bucket_count).to_vec();
    assert_eq!(buckets, ["0", "1", "2-3", "2-3", "4-7", "4-7", "8+", "8+"]);
}

#[test]
fn is_the_capture_batch_body_with_the_project_key_and_the_reports_as_given() {
    let report = build_error_report(
        &ErrorInput {
            source: ErrorSource::MainException,
            name: "E".to_owned(),
            message: "m".to_owned(),
            stack: None,
            extension: None,
        },
        &context(),
    );
    let body: Value =
        serde_json::from_str(&build_batch(&[report.clone(), report.clone()], "phc_abc")).unwrap();
    assert_eq!(
        body,
        json!({"api_key": "phc_abc", "batch": [report.clone(), report]})
    );
}
