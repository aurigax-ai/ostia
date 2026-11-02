#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_contract::incident::{CallPhase, INCIDENT_EVENTS_MAX, INCIDENT_WINDOW_MS};
use ostia_diagnostics::incident_timeline::{
    IncidentTimeline, IncidentTimelineDeps, PaneSnapshot, RawEvent, SnapshotFn, bind_incident,
    run_in_incident,
};
use serde_json::{Value, json};

const PERIOD: u64 = 24 * 3_600_000;

fn snapshot() -> PaneSnapshot {
    PaneSnapshot {
        agent: "claude".to_owned(),
        state: "waiting".to_owned(),
        drafting: true,
        mail: 2,
        alive: true,
    }
}

struct Rig {
    timeline: IncidentTimeline,
    now: Arc<AtomicI64>,
}

impl Rig {
    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

fn make() -> Rig {
    let now = Arc::new(AtomicI64::new(1000));
    let clock_now = now.clone();
    let snapshot_of: SnapshotFn = Arc::new(|_pane_id| Box::pin(async { Some(snapshot()) }));
    let timeline = IncidentTimeline::new(IncidentTimelineDeps {
        now: Arc::new(move || clock_now.load(Ordering::SeqCst)),
        snapshot: snapshot_of,
    });
    Rig { timeline, now }
}

async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

fn label(event: &RawEvent) -> &'static str {
    match event {
        RawEvent::Call { phase, .. } => match phase {
            CallPhase::Start => "start",
            CallPhase::End => "end",
            CallPhase::Cancel => "cancel",
            CallPhase::Phase => "phase",
        },
        RawEvent::State { .. } => "state",
        RawEvent::Hook { .. } => "hook",
        RawEvent::Mail { .. } => "mail",
        RawEvent::Wake { .. } => "wake",
    }
}

fn listed(rig: &Rig, period: u64) -> Vec<(String, String)> {
    rig.timeline
        .list(period)
        .into_iter()
        .map(|item| (item.reference, item.trigger))
        .collect()
}

#[tokio::test]
async fn records_a_call_with_before_and_after_snapshots() {
    let rig = make();
    let call = rig
        .timeline
        .begin(Some("pane-1"), "pane.input", Some("pane-2"));
    rig.advance(120);
    call.end(None);
    settle().await;
    let take = rig.timeline.take("pane-1").unwrap();
    assert_eq!(
        take.events.iter().map(label).collect::<Vec<_>>(),
        ["start", "end"]
    );
    match &take.events[1] {
        RawEvent::Call { ms, after, .. } => {
            assert_eq!(*ms, Some(120));
            assert_eq!(after.as_ref(), Some(&snapshot()));
        }
        other => panic!("expected a call event, got {other:?}"),
    }
    match &take.events[0] {
        RawEvent::Call { before, .. } => assert_eq!(before.as_ref(), Some(&snapshot())),
        other => panic!("expected a call event, got {other:?}"),
    }
    assert_eq!(take.callers, ["pane-2"]);
}

#[tokio::test]
async fn names_a_call_that_never_returned() {
    let rig = make();
    let _open = rig.timeline.begin(Some("pane-1"), "pane.input", None);
    rig.advance(20_000);
    assert_eq!(
        listed(&rig, PERIOD),
        [("pane-1".to_owned(), "call-open".to_owned())]
    );
    let names: Vec<Option<String>> = rig
        .timeline
        .take("pane-1")
        .unwrap()
        .events
        .iter()
        .map(|event| match event {
            RawEvent::Call { name, .. } => name.clone(),
            _ => None,
        })
        .collect();
    assert!(names.contains(&Some("never-returned".to_owned())));
}

#[tokio::test]
async fn lists_only_panes_with_trouble() {
    let rig = make();
    rig.timeline
        .begin(Some("pane-1"), "pane.list", None)
        .end(None);
    rig.timeline
        .begin(Some("pane-2"), "pane.input", None)
        .end(Some("not-submitted"));
    rig.advance(10);
    assert_eq!(
        listed(&rig, PERIOD),
        [("i1".to_owned(), "not-submitted".to_owned())]
    );
}

#[tokio::test]
async fn keeps_at_most_the_ring_size_and_window() {
    let rig = make();
    for _ in 0..INCIDENT_EVENTS_MAX + 20 {
        rig.timeline.state("pane-1", "working", None);
    }
    assert_eq!(
        rig.timeline.take("pane-1").unwrap().events.len(),
        INCIDENT_EVENTS_MAX
    );
    rig.advance(i64::try_from(INCIDENT_WINDOW_MS).unwrap() + 1);
    rig.timeline.state("pane-1", "done", None);
    assert_eq!(rig.timeline.take("pane-1").unwrap().events.len(), 1);
}

#[tokio::test]
async fn writes_an_odd_method_or_code_as_a_fixed_word() {
    let rig = make();
    rig.timeline
        .begin(Some("pane-1"), "/home/me/secret", None)
        .end(Some("Has Space"));
    let events = rig.timeline.take("pane-1").unwrap().events;
    assert!(!format!("{events:?}").contains("secret"));
    match &events[1] {
        RawEvent::Call { code, method, .. } => {
            assert_eq!(code.as_deref(), Some("error"));
            assert_eq!(method, "other");
        }
        other => panic!("expected a call event, got {other:?}"),
    }
}

#[tokio::test]
async fn forgets_a_closed_pane_and_clears_all() {
    let rig = make();
    rig.timeline.state("pane-1", "working", None);
    rig.timeline.forget("pane-1");
    assert!(rig.timeline.take("pane-1").is_none());
    rig.timeline.state("pane-2", "working", None);
    rig.timeline.clear();
    assert!(rig.timeline.take("pane-2").is_none());
}

#[tokio::test]
async fn attaches_a_call_to_its_pane_when_the_pane_is_resolved_later_and_drops_one_that_never_is() {
    let rig = make();
    let named = rig.timeline.begin(None, "pane.input", None);
    run_in_incident(Some(named.clone()), async { bind_incident("pane-1") }).await;
    named.end(Some("not-submitted"));
    rig.timeline.begin(None, "pane.list", None).end(None);
    assert_eq!(
        listed(&rig, PERIOD),
        [("i1".to_owned(), "not-submitted".to_owned())]
    );
    assert_eq!(rig.timeline.take("pane-1").unwrap().events.len(), 2);
}

#[tokio::test]
async fn names_the_specific_cause_over_a_slow_call() {
    let rig = make();
    let call = rig.timeline.begin(Some("pane-1"), "pane.wake", None);
    rig.timeline.wake("pane-1", "wake-not-ready", 12_000.0);
    rig.advance(12_000);
    call.end(None);
    let triggers: Vec<String> = rig
        .timeline
        .list(PERIOD)
        .into_iter()
        .map(|item| item.trigger)
        .collect();
    assert_eq!(triggers, ["wake-not-ready"]);
}

#[tokio::test]
async fn keeps_a_finished_incident_for_the_period_and_merges_its_follow_up_events() {
    let rig = make();
    let call = rig.timeline.begin(Some("pane-1"), "pane.input", None);
    rig.advance(50);
    call.end(Some("not-submitted"));
    rig.advance(60_000 * 10);
    rig.timeline
        .begin(Some("pane-1"), "pane.list", None)
        .end(None);
    let items = rig.timeline.list(PERIOD);
    assert_eq!(items[0].trigger, "not-submitted");
    assert_eq!(items.len(), 1);
    assert_eq!(rig.timeline.list(1000).len(), 0);
    let take = rig.timeline.take(&items[0].reference).unwrap();
    assert_eq!(take.pane_id, "pane-1");
    assert!(take.events.iter().any(|event| matches!(
        event,
        RawEvent::Call { code: Some(code), .. } if code == "not-submitted"
    )));
}

#[tokio::test]
async fn counts_calls_by_method_and_result_since_the_start() {
    let rig = make();
    rig.timeline
        .begin(Some("pane-1"), "pane.input", None)
        .end(None);
    rig.timeline
        .begin(Some("pane-1"), "pane.input", None)
        .end(Some("not-submitted"));
    rig.advance(3 * 60_000);
    let totals = rig.timeline.totals();
    assert_eq!(totals.since_min, 3);
    assert_eq!(
        Value::Object(totals.counts),
        json!({"pane.input.ok": 1, "pane.input.not-submitted": 1})
    );
}

#[tokio::test]
async fn clear_forgets_kept_incidents_and_counts() {
    let rig = make();
    rig.timeline
        .begin(Some("pane-1"), "pane.input", None)
        .end(Some("not-submitted"));
    rig.timeline.clear();
    assert!(rig.timeline.list(PERIOD).is_empty());
    assert!(rig.timeline.totals().counts.is_empty());
}
