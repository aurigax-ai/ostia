use std::sync::Arc;

use parking_lot::Mutex;

#[derive(Clone, Default)]
pub struct IdNamespace {
    namespace: Arc<Mutex<String>>,
}

impl IdNamespace {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, next: &str) {
        *self.namespace.lock() = next.to_owned();
    }

    pub fn namespaced_id(&self, prefix: &str, n: i64) -> String {
        self.namespaced_id_with(prefix, n, "-")
    }

    pub fn namespaced_id_with(&self, prefix: &str, n: i64, separator: &str) -> String {
        let namespace = self.namespace.lock();
        if namespace.is_empty() {
            format!("{prefix}{separator}{n}")
        } else {
            format!("{prefix}{separator}{namespace}-{n}")
        }
    }
}
