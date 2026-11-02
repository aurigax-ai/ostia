#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ostia_agents::agent_stream::StreamEvent;
use ostia_agents::stream_pi::{PiListener, PiStreamPort, pi_source};
use ostia_agents::stream_source::{Emit, StreamSource};
use serde_json::{Value, json};

fn ev(value: Value) -> StreamEvent {
    serde_json::from_value(value).unwrap()
}

fn started(turn: &str) -> StreamEvent {
    ev(json!({"type": "turn.started", "turn": turn}))
}

fn text(turn: &str, id: &str, body: &str) -> StreamEvent {
    ev(json!({"type": "text", "turn": turn, "id": id, "text": body}))
}

#[derive(Default)]
struct FakePi {
    listeners: Mutex<Vec<(usize, PiListener)>>,
    next: AtomicUsize,
    snapshots: Mutex<Vec<usize>>,
    stored: Mutex<Vec<StreamEvent>>,
    released: Arc<AtomicUsize>,
}

impl FakePi {
    fn emit(&self, events: Vec<StreamEvent>) {
        let listeners: Vec<PiListener> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(events.clone());
        }
    }

    fn listening(&self) -> usize {
        self.listeners.lock().unwrap().len()
    }
}

struct Port(Arc<FakePi>);

impl PiStreamPort for Port {
    fn subscribe(&self, listener: PiListener) -> Box<dyn FnOnce() + Send + Sync> {
        let id = self.0.next.fetch_add(1, Ordering::SeqCst);
        self.0.listeners.lock().unwrap().push((id, listener));
        let pi = Arc::clone(&self.0);
        Box::new(move || {
            pi.listeners.lock().unwrap().retain(|(held, _)| *held != id);
            pi.released.fetch_add(1, Ordering::SeqCst);
        })
    }

    fn snapshot(&self, turns: usize) -> Vec<StreamEvent> {
        self.0.snapshots.lock().unwrap().push(turns);
        self.0.stored.lock().unwrap().clone()
    }
}

type Batches = Arc<Mutex<Vec<Vec<StreamEvent>>>>;

fn sink() -> (Emit, Batches) {
    let batches: Batches = Arc::default();
    let held = Arc::clone(&batches);
    (
        Arc::new(move |events| held.lock().unwrap().push(events)),
        batches,
    )
}

fn rig() -> (Arc<FakePi>, impl StreamSource) {
    let pi = Arc::new(FakePi::default());
    let source = pi_source(Arc::new(Port(Arc::clone(&pi))));
    (pi, source)
}

#[tokio::test]
async fn backfills_the_snapshot_of_the_asked_turns_and_is_not_truncated() {
    let (pi, source) = rig();
    *pi.stored.lock().unwrap() = vec![started("t1"), text("t1", "x1", "hello")];
    let backfill = source.backfill(3).await.unwrap();
    assert_eq!(
        backfill.events,
        vec![started("t1"), text("t1", "x1", "hello")]
    );
    assert!(!backfill.truncated);
    assert_eq!(*pi.snapshots.lock().unwrap(), vec![3]);
}

#[tokio::test]
async fn holds_events_that_arrive_before_live_and_sends_them_in_one_batch_when_live_starts() {
    let (pi, source) = rig();
    source.backfill(5).await.unwrap();
    pi.emit(vec![started("t1")]);
    pi.emit(vec![text("t1", "x1", "a")]);
    let (emit, batches) = sink();
    source.live(emit);
    assert_eq!(
        *batches.lock().unwrap(),
        vec![vec![started("t1"), text("t1", "x1", "a")]]
    );
}

#[tokio::test]
async fn sends_nothing_at_live_when_no_event_was_held() {
    let (_pi, source) = rig();
    source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    source.live(emit);
    assert!(batches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn passes_events_straight_on_once_live() {
    let (pi, source) = rig();
    source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    source.live(emit);
    pi.emit(vec![started("t2")]);
    pi.emit(vec![text("t2", "x2", "b")]);
    assert_eq!(
        *batches.lock().unwrap(),
        vec![vec![started("t2")], vec![text("t2", "x2", "b")]]
    );
}

#[tokio::test]
async fn does_not_replay_held_events_a_second_time() {
    let (pi, source) = rig();
    source.backfill(5).await.unwrap();
    pi.emit(vec![started("t1")]);
    let (emit, batches) = sink();
    source.live(emit);
    pi.emit(vec![started("t2")]);
    assert_eq!(
        *batches.lock().unwrap(),
        vec![vec![started("t1")], vec![started("t2")]]
    );
}

#[tokio::test]
async fn stops_listening_and_delivering_when_closed() {
    let (pi, source) = rig();
    source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    source.live(emit);
    assert_eq!(pi.listening(), 1);
    source.close();
    assert_eq!(pi.listening(), 0);
    assert_eq!(pi.released.load(Ordering::SeqCst), 1);
    pi.emit(vec![started("t3")]);
    assert!(batches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn closing_twice_or_before_a_backfill_unsubscribes_at_most_once() {
    let (pi, source) = rig();
    source.close();
    assert_eq!(pi.released.load(Ordering::SeqCst), 0);
    source.backfill(5).await.unwrap();
    source.close();
    source.close();
    assert_eq!(pi.released.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn subscribes_at_backfill_and_not_before() {
    let (pi, source) = rig();
    assert_eq!(pi.listening(), 0);
    source.backfill(5).await.unwrap();
    assert_eq!(pi.listening(), 1);
}
