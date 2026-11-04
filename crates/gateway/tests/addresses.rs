#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_gateway::GatewayPhoneAddress;
use ostia_gateway::addresses::{
    AddressKind, AddressSources, GatewayAddress, TailnetNode, gateway_addresses, is_current_host,
};

fn node() -> TailnetNode {
    TailnetNode {
        ip: Some("100.101.102.103".to_owned()),
        dns_name: Some("ostia-box.tail1234.ts.net".to_owned()),
    }
}

fn phone(host: &str, port: u16) -> GatewayPhoneAddress {
    GatewayPhoneAddress {
        host: host.to_owned(),
        port,
    }
}

fn address(kind: AddressKind, host: &str, port: u16) -> GatewayAddress {
    GatewayAddress {
        kind,
        host: host.to_owned(),
        port,
    }
}

fn sources(port: Option<u16>) -> AddressSources {
    AddressSources {
        port,
        bind_host: None,
        tailnet: None,
        phone_address: None,
        relay: None,
    }
}

fn kinds(addresses: &[GatewayAddress]) -> Vec<AddressKind> {
    addresses.iter().map(|a| a.kind).collect()
}

fn current_addresses() -> Vec<GatewayAddress> {
    gateway_addresses(AddressSources {
        bind_host: Some("192.168.2.108".to_owned()),
        tailnet: Some(node()),
        phone_address: Some(phone("gw.example.org", 443)),
        ..sources(Some(8722))
    })
}

fn relay_only(port: u16) -> Vec<GatewayAddress> {
    gateway_addresses(AddressSources {
        relay: Some(phone("lblabc.relay.test", port)),
        ..sources(Some(8722))
    })
}

#[test]
fn rds_c15_lists_the_tailnet_name_the_tailnet_ipv4_the_phone_address_and_the_lan_address_best_first()
 {
    assert_eq!(
        current_addresses(),
        vec![
            address(AddressKind::Tailnet, "ostia-box.tail1234.ts.net", 8722),
            address(AddressKind::Tailnet, "100.101.102.103", 8722),
            address(AddressKind::Phone, "gw.example.org", 443),
            address(AddressKind::Lan, "192.168.2.108", 8722),
        ]
    );
}

#[test]
fn rds_c16_leaves_out_loopback_and_whatever_does_not_exist_now() {
    assert_eq!(
        gateway_addresses(AddressSources {
            bind_host: Some("127.0.0.1".to_owned()),
            ..sources(Some(8722))
        }),
        vec![]
    );
    assert_eq!(
        gateway_addresses(AddressSources {
            tailnet: Some(TailnetNode {
                ip: Some("100.64.0.9".to_owned()),
                dns_name: None,
            }),
            ..sources(Some(8722))
        }),
        vec![address(AddressKind::Tailnet, "100.64.0.9", 8722)]
    );
}

#[test]
fn rly_c40_lists_the_relay_host_on_443_after_the_tailnet_phone_and_lan_addresses() {
    let all = gateway_addresses(AddressSources {
        bind_host: Some("192.168.2.108".to_owned()),
        tailnet: Some(node()),
        phone_address: Some(phone("gw.example.org", 443)),
        relay: Some(phone("lblabc.relay.test", 443)),
        ..sources(Some(8722))
    });
    assert_eq!(
        kinds(&all),
        vec![
            AddressKind::Tailnet,
            AddressKind::Tailnet,
            AddressKind::Phone,
            AddressKind::Lan,
            AddressKind::Relay,
        ]
    );
    assert_eq!(
        relay_only(443),
        vec![address(AddressKind::Relay, "lblabc.relay.test", 443)]
    );
}

#[test]
fn rds_c17_lists_nothing_while_the_gateway_is_not_listening() {
    assert_eq!(
        gateway_addresses(AddressSources {
            tailnet: Some(node()),
            ..sources(None)
        }),
        vec![]
    );
}

#[test]
fn lists_nothing_for_port_zero_and_skips_empty_names_as_ts_does() {
    assert_eq!(
        gateway_addresses(AddressSources {
            tailnet: Some(node()),
            bind_host: Some("192.168.2.108".to_owned()),
            ..sources(Some(0))
        }),
        vec![]
    );
    assert_eq!(
        gateway_addresses(AddressSources {
            bind_host: Some(String::new()),
            tailnet: Some(TailnetNode {
                ip: Some(String::new()),
                dns_name: Some(String::new()),
            }),
            ..sources(Some(8722))
        }),
        vec![]
    );
}

#[test]
fn rds_c18_accepts_every_current_address_with_its_port_or_without_one() {
    let addresses = current_addresses();
    for host in [
        "ostia-box.tail1234.ts.net:8722",
        "ostia-box.tail1234.ts.net",
        "OSTIA-BOX.tail1234.ts.net",
        "100.101.102.103:8722",
        "192.168.2.108:8722",
        "gw.example.org:443",
        "gw.example.org",
        "127.0.0.1:8722",
        "localhost",
    ] {
        assert!(
            is_current_host(Some(host), Some(8722), &addresses),
            "{host}"
        );
    }
}

#[test]
fn rds_c19_refuses_an_address_that_is_no_longer_current_or_a_known_host_on_another_port() {
    let addresses = current_addresses();
    for host in [
        "100.101.102.104:8722",
        "192.168.2.109:8722",
        "old-box.tail1234.ts.net",
        "gw.example.org:8722",
        "192.168.2.108:443",
        "127.0.0.1:443",
        "",
    ] {
        assert!(
            !is_current_host(Some(host), Some(8722), &addresses),
            "{host}"
        );
    }
    assert!(!is_current_host(None, Some(8722), &addresses));
    assert!(!is_current_host(Some("127.0.0.1:8722"), None, &addresses));
}

#[test]
fn reads_the_header_port_as_javascript_number_does() {
    let addresses = current_addresses();
    let cases = [
        ("localhost:", false),
        ("localhost:0x2212", true),
        ("localhost: 8722", true),
        ("localhost:8722 ", true),
        ("localhost:8.722e3", true),
        ("localhost:abc", false),
        ("localhost:8722abc", false),
        ("localhost:+8722", true),
        ("[::1]:8722", false),
        ("localhost:8722:8722", false),
    ];
    for (host, expected) in cases {
        assert_eq!(
            is_current_host(Some(host), Some(8722), &addresses),
            expected,
            "{host}"
        );
    }
}

#[test]
fn rly_c41_accepts_the_relay_host_with_443_or_no_port_and_nothing_else_on_it() {
    let addresses = relay_only(443);
    assert!(is_current_host(
        Some("lblabc.relay.test"),
        Some(8722),
        &addresses
    ));
    assert!(is_current_host(
        Some("LBLABC.relay.test:443"),
        Some(8722),
        &addresses
    ));
    assert!(!is_current_host(
        Some("lblabc.relay.test:8722"),
        Some(8722),
        &addresses
    ));
    assert!(!is_current_host(
        Some("other.relay.test"),
        Some(8722),
        &addresses
    ));
}

#[test]
fn rly_c62_accepts_the_relay_host_on_the_public_port_of_the_server_with_it_or_without_one() {
    let mapped = relay_only(8443);
    assert_eq!(
        mapped,
        vec![address(AddressKind::Relay, "lblabc.relay.test", 8443)]
    );
    assert!(is_current_host(
        Some("lblabc.relay.test"),
        Some(8722),
        &mapped
    ));
    assert!(is_current_host(
        Some("lblabc.relay.test:8443"),
        Some(8722),
        &mapped
    ));
    assert!(!is_current_host(
        Some("lblabc.relay.test:443"),
        Some(8722),
        &mapped
    ));
    assert!(!is_current_host(
        Some("lblabc.relay.test:8722"),
        Some(8722),
        &mapped
    ));
}

#[test]
fn rly_c42_stops_accepting_the_relay_host_once_no_address_lists_it() {
    let without = gateway_addresses(sources(Some(8722)));
    assert!(!is_current_host(
        Some("lblabc.relay.test"),
        Some(8722),
        &without
    ));
}
