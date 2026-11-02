use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

#[derive(Default)]
struct State {
    timer: Option<JoinHandle<()>>,
    generation: u64,
    shown: bool,
}

impl State {
    fn cancel(&mut self) {
        self.generation += 1;
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

struct Shared<T> {
    runtime: Handle,
    delay: Duration,
    pane_visible: Box<dyn Fn() -> bool + Send + Sync>,
    publish: Box<dyn Fn(Option<T>) + Send + Sync>,
    state: Mutex<State>,
}

pub struct LinkHint<T> {
    shared: Arc<Shared<T>>,
}

impl<T: Send + 'static> LinkHint<T> {
    pub fn new(
        runtime: Handle,
        delay: Duration,
        pane_visible: impl Fn() -> bool + Send + Sync + 'static,
        publish: impl Fn(Option<T>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                runtime,
                delay,
                pane_visible: Box::new(pane_visible),
                publish: Box::new(publish),
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn show(&self, measure: impl FnOnce() -> Option<T> + Send + 'static) {
        let deadline = Instant::now() + self.shared.delay;
        let shared = self.shared.clone();
        let mut state = self.shared.state.lock();
        state.cancel();
        let generation = state.generation;
        state.timer = Some(self.shared.runtime.spawn(async move {
            sleep_until(deadline).await;
            let mut state = shared.state.lock();
            if state.generation != generation {
                return;
            }
            state.timer = None;
            if !(shared.pane_visible)() {
                return;
            }
            let Some(hint) = measure() else {
                return;
            };
            state.shown = true;
            (shared.publish)(Some(hint));
        }));
    }

    pub fn hide(&self) {
        let mut state = self.shared.state.lock();
        state.cancel();
        if !state.shown {
            return;
        }
        state.shown = false;
        (self.shared.publish)(None);
    }
}
