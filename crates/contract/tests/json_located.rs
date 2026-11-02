#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::json_located::parse_located_json;

#[test]
fn keeps_a_whole_number_a_whole_number() {
    let parsed = parse_located_json(r#"{"a":5,"b":-3,"c":5.0,"d":1e2,"e":0,"f":-0}"#).unwrap();
    assert_eq!(
        parsed.value.to_string(),
        r#"{"a":5,"b":-3,"c":5,"d":100,"e":0,"f":0}"#
    );
}

#[test]
fn keeps_a_fraction_a_fraction() {
    let parsed = parse_located_json(r#"{"a":0.5,"b":-2.25}"#).unwrap();
    assert_eq!(parsed.value.to_string(), r#"{"a":0.5,"b":-2.25}"#);
}
