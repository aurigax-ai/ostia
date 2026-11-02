use std::collections::HashMap;
use std::sync::Arc;

use ostia_base::clock::Clock;
use parking_lot::Mutex;

use crate::mail_delivery::{EVENT_BATCH_MS, MAIL_TURNS_MAX, MAIL_TURNS_WINDOW_MS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MailerState {
    pub draft: bool,
}

#[derive(Default)]
struct Books {
    ready: HashMap<String, MailerState>,
    turns: HashMap<String, Vec<i64>>,
    events_taken_at: HashMap<String, i64>,
}

fn recent<'a>(books: &'a mut Books, now: i64, external_id: &str) -> &'a mut Vec<i64> {
    let since = now - MAIL_TURNS_WINDOW_MS;
    let turns = books.turns.entry(external_id.to_owned()).or_default();
    turns.retain(|at| *at > since);
    turns
}

#[derive(Clone)]
pub struct Mailers {
    now: Clock,
    books: Arc<Mutex<Books>>,
}

impl Mailers {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            books: Arc::new(Mutex::new(Books::default())),
        }
    }

    pub fn set(&self, external_id: &str, draft: bool) {
        self.books
            .lock()
            .ready
            .insert(external_id.to_owned(), MailerState { draft });
    }

    pub fn state(&self, external_id: &str) -> Option<MailerState> {
        self.books.lock().ready.get(external_id).copied()
    }

    pub fn clear(&self, external_id: &str) {
        let mut books = self.books.lock();
        books.ready.remove(external_id);
        books.turns.remove(external_id);
        books.events_taken_at.remove(external_id);
    }

    pub fn limited(&self, external_id: &str) -> bool {
        let now = (self.now)();
        let mut books = self.books.lock();
        recent(&mut books, now, external_id).len() >= MAIL_TURNS_MAX
    }

    pub fn limited_ms(&self, external_id: &str) -> i64 {
        let now = (self.now)();
        let mut books = self.books.lock();
        let turns = recent(&mut books, now, external_id);
        if turns.len() < MAIL_TURNS_MAX {
            return 0;
        }
        turns
            .first()
            .map_or(0, |oldest| (oldest + MAIL_TURNS_WINDOW_MS - now).max(1))
    }

    pub fn record_turn(&self, external_id: &str) {
        let now = (self.now)();
        let mut books = self.books.lock();
        recent(&mut books, now, external_id).push(now);
    }

    pub fn unrecord_turn(&self, external_id: &str) {
        let now = (self.now)();
        let mut books = self.books.lock();
        recent(&mut books, now, external_id).pop();
    }

    pub fn events_wait_ms(&self, external_id: &str) -> i64 {
        let now = (self.now)();
        let books = self.books.lock();
        books
            .events_taken_at
            .get(external_id)
            .map_or(0, |at| (at + EVENT_BATCH_MS - now).max(0))
    }

    pub fn mark_events(&self, external_id: &str) {
        let now = (self.now)();
        self.books
            .lock()
            .events_taken_at
            .insert(external_id.to_owned(), now);
    }
}
