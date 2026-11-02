use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use ostia_base::clock::Clock;
use ostia_base::events::EventHub;
use ostia_base::js::non_empty;
use ostia_contract::closing_line::{STATUS_MESSAGE_MAX, closing_line};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

pub const JOURNAL_EVENTS_MAX: usize = 20;
pub const JOURNAL_CURSORS_MAX: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JournalEvent {
    State {
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<String>,
    },
    Command {
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    Closing,
    Mail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StampedEvent {
    #[serde(flatten)]
    pub event: JournalEvent,
    pub at: i64,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JournalChange {
    Attention { state: Option<String> },
    State,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Changes {
    First,
    Since(Vec<StampedEvent>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalState {
    pub running: bool,
    pub last_exit_code: Option<i64>,
}

pub type TerminalLookup = Arc<dyn Fn(&str) -> Option<TerminalState> + Send + Sync>;

#[derive(Clone)]
pub struct JournalDeps {
    pub terminal: TerminalLookup,
    pub now: Clock,
}

#[derive(Default)]
struct PaneRecord {
    ring: VecDeque<StampedEvent>,
    state: Option<String>,
    state_at: Option<i64>,
    changed_at: Option<i64>,
    running: Option<bool>,
    explicit: Option<String>,
    stop: Option<String>,
}

#[derive(Default)]
struct Book {
    panes: HashMap<String, PaneRecord>,
    cursors: VecDeque<(String, u64)>,
    seq: u64,
}

impl Book {
    fn record(&mut self, pane_id: &str) -> &mut PaneRecord {
        self.panes.entry(pane_id.to_owned()).or_default()
    }

    fn forget(&mut self, pane_id: &str, external_id: Option<&str>) {
        self.panes.remove(pane_id);
        let ends = format!(">{pane_id}");
        let starts = non_empty(external_id).map(|external| format!("{external}>"));
        self.cursors.retain(|(key, _)| {
            !(key.ends_with(&ends)
                || starts
                    .as_deref()
                    .is_some_and(|start| key.starts_with(start)))
        });
    }
}

#[derive(Clone)]
pub struct PaneJournal {
    book: Arc<Mutex<Book>>,
    heard: EventHub<(String, StampedEvent)>,
    deps: JournalDeps,
}

fn utf16_cut(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    String::from_utf16_lossy(&units[..max])
}

impl PaneJournal {
    pub fn new(deps: JournalDeps) -> Self {
        Self {
            book: Arc::default(),
            heard: EventHub::default(),
            deps,
        }
    }

    pub fn subscribe(&self) -> UnboundedReceiver<(String, StampedEvent)> {
        self.heard.subscribe()
    }

    fn push(&self, book: &mut Book, pane_id: &str, event: JournalEvent) {
        book.seq += 1;
        let stamped = StampedEvent {
            event,
            at: (self.deps.now)(),
            seq: book.seq,
        };
        let record = book.record(pane_id);
        record.ring.push_back(stamped.clone());
        if record.ring.len() > JOURNAL_EVENTS_MAX {
            record.ring.pop_front();
        }
        self.heard.emit((pane_id.to_owned(), stamped));
    }

    pub fn on_change(&self, pane_id: &str, change: JournalChange) {
        match change {
            JournalChange::Closed => self.forget(pane_id, None),
            JournalChange::Attention { state } => self.on_attention(pane_id, state),
            JournalChange::State => self.on_terminal(pane_id),
        }
    }

    fn on_attention(&self, pane_id: &str, state: Option<String>) {
        let state = state.unwrap_or_else(|| "idle".to_owned());
        let mut book = self.book.lock();
        let now = (self.deps.now)();
        let record = book.record(pane_id);
        if record.state.as_deref() == Some(state.as_str()) {
            return;
        }
        let from = record.state.replace(state.clone());
        record.state_at = Some(now);
        record.changed_at = Some(now);
        if state == "working" {
            record.explicit = None;
            record.stop = None;
        }
        let from = non_empty(from.as_deref()).map(str::to_owned);
        self.push(&mut book, pane_id, JournalEvent::State { state, from });
    }

    fn on_terminal(&self, pane_id: &str) {
        let terminal = (self.deps.terminal)(pane_id);
        let mut book = self.book.lock();
        let was_running = book.record(pane_id).running == Some(true);
        let Some(terminal) = terminal else {
            return;
        };
        if was_running && !terminal.running {
            self.push(
                &mut book,
                pane_id,
                JournalEvent::Command {
                    exit_code: terminal.last_exit_code,
                },
            );
        }
        let now = (self.deps.now)();
        let record = book.record(pane_id);
        if record.running != Some(terminal.running) {
            record.changed_at = Some(now);
        }
        record.running = Some(terminal.running);
    }

    pub fn lifecycle(&self, pane_id: &str) {
        let now = (self.deps.now)();
        self.book.lock().record(pane_id).changed_at = Some(now);
    }

    pub fn since(&self, pane_id: &str) -> Option<i64> {
        self.book.lock().panes.get(pane_id)?.changed_at
    }

    pub fn report(&self, pane_id: &str, state: &str, message: Option<&str>, stop: Option<&str>) {
        if state != "done" {
            return;
        }
        let mut book = self.book.lock();
        let explicit = message.and_then(closing_line);
        let stop = non_empty(stop);
        let record = book.record(pane_id);
        if let Some(line) = &explicit {
            record.explicit = Some(line.clone());
        }
        if let Some(stop) = stop {
            record.stop = Some(utf16_cut(stop, STATUS_MESSAGE_MAX));
        }
        if explicit.is_some() || stop.is_some() {
            self.push(&mut book, pane_id, JournalEvent::Closing);
        }
    }

    pub fn mail(&self, pane_id: &str) {
        let mut book = self.book.lock();
        self.push(&mut book, pane_id, JournalEvent::Mail);
    }

    pub fn closing(&self, pane_id: &str) -> Option<String> {
        let book = self.book.lock();
        let record = book.panes.get(pane_id)?;
        record.explicit.clone().or_else(|| record.stop.clone())
    }

    pub fn state_of(&self, pane_id: &str) -> Option<String> {
        self.book.lock().panes.get(pane_id)?.state.clone()
    }

    pub fn state_since(&self, pane_id: &str) -> Option<i64> {
        self.book.lock().panes.get(pane_id)?.state_at
    }

    pub fn changes(&self, caller: &str, pane_id: &str) -> Changes {
        let key = format!("{caller}>{pane_id}");
        let mut book = self.book.lock();
        let seen = book
            .cursors
            .iter()
            .position(|(held, _)| *held == key)
            .and_then(|at| book.cursors.remove(at))
            .map(|(_, seq)| seq);
        let seq = book.seq;
        book.cursors.push_back((key, seq));
        if book.cursors.len() > JOURNAL_CURSORS_MAX {
            book.cursors.pop_front();
        }
        let Some(seen) = seen else {
            return Changes::First;
        };
        let events = book.panes.get(pane_id).map_or_else(Vec::new, |record| {
            record
                .ring
                .iter()
                .filter(|event| event.seq > seen)
                .cloned()
                .collect()
        });
        Changes::Since(events)
    }

    pub fn forget(&self, pane_id: &str, external_id: Option<&str>) {
        self.book.lock().forget(pane_id, external_id);
    }
}
