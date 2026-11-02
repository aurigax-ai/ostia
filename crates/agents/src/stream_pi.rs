use std::sync::Arc;

use futures_util::future::{BoxFuture, FutureExt};
use parking_lot::Mutex;

use crate::stream_source::{Backfill, Emit, StreamSource, StreamSourceError};
use ostia_contract::agent_stream::StreamEvent;

pub type PiListener = Arc<dyn Fn(Vec<StreamEvent>) + Send + Sync>;

pub trait PiStreamPort: Send + Sync {
    fn subscribe(&self, listener: PiListener) -> Box<dyn FnOnce() + Send + Sync>;
    fn snapshot(&self, turns: usize) -> Vec<StreamEvent>;
}

#[derive(Default)]
struct PiState {
    off: Option<Box<dyn FnOnce() + Send + Sync>>,
    sink: Option<Emit>,
    buffered: Vec<StreamEvent>,
}

struct PiSource {
    port: Arc<dyn PiStreamPort>,
    state: Arc<Mutex<PiState>>,
}

pub fn pi_source(port: Arc<dyn PiStreamPort>) -> impl StreamSource {
    PiSource {
        port,
        state: Arc::default(),
    }
}

impl StreamSource for PiSource {
    fn backfill(&self, turns: usize) -> BoxFuture<'_, Result<Backfill, StreamSourceError>> {
        let held = Arc::clone(&self.state);
        let listener: PiListener = Arc::new(move |events: Vec<StreamEvent>| {
            let mut state = held.lock();
            let sink = state.sink.clone();
            match sink {
                Some(sink) => {
                    drop(state);
                    sink(events);
                }
                None => state.buffered.extend(events),
            }
        });
        let off = self.port.subscribe(listener);
        self.state.lock().off = Some(off);
        let events = self.port.snapshot(turns);
        async move {
            Ok::<Backfill, StreamSourceError>(Backfill {
                events,
                truncated: false,
            })
        }
        .boxed()
    }

    fn live(&self, emit: Emit) {
        let held = {
            let mut state = self.state.lock();
            state.sink = Some(Arc::clone(&emit));
            std::mem::take(&mut state.buffered)
        };
        if !held.is_empty() {
            emit(held);
        }
    }

    fn close(&self) {
        let off = {
            let mut state = self.state.lock();
            state.sink = None;
            state.off.take()
        };
        if let Some(off) = off {
            off();
        }
    }
}
