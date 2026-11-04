use ostia_base::js::non_empty;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::LOOPBACK_ADDRESS;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Announcement {
    pub name: String,
    #[serde(rename = "type")]
    pub service_type: &'static str,
    pub protocol: &'static str,
    pub port: u16,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iface: Option<String>,
    pub txt: Map<String, Value>,
}

#[derive(Clone, Debug)]
pub struct AnnounceInput {
    pub discoverable: bool,
    pub live_codes: usize,
    pub name: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub fingerprint: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LanAnnounceInput {
    pub name: String,
    pub bind_host: Option<String>,
    pub port: Option<u16>,
}

fn txt_of(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
        .collect()
}

pub fn announcement_for(input: &AnnounceInput) -> Option<Announcement> {
    if !input.discoverable || input.live_codes == 0 {
        return None;
    }
    let host = non_empty(input.host.as_deref())?;
    let port = input.port.filter(|port| *port != 0)?;
    let fingerprint = non_empty(input.fingerprint.as_deref())?;
    Some(Announcement {
        name: input.name.clone(),
        service_type: "ostia",
        protocol: "tcp",
        port,
        host: format!("{}.local", input.name),
        iface: None,
        txt: txt_of(&[
            ("v", "1"),
            ("name", input.name.as_str()),
            ("host", host),
            ("port", port.to_string().as_str()),
            ("fp", fingerprint),
        ]),
    })
}

pub fn lan_announcement_for(input: &LanAnnounceInput) -> Option<Announcement> {
    let bind_host =
        non_empty(input.bind_host.as_deref()).filter(|host| *host != LOOPBACK_ADDRESS)?;
    let port = input.port.filter(|port| *port != 0)?;
    Some(Announcement {
        name: input.name.clone(),
        service_type: "ostia",
        protocol: "tcp",
        port,
        host: format!("{}.local", input.name),
        iface: Some(bind_host.to_owned()),
        txt: txt_of(&[
            ("v", "1"),
            ("mode", "paired"),
            ("port", port.to_string().as_str()),
        ]),
    })
}
