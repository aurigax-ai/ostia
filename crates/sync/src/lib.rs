use serde::{Deserialize, Serialize};

pub mod app_update;
pub mod app_version;
mod install_cleanup;
pub mod install_method;
pub mod install_replace;
pub mod launch_sweep;
pub mod mac_replace;
pub mod release_check;
pub mod update_run;
pub mod update_wiring;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncOffer {
    pub id: String,
    pub marketplace: String,
}
