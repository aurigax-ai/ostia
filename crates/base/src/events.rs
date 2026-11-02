use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

pub struct EventHub<E> {
    subscribers: Arc<Mutex<Vec<UnboundedSender<E>>>>,
}

impl<E> Clone for EventHub<E> {
    fn clone(&self) -> Self {
        Self {
            subscribers: Arc::clone(&self.subscribers),
        }
    }
}

impl<E> Default for EventHub<E> {
    fn default() -> Self {
        Self {
            subscribers: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl<E: Clone> EventHub<E> {
    pub fn subscribe(&self) -> UnboundedReceiver<E> {
        let (sender, receiver) = unbounded_channel();
        self.subscribers.lock().push(sender);
        receiver
    }

    pub fn emit(&self, event: E) {
        self.subscribers
            .lock()
            .retain(|subscriber| subscriber.send(event.clone()).is_ok());
    }
}
