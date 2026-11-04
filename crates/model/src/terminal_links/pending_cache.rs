use std::collections::HashMap;
use std::time::Duration;

use tokio::time::Instant;

const TTL: Duration = Duration::from_millis(5_000);
const MAX_ENTRIES: usize = 500;

struct Entry<V> {
    value: V,
    stored_at: Instant,
    used: u64,
}

pub struct PendingCache<V> {
    entries: HashMap<String, Entry<V>>,
    clock: u64,
}

impl<V> Default for PendingCache<V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            clock: 0,
        }
    }
}

impl<V: Clone> PendingCache<V> {
    pub fn get(&mut self, key: &str) -> Option<V> {
        let fresh = self
            .entries
            .get(key)
            .is_some_and(|entry| entry.stored_at.elapsed() < TTL);
        if !fresh {
            self.entries.remove(key);
            return None;
        }
        self.clock += 1;
        let entry = self.entries.get_mut(key)?;
        entry.used = self.clock;
        Some(entry.value.clone())
    }

    pub fn set(&mut self, key: String, value: V) {
        self.clock += 1;
        self.entries.insert(
            key,
            Entry {
                value,
                stored_at: Instant::now(),
                used: self.clock,
            },
        );
        if self.entries.len() > MAX_ENTRIES {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
    }
}
