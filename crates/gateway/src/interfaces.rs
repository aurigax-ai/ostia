use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};

use nix::ifaddrs::getifaddrs;
use nix::net::if_::InterfaceFlags;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InterfaceAddress {
    pub address: IpAddr,
    pub internal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GatewayBindAddress {
    pub address: String,
    pub iface: String,
    pub loopback: bool,
}

pub fn bind_addresses_of(ifaces: &[(String, Vec<InterfaceAddress>)]) -> Vec<GatewayBindAddress> {
    let mut found: Vec<GatewayBindAddress> = Vec::new();
    for (iface, infos) in ifaces {
        for info in infos {
            let IpAddr::V4(address) = info.address else {
                continue;
            };
            if address == Ipv4Addr::UNSPECIFIED {
                continue;
            }
            let text = address.to_string();
            if found.iter().any(|known| known.address == text) {
                continue;
            }
            found.push(GatewayBindAddress {
                address: text,
                iface: iface.clone(),
                loopback: info.internal,
            });
        }
    }
    let (loopback, other): (Vec<_>, Vec<_>) = found.into_iter().partition(|known| known.loopback);
    loopback.into_iter().chain(other).collect()
}

fn system_interfaces() -> Vec<(String, Vec<InterfaceAddress>)> {
    let Ok(entries) = getifaddrs() else {
        return Vec::new();
    };
    let mut order: Vec<String> = Vec::new();
    let mut by_name: BTreeMap<String, Vec<InterfaceAddress>> = BTreeMap::new();
    for entry in entries {
        let Some(address) = entry.address else {
            continue;
        };
        let ip = if let Some(v4) = address.as_sockaddr_in() {
            IpAddr::V4(v4.ip())
        } else if let Some(v6) = address.as_sockaddr_in6() {
            IpAddr::V6(v6.ip())
        } else {
            continue;
        };
        if !by_name.contains_key(&entry.interface_name) {
            order.push(entry.interface_name.clone());
        }
        by_name
            .entry(entry.interface_name)
            .or_default()
            .push(InterfaceAddress {
                address: ip,
                internal: entry.flags.contains(InterfaceFlags::IFF_LOOPBACK),
            });
    }
    order
        .into_iter()
        .filter_map(|name| by_name.remove(&name).map(|infos| (name, infos)))
        .collect()
}

pub fn list_bind_addresses() -> Vec<GatewayBindAddress> {
    bind_addresses_of(&system_interfaces())
}
