use std::fmt;

use ostia_contract::chat_tools::McpServerSettings;
use serde_json::Value;

const HIDDEN: &str = "[hidden]";

#[derive(Clone, PartialEq)]
pub struct McpOAuthRecord {
    pub url: String,
    pub redirect_url: String,
    pub client: Value,
    pub tokens: Option<Value>,
    pub expires_at: Option<i64>,
}

impl fmt::Debug for McpOAuthRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpOAuthRecord")
            .field("url", &self.url)
            .field("redirect_url", &self.redirect_url)
            .field("client", &HIDDEN)
            .field("tokens", &self.tokens.as_ref().map(|_| HIDDEN))
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

pub trait McpOAuthStore: Send + Sync {
    fn get(&self, server: &str, url: &str) -> Option<McpOAuthRecord>;
    fn set(&self, server: &str, record: McpOAuthRecord) -> Result<(), String>;
    fn clear(&self, server: &str);
    fn prune(&self, servers: &[McpServerSettings]);
    fn can_store(&self) -> bool;
}
