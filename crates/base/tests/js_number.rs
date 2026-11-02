#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_base::js::js_number;
use serde_json::Value;

fn expected_bits(hex_text: &str) -> u64 {
    u64::from_str_radix(hex_text, 16).unwrap()
}

#[test]
fn matches_every_value_that_js_number_gave() {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/rust/js-number.json");
    let table: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let rows = table.as_array().unwrap();
    assert!(rows.len() > 80);
    for row in rows {
        let text = row["text"].as_str().unwrap();
        let expected = f64::from_bits(expected_bits(row["bits"].as_str().unwrap()));
        let actual = js_number(text);
        if expected.is_nan() {
            assert!(actual.is_nan(), "{text:?} gave {actual}");
        } else {
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "{text:?} gave {actual}, not {expected}"
            );
        }
    }
}

#[test]
fn the_cases_parse_safe_int_gets_wrong() {
    assert!(js_number("12abc").is_nan());
    assert_eq!(js_number("1.5"), 1.5);
    assert_eq!(js_number("0x10"), 16.0);
    assert_eq!(js_number("1e3"), 1000.0);
    assert_eq!(js_number("9007199254740993"), 9007199254740992.0);
}
