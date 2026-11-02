#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::mpsc::channel;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use history_support::{HistoryOptions, make_history};
use ostia_terminal::history_feed::{HistoryFeed, SpillClient, SpillPort, SpillPressure};
use ostia_terminal::spill_host::{SpillEvent, SpillRequest};
use parking_lot::Mutex;

type EventListener = Arc<dyn Fn(SpillEvent) + Send + Sync>;

#[derive(Default)]
struct FakePort {
    posted: Mutex<Vec<SpillRequest>>,
    listener: Mutex<Option<EventListener>>,
}

impl SpillPort for FakePort {
    fn post_message(&self, request: SpillRequest) -> Result<(), String> {
        self.posted.lock().push(request);
        Ok(())
    }

    fn on_message(&self, listener: EventListener) {
        *self.listener.lock() = Some(listener);
    }
}

struct CannotPause;

impl SpillPressure for CannotPause {
    fn can_pause(&self) -> bool {
        false
    }

    fn hold(&self, _chars: usize) {}

    fn release(&self, _chars: usize) {}

    fn close(&self) {}
}

#[tokio::test]
async fn reads_the_screen_for_a_resync_without_holding_the_client_lock_and_keeps_output_that_arrives_meanwhile()
 {
    let port = Arc::new(FakePort::default());
    let client = SpillClient::new(port.clone());
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, 80, 24, Some(Arc::new(CannotPause)));
    let slot: Arc<OnceLock<HistoryFeed>> = Arc::new(OnceLock::new());
    let inner = slot.clone();
    feed.watch_screen(Arc::new(move || {
        if let Some(feed) = inner.get() {
            feed.write("during");
        }
        "screen now".to_string()
    }));
    slot.set(feed.clone()).ok().unwrap();
    for _ in 0..800 {
        feed.write(&"z".repeat(64 * 1024));
    }
    feed.resize(81, 24);
    let writes: Vec<(u64, usize)> = port
        .posted
        .lock()
        .iter()
        .filter_map(|request| match request {
            SpillRequest::Write { session, chars, .. } => Some((*session, *chars)),
            _ => None,
        })
        .collect();
    let listener = port.listener.lock().clone().unwrap();
    let (done, finished) = channel();
    std::thread::spawn(move || {
        for (session, chars) in writes {
            listener(SpillEvent::Parsed { session, chars });
        }
        done.send(()).unwrap();
    });
    finished.recv_timeout(Duration::from_secs(10)).unwrap();
    feed.resize(82, 24);
    let posted = port.posted.lock().clone();
    let resync = posted
        .iter()
        .position(|request| matches!(request, SpillRequest::Resync { .. }))
        .unwrap();
    let during = posted
        .iter()
        .position(|request| match request {
            SpillRequest::Write { data, .. } => data.as_slice() == b"during",
            _ => false,
        })
        .unwrap();
    assert!(resync < during);
    client.end("test-done");
}
