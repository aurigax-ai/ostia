#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Harness, batch_events, facts, has_prefix, only, properties, settle};
use ostia_diagnostics::privacy_telemetry::{
    TELEMETRY_COUNTS_MAX, TELEMETRY_LIST_MAX, TelemetryCategory,
};
use ostia_diagnostics::telemetry_usage::SessionFacts;
use serde_json::json;

fn first_event(h: &Harness) -> serde_json::Value {
    batch_events(&h.sent.lock()[0].body).remove(0)
}

#[tokio::test]
async fn drops_a_session_value_that_is_not_a_safe_word() {
    let h = Harness::new(only(&[TelemetryCategory::Usage]));
    let t = h.create_with(|deps| {
        deps.session = Arc::new(|| SessionFacts {
            windows: "bad value!".to_owned(),
            restore: "r".repeat(41),
            ..facts()
        });
    });
    t.shutdown().await;
    let event = first_event(&h);
    let props = properties(&event);
    assert!(props.get("usage.windows").is_none());
    assert!(props.get("usage.restore").is_none());
    assert_eq!(props["usage.workspaces"], json!("2-3"));
    assert_eq!(props["usage.app_starts"], json!(1));
}

#[tokio::test]
async fn ignores_an_in_effect_key_the_category_does_not_know_and_a_key_that_is_not_a_value() {
    let h = Harness::new(only(&[
        TelemetryCategory::Features,
        TelemetryCategory::Terminal,
    ]));
    let t = h.create_with(|deps| {
        deps.session = Arc::new(|| SessionFacts {
            in_effect: vec![
                (
                    "features".to_owned(),
                    vec![
                        ("input_mode".to_owned(), "editor".to_owned()),
                        ("nope".to_owned(), "x".to_owned()),
                        ("command".to_owned(), "x".to_owned()),
                    ],
                ),
                ("nope".to_owned(), vec![("gpu".to_owned(), "on".to_owned())]),
            ],
            ..facts()
        });
    });
    t.shutdown().await;
    let event = first_event(&h);
    let props = properties(&event);
    assert_eq!(props["features.input_mode"], json!("editor"));
    assert!(props.get("features.nope").is_none());
    assert!(props.get("features.command").is_none());
    assert!(!props.keys().any(|key| key.starts_with("nope.")));
    assert!(props.get("terminal.gpu").is_none());
}

#[tokio::test]
async fn leaves_in_effect_values_out_of_a_category_that_is_off() {
    let h = Harness::new(only(&[TelemetryCategory::Terminal]));
    let t = h.create();
    t.shutdown().await;
    let event = first_event(&h);
    assert_eq!(properties(&event)["terminal.gpu"], json!("on"));
    assert!(!has_prefix(&event, "features."));
}

#[tokio::test]
async fn lists_only_safe_ids_and_at_most_a_hundred() {
    let h = Harness::new(only(&[TelemetryCategory::Extensions]));
    let mut installed: Vec<String> = (0..TELEMETRY_LIST_MAX + 50)
        .map(|i| format!("ext-{i}"))
        .collect();
    installed.insert(0, "bad id!".to_owned());
    let t = h.create_with(|deps| {
        let installed = installed.clone();
        deps.session = Arc::new(move || SessionFacts {
            installed_extensions: installed.clone(),
            enabled_extensions: vec!["ext-1".to_owned()],
            ..facts()
        });
    });
    t.shutdown().await;
    let event = first_event(&h);
    let listed = properties(&event)["extensions.installed"]
        .as_array()
        .unwrap();
    assert_eq!(listed.len(), TELEMETRY_LIST_MAX);
    assert!(!listed.contains(&json!("bad id!")));
    assert_eq!(listed[0], json!("ext-0"));
    assert_eq!(properties(&event)["extensions.enabled"], json!(["ext-1"]));
}

#[tokio::test]
async fn counts_at_most_two_hundred_distinct_ids_for_a_key_but_keeps_counting_known_ones() {
    let h = Harness::new(only(&[TelemetryCategory::Features]));
    let t = h.create();
    for i in 0..TELEMETRY_COUNTS_MAX + 5 {
        t.count("features", "command", Some(&format!("c{i}")));
    }
    t.count("features", "command", Some("c0"));
    t.count("features", "command", Some("c-late"));
    t.shutdown().await;
    let event = first_event(&h);
    let props = properties(&event);
    let counted = props
        .keys()
        .filter(|key| key.starts_with("features.command."))
        .count();
    assert_eq!(counted, TELEMETRY_COUNTS_MAX);
    assert_eq!(props["features.command.c0"], json!(2));
    assert!(props.get("features.command.c-late").is_none());
}

#[tokio::test]
async fn sends_no_usage_event_when_only_errors_are_on() {
    let h = Harness::new(only(&[TelemetryCategory::Errors]));
    let t = h.create();
    t.count("features", "command", Some("pane.split"));
    t.shutdown().await;
    assert_eq!(h.sent_count(), 0);
    assert!(t.reports().queued.is_empty());
}

#[tokio::test(start_paused = true)]
async fn starts_the_next_usage_event_from_zero_counts() {
    let h = Harness::new(only(&[
        TelemetryCategory::Usage,
        TelemetryCategory::Terminal,
    ]));
    let t = h.create_with(|deps| {
        deps.endpoint = None;
        deps.usage_interval = Duration::from_secs(60);
    });
    t.count("terminal", "wake", None);
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    let queued = t.reports().queued;
    assert_eq!(queued.len(), 2);
    assert_eq!(properties(&queued[0])["terminal.wake"], json!(1));
    assert!(properties(&queued[1]).get("terminal.wake").is_none());
}

#[tokio::test]
async fn forgets_the_counts_when_the_install_id_is_reset() {
    let h = Harness::new(only(&[TelemetryCategory::Terminal]));
    let t = h.create();
    t.count("terminal", "wake", None);
    t.reset_install_id();
    t.shutdown().await;
    let event = first_event(&h);
    assert!(properties(&event).get("terminal.wake").is_none());
    assert_eq!(properties(&event)["terminal.gpu"], json!("on"));
}
