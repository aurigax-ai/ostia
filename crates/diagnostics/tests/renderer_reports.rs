#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::PaneId;
use ostia_diagnostics::renderer_reports::{
    REPORT_MESSAGE_MAX, REPORT_PANE_IDS_MAX, REPORT_STACK_MAX, RendererErrorKind,
    RendererErrorReport, ReportLimiter, Take, normalize_pane_ids, normalize_renderer_report,
};
use serde_json::json;

#[test]
fn accepts_a_known_kind_with_a_message_a_stack_and_a_source() {
    assert_eq!(
        normalize_renderer_report(
            &json!({"kind": "render", "message": "boom", "stack": "at x", "source": "a.js:1"})
        ),
        Some(RendererErrorReport {
            kind: RendererErrorKind::Render,
            message: "boom".to_owned(),
            stack: Some("at x".to_owned()),
            source: Some("a.js:1".to_owned()),
        })
    );
}

#[test]
fn refuses_unknown_kinds_missing_messages_and_non_objects() {
    let refused = [
        json!({"kind": "shell", "message": "x"}),
        json!({"kind": "error"}),
        json!({"kind": "error", "message": 42}),
        json!("error"),
        json!(null),
        json!([{"kind": "error", "message": "x"}]),
    ];
    for raw in refused {
        assert_eq!(normalize_renderer_report(&raw), None, "{raw}");
    }
}

#[test]
fn clips_long_text_strips_control_characters_and_drops_non_string_extras() {
    let report = normalize_renderer_report(&json!({
        "kind": "error",
        "message": format!("a\u{7}b{}", "m".repeat(REPORT_MESSAGE_MAX * 2)),
        "stack": "s".repeat(REPORT_STACK_MAX * 2),
        "source": {"file": "x"},
        "extra": "ignored",
    }))
    .unwrap();
    assert!(report.message.starts_with("ab"));
    assert_eq!(report.message.chars().count(), REPORT_MESSAGE_MAX);
    assert_eq!(report.stack.unwrap().chars().count(), REPORT_STACK_MAX);
    assert_eq!(report.source, None);
}

#[test]
fn keeps_line_breaks_in_a_stack() {
    let report =
        normalize_renderer_report(&json!({"kind": "error", "message": "m", "stack": "a\nb"}))
            .unwrap();
    assert_eq!(report.stack.as_deref(), Some("a\nb"));
}

#[test]
fn writes_no_message_when_the_message_is_empty_after_cleaning() {
    let report =
        normalize_renderer_report(&json!({"kind": "surface", "message": "\u{7}\u{1b}"})).unwrap();
    assert_eq!(report.message, "(no message)");
    assert_eq!(report.stack, None);
}

#[test]
fn accepts_a_list_of_pane_id_strings() {
    assert_eq!(
        normalize_pane_ids(&json!(["p1", "p2", "p1"])),
        Some(HashSet::from([PaneId::new("p1"), PaneId::new("p2")]))
    );
}

#[test]
fn refuses_anything_else_or_an_oversized_list() {
    assert_eq!(normalize_pane_ids(&json!("p1")), None);
    assert_eq!(normalize_pane_ids(&json!(["p1", 3])), None);
    assert_eq!(normalize_pane_ids(&json!([""])), None);
    let oversized: Vec<String> = (0..=REPORT_PANE_IDS_MAX).map(|i| format!("p{i}")).collect();
    assert_eq!(normalize_pane_ids(&json!(oversized)), None);
}

#[test]
fn refuses_a_pane_id_longer_than_two_hundred_characters() {
    assert_eq!(normalize_pane_ids(&json!(["x".repeat(201)])), None);
    assert!(normalize_pane_ids(&json!(["x".repeat(200)])).is_some());
}

#[test]
fn allows_a_burst_per_key_then_drops_and_reports_how_many_were_dropped() {
    let now = Arc::new(AtomicI64::new(0));
    let clock_now = now.clone();
    let limiter = ReportLimiter::new(2, 1000, Arc::new(move || clock_now.load(Ordering::SeqCst)));
    assert_eq!(
        limiter.take("w1"),
        Take {
            allowed: true,
            suppressed: 0
        }
    );
    assert_eq!(
        limiter.take("w1"),
        Take {
            allowed: true,
            suppressed: 0
        }
    );
    assert!(!limiter.take("w1").allowed);
    assert!(!limiter.take("w1").allowed);
    assert!(limiter.take("w2").allowed);
    now.store(1000, Ordering::SeqCst);
    assert_eq!(
        limiter.take("w1"),
        Take {
            allowed: true,
            suppressed: 2
        }
    );
}

#[test]
fn starts_a_key_again_after_it_is_forgotten() {
    let limiter = ReportLimiter::new(1, 60_000, Arc::new(|| 0));
    assert!(limiter.take("w1").allowed);
    assert!(!limiter.take("w1").allowed);
    limiter.forget("w1");
    assert_eq!(
        limiter.take("w1"),
        Take {
            allowed: true,
            suppressed: 0
        }
    );
}
