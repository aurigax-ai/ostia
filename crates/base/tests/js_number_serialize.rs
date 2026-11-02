#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::JsNumber;

fn text(value: f64) -> String {
    serde_json::to_string(&JsNumber(value)).unwrap()
}

#[test]
fn writes_a_whole_number_without_a_fraction() {
    assert_eq!(text(120.0), "120");
    assert_eq!(text(-0.0), "0");
    assert_eq!(text(-45.0), "-45");
}

#[test]
fn writes_a_fraction_as_a_float() {
    assert_eq!(text(1.5), "1.5");
}

#[test]
fn keeps_the_value_of_a_whole_number_too_large_for_an_integer() {
    let written: f64 = text(1e30).parse().unwrap();
    assert_eq!(written, 1e30);
    let negative: f64 = text(-1e30).parse().unwrap();
    assert_eq!(negative, -1e30);
}

#[test]
fn writes_null_for_a_value_json_cannot_hold() {
    assert_eq!(text(f64::NAN), "null");
    assert_eq!(text(f64::INFINITY), "null");
}
