#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use history_support::{mark, numbered};
use ostia_terminal::spill_host::{
    BlockEnd, HostedTerminal, OpenTerminal, SpillEvent, SpillHostPort, SpillRequest, serve_spill,
    serve_spill_with,
};
use parking_lot::Mutex;

type RequestListener = Arc<dyn Fn(SpillRequest) + Send + Sync>;

struct HostPort {
    events: Mutex<Sender<SpillEvent>>,
    listener: Mutex<Option<RequestListener>>,
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

fn host_serving(serve: impl FnOnce(Arc<HostPort>)) -> Host {
    let (tx, events) = channel();
    let port = Arc::new(HostPort {
        events: Mutex::new(tx),
        listener: Mutex::new(None),
    });
    serve(port.clone());
    Host { port, events }
}

fn host() -> Host {
    host_serving(|port| serve_spill(port).unwrap())
}

fn host_with(open: OpenTerminal) -> Host {
    host_serving(|port| serve_spill_with(port, open).unwrap())
}

struct Panicking;

impl HostedTerminal for Panicking {
    fn write(&mut self, _data: &[u8]) {
        panic!("write failed");
    }

    fn resync(&mut self, _screen: &str) {}

    fn restore(&mut self, _history: &str, _hold: bool) {}

    fn resize(&mut self, _cols: u16, _rows: u16) {}

    fn tail(&self) -> Vec<String> {
        panic!("tail failed");
    }

    fn pending_end(&self, _seq: u64) -> Option<BlockEnd> {
        panic!("pending end failed");
    }

    fn close(&mut self) -> u64 {
        0
    }
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

#[test]
fn fails_the_session_when_its_terminal_cannot_start() {
    let host = host_with(Box::new(|_, _, _, _| Err("no terminal".to_owned())));
    host.send(open(4));
    assert_eq!(
        host.next(),
        SpillEvent::Failed {
            session: 4,
            reason: "no terminal".to_owned()
        }
    );
}

#[test]
fn fails_the_session_and_keeps_serving_when_a_write_panics() {
    let host = host_with(Box::new(|_, _, _, _| Ok(Box::new(Panicking))));
    host.send(open(1));
    host.send(SpillRequest::Write {
        session: 1,
        data: b"x".to_vec(),
        chars: 1,
    });
    assert_eq!(
        host.next(),
        SpillEvent::Failed {
            session: 1,
            reason: "spill terminal panicked".to_owned()
        }
    );
    host.send(SpillRequest::Write {
        session: 1,
        data: b"y".to_vec(),
        chars: 1,
    });
    assert_eq!(
        host.next(),
        SpillEvent::Parsed {
            session: 1,
            chars: 1
        }
    );
}

#[test]
fn answers_a_tail_that_panics_with_nothing_after_failing_the_session() {
    let host = host_with(Box::new(|_, _, _, _| Ok(Box::new(Panicking))));
    host.send(open(2));
    host.send(SpillRequest::Tail { session: 2, id: 5 });
    assert!(matches!(host.next(), SpillEvent::Failed { session: 2, .. }));
    assert_eq!(
        host.next(),
        SpillEvent::Reply {
            id: 5,
            tail: Some(Vec::new()),
            pending_end: None
        }
    );
}

#[test]
fn prints_no_terminal_text_in_its_debug_output() {
    let write = SpillRequest::Write {
        session: 1,
        data: b"hunter2".to_vec(),
        chars: 7,
    };
    let append = SpillEvent::Append {
        session: 1,
        text: "hunter2".to_owned(),
        count: 1,
    };
    let reply = SpillEvent::Reply {
        id: 1,
        tail: Some(vec!["hunter2".to_owned()]),
        pending_end: None,
    };
    let started = SpillEvent::BlockStarted {
        session: 1,
        seq: 1,
        start: 0,
        command: Some("hunter2".to_owned()),
    };
    let restore = SpillRequest::Restore {
        session: 1,
        history: "hunter2".to_owned(),
        hold: false,
    };
    for shown in [
        format!("{write:?}"),
        format!("{append:?}"),
        format!("{reply:?}"),
        format!("{started:?}"),
        format!("{restore:?}"),
    ] {
        assert!(!shown.contains("hunter2"), "{shown}");
    }
}
