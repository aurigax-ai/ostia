use std::collections::HashMap;
use std::future::{Future, IntoFuture};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use ostia_base::js::utf16_len;
use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use crate::pane_history::PaneHistory;
use crate::pty_flow::FlowMarks;
use crate::spill_host::{BlockEnd, SpillEvent, SpillHostPort, SpillRequest, serve_spill};

pub const SPILL_BACKLOG: FlowMarks = FlowMarks {
    high: 12 * 1024 * 1024,
    low: 9 * 1024 * 1024,
};
pub const SPILL_PAUSE: FlowMarks = FlowMarks {
    high: 3 * 1024 * 1024,
    low: 2 * 1024 * 1024,
};
const SPILL_QUIET: Duration = Duration::from_millis(100);
pub const PANE_SEND_CHARS: usize = 1024 * 1024;
pub const SLICE_CHARS: usize = 256 * 1024;

pub trait SpillPort: Send + Sync {
    fn post_message(&self, request: SpillRequest) -> Result<(), String>;
    fn on_message(&self, listener: Arc<dyn Fn(SpillEvent) + Send + Sync>);
}

pub trait SpillPressure: Send + Sync {
    fn can_pause(&self) -> bool;
    fn hold(&self, chars: usize);
    fn release(&self, chars: usize);
    fn close(&self);
}

type ScreenText = Arc<dyn Fn() -> String + Send + Sync>;
type CloseHook = Arc<dyn Fn(&Closing) + Send + Sync>;

#[derive(Clone)]
pub struct Closing {
    receiver: watch::Receiver<bool>,
}

impl Closing {
    pub async fn wait(self) {
        let mut receiver = self.receiver;
        let _ = receiver.wait_for(|closed| *closed).await;
    }
}

impl IntoFuture for Closing {
    type Output = ();
    type IntoFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

    fn into_future(self) -> Self::IntoFuture {
        Box::pin(self.wait())
    }
}

#[derive(Default)]
struct Reply {
    tail: Option<Vec<String>>,
    pending_end: Option<Option<BlockEnd>>,
}

struct Session {
    history: PaneHistory,
    pressure: Option<Arc<dyn SpillPressure>>,
    unsent: Vec<String>,
    unsent_chars: usize,
    in_flight: usize,
    dropping: bool,
    screen: ScreenText,
    closing: Option<watch::Sender<bool>>,
}

struct Sending {
    generation: u64,
    deadline: Instant,
}

#[derive(Default)]
struct State {
    sessions: HashMap<u64, Session>,
    replies: HashMap<u64, oneshot::Sender<Option<Reply>>>,
    sending: Option<Sending>,
    next_session: u64,
    next_reply: u64,
    timer_generation: u64,
    ended: bool,
}

enum Effect {
    Hold(Arc<dyn SpillPressure>, usize),
    Release(Arc<dyn SpillPressure>, usize),
    ClosePressure(Arc<dyn SpillPressure>),
    Fail(PaneHistory, String),
    Settle(watch::Sender<bool>),
}

fn run(effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Hold(pressure, chars) => pressure.hold(chars),
            Effect::Release(pressure, chars) => pressure.release(chars),
            Effect::ClosePressure(pressure) => pressure.close(),
            Effect::Fail(history, reason) => history.fail(&reason),
            Effect::Settle(closing) => {
                closing.send_replace(true);
            }
        }
    }
}

struct ClientInner {
    self_ref: Weak<ClientInner>,
    port: Arc<dyn SpillPort>,
    state: Mutex<State>,
    runtime: Option<Handle>,
}

#[derive(Clone)]
pub struct SpillClient {
    inner: Arc<ClientInner>,
}

impl ClientInner {
    fn deliver(&self, state: &mut State, request: SpillRequest, effects: &mut Vec<Effect>) {
        if state.ended {
            return;
        }
        if let Err(reason) = self.port.post_message(request) {
            self.end_locked(state, &reason, effects);
        }
    }

    fn post(&self, state: &mut State, request: SpillRequest, effects: &mut Vec<Effect>) {
        if state.sending.is_some() {
            self.send_all(state, effects);
        }
        self.deliver(state, request, effects);
    }

    fn send_all(&self, state: &mut State, effects: &mut Vec<Effect>) {
        state.sending = None;
        let mut ids: Vec<u64> = state.sessions.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            self.send_session(state, id, effects);
        }
    }

    fn send_session(&self, state: &mut State, id: u64, effects: &mut Vec<Effect>) {
        let parts = match state.sessions.get_mut(&id) {
            Some(session) if !session.unsent.is_empty() => {
                session.unsent_chars = 0;
                std::mem::take(&mut session.unsent)
            }
            _ => return,
        };
        let mut slices: Vec<(String, usize)> = Vec::new();
        let mut slice = String::new();
        let mut chars = 0usize;
        for part in parts {
            let length = utf16_len(&part);
            if chars > 0 && chars + length > SLICE_CHARS {
                slices.push((std::mem::take(&mut slice), chars));
                chars = 0;
            }
            slice.push_str(&part);
            chars += length;
        }
        if chars > 0 {
            slices.push((slice, chars));
        }
        for (text, chars) in slices {
            if let Some(session) = state.sessions.get_mut(&id) {
                session.in_flight += chars;
            }
            self.deliver(
                state,
                SpillRequest::Write {
                    session: id,
                    data: text.into_bytes(),
                    chars,
                },
                effects,
            );
        }
    }

    fn settle(&self, state: &mut State, id: u64, effects: &mut Vec<Effect>) {
        if let Some(mut session) = state.sessions.remove(&id) {
            if let Some(pressure) = session.pressure.take() {
                effects.push(Effect::ClosePressure(pressure));
            }
            session.unsent.clear();
            if let Some(closing) = session.closing.take() {
                effects.push(Effect::Settle(closing));
            }
        }
    }

    fn end_locked(&self, state: &mut State, reason: &str, effects: &mut Vec<Effect>) {
        if state.ended {
            return;
        }
        state.ended = true;
        state.sending = None;
        let mut ids: Vec<u64> = state.sessions.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            if let Some(session) = state.sessions.get(&id) {
                effects.push(Effect::Fail(session.history.clone(), reason.to_string()));
            }
            self.settle(state, id, effects);
        }
        state.replies.clear();
    }

    fn queue(&self, id: u64, data: &str) {
        let mut effects = Vec::new();
        {
            let mut state = self.state.lock();
            if state.ended || data.is_empty() {
                return;
            }
            let chars = utf16_len(data);
            let high = usize::try_from(SPILL_BACKLOG.high).unwrap_or(usize::MAX);
            let Some(session) = state.sessions.get_mut(&id) else {
                return;
            };
            if session.dropping {
                return;
            }
            let can_pause = session
                .pressure
                .as_ref()
                .is_some_and(|pressure| pressure.can_pause());
            if !can_pause && session.unsent_chars + session.in_flight + chars > high {
                session.dropping = true;
                return;
            }
            session.unsent.push(data.to_string());
            session.unsent_chars += chars;
            if let Some(pressure) = &session.pressure {
                effects.push(Effect::Hold(pressure.clone(), chars));
            }
            if session.unsent_chars >= PANE_SEND_CHARS {
                self.send_session(&mut state, id, &mut effects);
            } else if let Some(sending) = state.sending.as_mut() {
                sending.deadline = Instant::now() + SPILL_QUIET;
            } else if self.runtime.is_some() {
                self.arm_timer(&mut state);
            } else {
                self.send_all(&mut state, &mut effects);
            }
        }
        run(effects);
    }

    fn arm_timer(&self, state: &mut State) {
        let Some(runtime) = &self.runtime else {
            return;
        };
        state.timer_generation += 1;
        let generation = state.timer_generation;
        state.sending = Some(Sending {
            generation,
            deadline: Instant::now() + SPILL_QUIET,
        });
        let weak = self.weak();
        runtime.spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let deadline = {
                    let state = inner.state.lock();
                    match &state.sending {
                        Some(sending) if sending.generation == generation => sending.deadline,
                        _ => return,
                    }
                };
                drop(inner);
                tokio::time::sleep_until(deadline).await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let mut effects = Vec::new();
                let fire = {
                    let mut state = inner.state.lock();
                    match &state.sending {
                        Some(sending) if sending.generation == generation => {
                            if sending.deadline <= Instant::now() {
                                inner.send_all(&mut state, &mut effects);
                                true
                            } else {
                                false
                            }
                        }
                        _ => return,
                    }
                };
                run(effects);
                if fire {
                    return;
                }
            }
        });
    }

    fn weak(&self) -> Weak<ClientInner> {
        self.self_ref.clone()
    }

    fn ask(&self, build: impl FnOnce(u64) -> SpillRequest) -> oneshot::Receiver<Option<Reply>> {
        let (reply, receiver) = oneshot::channel();
        let mut effects = Vec::new();
        {
            let mut state = self.state.lock();
            if state.ended {
                let _ = reply.send(None);
                return receiver;
            }
            let id = state.next_reply;
            state.next_reply += 1;
            state.replies.insert(id, reply);
            self.post(&mut state, build(id), &mut effects);
        }
        run(effects);
        receiver
    }

    fn receive(&self, event: SpillEvent) {
        match event {
            SpillEvent::Reply {
                id,
                tail,
                pending_end,
            } => {
                let settle = self.state.lock().replies.remove(&id);
                if let Some(settle) = settle {
                    let _ = settle.send(Some(Reply { tail, pending_end }));
                }
            }
            SpillEvent::Append {
                session,
                text,
                count,
            } => {
                if let Some(history) = self.history_of(session) {
                    history.append(&text, count);
                }
            }
            SpillEvent::BlockStarted {
                session,
                seq,
                start,
                command,
            } => {
                if let Some(history) = self.history_of(session) {
                    history.block_started(seq, start, command.as_deref());
                }
            }
            SpillEvent::BlockEnded {
                session,
                seq,
                end,
                end_col,
                exit_code,
                command,
            } => {
                if let Some(history) = self.history_of(session) {
                    history.block_ended(seq, end, end_col, exit_code, command.as_deref());
                }
            }
            SpillEvent::Wipe { session } => {
                if let Some(history) = self.history_of(session) {
                    history.wipe();
                }
            }
            SpillEvent::Flush { session } => {
                if let Some(history) = self.history_of(session) {
                    drop(history.flush());
                }
            }
            SpillEvent::Parsed { session, chars } => self.parsed(session, chars),
            SpillEvent::Closed { session, seq_end } => {
                let history = self.history_of(session);
                if let Some(history) = history {
                    history.set_seq_offset(seq_end);
                    let mut effects = Vec::new();
                    {
                        let mut state = self.state.lock();
                        self.settle(&mut state, session, &mut effects);
                    }
                    run(effects);
                }
            }
        }
    }

    fn history_of(&self, session: u64) -> Option<PaneHistory> {
        self.state
            .lock()
            .sessions
            .get(&session)
            .map(|found| found.history.clone())
    }

    fn parsed(&self, id: u64, chars: usize) {
        let mut effects = Vec::new();
        {
            let mut state = self.state.lock();
            let Some(session) = state.sessions.get_mut(&id) else {
                return;
            };
            session.in_flight = session.in_flight.saturating_sub(chars);
            if let Some(pressure) = &session.pressure {
                effects.push(Effect::Release(pressure.clone(), chars));
            }
            let low = usize::try_from(SPILL_BACKLOG.low).unwrap_or(usize::MAX);
            if session.dropping && session.unsent_chars + session.in_flight <= low {
                session.dropping = false;
                let screen = (session.screen)();
                self.post(
                    &mut state,
                    SpillRequest::Resync {
                        session: id,
                        screen,
                    },
                    &mut effects,
                );
            }
        }
        run(effects);
    }
}

impl SpillClient {
    pub fn new(port: Arc<dyn SpillPort>) -> Self {
        let inner = Arc::new_cyclic(|weak| ClientInner {
            self_ref: weak.clone(),
            port: port.clone(),
            state: Mutex::new(State::default()),
            runtime: Handle::try_current().ok(),
        });
        let weak = Arc::downgrade(&inner);
        port.on_message(Arc::new(move |event| {
            if let Some(inner) = weak.upgrade() {
                inner.receive(event);
            }
        }));
        Self { inner }
    }

    pub fn spawn() -> io::Result<Self> {
        let link = Arc::new(Link::default());
        serve_spill(Arc::new(HostSide(Arc::downgrade(&link))))?;
        Ok(Self::new(Arc::new(ClientSide(link))))
    }

    pub fn alive(&self) -> bool {
        !self.inner.state.lock().ended
    }

    pub fn open(
        &self,
        history: &PaneHistory,
        cols: u16,
        rows: u16,
        pressure: Option<Arc<dyn SpillPressure>>,
    ) -> HistoryFeed {
        let seq_base = history.seq_offset();
        let continues = history.end() > history.first();
        let mut effects = Vec::new();
        let id = {
            let mut state = self.inner.state.lock();
            let id = state.next_session;
            state.next_session += 1;
            state.sessions.insert(
                id,
                Session {
                    history: history.clone(),
                    pressure,
                    unsent: Vec::new(),
                    unsent_chars: 0,
                    in_flight: 0,
                    dropping: false,
                    screen: Arc::new(String::new),
                    closing: None,
                },
            );
            self.inner.post(
                &mut state,
                SpillRequest::Open {
                    session: id,
                    cols,
                    rows,
                    end: history.end(),
                    seq_offset: seq_base,
                },
                &mut effects,
            );
            id
        };
        run(effects);
        HistoryFeed {
            client: self.clone(),
            id,
            seq_base,
            continues,
            closed: Arc::new(Mutex::new(None)),
            on_close: None,
        }
    }

    pub fn end(&self, reason: &str) {
        let mut effects = Vec::new();
        {
            let mut state = self.inner.state.lock();
            self.inner.end_locked(&mut state, reason, &mut effects);
        }
        run(effects);
    }

    fn post(&self, request: SpillRequest) {
        let mut effects = Vec::new();
        {
            let mut state = self.inner.state.lock();
            self.inner.post(&mut state, request, &mut effects);
        }
        run(effects);
    }
}

#[derive(Clone)]
pub struct HistoryFeed {
    client: SpillClient,
    id: u64,
    seq_base: u64,
    continues: bool,
    closed: Arc<Mutex<Option<Closing>>>,
    on_close: Option<CloseHook>,
}

impl HistoryFeed {
    pub fn seq_base(&self) -> u64 {
        self.seq_base
    }

    pub fn continues(&self) -> bool {
        self.continues
    }

    pub fn with_close_hook(mut self, hook: CloseHook) -> Self {
        self.on_close = Some(hook);
        self
    }

    pub fn write(&self, data: &str) {
        self.client.inner.queue(self.id, data);
    }

    pub fn restore(&self, text: &str) {
        self.client.post(SpillRequest::Restore {
            session: self.id,
            history: text.to_string(),
            hold: self.continues,
        });
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.client.post(SpillRequest::Resize {
            session: self.id,
            cols,
            rows,
        });
    }

    pub fn watch_screen(&self, screen: ScreenText) {
        if let Some(session) = self.client.inner.state.lock().sessions.get_mut(&self.id) {
            session.screen = screen;
        }
    }

    pub fn tail(&self) -> impl Future<Output = Vec<String>> + Send + use<> {
        let session = self.id;
        let reply = self
            .client
            .inner
            .ask(move |id| SpillRequest::Tail { session, id });
        async move {
            reply
                .await
                .ok()
                .flatten()
                .and_then(|reply| reply.tail)
                .unwrap_or_default()
        }
    }

    pub fn pending_end(&self, seq: u64) -> impl Future<Output = Option<BlockEnd>> + Send + use<> {
        let session = self.id;
        let reply = self
            .client
            .inner
            .ask(move |id| SpillRequest::PendingEnd { session, seq, id });
        async move {
            reply
                .await
                .ok()
                .flatten()
                .and_then(|reply| reply.pending_end)
                .flatten()
        }
    }

    pub fn close(&self) -> Closing {
        let closing = {
            let mut memo = self.closed.lock();
            if let Some(closing) = memo.as_ref() {
                return closing.clone();
            }
            let (sender, receiver) = watch::channel(false);
            let closing = Closing { receiver };
            *memo = Some(closing.clone());
            let mut effects = Vec::new();
            {
                let mut state = self.client.inner.state.lock();
                match state.sessions.get_mut(&self.id) {
                    Some(session) => {
                        session.closing = Some(sender);
                        if state.ended {
                            self.client.inner.settle(&mut state, self.id, &mut effects);
                        } else {
                            self.client.inner.post(
                                &mut state,
                                SpillRequest::Close { session: self.id },
                                &mut effects,
                            );
                        }
                    }
                    None => {
                        sender.send_replace(true);
                    }
                }
            }
            run(effects);
            closing
        };
        if let Some(hook) = &self.on_close {
            hook(&closing);
        }
        closing
    }
}

#[derive(Default)]
struct Link {
    to_host: Mutex<Option<Arc<dyn Fn(SpillRequest) + Send + Sync>>>,
    to_client: Mutex<Option<Arc<dyn Fn(SpillEvent) + Send + Sync>>>,
}

struct HostSide(Weak<Link>);

impl SpillHostPort for HostSide {
    fn post_message(&self, event: SpillEvent) {
        let Some(link) = self.0.upgrade() else {
            return;
        };
        let listener = link.to_client.lock().clone();
        if let Some(listener) = listener {
            listener(event);
        }
    }

    fn on_message(&self, listener: Arc<dyn Fn(SpillRequest) + Send + Sync>) {
        if let Some(link) = self.0.upgrade() {
            *link.to_host.lock() = Some(listener);
        }
    }
}

struct ClientSide(Arc<Link>);

impl SpillPort for ClientSide {
    fn post_message(&self, request: SpillRequest) -> Result<(), String> {
        let listener = self.0.to_host.lock().clone();
        match listener {
            Some(listener) => {
                listener(request);
                Ok(())
            }
            None => Err("spill-worker-missing".to_string()),
        }
    }

    fn on_message(&self, listener: Arc<dyn Fn(SpillEvent) + Send + Sync>) {
        *self.0.to_client.lock() = Some(listener);
    }
}
