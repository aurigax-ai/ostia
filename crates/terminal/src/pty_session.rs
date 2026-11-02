use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::pty_ring_buffer::{PtyRingBuffer, RingSlice};

const DEFAULT_CAP_BYTES: usize = 1_000_000;

type SendFn = Box<dyn Fn(&str, usize) + Send + Sync>;
type Hook = Box<dyn Fn() + Send + Sync>;
type CoverFn = Box<dyn Fn(bool) + Send + Sync>;
type ExitFn = Box<dyn Fn(i32) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubscriberRole {
    Owner,
    Observer,
}

pub struct Subscriber {
    id: String,
    role: SubscriberRole,
    send: SendFn,
    flush: Option<Hook>,
    cover: Option<CoverFn>,
    close: Option<Hook>,
}

impl Subscriber {
    pub fn new(
        id: &str,
        role: SubscriberRole,
        send: impl Fn(&str, usize) + Send + Sync + 'static,
    ) -> Self {
        Self {
            id: id.to_owned(),
            role,
            send: Box::new(send),
            flush: None,
            cover: None,
            close: None,
        }
    }

    pub fn with_flush(mut self, flush: impl Fn() + Send + Sync + 'static) -> Self {
        self.flush = Some(Box::new(flush));
        self
    }

    pub fn with_cover(mut self, cover: impl Fn(bool) + Send + Sync + 'static) -> Self {
        self.cover = Some(Box::new(cover));
        self
    }

    pub fn with_close(mut self, close: impl Fn() + Send + Sync + 'static) -> Self {
        self.close = Some(Box::new(close));
        self
    }

    fn close(&self) {
        if let Some(close) = &self.close {
            close();
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CursorIssuer {
    issued: Arc<AtomicUsize>,
}

impl CursorIssuer {
    fn current(&self) -> usize {
        self.issued.load(Ordering::SeqCst)
    }

    fn raise(&self, cursor: usize) {
        self.issued.fetch_max(cursor, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct PtySessionOptions {
    cap_bytes: Option<usize>,
    on_no_owners: Option<Hook>,
    on_exit: Option<ExitFn>,
}

impl PtySessionOptions {
    pub fn cap_bytes(mut self, cap_bytes: usize) -> Self {
        self.cap_bytes = Some(cap_bytes);
        self
    }

    pub fn on_no_owners(mut self, on_no_owners: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_no_owners = Some(Box::new(on_no_owners));
        self
    }

    pub fn on_exit(mut self, on_exit: impl Fn(i32) + Send + Sync + 'static) -> Self {
        self.on_exit = Some(Box::new(on_exit));
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attached {
    pub cursor: usize,
    pub dropped: bool,
}

pub struct PtySession {
    ring: PtyRingBuffer,
    issuer: CursorIssuer,
    subs: Vec<Subscriber>,
    on_no_owners: Option<Hook>,
    on_exit: Option<ExitFn>,
}

impl PtySession {
    pub fn new(issuer: CursorIssuer, options: PtySessionOptions) -> Self {
        let cap = options.cap_bytes.unwrap_or(DEFAULT_CAP_BYTES);
        Self {
            ring: PtyRingBuffer::with_base(cap, issuer.current()),
            issuer,
            subs: Vec::new(),
            on_no_owners: options.on_no_owners,
            on_exit: options.on_exit,
        }
    }

    pub fn push(&mut self, data: &str) {
        self.ring.push(data);
        let cursor = self.ring.end();
        self.issuer.raise(cursor);
        for sub in &self.subs {
            (sub.send)(data, cursor);
        }
    }

    pub fn exit(&self, code: i32) {
        for sub in &self.subs {
            if let Some(flush) = &sub.flush {
                flush();
            }
        }
        if let Some(on_exit) = &self.on_exit {
            on_exit(code);
        }
    }

    pub fn add_subscriber(&mut self, sub: Subscriber, since_cursor: usize) -> Attached {
        let index = self.replace(sub);
        let slice = self.ring.since(since_cursor);
        if !slice.data.is_empty() {
            (self.subs[index].send)(&slice.data, slice.cursor);
        }
        Attached {
            cursor: slice.cursor,
            dropped: slice.dropped,
        }
    }

    pub fn since(&self, since_cursor: usize) -> RingSlice {
        self.ring.since(since_cursor)
    }

    pub fn cover(&self, id: &str, covered: bool) {
        if let Some(cover) = self
            .subs
            .iter()
            .find(|sub| sub.id == id)
            .and_then(|sub| sub.cover.as_ref())
        {
            cover(covered);
        }
    }

    pub fn add_live_subscriber(&mut self, sub: Subscriber) {
        self.replace(sub);
    }

    fn replace(&mut self, sub: Subscriber) -> usize {
        match self.subs.iter().position(|known| known.id == sub.id) {
            Some(index) => {
                let previous = std::mem::replace(&mut self.subs[index], sub);
                previous.close();
                index
            }
            None => {
                self.subs.push(sub);
                self.subs.len() - 1
            }
        }
    }

    pub fn remove_subscriber(&mut self, id: &str) {
        let Some(index) = self.subs.iter().position(|sub| sub.id == id) else {
            return;
        };
        let sub = self.subs.remove(index);
        sub.close();
        if sub.role == SubscriberRole::Owner
            && self.owner_count() == 0
            && let Some(on_no_owners) = &self.on_no_owners
        {
            on_no_owners();
        }
    }

    pub fn cursor(&self) -> usize {
        self.ring.end()
    }

    pub fn owner_count(&self) -> usize {
        self.subs
            .iter()
            .filter(|sub| sub.role == SubscriberRole::Owner)
            .count()
    }

    pub fn can_write(&self, id: &str) -> bool {
        self.subs
            .iter()
            .any(|sub| sub.id == id && sub.role == SubscriberRole::Owner)
    }
}
