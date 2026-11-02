use std::collections::{BTreeSet, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::watch_sets::WatchSets;

pub type ReadFuture<D> = Pin<Box<dyn Future<Output = Result<D, String>> + Send>>;

pub trait RefreshSource: Send + Sync + 'static {
    type Data: Send + 'static;
    type Items: Serialize + Default + Send + 'static;

    fn enabled(&self) -> bool;
    fn poll_ms(&self) -> u64;
    fn read(&self, watched: &BTreeSet<String>) -> ReadFuture<Self::Data>;
    fn items_for(&self, ids: &BTreeSet<String>, data: &Self::Data) -> Self::Items;

    fn published(&self, _data: &Self::Data) {}

    fn cleared(&self) {}
}

pub struct WatchedRefresherOptions<S: RefreshSource> {
    pub channel: String,
    pub debounce: Duration,
    pub events: HashSet<String>,
    pub send: Arc<dyn Fn(&str, &str, &S::Items) + Send + Sync>,
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

struct State {
    watches: WatchSets,
    timer: Option<JoinHandle<()>>,
    timer_generation: u64,
    poll: Option<JoinHandle<()>>,
    armed_ms: u64,
    focused: bool,
    running: bool,
    again: bool,
    sent: Vec<(String, String)>,
}

struct Inner<S: RefreshSource> {
    source: S,
    options: WatchedRefresherOptions<S>,
    state: Mutex<State>,
}

pub struct WatchedRefresher<S: RefreshSource> {
    inner: Arc<Inner<S>>,
}

impl<S: RefreshSource> WatchedRefresher<S> {
    pub fn new(source: S, options: WatchedRefresherOptions<S>) -> Self {
        Self {
            inner: Arc::new(Inner {
                source,
                options,
                state: Mutex::new(State {
                    watches: WatchSets::new(),
                    timer: None,
                    timer_generation: 0,
                    poll: None,
                    armed_ms: 0,
                    focused: true,
                    running: false,
                    again: false,
                    sent: Vec::new(),
                }),
            }),
        }
    }

    pub fn active(&self) -> bool {
        self.inner.active()
    }

    pub fn polling(&self) -> bool {
        self.inner.state.lock().poll.is_some()
    }

    pub fn pending(&self) -> bool {
        self.inner.state.lock().timer.is_some()
    }

    pub fn watch(&self, window_id: &str, workspace_ids: &Value) {
        let changed = self
            .inner
            .state
            .lock()
            .watches
            .set(window_id, workspace_ids);
        if changed {
            self.inner.apply();
        }
    }

    pub fn window_gone(&self, window_id: &str) {
        let dropped = {
            let mut state = self.inner.state.lock();
            state.sent.retain(|(id, _)| id != window_id);
            state.watches.drop_window(window_id)
        };
        if dropped {
            self.inner.apply();
        }
    }

    pub fn set_focused(&self, focused: bool) {
        {
            let mut state = self.inner.state.lock();
            if state.focused == focused {
                return;
            }
            state.focused = focused;
        }
        if !self.inner.active() {
            return;
        }
        self.inner.arm_poll();
        if focused {
            self.inner.schedule(Duration::ZERO);
        }
    }

    pub fn activity(&self, event_type: &str) {
        if self.inner.active() && self.inner.options.events.contains(event_type) {
            self.inner.schedule(self.inner.options.debounce);
        }
    }

    pub fn stop(&self) {
        self.inner.halt();
    }

    pub fn refresh(&self) -> impl Future<Output = ()> + Send + use<S> {
        let inner = Arc::clone(&self.inner);
        let read = inner.begin_refresh();
        async move {
            if let Some(read) = read {
                inner.finish_refresh(read).await;
            }
        }
    }
}

impl<S: RefreshSource> Drop for WatchedRefresher<S> {
    fn drop(&mut self) {
        self.inner.halt();
    }
}

impl<S: RefreshSource> Inner<S> {
    fn active(&self) -> bool {
        self.source.enabled() && !self.state.lock().watches.is_empty()
    }

    fn apply(self: &Arc<Self>) {
        if self.active() {
            self.arm_poll();
            self.schedule(Duration::ZERO);
        } else {
            self.halt();
            self.clear();
        }
    }

    fn schedule(self: &Arc<Self>, delay: Duration) {
        let sleep = tokio::time::sleep(delay);
        let weak = Arc::downgrade(self);
        let mut state = self.state.lock();
        state.timer_generation += 1;
        let generation = state.timer_generation;
        if let Some(previous) = state.timer.take() {
            previous.abort();
        }
        state.timer = Some(tokio::spawn(async move {
            sleep.await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            {
                let mut state = inner.state.lock();
                if state.timer_generation != generation {
                    return;
                }
                state.timer = None;
            }
            if let Some(read) = inner.begin_refresh() {
                inner.finish_refresh(read).await;
            }
        }));
    }

    fn halt(&self) {
        let mut state = self.state.lock();
        state.timer_generation += 1;
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        if let Some(poll) = state.poll.take() {
            poll.abort();
        }
        state.again = false;
    }

    fn clear(&self) {
        self.source.cleared();
        let sent = std::mem::take(&mut self.state.lock().sent);
        for (window_id, _) in sent {
            (self.options.send)(
                &window_id,
                &self.options.channel,
                &<S::Items as Default>::default(),
            );
        }
    }

    fn arm_poll(self: &Arc<Self>) {
        let ms = self.source.poll_ms();
        let period = Duration::from_millis(ms.max(1));
        let mut state = self.state.lock();
        if state.poll.is_some() && state.focused && state.armed_ms == ms {
            return;
        }
        if let Some(poll) = state.poll.take() {
            poll.abort();
        }
        state.armed_ms = ms;
        if !state.focused {
            return;
        }
        let mut interval = tokio::time::interval_at(Instant::now() + period, period);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let weak: Weak<Self> = Arc::downgrade(self);
        state.poll = Some(tokio::spawn(async move {
            loop {
                interval.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                tokio::spawn(async move {
                    if let Some(read) = inner.begin_refresh() {
                        inner.finish_refresh(read).await;
                    }
                });
            }
        }));
    }

    fn begin_refresh(&self) -> Option<ReadFuture<S::Data>> {
        if !self.active() {
            return None;
        }
        let watched = {
            let mut state = self.state.lock();
            if state.running {
                state.again = true;
                return None;
            }
            state.running = true;
            state.watches.union()
        };
        Some(self.source.read(&watched))
    }

    async fn finish_refresh(self: Arc<Self>, read: ReadFuture<S::Data>) {
        match read.await {
            Ok(data) => {
                if self.active() {
                    self.publish(&data);
                }
            }
            Err(message) => {
                if let Some(log) = &self.options.log {
                    log(&message);
                }
            }
        }
        let rerun = {
            let mut state = self.state.lock();
            state.running = false;
            std::mem::take(&mut state.again)
        };
        if rerun && self.active() {
            self.schedule(self.options.debounce);
        }
    }

    fn publish(&self, data: &S::Data) {
        let mut outgoing: Vec<(String, S::Items)> = Vec::new();
        {
            let mut state = self.state.lock();
            let watching = state.watches.windows();
            let gone: Vec<String> = state
                .sent
                .iter()
                .filter(|(id, _)| !watching.iter().any(|(watched, _)| watched == id))
                .map(|(id, _)| id.clone())
                .collect();
            for id in gone {
                state.sent.retain(|(sent, _)| *sent != id);
                outgoing.push((id, <S::Items as Default>::default()));
            }
            for (window_id, ids) in &watching {
                let items = self.source.items_for(ids, data);
                let Ok(text) = serde_json::to_string(&items) else {
                    continue;
                };
                match state.sent.iter_mut().find(|(id, _)| id == window_id) {
                    Some((_, previous)) if *previous == text => continue,
                    Some((_, previous)) => *previous = text,
                    None => state.sent.push((window_id.clone(), text)),
                }
                outgoing.push((window_id.clone(), items));
            }
        }
        for (window_id, items) in &outgoing {
            (self.options.send)(window_id, &self.options.channel, items);
        }
        self.source.published(data);
    }
}
