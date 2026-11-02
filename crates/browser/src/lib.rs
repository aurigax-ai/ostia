pub mod browse_world;
pub mod browser_profile;
pub mod browser_profiles;
pub mod browser_user_agent;
pub mod chord_spec;
pub mod credentials;
pub mod guest_first_load;
pub mod guest_key;
pub mod native_menu_keys;

use ostia_rpc::RpcError;
use serde_json::Value;

pub trait BrowserSurface: Send + Sync {
    fn run(&self, method: &str, params: &Value) -> Result<Value, RpcError>;
}
