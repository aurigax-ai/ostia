#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_agents::manager_session::{
    ManagerEnds, ManagerSessionDeps, SessionHandle, SessionHost, SessionSink,
    create_session_attacher,
};
use ostia_agents::stream_pi::{PiListener, PiStreamPort};
use ostia_contract::agent_stream::StreamEvent;
use serde_json::{Value, json};

#[derive(Default)]
struct FakeStream {
    listeners: Mutex<Vec<(usize, PiListener)>>,
    next: AtomicUsize,
    stored: Mutex<Vec<StreamEvent>>,
}

impl FakeStream {
    fn prompt(&self, text: &str) {
        let event: StreamEvent = serde_json::from_value(
            json!({"type": "prompt", "turn": "t1", "id": "p1", "text": text}),
        )
        .unwrap();
        self.stored.lock().unwrap().push(event.clone());
        let listeners: Vec<PiListener> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(vec![event.clone()]);
        }
    }
}

struct StreamPort(Arc<FakeStream>);

impl PiStreamPort for StreamPort {
    fn subscribe(&self, listener: PiListener) -> Box<dyn FnOnce() + Send + Sync> {
        let id = self.0.next.fetch_add(1, Ordering::SeqCst);
        self.0.listeners.lock().unwrap().push((id, listener));
        let stream = Arc::clone(&self.0);
        Box::new(move || {
            stream
                .listeners
                .lock()
                .unwrap()
                .retain(|(held, _)| *held != id);
        })
    }

    fn snapshot(&self, _turns: usize) -> Vec<StreamEvent> {
        self.0.stored.lock().unwrap().clone()
    }
}

type Waiting = Arc<Mutex<Vec<(usize, Arc<dyn Fn(bool) + Send + Sync>)>>>;
type Ends = Arc<Mutex<Vec<(usize, Arc<dyn Fn(&str) + Send + Sync>)>>>;

struct Host {
    stream: Arc<FakeStream>,
    waiting: Waiting,
    prompted: Arc<Mutex<Vec<String>>>,
    next: AtomicUsize,
}

impl SessionHost for Host {
    fn session_of_pane(&self, pane_id: &str) -> Option<String> {
        (pane_id == "pane-1").then(|| "s1".to_owned())
    }

    fn stream(&self, _session_id: &str) -> Option<Arc<dyn PiStreamPort>> {
        Some(Arc::new(StreamPort(Arc::clone(&self.stream))))
    }

    fn watch_waiting(
        &self,
        _session_id: &str,
        listener: Arc<dyn Fn(bool) + Send + Sync>,
    ) -> Box<dyn FnOnce() + Send + Sync> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.waiting.lock().unwrap().push((id, listener));
        let waiting = Arc::clone(&self.waiting);
        Box::new(move || waiting.lock().unwrap().retain(|(held, _)| *held != id))
    }

    fn prompt_from_portal(&self, _session_id: &str, text: &str) -> BoxFuture<'static, Value> {
        self.prompted.lock().unwrap().push(text.to_owned());
        async { json!({"ok": true}) }.boxed()
    }
}

struct Manager {
    ends: Ends,
    next: AtomicUsize,
}

impl ManagerEnds for Manager {
    fn on_end(&self, listener: Arc<dyn Fn(&str) + Send + Sync>) -> Box<dyn FnOnce() + Send + Sync> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.ends.lock().unwrap().push((id, listener));
        let ends = Arc::clone(&self.ends);
        Box::new(move || ends.lock().unwrap().retain(|(held, _)| *held != id))
    }
}

type Attach = Box<dyn Fn(&str, SessionSink) -> Option<SessionHandle>>;

struct Rig {
    attach: Attach,
    stream: Arc<FakeStream>,
    waiting: Waiting,
    ends: Ends,
    prompted: Arc<Mutex<Vec<String>>>,
}

fn rig() -> Rig {
    let stream = Arc::new(FakeStream::default());
    let waiting: Waiting = Arc::default();
    let ends: Ends = Arc::default();
    let prompted = Arc::new(Mutex::new(Vec::new()));
    let host: Arc<dyn SessionHost> = Arc::new(Host {
        stream: Arc::clone(&stream),
        waiting: Arc::clone(&waiting),
        prompted: Arc::clone(&prompted),
        next: AtomicUsize::new(0),
    });
    let manager: Arc<dyn ManagerEnds> = Arc::new(Manager {
        ends: Arc::clone(&ends),
        next: AtomicUsize::new(0),
    });
    let attach = create_session_attacher(ManagerSessionDeps {
        sessions: Box::new(move || Some(Arc::clone(&host))),
        manager: Box::new(move || Some(Arc::clone(&manager))),
    });
    Rig {
        attach: Box::new(attach),
        stream,
        waiting,
        ends,
        prompted,
    }
}

#[derive(Default)]
struct Calls {
    events: AtomicUsize,
    waiting: Mutex<Vec<bool>>,
    ended: AtomicUsize,
}

fn new_sink() -> (SessionSink, Arc<Calls>) {
    let calls = Arc::new(Calls::default());
    let sink = SessionSink {
        events: {
            let calls = Arc::clone(&calls);
            Arc::new(move |_| {
                calls.events.fetch_add(1, Ordering::SeqCst);
            })
        },
        waiting: {
            let calls = Arc::clone(&calls);
            Arc::new(move |on| calls.waiting.lock().unwrap().push(on))
        },
        ended: {
            let calls = Arc::clone(&calls);
            Arc::new(move || {
                calls.ended.fetch_add(1, Ordering::SeqCst);
            })
        },
    };
    (sink, calls)
}

fn fire_waiting(waiting: &Waiting, on: bool) {
    let listeners: Vec<_> = waiting
        .lock()
        .unwrap()
        .iter()
        .map(|(_, listener)| Arc::clone(listener))
        .collect();
    for listener in listeners {
        listener(on);
    }
}

fn fire_end(ends: &Ends, pane_id: &str) {
    let listeners: Vec<_> = ends
        .lock()
        .unwrap()
        .iter()
        .map(|(_, listener)| Arc::clone(listener))
        .collect();
    for listener in listeners {
        listener(pane_id);
    }
}

#[test]
fn forwards_stream_events_waiting_changes_and_the_end_of_the_manager_pane() {
    let rig = rig();
    let (sink, calls) = new_sink();
    assert!((rig.attach)("pane-1", sink).is_some());
    rig.stream.prompt("hi");
    assert!(calls.events.load(Ordering::SeqCst) > 0);
    fire_waiting(&rig.waiting, true);
    assert_eq!(*calls.waiting.lock().unwrap(), [true]);
    fire_end(&rig.ends, "other-pane");
    assert_eq!(calls.ended.load(Ordering::SeqCst), 0);
    fire_end(&rig.ends, "pane-1");
    assert_eq!(calls.ended.load(Ordering::SeqCst), 1);
}

#[test]
fn detach_only_stops_listening_the_stream_and_the_session_stay() {
    let rig = rig();
    let (sink, calls) = new_sink();
    let handle = (rig.attach)("pane-1", sink);
    handle.unwrap().detach();
    assert!(rig.waiting.lock().unwrap().is_empty());
    assert!(rig.ends.lock().unwrap().is_empty());
    assert!(rig.stream.listeners.lock().unwrap().is_empty());
    rig.stream.prompt("after detach");
    assert_eq!(calls.events.load(Ordering::SeqCst), 0);
    assert_eq!(rig.stream.stored.lock().unwrap().len(), 1);
    assert!(rig.prompted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn prompts_the_session_and_answers_null_for_a_pane_with_no_session() {
    let rig = rig();
    let (sink, _calls) = new_sink();
    assert!((rig.attach)("pane-9", sink).is_none());
    let (sink, _calls) = new_sink();
    let handle = (rig.attach)("pane-1", sink).unwrap();
    assert_eq!(handle.prompt("go").await, json!({"ok": true}));
    assert_eq!(*rig.prompted.lock().unwrap(), ["go"]);
}
