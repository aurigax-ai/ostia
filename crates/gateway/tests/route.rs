#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use ostia_gateway::friendly_name::is_friendly_name;
use ostia_gateway::route::{RouteConfig, RouteProblem, check_route};
use ostia_gateway::{GatewayPhoneAddress, GatewayRoute};
use serde_json::{Map, Value, json};
use tempfile::TempDir;

fn lan() -> Value {
    json!({
        "bindAddress": "192.168.2.108",
        "bindInterface": "wlan0",
        "tailnet": false,
        "phoneAddress": null,
        "relay": false,
    })
}

fn loopback() -> Value {
    with(
        lan(),
        &[
            ("bindAddress", json!("127.0.0.1")),
            ("bindInterface", Value::Null),
        ],
    )
}

fn with(base: Value, changes: &[(&str, Value)]) -> Value {
    let mut map: Map<String, Value> = base.as_object().unwrap().clone();
    for (key, value) in changes {
        map.insert((*key).to_owned(), value.clone());
    }
    Value::Object(map)
}

fn without(base: Value, key: &str) -> Value {
    let mut map: Map<String, Value> = base.as_object().unwrap().clone();
    map.shift_remove(key);
    Value::Object(map)
}

fn route_of(value: &Value) -> GatewayRoute {
    check_route(value).unwrap()
}

fn file_in() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("gateway-config.json");
    (dir, file)
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn stored(file: &PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

#[test]
fn rds_c25_accepts_loopback_with_no_card_and_a_lan_address_with_its_card() {
    let accepted = route_of(&lan());
    assert_eq!(serde_json::to_value(&accepted).unwrap(), lan());
    assert_eq!(route_of(&loopback()).bind_interface, None);
}

#[test]
fn rds_c26_refuses_a_lan_address_with_no_card_and_loopback_with_a_card() {
    let refused = Err(RouteProblem::UnknownAddress);
    assert_eq!(
        check_route(&with(lan(), &[("bindInterface", Value::Null)])),
        refused
    );
    assert_eq!(
        check_route(&with(lan(), &[("bindAddress", json!("127.0.0.1"))])),
        refused
    );
    assert_eq!(check_route(&without(lan(), "bindInterface")), refused);
}

#[test]
fn rly_c43_keeps_the_relay_switch_and_refuses_a_route_without_one() {
    assert!(route_of(&with(loopback(), &[("relay", json!(true))])).relay);
    assert_eq!(
        check_route(&without(lan(), "relay")),
        Err(RouteProblem::UnknownAddress)
    );
    assert_eq!(
        check_route(&with(lan(), &[("relay", json!("yes"))])),
        Err(RouteProblem::UnknownAddress)
    );
}

#[test]
fn rds_c29_refuses_a_route_with_two_connection_methods_on() {
    let phone_address = json!({"host": "desk.example.com", "port": 443});
    let two = Err(RouteProblem::TwoMethods);
    assert_eq!(
        check_route(&with(
            loopback(),
            &[("relay", json!(true)), ("tailnet", json!(true))]
        )),
        two
    );
    assert_eq!(check_route(&with(lan(), &[("tailnet", json!(true))])), two);
    assert_eq!(check_route(&with(lan(), &[("relay", json!(true))])), two);
    assert_eq!(
        check_route(&with(
            loopback(),
            &[
                ("tailnet", json!(true)),
                ("phoneAddress", phone_address.clone())
            ]
        )),
        two
    );
    assert_eq!(
        route_of(&with(loopback(), &[("phoneAddress", phone_address)])).phone_address,
        Some(GatewayPhoneAddress {
            host: "desk.example.com".to_owned(),
            port: 443
        })
    );
    assert!(route_of(&with(loopback(), &[("tailnet", json!(true))])).tailnet);
    assert_eq!(
        serde_json::to_value(route_of(&loopback())).unwrap(),
        loopback()
    );
}

#[test]
fn rds_c27_reads_a_saved_route_back_with_its_card() {
    let (_dir, file) = file_in();
    let config = RouteConfig::new(file);
    config.save_route(&route_of(&lan())).unwrap();
    assert_eq!(serde_json::to_value(config.load_route()).unwrap(), lan());
}

#[test]
fn rds_c28_is_two_random_words_made_once_and_kept() {
    let (_dir, file) = file_in();
    let config = RouteConfig::new(file);
    let first = config.friendly_name().unwrap();
    assert!(is_friendly_name(&first), "{first}");
    assert_eq!(config.friendly_name().unwrap(), first);
}

#[test]
fn refuses_a_value_that_is_not_an_object_and_an_unusable_bind_address() {
    for value in [json!(null), json!("lan"), json!(5), json!([]), json!(true)] {
        assert_eq!(
            check_route(&value),
            Err(RouteProblem::UnknownAddress),
            "{value}"
        );
    }
    for address in [
        json!("0.0.0.0"),
        json!("256.1.1.1"),
        json!("lan"),
        json!(null),
        json!(7),
    ] {
        assert_eq!(
            check_route(&with(lan(), &[("bindAddress", address.clone())])),
            Err(RouteProblem::UnknownAddress),
            "{address}"
        );
    }
}

#[test]
fn refuses_a_tailnet_that_is_not_a_boolean_and_a_card_name_that_is_empty_or_too_long() {
    assert_eq!(
        check_route(&with(lan(), &[("tailnet", json!("no"))])),
        Err(RouteProblem::UnknownAddress)
    );
    assert_eq!(
        check_route(&without(lan(), "tailnet")),
        Err(RouteProblem::UnknownAddress)
    );
    for card in [json!(""), json!("x".repeat(65)), json!(4)] {
        assert_eq!(
            check_route(&with(lan(), &[("bindInterface", card.clone())])),
            Err(RouteProblem::UnknownAddress),
            "{card}"
        );
    }
    assert_eq!(
        route_of(&with(lan(), &[("bindInterface", json!("x".repeat(64)))])).bind_interface,
        Some("x".repeat(64))
    );
}

#[test]
fn refuses_a_phone_address_that_is_missing_or_malformed() {
    let bad = Err(RouteProblem::InvalidPhoneAddress);
    assert_eq!(check_route(&without(loopback(), "phoneAddress")), bad);
    for address in [
        json!("desk.example.com:443"),
        json!({"host": "desk.example.com"}),
        json!({"host": "desk.example.com", "port": 0}),
        json!({"host": "desk.example.com", "port": 65536}),
        json!({"host": "desk.example.com", "port": 443.5}),
        json!({"host": "", "port": 443}),
        json!({"host": "-bad.example.com", "port": 443}),
        json!({"host": "300.1.1.1", "port": 443}),
        json!({"host": 4, "port": 443}),
    ] {
        assert_eq!(
            check_route(&with(loopback(), &[("phoneAddress", address.clone())])),
            bad,
            "{address}"
        );
    }
}

#[test]
fn checks_the_address_before_the_phone_address_and_the_phone_address_before_two_methods() {
    assert_eq!(
        check_route(&with(
            lan(),
            &[("bindInterface", Value::Null), ("phoneAddress", json!("x"))]
        )),
        Err(RouteProblem::UnknownAddress)
    );
    assert_eq!(
        check_route(&with(
            loopback(),
            &[("tailnet", json!(true)), ("phoneAddress", json!("x"))]
        )),
        Err(RouteProblem::InvalidPhoneAddress)
    );
}

#[test]
fn loads_the_default_route_when_the_file_is_missing_or_holds_a_route_that_fails_the_check() {
    let (_dir, file) = file_in();
    let config = RouteConfig::new(file.clone());
    let default = GatewayRoute {
        bind_address: "127.0.0.1".to_owned(),
        bind_interface: None,
        tailnet: true,
        phone_address: None,
        relay: false,
    };
    assert_eq!(config.load_route(), default);
    fs::write(
        &file,
        json!({"route": with(lan(), &[("relay", json!(true))])}).to_string(),
    )
    .unwrap();
    assert_eq!(config.load_route(), default);
    fs::write(&file, "not json").unwrap();
    assert_eq!(config.load_route(), default);
}

#[test]
fn discoverable_is_on_only_when_the_file_says_true() {
    let (_dir, file) = file_in();
    let config = RouteConfig::new(file.clone());
    assert!(!config.load_discoverable());
    for value in [json!("true"), json!(1), json!(null)] {
        fs::write(&file, json!({"discoverable": value}).to_string()).unwrap();
        assert!(!config.load_discoverable(), "{value}");
    }
    config.save_discoverable(true).unwrap();
    assert!(config.load_discoverable());
    config.save_discoverable(false).unwrap();
    assert!(!config.load_discoverable());
}

#[test]
fn keeps_the_phone_workspace_record_as_it_was_given() {
    let (_dir, file) = file_in();
    let config = RouteConfig::new(file);
    assert_eq!(config.load_phone_workspace_record(), None);
    let record = json!({"workspaceId": "ws-é", "nested": {"a": [1, 2.5, null]}});
    config.save_phone_workspace_record(&record).unwrap();
    assert_eq!(config.load_phone_workspace_record(), Some(record));
}

#[test]
fn replaces_a_stored_friendly_name_that_is_not_two_lowercase_words_and_saves_the_new_one() {
    for bad in [
        json!("Quiet-Otter"),
        json!("one"),
        json!("a-b-c"),
        json!(7),
        json!(""),
    ] {
        let (_dir, file) = file_in();
        fs::write(
            &file,
            json!({"friendlyName": bad, "discoverable": true}).to_string(),
        )
        .unwrap();
        let config = RouteConfig::new(file.clone());
        let fresh = config.friendly_name().unwrap();
        assert!(is_friendly_name(&fresh), "{bad}: {fresh}");
        let saved = stored(&file);
        assert_eq!(saved["friendlyName"], json!(fresh), "{bad}");
        assert_eq!(saved["discoverable"], json!(true), "{bad}");
    }
}

#[test]
fn keeps_a_valid_stored_friendly_name_without_writing_the_file() {
    let (_dir, file) = file_in();
    let text = json!({"friendlyName": "brave-otter"}).to_string();
    fs::write(&file, &text).unwrap();
    let config = RouteConfig::new(file.clone());
    assert_eq!(config.friendly_name().unwrap(), "brave-otter");
    assert_eq!(fs::read_to_string(&file).unwrap(), text);
}

#[test]
fn saving_one_field_keeps_the_others() {
    let (_dir, file) = file_in();
    let config = RouteConfig::new(file.clone());
    config.save_route(&route_of(&lan())).unwrap();
    config.save_discoverable(true).unwrap();
    config
        .save_phone_workspace_record(&json!({"w": 1}))
        .unwrap();
    let saved = stored(&file);
    assert_eq!(saved["route"], lan());
    assert_eq!(saved["discoverable"], json!(true));
    assert_eq!(saved["phoneWorkspace"], json!({"w": 1}));
    config.save_route(&route_of(&loopback())).unwrap();
    let saved = stored(&file);
    assert_eq!(saved["route"], loopback());
    assert_eq!(saved["discoverable"], json!(true));
    assert_eq!(saved["phoneWorkspace"], json!({"w": 1}));
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let (_dir, file) = file_in();
    fs::copy(fixture("gateway-route-before.json"), &file).unwrap();
    let config = RouteConfig::new(file.clone());
    assert_eq!(serde_json::to_value(config.load_route()).unwrap(), lan());
    assert!(config.load_discoverable());
    assert_eq!(config.friendly_name().unwrap(), "brave-otter");
    config
        .save_route(&route_of(&json!({
            "bindAddress": "127.0.0.1",
            "bindInterface": null,
            "tailnet": false,
            "phoneAddress": {"host": "desk.example.com", "port": 443},
            "relay": false,
        })))
        .unwrap();
    config.save_discoverable(false).unwrap();
    config
        .save_phone_workspace_record(&json!({"workspaceId": "ws-2"}))
        .unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("gateway-route-after.json")).unwrap()
    );
}
