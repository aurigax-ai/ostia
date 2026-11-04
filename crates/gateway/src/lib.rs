use serde::{Deserialize, Serialize};

pub mod addresses;
pub mod announce;
pub mod bind_follower;
pub mod cert;
pub mod device_name;
pub mod devices;
pub mod interfaces;
pub mod iso_time;
pub mod pair_check;
pub mod pairing;
pub mod phone_caps;
pub mod phone_input;
pub mod proxy_protocol;

pub const LOOPBACK_ADDRESS: &str = "127.0.0.1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayPhoneAddress {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRoute {
    pub bind_address: String,
    pub bind_interface: Option<String>,
    pub tailnet: bool,
    pub phone_address: Option<GatewayPhoneAddress>,
    pub relay: bool,
}
