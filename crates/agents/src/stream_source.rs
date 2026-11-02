use std::sync::Arc;

use futures_util::future::BoxFuture;

use ostia_contract::agent_stream::StreamEvent;

pub type Emit = Arc<dyn Fn(Vec<StreamEvent>) + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct Backfill {
    pub events: Vec<StreamEvent>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamSourceError {
    pub message: String,
}

impl StreamSourceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait StreamSource {
    fn backfill(&self, turns: usize) -> BoxFuture<'_, Result<Backfill, StreamSourceError>>;
    fn live(&self, emit: Emit);
    fn close(&self);
}
