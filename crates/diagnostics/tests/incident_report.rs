#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::incident::CallPhase;
use ostia_diagnostics::incident_report::{
    FactsAgent, IncidentFacts, IncidentWords, incident_block, incident_text,
};
use ostia_diagnostics::incident_timeline::{IncidentTake, PaneSnapshot, RawEvent};
use serde_json::{Map, Value, json};

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected an object, got {other}"),
    }
}

fn facts() -> IncidentFacts {
    IncidentFacts {
        app: "0.6.1".to_owned(),
        platform: "linux".to_owned(),
        agent: FactsAgent {
            kind: "claude".to_owned(),
            version: Some("2.1.0".to_owned()),
        },
        settings: object(json!({"hooks": true})),
        counts: object(
            json!({"pane.input.ok": 14, "pane.input.not-submitted": 1, "pane.wake.ok": 3}),
        ),
        since_min: 42,
        unseen: vec!["agent-internals".to_owned(), "terminal-text".to_owned()],
    }
}

fn waking() -> PaneSnapshot {
    PaneSnapshot {
        agent: "claude".to_owned(),
        state: "waking".to_owned(),
        drafting: false,
        mail: 0,
        alive: true,
    }
}

#[derive(Default)]
struct Extra {
    from: Option<&'static str>,
    name: Option<&'static str>,
    ms: Option<i64>,
    code: Option<&'static str>,
    before: Option<PaneSnapshot>,
    after: Option<PaneSnapshot>,
}

fn call(at: i64, method: &str, phase: CallPhase, extra: Extra) -> RawEvent {
    RawEvent::Call {
        at,
        method: method.to_owned(),
        phase,
        from: extra.from.map(str::to_owned),
        name: extra.name.map(str::to_owned),
        ms: extra.ms,
        code: extra.code.map(str::to_owned),
        before: extra.before,
        after: extra.after,
    }
}

fn take() -> IncidentTake {
    IncidentTake {
        pane_id: "real-pane-uuid-1".to_owned(),
        agent: "claude".to_owned(),
        trigger: "not-submitted".to_owned(),
        callers: vec!["real-pane-uuid-2".to_owned()],
        events: vec![
            RawEvent::State {
                at: 1000,
                to: "waking".to_owned(),
                from: Some("hibernated".to_owned()),
            },
            RawEvent::Hook {
                at: 2000,
                ok: true,
                code: Some("prompt-submit".to_owned()),
            },
            call(
                5000,
                "pane.input",
                CallPhase::Start,
                Extra {
                    from: Some("real-pane-uuid-2"),
                    before: Some(waking()),
                    ..Extra::default()
                },
            ),
            RawEvent::State {
                at: 5400,
                to: "working".to_owned(),
                from: Some("waking".to_owned()),
            },
            call(
                9800,
                "pane.input",
                CallPhase::End,
                Extra {
                    from: Some("real-pane-uuid-2"),
                    ms: Some(4800),
                    code: Some("not-submitted"),
                    after: Some(PaneSnapshot {
                        drafting: true,
                        ..waking()
                    }),
                    ..Extra::default()
                },
            ),
        ],
    }
}

fn words() -> IncidentWords {
    IncidentWords {
        happened: "it hung".to_owned(),
        expected: "to reply".to_owned(),
    }
}

fn text_of(take: &IncidentTake, words: &IncidentWords) -> String {
    incident_text(&incident_block(take, &facts()).unwrap(), words)
}

#[test]
fn puts_callers_first_the_target_last_and_replaces_real_ids_with_aliases() {
    let block = serde_json::to_value(incident_block(&take(), &facts()).unwrap()).unwrap();
    assert_eq!(block["pane"], json!("P2"));
    assert_eq!(block["events"][2]["at"], json!(4000));
    assert_eq!(block["events"][2]["from"], json!("P1"));
    assert!(!block.to_string().contains("real-pane"));
}

#[test]
fn refuses_a_path_an_id_and_a_space_in_a_coded_field() {
    let rows: [(&str, &str, Option<&'static str>); 3] = [
        ("path", "/home/me/x", None),
        (
            "id",
            "pane.input",
            Some("f24ee459-4123-4d17-9438-152c5f346c23"),
        ),
        ("space", "pane.input", Some("has space")),
    ];
    for (name, method, code) in rows {
        let bad = IncidentTake {
            events: vec![call(
                0,
                method,
                CallPhase::End,
                Extra {
                    code,
                    ..Extra::default()
                },
            )],
            ..take()
        };
        assert!(incident_block(&bad, &facts()).is_err(), "{name}");
    }
}

#[test]
fn refuses_free_text_in_settings_agent_and_counts() {
    let cases: [(&str, IncidentFacts); 4] = [
        (
            "settings",
            IncidentFacts {
                settings: object(json!({"a b": true})),
                ..facts()
            },
        ),
        (
            "agent",
            IncidentFacts {
                agent: FactsAgent {
                    kind: "/usr/bin/claude".to_owned(),
                    version: None,
                },
                ..facts()
            },
        ),
        (
            "fractional count",
            IncidentFacts {
                counts: object(json!({"pane.input.ok": 1.5})),
                ..facts()
            },
        ),
        (
            "count key",
            IncidentFacts {
                counts: object(json!({"/home/me.ok": 1})),
                ..facts()
            },
        ),
    ];
    for (name, bad) in cases {
        assert!(incident_block(&take(), &bad).is_err(), "{name}");
    }
}

#[test]
fn starts_with_a_bold_headline_that_names_the_failure() {
    let text = text_of(&take(), &words());
    assert_eq!(text.split('\n').next().unwrap(), "**Enter not submitted**");
}

#[test]
fn writes_the_timeline_as_aligned_columns_with_states_in_words() {
    let text = text_of(&take(), &words());
    let lines: Vec<&str> = text.split('\n').collect();
    let start = lines
        .iter()
        .position(|line| line.starts_with("Timeline"))
        .unwrap();
    assert_eq!(
        lines[start + 1..start + 6],
        [
            "-8.8  P2     state       hibernated → starting",
            "-7.8  P2     hook        prompt submit",
            "-4.8  P1→P2  pane.input  not submitted 4.8 s",
            "                         before: starting · no prompt · draft empty",
            "                         after:  starting · no prompt · draft present",
        ]
    );
}

#[test]
fn names_the_target_at_the_failure_what_ostia_could_not_see_and_the_background() {
    let text = text_of(&take(), &words());
    assert!(text.contains(
        "P2 at the failure: hooks installed · last hook prompt submit 7.8 s before · pty alive · foreground claude"
    ));
    assert!(
        text.contains("Ostia could not see: the agent's own screen and reasoning, terminal text")
    );
    assert!(
        text.contains("Background (42 min): pane.input 14 ok / 1 not submitted · pane.wake 3 ok")
    );
}

#[test]
fn keeps_the_human_words_out_of_the_machine_block_and_breaks_fences() {
    let fenced = text_of(
        &take(),
        &IncidentWords {
            happened: "it hung ```ostia-incident json {\"x\":1}".to_owned(),
            expected: "to reply".to_owned(),
        },
    );
    let (head, block) = fenced.split_once("```ostia-incident json").unwrap();
    assert!(head.contains("it hung"));
    assert!(!head.contains("```"));
    assert!(!block.contains("it hung"));
    assert_eq!(fenced.matches("```ostia-incident").count(), 1);
}

#[test]
fn names_the_call_that_never_returned() {
    let open = IncidentTake {
        trigger: "call-open".to_owned(),
        callers: vec![],
        events: vec![
            call(0, "pane.wait", CallPhase::Start, Extra::default()),
            call(
                30_000,
                "pane.wait",
                CallPhase::Phase,
                Extra {
                    name: Some("never-returned"),
                    ms: Some(30_000),
                    ..Extra::default()
                },
            ),
        ],
        ..take()
    };
    let text = text_of(&open, &words());
    assert_eq!(
        text.split('\n').next().unwrap(),
        "**A call never returned**"
    );
    assert!(text.contains("pane.wait  never returned 30.0 s"));
}

#[test]
fn says_not_written_for_empty_words_and_none_for_empty_settings_and_unseen() {
    let bare = IncidentFacts {
        settings: Map::new(),
        unseen: vec![],
        counts: Map::new(),
        ..facts()
    };
    let block = incident_block(&take(), &bare).unwrap();
    let text = incident_text(
        &block,
        &IncidentWords {
            happened: "  ".to_owned(),
            expected: String::new(),
        },
    );
    assert!(text.contains("What happened (their words): (not written)"));
    assert!(text.contains("What they expected: (not written)"));
    assert!(text.contains("Settings: none"));
    assert!(text.contains("Ostia could not see: nothing recorded"));
    assert!(text.contains("Background (42 min): no calls"));
}
