use serde::{Deserialize, Serialize};

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
