#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ostia_base::PaneId;
use ostia_gateway::phone_input::phone_input_noter;

type Waits = Arc<Mutex<HashMap<String, i64>>>;
type Sent = Arc<Mutex<Vec<String>>>;

fn waits(rows: &[(&str, i64)]) -> Waits {
    Arc::new(Mutex::new(
        rows.iter()
            .map(|(id, at)| ((*id).to_owned(), *at))
            .collect(),
    ))
}

fn recorder() -> (Sent, impl Fn(&PaneId) + Send + Sync + 'static) {
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let sink = sent.clone();
    (sent, move |pane: &PaneId| {
        sink.lock().unwrap().push(pane.as_str().to_owned());
    })
}

fn waiting_since(waits: &Waits) -> impl Fn(&PaneId) -> Option<i64> + Send + Sync + 'static {
    let waits = waits.clone();
    move |pane: &PaneId| waits.lock().unwrap().get(pane.as_str()).copied()
}

fn sent_panes(sent: &Sent) -> Vec<String> {
    sent.lock().unwrap().clone()
}

#[test]
fn notes_only_the_first_input_after_a_wait_was_set_per_pane() {
    let since = waits(&[("p1", 100), ("p2", 200)]);
    let (sent, input_sent) = recorder();
    let note = phone_input_noter(waiting_since(&since), input_sent);
    let p1 = PaneId::new("p1");
    note.note(&p1);
    note.note(&p1);
    note.note(&p1);
    assert_eq!(sent_panes(&sent), ["p1"]);
    note.note(&PaneId::new("p2"));
    assert_eq!(sent_panes(&sent), ["p1", "p2"]);
}

#[test]
fn notes_again_for_a_later_wait_of_the_same_pane() {
    let since = waits(&[("p1", 100)]);
    let (sent, input_sent) = recorder();
    let note = phone_input_noter(waiting_since(&since), input_sent);
    let p1 = PaneId::new("p1");
    note.note(&p1);
    since.lock().unwrap().remove("p1");
    note.note(&p1);
    since.lock().unwrap().insert("p1".to_owned(), 300);
    note.note(&p1);
    note.note(&p1);
    assert_eq!(sent_panes(&sent).len(), 2);
}

#[test]
fn notes_nothing_for_a_pane_that_is_not_waiting() {
    let (sent, input_sent) = recorder();
    phone_input_noter(|_: &PaneId| None, input_sent).note(&PaneId::new("p1"));
    assert!(sent_panes(&sent).is_empty());
}

#[test]
fn notes_again_when_the_same_pane_starts_a_new_wait_without_a_gap_in_between() {
    let since = waits(&[("p1", 100)]);
    let (sent, input_sent) = recorder();
    let note = phone_input_noter(waiting_since(&since), input_sent);
    let p1 = PaneId::new("p1");
    note.note(&p1);
    since.lock().unwrap().insert("p1".to_owned(), 101);
    note.note(&p1);
    assert_eq!(sent_panes(&sent), ["p1", "p1"]);
}

#[test]
fn notes_a_wait_that_began_at_time_zero() {
    let since = waits(&[("p1", 0)]);
    let (sent, input_sent) = recorder();
    let note = phone_input_noter(waiting_since(&since), input_sent);
    note.note(&PaneId::new("p1"));
    assert_eq!(sent_panes(&sent), ["p1"]);
}
