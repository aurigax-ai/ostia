pub mod browse_method;
pub mod browse_world;
pub mod browser_profile;
pub mod browser_profiles;
pub mod browser_storage;
pub mod browser_user_agent;
pub mod credentials;
pub mod guest_chords;
pub mod guest_first_load;
pub mod guest_inject;
pub mod guest_key;
pub mod guest_key_event;
pub mod guest_link_clicks;
pub mod guest_pointer;
pub mod guest_popups;
pub mod guest_remap;
pub mod guest_tabs;
pub mod native_menu_keys;
pub mod signin_user_agent;

use ostia_rpc::RpcError;
use serde_json::Value;

pub trait BrowserSurface: Send + Sync {
    fn run(&self, method: &str, params: &Value) -> Result<Value, RpcError>;
}
