use std::collections::HashMap;
use std::sync::Arc;

pub struct HandleRegistry<T> {
    by_pane: HashMap<String, Arc<T>>,
}

impl<T> Default for HandleRegistry<T> {
    fn default() -> Self {
        Self {
            by_pane: HashMap::new(),
        }
    }
}

impl<T> HandleRegistry<T> {
    pub fn register(&mut self, pane_id: &str, handle: Arc<T>) {
        self.by_pane.insert(pane_id.to_owned(), handle);
    }

    pub fn unregister(&mut self, pane_id: &str, handle: &Arc<T>) -> bool {
        let current = self.by_pane.get(pane_id);
        if !current.is_some_and(|held| Arc::ptr_eq(held, handle)) {
            return false;
        }
        self.by_pane.remove(pane_id);
        true
    }

    pub fn get(&self, pane_id: &str) -> Option<&Arc<T>> {
        self.by_pane.get(pane_id)
    }
}
