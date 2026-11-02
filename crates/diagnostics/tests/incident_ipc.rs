#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use ostia_contract::incident::INCIDENT_WORDS_MAX;
use ostia_diagnostics::incident_ipc::{IncidentActions, IncidentActionsDeps, Redacted};
use ostia_diagnostics::incident_timeline::{
    IncidentTimeline, IncidentTimelineDeps, PaneSnapshot, SnapshotFn,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tempfile::TempDir;

struct Rig {
    actions: IncidentActions,
    timeline: IncidentTimeline,
    clipboard: Arc<Mutex<Vec<String>>>,
    opened: Arc<Mutex<Vec<String>>>,
    asked_agent: Arc<Mutex<Vec<String>>>,
}

struct Options {
    known_agent: bool,
    save_to: Option<PathBuf>,
    agent_answer: Option<&'static str>,
}

fn rig(options: Options) -> Rig {
    let known = options.known_agent;
    let snapshot_of: SnapshotFn = Arc::new(move |_pane| {
        Box::pin(async move {
            known.then(|| PaneSnapshot {
                agent: "claude".to_owned(),
                state: "idle".to_owned(),
                drafting: false,
                mail: 0,
                alive: true,
            })
        })
    });
    let timeline = IncidentTimeline::new(IncidentTimelineDeps {
        now: Arc::new(|| 1000),
        snapshot: snapshot_of,
    });
    let clipboard = Arc::new(Mutex::new(Vec::new()));
    let opened = Arc::new(Mutex::new(Vec::new()));
    let asked_agent = Arc::new(Mutex::new(Vec::new()));
    let save_to = options.save_to.clone();
    let agent_answer = options.agent_answer;
    let asked = asked_agent.clone();
    let copied = clipboard.clone();
    let browsed = opened.clone();
    let actions = IncidentActions::new(IncidentActionsDeps {
        incidents: timeline.clone(),
        redact: Arc::new(|text: &str| {
            let count = text.matches("secret").count();
            let text = text.replace("secret", "[redacted]");
            Box::pin(async move { Redacted { text, count } })
        }),
        external_of: Arc::new(|reference: &str| (reference == "ext-1").then(|| "i1".to_owned())),
        agent_of: Arc::new(move |pane_id: &str| {
            asked.lock().push(pane_id.to_owned());
            Box::pin(async move { agent_answer.map(str::to_owned) })
        }),
        settings: Arc::new(|_agent: &str| match json!({"hooks": true}) {
            Value::Object(map) => map,
            _ => Map::new(),
        }),
        app: Arc::new(|| "0.6.1".to_owned()),
        platform: "linux".to_owned(),
        open_external: Arc::new(move |url: &str| {
            browsed.lock().push(url.to_owned());
            true
        }),
        pick_save_path: Arc::new(move || {
            let path = save_to.clone();
            Box::pin(async move { path })
        }),
        copy_to_clipboard: Arc::new(move |text: &str| copied.lock().push(text.to_owned())),
    });
    Rig {
        actions,
        timeline,
        clipboard,
        opened,
        asked_agent,
    }
}

fn default_rig() -> Rig {
    rig(Options {
        known_agent: true,
        save_to: None,
        agent_answer: None,
    })
}

async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

fn words(happened: &str, expected: &str) -> Value {
    json!({"happened": happened, "expected": expected})
}

async fn with_incident(rig: &Rig, pane: &str, code: &str) {
    rig.timeline
        .begin(Some(pane), "pane.input", None)
        .end(Some(code));
    settle().await;
}

#[tokio::test]
async fn groups_incidents_with_the_same_trigger_and_agent_and_counts_them() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    with_incident(&rig, "pane-2", "not-submitted").await;
    with_incident(&rig, "pane-3", "inbox-full").await;
    let listed: Vec<(String, String, usize)> = rig
        .actions
        .list("24h")
        .into_iter()
        .map(|item| (item.trigger, item.agent, item.count))
        .collect();
    assert_eq!(
        listed,
        [
            ("not-submitted".to_owned(), "claude".to_owned(), 2),
            ("inbox-full".to_owned(), "claude".to_owned(), 1),
        ]
    );
}

#[tokio::test]
async fn answers_an_empty_list_for_a_period_it_does_not_know() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    assert!(rig.actions.list("1h").is_empty());
    assert!(rig.actions.list("").is_empty());
    assert_eq!(rig.actions.list("30d").len(), 1);
}

#[tokio::test]
async fn refuses_a_report_when_the_words_are_not_two_strings_within_the_limit() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    let too_long = "x".repeat(INCIDENT_WORDS_MAX + 1);
    let refused = [
        json!(null),
        json!("words"),
        json!({"happened": "a"}),
        json!({"happened": "a", "expected": 3}),
        words(&too_long, "b"),
        words("a", &too_long),
    ];
    for raw in refused {
        assert!(rig.actions.report("i1", &raw).await.is_none(), "{raw}");
    }
    assert!(
        rig.actions
            .report("i1", &words(&"x".repeat(INCIDENT_WORDS_MAX), "b"))
            .await
            .is_some()
    );
}

#[tokio::test]
async fn refuses_a_report_for_a_reference_it_does_not_know() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    assert!(rig.actions.report("i99", &words("a", "b")).await.is_none());
}

#[tokio::test]
async fn writes_the_report_text_with_redacted_words_and_counts_the_redactions() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    let report = rig
        .actions
        .report("i1", &words("it leaked secret one", "no secret here"))
        .await
        .unwrap();
    assert_eq!(report.redacted, 2);
    assert!(report.text.starts_with("**Enter not submitted**"));
    assert!(report.text.contains("it leaked [redacted] one"));
    assert!(report.text.contains("no [redacted] here"));
    assert!(!report.text.contains("secret"));
    assert!(report.text.contains("Ostia 0.6.1 · linux · agent claude"));
    assert!(report.text.contains("Settings: hooks=on"));
    assert!(report.text.contains(
        "Ostia could not see: the agent's own screen and reasoning, terminal text, model output, prompts and messages"
    ));
}

#[tokio::test]
async fn reads_the_reference_through_the_external_id_first() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    assert!(
        rig.actions
            .report("ext-1", &words("a", "b"))
            .await
            .is_some()
    );
}

#[tokio::test]
async fn asks_which_agent_runs_in_the_pane_when_the_incident_does_not_know() {
    let rig = rig(Options {
        known_agent: false,
        save_to: None,
        agent_answer: Some("codex"),
    });
    with_incident(&rig, "pane-1", "not-submitted").await;
    let report = rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert_eq!(*rig.asked_agent.lock(), ["pane-1"]);
    assert!(report.text.contains("agent codex"));
}

#[tokio::test]
async fn names_the_agent_other_when_nobody_knows_it() {
    let rig = rig(Options {
        known_agent: false,
        save_to: None,
        agent_answer: None,
    });
    with_incident(&rig, "pane-1", "not-submitted").await;
    let report = rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert!(report.text.contains("agent other"));
}

#[tokio::test]
async fn does_not_ask_for_the_agent_when_the_incident_knows_it() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert!(rig.asked_agent.lock().is_empty());
}

#[tokio::test]
async fn saves_nothing_before_a_report_and_writes_the_last_report_to_the_chosen_file() {
    let dir = TempDir::new().unwrap();
    let target = dir.path().join("ostia-incident.md");
    let rig = rig(Options {
        known_agent: true,
        save_to: Some(target.clone()),
        agent_answer: None,
    });
    with_incident(&rig, "pane-1", "not-submitted").await;
    assert!(!rig.actions.save().await.unwrap());
    assert!(!target.exists());
    let report = rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert!(rig.actions.save().await.unwrap());
    assert_eq!(fs::read_to_string(&target).unwrap(), report.text);
}

#[tokio::test]
async fn saves_nothing_when_the_human_cancels_the_dialog() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert!(!rig.actions.save().await.unwrap());
}

#[tokio::test]
async fn opens_no_issue_before_a_report_then_copies_the_text_and_opens_the_new_issue_page() {
    let rig = default_rig();
    with_incident(&rig, "pane-1", "not-submitted").await;
    assert!(!rig.actions.open_issue());
    assert!(rig.clipboard.lock().is_empty());
    assert!(rig.opened.lock().is_empty());
    let report = rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert!(rig.actions.open_issue());
    assert_eq!(*rig.clipboard.lock(), [report.text]);
    assert_eq!(
        *rig.opened.lock(),
        [
            "https://github.com/aurigax-ai/ostia/issues/new?title=Agent%20stalled&body=Paste%20the%20report%20here%20(it%20is%20on%20your%20clipboard)."
        ]
    );
}

#[tokio::test]
async fn clear_forgets_the_incidents_and_the_last_report() {
    let dir = TempDir::new().unwrap();
    let target = dir.path().join("out.md");
    let rig = rig(Options {
        known_agent: true,
        save_to: Some(target.clone()),
        agent_answer: None,
    });
    with_incident(&rig, "pane-1", "not-submitted").await;
    rig.actions.report("i1", &words("a", "b")).await.unwrap();
    assert!(rig.actions.clear());
    assert!(rig.actions.list("30d").is_empty());
    assert!(!rig.actions.open_issue());
    assert!(!rig.actions.save().await.unwrap());
    assert!(!target.exists());
}
