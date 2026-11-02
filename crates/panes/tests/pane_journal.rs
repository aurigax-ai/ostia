#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::clock::Clock;
use ostia_panes::pane_journal::{
    Changes, JOURNAL_CURSORS_MAX, JOURNAL_EVENTS_MAX, JournalChange, JournalDeps, JournalEvent,
    PaneJournal, StampedEvent, TerminalState,
};
use parking_lot::Mutex;

struct Scene {
    j: PaneJournal,
    clock: Arc<AtomicI64>,
    terminal: Arc<Mutex<HashMap<String, TerminalState>>>,
}

impl Scene {
    fn at(&self, now: i64) {
        self.clock.store(now, Ordering::SeqCst);
    }

    fn set(&self, pane_id: &str, running: bool, last_exit_code: Option<i64>) {
        self.terminal.lock().insert(
            pane_id.to_owned(),
            TerminalState {
                running,
                last_exit_code,
            },
        );
    }
}

fn journal() -> Scene {
    let clock = Arc::new(AtomicI64::new(1000));
    let terminal: Arc<Mutex<HashMap<String, TerminalState>>> = Arc::default();
    let reader = Arc::clone(&clock);
    let now: Clock = Arc::new(move || reader.load(Ordering::SeqCst));
    let lookup = Arc::clone(&terminal);
    let j = PaneJournal::new(JournalDeps {
        terminal: Arc::new(move |pane_id| lookup.lock().get(pane_id).cloned()),
        now,
    });
    Scene { j, clock, terminal }
}

fn attention(state: Option<&str>) -> JournalChange {
    JournalChange::Attention {
        state: state.map(str::to_owned),
    }
}

fn state(state: &str, from: Option<&str>) -> JournalEvent {
    JournalEvent::State {
        state: state.to_owned(),
        from: from.map(str::to_owned),
    }
}

fn events(changes: Changes) -> Vec<JournalEvent> {
    match changes {
        Changes::First => panic!("expected a follow-up look, got the first"),
        Changes::Since(seen) => seen.into_iter().map(|stamped| stamped.event).collect(),
    }
}

#[test]
fn records_a_transition_once_with_the_state_it_left_and_when_it_began() {
    let scene = journal();
    let j = &scene.j;
    j.on_change("p", attention(Some("working")));
    scene.at(5000);
    j.on_change("p", attention(Some("working")));
    j.on_change("p", attention(Some("done")));
    assert_eq!(j.state_since("p"), Some(5000));
    assert_eq!(j.changes("me", "p"), Changes::First);
    scene.at(6000);
    j.on_change("p", attention(Some("working")));
    assert_eq!(
        events(j.changes("me", "p")),
        vec![state("working", Some("done"))]
    );
}

#[test]
fn reads_a_cleared_attention_as_idle() {
    let scene = journal();
    let j = &scene.j;
    j.on_change("p", attention(Some("done")));
    j.on_change("p", attention(None));
    j.changes("me", "p");
    j.on_change("p", attention(Some("working")));
    assert_eq!(
        events(j.changes("me", "p")),
        vec![state("working", Some("idle"))]
    );
}

#[test]
fn leaves_out_the_state_it_left_for_the_first_transition_of_a_pane() {
    let scene = journal();
    let j = &scene.j;
    j.changes("me", "p");
    j.on_change("p", attention(Some("working")));
    assert_eq!(events(j.changes("me", "p")), vec![state("working", None)]);
    assert_eq!(j.state_of("p"), Some("working".to_owned()));
    assert_eq!(j.state_of("other"), None);
    assert_eq!(j.state_since("other"), None);
}

#[test]
fn records_a_finished_command_with_its_exit_code_and_ignores_one_that_is_still_running() {
    let scene = journal();
    let j = &scene.j;
    scene.set("p", true, None);
    j.on_change("p", JournalChange::State);
    j.changes("me", "p");
    scene.set("p", false, Some(2));
    j.on_change("p", JournalChange::State);
    j.on_change("p", JournalChange::State);
    assert_eq!(
        events(j.changes("me", "p")),
        vec![JournalEvent::Command { exit_code: Some(2) }]
    );
}

#[test]
fn records_a_finished_command_that_has_no_exit_code_without_one() {
    let scene = journal();
    let j = &scene.j;
    scene.set("p", true, None);
    j.on_change("p", JournalChange::State);
    j.changes("me", "p");
    scene.set("p", false, None);
    j.on_change("p", JournalChange::State);
    assert_eq!(
        events(j.changes("me", "p")),
        vec![JournalEvent::Command { exit_code: None }]
    );
}

#[test]
fn records_nothing_for_a_pane_that_has_no_terminal_state() {
    let scene = journal();
    let j = &scene.j;
    j.on_change("p", JournalChange::State);
    assert_eq!(j.changes("me", "p"), Changes::First);
    assert_eq!(events(j.changes("me", "p")), Vec::<JournalEvent>::new());
}

#[test]
fn tells_a_listener_each_event_as_it_is_recorded_with_its_pane() {
    let scene = journal();
    let j = &scene.j;
    let mut heard = j.subscribe();
    j.on_change("p", attention(Some("done")));
    scene.set("p", true, None);
    j.on_change("p", JournalChange::State);
    scene.set("p", false, Some(0));
    j.on_change("p", JournalChange::State);
    j.mail("p");
    let mut seen: Vec<(String, JournalEvent)> = Vec::new();
    while let Ok((pane_id, stamped)) = heard.try_recv() {
        seen.push((pane_id, stamped.event));
    }
    assert_eq!(
        seen,
        vec![
            ("p".to_owned(), state("done", None)),
            ("p".to_owned(), JournalEvent::Command { exit_code: Some(0) }),
            ("p".to_owned(), JournalEvent::Mail),
        ]
    );
}

#[test]
fn stamps_each_event_with_the_time_and_a_rising_sequence_number() {
    let scene = journal();
    let j = &scene.j;
    let mut heard = j.subscribe();
    scene.at(10);
    j.mail("p");
    scene.at(20);
    j.mail("q");
    let (_, first): (String, StampedEvent) = heard.try_recv().unwrap();
    let (_, second) = heard.try_recv().unwrap();
    assert_eq!((first.at, second.at), (10, 20));
    assert!(second.seq > first.seq);
}

#[test]
fn prefers_the_line_the_agent_set_over_the_stop_text_and_keeps_both_until_the_next_turn() {
    let scene = journal();
    let j = &scene.j;
    j.report("p", "done", None, Some("stop text"));
    assert_eq!(j.closing("p"), Some("stop text".to_owned()));
    j.report("p", "done", Some("PR #4 open\nmore"), Some("stop text"));
    assert_eq!(j.closing("p"), Some("PR #4 open".to_owned()));
    j.report("p", "done", None, Some("later stop text"));
    assert_eq!(j.closing("p"), Some("PR #4 open".to_owned()));
    j.on_change("p", attention(Some("working")));
    assert_eq!(j.closing("p"), None);
}

#[test]
fn takes_a_closing_line_only_from_a_done_report() {
    let scene = journal();
    let j = &scene.j;
    j.report("p", "waiting", Some("Allow Bash?"), Some("text"));
    j.report("p", "error", Some("boom"), None);
    assert_eq!(j.closing("p"), None);
}

#[test]
fn records_a_closing_event_only_when_a_done_report_carries_a_line_or_stop_text() {
    let scene = journal();
    let j = &scene.j;
    j.changes("me", "p");
    j.report("p", "done", Some("   "), Some(""));
    j.report("p", "done", None, None);
    assert_eq!(events(j.changes("me", "p")), Vec::<JournalEvent>::new());
    j.report("p", "done", Some("shipped"), None);
    assert_eq!(events(j.changes("me", "p")), vec![JournalEvent::Closing]);
}

#[test]
fn cuts_the_stop_text_to_280_utf16_units() {
    let scene = journal();
    let j = &scene.j;
    j.report("p", "done", None, Some(&"a".repeat(400)));
    assert_eq!(j.closing("p").unwrap().len(), 280);
    j.report(
        "q",
        "done",
        None,
        Some(&format!("{}\u{1F6D2}", "b".repeat(279))),
    );
    let cut = j.closing("q").unwrap();
    assert_eq!(cut.encode_utf16().count(), 280);
}

#[test]
fn answers_first_look_then_only_what_is_new_for_that_caller() {
    let scene = journal();
    let j = &scene.j;
    j.mail("p");
    assert_eq!(j.changes("a", "p"), Changes::First);
    j.mail("p");
    assert_eq!(j.changes("b", "p"), Changes::First);
    assert_eq!(events(j.changes("a", "p")), vec![JournalEvent::Mail]);
    assert_eq!(events(j.changes("a", "p")), Vec::<JournalEvent>::new());
    assert_eq!(events(j.changes("b", "p")), Vec::<JournalEvent>::new());
    j.mail("p");
    assert_eq!(events(j.changes("b", "p")), vec![JournalEvent::Mail]);
    assert_eq!(events(j.changes("a", "p")), vec![JournalEvent::Mail]);
}

#[test]
fn keeps_the_last_twenty_events_of_a_pane() {
    let scene = journal();
    let j = &scene.j;
    j.changes("a", "p");
    for _ in 0..JOURNAL_EVENTS_MAX + 5 {
        j.mail("p");
    }
    assert_eq!(events(j.changes("a", "p")).len(), JOURNAL_EVENTS_MAX);
}

#[test]
fn bounds_the_cursors_it_keeps_dropping_the_one_looked_at_longest_ago() {
    let scene = journal();
    let j = &scene.j;
    j.changes("first", "p");
    for i in 0..JOURNAL_CURSORS_MAX {
        j.changes(&format!("caller-{i}"), "p");
    }
    assert_eq!(j.changes("first", "p"), Changes::First);
    assert!(matches!(
        j.changes(&format!("caller-{}", JOURNAL_CURSORS_MAX - 1), "p"),
        Changes::Since(_)
    ));
}

#[test]
fn forgets_a_closed_pane_its_closing_line_and_every_cursor_that_pointed_at_it() {
    let scene = journal();
    let j = &scene.j;
    j.report("p", "done", Some("PR"), None);
    j.changes("a", "p");
    j.changes("p-ext", "q");
    j.on_change("p", JournalChange::Closed);
    assert_eq!(j.closing("p"), None);
    assert_eq!(j.changes("a", "p"), Changes::First);
    j.forget("other", Some("p-ext"));
    assert_eq!(j.changes("p-ext", "q"), Changes::First);
}

#[test]
fn forgets_only_the_cursors_that_end_at_the_pane_when_no_external_id_is_given() {
    let scene = journal();
    let j = &scene.j;
    j.changes("a", "p");
    j.changes("a", "pp");
    j.changes("a", "q");
    j.forget("p", None);
    assert_eq!(j.changes("a", "p"), Changes::First);
    assert!(matches!(j.changes("a", "pp"), Changes::Since(_)));
    assert!(matches!(j.changes("a", "q"), Changes::Since(_)));
}

#[test]
fn pha_c7_marks_when_the_agent_state_running_or_hibernation_last_changed() {
    let scene = journal();
    let j = &scene.j;
    assert_eq!(j.since("p"), None);
    j.on_change("p", attention(Some("working")));
    assert_eq!(j.since("p"), Some(1000));
    scene.at(2000);
    j.on_change("p", attention(Some("working")));
    assert_eq!(j.since("p"), Some(1000));
    scene.set("p", true, None);
    j.on_change("p", JournalChange::State);
    assert_eq!(j.since("p"), Some(2000));
    scene.at(3000);
    j.on_change("p", JournalChange::State);
    assert_eq!(j.since("p"), Some(2000));
    scene.at(4000);
    j.lifecycle("p");
    assert_eq!(j.since("p"), Some(4000));
    j.on_change("p", JournalChange::Closed);
    assert_eq!(j.since("p"), None);
}
