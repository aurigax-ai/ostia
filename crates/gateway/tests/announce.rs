#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_gateway::announce::{
    AnnounceInput, Announcement, LanAnnounceInput, announcement_for, lan_announcement_for,
};
use serde_json::{Value, json};

const NAME: &str = "Quiet-Otter";
const LAN_ADDRESS: &str = "192.168.2.108";
const FINGERPRINT: &str = "sha256/fp";

fn pairing_input(host: Option<&str>) -> AnnounceInput {
    AnnounceInput {
        discoverable: true,
        live_codes: 1,
        name: NAME.to_owned(),
        host: host.map(str::to_owned),
        port: Some(8722),
        fingerprint: Some(FINGERPRINT.to_owned()),
    }
}

fn lan_input(bind_host: Option<&str>) -> LanAnnounceInput {
    LanAnnounceInput {
        name: NAME.to_owned(),
        bind_host: bind_host.map(str::to_owned),
        port: Some(8722),
    }
}

fn json_of(announcement: &Option<Announcement>) -> Value {
    serde_json::to_value(announcement).unwrap()
}

fn txt_keys(announcement: &Option<Announcement>) -> Vec<String> {
    let value = json_of(announcement);
    let mut keys: Vec<String> = value["txt"].as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn cpd_c1_announces_name_host_port_and_fingerprint_on_either_route_while_a_code_is_shown() {
    assert_eq!(
        json_of(&announcement_for(&pairing_input(Some("100.64.1.2")))),
        json!({
            "name": NAME,
            "type": "ostia",
            "protocol": "tcp",
            "port": 8722,
            "host": format!("{NAME}.local"),
            "txt": {"v": "1", "name": NAME, "host": "100.64.1.2", "port": "8722", "fp": FINGERPRINT},
        })
    );
    assert_eq!(
        json_of(&announcement_for(&pairing_input(Some(LAN_ADDRESS))))["txt"]["host"],
        json!(LAN_ADDRESS)
    );
}

#[test]
fn cpd_c2_announces_nothing_while_discoverable_is_off() {
    let input = AnnounceInput {
        discoverable: false,
        ..pairing_input(Some("100.64.1.2"))
    };
    assert!(announcement_for(&input).is_none());
}

#[test]
fn cpd_c3_withdraws_the_announcement_when_the_code_is_used_expires_or_remote_access_stops() {
    let live = pairing_input(Some("100.64.1.2"));
    assert!(announcement_for(&live).is_some());
    let used = AnnounceInput {
        live_codes: 0,
        ..pairing_input(Some("100.64.1.2"))
    };
    assert!(announcement_for(&used).is_none());
    assert!(announcement_for(&pairing_input(None)).is_none());
    let no_port = AnnounceInput {
        port: None,
        ..pairing_input(Some("100.64.1.2"))
    };
    assert!(announcement_for(&no_port).is_none());
    let no_fingerprint = AnnounceInput {
        fingerprint: None,
        ..pairing_input(Some("100.64.1.2"))
    };
    assert!(announcement_for(&no_fingerprint).is_none());
}

#[test]
fn cpd_c6_never_puts_a_code_token_or_device_in_the_announcement() {
    let code = "ABCDEFGH";
    let announcement = announcement_for(&pairing_input(Some("100.64.1.2")));
    assert_eq!(txt_keys(&announcement), ["fp", "host", "name", "port", "v"]);
    let value = json_of(&announcement);
    for text in value["txt"].as_object().unwrap().values() {
        assert_ne!(text.as_str().unwrap(), code);
    }
    assert!(!value.to_string().contains(code));
}

#[test]
fn treats_an_empty_name_part_and_a_zero_port_as_missing_as_ts_does() {
    let empty_host = pairing_input(Some(""));
    assert!(announcement_for(&empty_host).is_none());
    let empty_fingerprint = AnnounceInput {
        fingerprint: Some(String::new()),
        ..pairing_input(Some("100.64.1.2"))
    };
    assert!(announcement_for(&empty_fingerprint).is_none());
    let zero_port = AnnounceInput {
        port: Some(0),
        ..pairing_input(Some("100.64.1.2"))
    };
    assert!(announcement_for(&zero_port).is_none());
    assert!(
        lan_announcement_for(&LanAnnounceInput {
            port: Some(0),
            ..lan_input(Some(LAN_ADDRESS))
        })
        .is_none()
    );
    assert!(lan_announcement_for(&lan_input(Some(""))).is_none());
}

#[test]
fn rds_c1_announces_the_friendly_name_with_only_the_version_and_the_port_no_code_needed() {
    let lan = lan_announcement_for(&lan_input(Some(LAN_ADDRESS)));
    assert_eq!(
        json_of(&lan),
        json!({
            "name": NAME,
            "type": "ostia",
            "protocol": "tcp",
            "port": 8722,
            "host": format!("{NAME}.local"),
            "iface": LAN_ADDRESS,
            "txt": {"v": "1", "mode": "paired", "port": "8722"},
        })
    );
}

#[test]
fn rds_c2_puts_no_hostname_in_any_announce_and_no_fingerprint_code_or_token_in_the_paired_phone_one()
 {
    let lan = lan_announcement_for(&lan_input(Some(LAN_ADDRESS)));
    assert_eq!(txt_keys(&lan), ["mode", "port", "v"]);
    let lan_text = json_of(&lan).to_string();
    let pairing_text = json_of(&announcement_for(&pairing_input(Some(LAN_ADDRESS)))).to_string();
    let machine = gethostname::gethostname().to_string_lossy().into_owned();
    assert!(!machine.is_empty());
    for (what, text) in [("lan", &lan_text), ("pairing", &pairing_text)] {
        assert!(!text.contains(&machine), "{what}");
    }
    for secret in [FINGERPRINT, "ABCDEFGH"] {
        assert!(!lan_text.contains(secret), "{secret}");
    }
}

#[test]
fn rds_c3_announces_nothing_with_a_loopback_bind() {
    assert!(lan_announcement_for(&lan_input(Some("127.0.0.1"))).is_none());
}

#[test]
fn rds_c4_withdraws_the_announcement_when_remote_access_stops() {
    assert!(lan_announcement_for(&lan_input(Some(LAN_ADDRESS))).is_some());
    assert!(lan_announcement_for(&lan_input(None)).is_none());
    let no_port = LanAnnounceInput {
        port: None,
        ..lan_input(Some(LAN_ADDRESS))
    };
    assert!(lan_announcement_for(&no_port).is_none());
}

#[test]
fn rds_c5_keeps_the_same_random_name_across_restarts() {
    let first = json_of(&lan_announcement_for(&lan_input(Some(LAN_ADDRESS))));
    let second = json_of(&lan_announcement_for(&lan_input(Some(LAN_ADDRESS))));
    assert_eq!(first, second);
    assert_eq!(first["name"], json!(NAME));
}
