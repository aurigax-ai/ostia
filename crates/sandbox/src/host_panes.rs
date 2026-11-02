use std::collections::HashMap;
use std::fmt::Write;
use std::sync::Arc;

use ostia_base::random::random_bytes;
use parking_lot::Mutex;

const TOKEN_BYTES: usize = 24;

#[derive(Clone)]
pub struct HostPaneGrantsDeps {
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub ttl_ms: i64,
}

#[derive(Default)]
struct Grants {
    offers: HashMap<(String, String), i64>,
    tokens: HashMap<String, i64>,
}

#[derive(Clone)]
pub struct HostPaneGrants {
    deps: HostPaneGrantsDeps,
    grants: Arc<Mutex<Grants>>,
}

fn hex_token() -> String {
    random_bytes::<TOKEN_BYTES>()
        .iter()
        .fold(String::new(), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

impl HostPaneGrants {
    pub fn new(deps: HostPaneGrantsDeps) -> Self {
        Self {
            deps,
            grants: Arc::new(Mutex::new(Grants::default())),
        }
    }

    pub fn offer(&self, ext_id: &str, command: &str) {
        let expires = (self.deps.now)() + self.deps.ttl_ms;
        self.grants
            .lock()
            .offers
            .insert((ext_id.to_owned(), command.to_owned()), expires);
    }

    pub fn claim(&self, ext_id: &str, command: &str) -> Option<String> {
        let now = (self.deps.now)();
        let mut grants = self.grants.lock();
        let expires = grants
            .offers
            .remove(&(ext_id.to_owned(), command.to_owned()))?;
        if expires < now {
            return None;
        }
        let token = hex_token();
        grants.tokens.insert(token.clone(), now + self.deps.ttl_ms);
        Some(token)
    }

    pub fn consume(&self, token: &str) -> bool {
        let now = (self.deps.now)();
        self.grants
            .lock()
            .tokens
            .remove(token)
            .is_some_and(|expires| expires >= now)
    }
}
