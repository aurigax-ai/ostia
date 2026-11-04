#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nix::net::if_::InterfaceFlags;
use ostia_gateway::interfaces::{InterfaceAddress, bind_addresses_of, is_usable};
use serde_json::{Value, json};

fn info(address: &str, internal: bool) -> InterfaceAddress {
    InterfaceAddress {
        address: address.parse().unwrap(),
        internal,
    }
}

fn interface(name: &str, addresses: Vec<InterfaceAddress>) -> (String, Vec<InterfaceAddress>) {
    (name.to_owned(), addresses)
}

fn listed(ifaces: &[(String, Vec<InterfaceAddress>)]) -> Value {
    serde_json::to_value(bind_addresses_of(ifaces)).unwrap()
}

#[test]
fn tsn_c43_lists_loopback_first_then_each_ipv4_of_this_machine_once() {
    let ifaces = [
        interface(
            "wlan0",
            vec![info("192.168.2.108", false), info("fe80::1", false)],
        ),
        interface("lo", vec![info("127.0.0.1", true), info("::1", true)]),
        interface(
            "tun0",
            vec![info("10.8.0.2", false), info("192.168.2.108", false)],
        ),
    ];
    assert_eq!(
        listed(&ifaces),
        json!([
            {"address": "127.0.0.1", "iface": "lo", "loopback": true},
            {"address": "192.168.2.108", "iface": "wlan0", "loopback": false},
            {"address": "10.8.0.2", "iface": "tun0", "loopback": false},
        ])
    );
}

#[test]
fn tsn_c44_never_lists_0_0_0_0() {
    let ifaces = [interface("any", vec![info("0.0.0.0", false)])];
    assert_eq!(listed(&ifaces), json!([]));
}

#[test]
fn skips_an_interface_that_is_up_but_not_running() {
    assert!(is_usable(
        InterfaceFlags::IFF_UP | InterfaceFlags::IFF_RUNNING
    ));
    assert!(!is_usable(InterfaceFlags::IFF_UP));
    assert!(!is_usable(InterfaceFlags::IFF_RUNNING));
    assert!(!is_usable(InterfaceFlags::empty()));
}
