#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use history_support::{mark, numbered};
use ostia_terminal::spill_host::{SpillEvent, SpillHostPort, SpillRequest, serve_spill};
use parking_lot::Mutex;

struct HostPort {
    events: Mutex<Sender<SpillEvent>>,
    listener: Mutex<Option<Arc<dyn Fn(SpillRequest) + Send + Sync>>>,
}

impl SpillHostPort for HostPort {
    fn post_message(&self, event: SpillEvent) {
        self.events.lock().send(event).unwrap();
    }

    fn on_message(&self, listener: Arc<dyn Fn(SpillRequest) + Send + Sync>) {
        *self.listener.lock() = Some(listener);
    }
}

struct Host {
    port: Arc<HostPort>,
    events: Receiver<SpillEvent>,
}

fn host() -> Host {
    let (tx, events) = channel();
    let port = Arc::new(HostPort {
        events: Mutex::new(tx),
        listener: Mutex::new(None),
    });
    serve_spill(port.clone()).unwrap();
    Host { port, events }
}

impl Host {
    fn send(&self, request: SpillRequest) {
        let listener = self.port.listener.lock().clone().unwrap();
        listener(request);
    }

    fn next(&self) -> SpillEvent {
        self.events.recv_timeout(Duration::from_secs(10)).unwrap()
    }

    fn next_matching(&self, wanted: impl Fn(&SpillEvent) -> bool) -> SpillEvent {
        loop {
            let event = self.next();
            if wanted(&event) {
                return event;
            }
        }
    }
}

fn open(session: u64) -> SpillRequest {
    SpillRequest::Open {
        session,
        cols: 80,
        rows: 24,
        end: 0,
        seq_offset: 0,
    }
}

#[test]
fn answers_a_write_for_a_session_it_does_not_have_as_parsed_at_once() {
    let host = host();
    host.send(SpillRequest::Write {
        session: 9,
        data: b"lost".to_vec(),
        chars: 4,
    });
    assert_eq!(
        host.next(),
        SpillEvent::Parsed {
            session: 9,
            chars: 4
        }
    );
}

#[test]
fn answers_a_close_for_a_session_it_does_not_have_with_end_zero() {
    let host = host();
    host.send(SpillRequest::Close { session: 3 });
    assert_eq!(
        host.next(),
        SpillEvent::Closed {
            session: 3,
            seq_end: 0
        }
    );
}

#[test]
fn answers_tail_and_pending_end_for_a_session_it_does_not_have_with_nothing() {
    let host = host();
    host.send(SpillRequest::Tail { session: 3, id: 11 });
    assert_eq!(
        host.next(),
        SpillEvent::Reply {
            id: 11,
            tail: Some(Vec::new()),
            pending_end: None,
        }
    );
    host.send(SpillRequest::PendingEnd {
        session: 3,
        seq: 1,
        id: 12,
    });
    assert_eq!(
        host.next(),
        SpillEvent::Reply {
            id: 12,
            tail: None,
            pending_end: Some(None),
        }
    );
}

#[test]
fn reports_what_it_parsed_then_the_block_count_when_a_session_closes() {
    let host = host();
    host.send(open(1));
    let data = format!("{}{}{}", mark("C"), numbered(0, 2), mark("D;0"));
    let chars = data.len();
    host.send(SpillRequest::Write {
        session: 1,
        data: data.into_bytes(),
        chars,
    });
    assert_eq!(host.next(), SpillEvent::Parsed { session: 1, chars });
    host.send(SpillRequest::Close { session: 1 });
    let closed = host.next_matching(|event| matches!(event, SpillEvent::Closed { .. }));
    assert_eq!(
        closed,
        SpillEvent::Closed {
            session: 1,
            seq_end: 1
        }
    );
}
