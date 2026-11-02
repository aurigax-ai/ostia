use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortHost {
    #[default]
    #[serde(rename = "localhost")]
    Localhost,
    #[serde(rename = "127.0.0.1")]
    Loopback,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsSettings {
    pub enabled: bool,
    pub interval_seconds: u32,
    pub port_host: PortHost,
}

impl Default for PortsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: 3,
            port_host: PortHost::Localhost,
        }
    }
}
