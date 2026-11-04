use ostia_base::js::{js_number, non_empty};

use crate::{GatewayPhoneAddress, LOOPBACK_ADDRESS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressKind {
    Tailnet,
    Phone,
    Lan,
    Relay,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayAddress {
    pub kind: AddressKind,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailnetNode {
    pub ip: Option<String>,
    pub dns_name: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AddressSources {
    pub port: Option<u16>,
    pub bind_host: Option<String>,
    pub tailnet: Option<TailnetNode>,
    pub phone_address: Option<GatewayPhoneAddress>,
    pub relay: Option<GatewayPhoneAddress>,
}

fn listed(kind: AddressKind, address: &GatewayPhoneAddress) -> GatewayAddress {
    GatewayAddress {
        kind,
        host: address.host.clone(),
        port: address.port,
    }
}

pub fn gateway_addresses(sources: AddressSources) -> Vec<GatewayAddress> {
    let AddressSources {
        port,
        bind_host,
        tailnet,
        phone_address,
        relay,
    } = sources;
    let Some(port) = port.filter(|port| *port != 0) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let on_port = |kind: AddressKind, host: &str| GatewayAddress {
        kind,
        host: host.to_owned(),
        port,
    };
    if let Some(node) = &tailnet {
        if let Some(name) = non_empty(node.dns_name.as_deref()) {
            found.push(on_port(AddressKind::Tailnet, name));
        }
        if let Some(ip) = non_empty(node.ip.as_deref()) {
            found.push(on_port(AddressKind::Tailnet, ip));
        }
    }
    if let Some(address) = &phone_address {
        found.push(listed(AddressKind::Phone, address));
    }
    if let Some(host) = non_empty(bind_host.as_deref()).filter(|host| *host != LOOPBACK_ADDRESS) {
        found.push(on_port(AddressKind::Lan, host));
    }
    if let Some(address) = &relay {
        found.push(listed(AddressKind::Relay, address));
    }
    found
}

pub fn is_current_host(
    host_header: Option<&str>,
    port: Option<u16>,
    addresses: &[GatewayAddress],
) -> bool {
    let Some(port) = port.filter(|port| *port != 0) else {
        return false;
    };
    let Some(header) = non_empty(host_header) else {
        return false;
    };
    let separator = header.rfind(':');
    let host = separator.map_or(header, |at| &header[..at]).to_lowercase();
    let header_port = separator.map(|at| js_number(&header[at + 1..]));
    let reaches = |wanted: &str, wanted_port: u16| {
        host == wanted.to_lowercase()
            && header_port.is_none_or(|header_port| header_port == f64::from(wanted_port))
    };
    reaches(LOOPBACK_ADDRESS, port)
        || reaches("localhost", port)
        || addresses
            .iter()
            .any(|address| reaches(&address.host, address.port))
}
