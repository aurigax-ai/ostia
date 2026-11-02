pub mod guest_key;
pub mod native_menu_keys;

use ostia_rpc::RpcError;
use serde_json::Value;

pub trait BrowserSurface: Send + Sync {
    fn run(&self, method: &str, params: &Value) -> Result<Value, RpcError>;
}
