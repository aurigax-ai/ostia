#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use ostia_contract::viewer_selection::{decode_viewer_selection, encode_viewer_selection};
use serde_json::{Value, json};

fn meta() -> Value {
    json!({
        "capture": { "kind": "image", "imageWidth": 4, "imageHeight": 3, "region": null },
        "rect": { "x": 1, "y": 2, "width": 3, "height": 4 },
        "frame": { "width": 800, "height": 600 },
        "text": "héllo",
    })
}

fn framed(json: &[u8], tail: &[u8]) -> Vec<u8> {
    let mut body = u32::try_from(json.len()).unwrap().to_be_bytes().to_vec();
    body.extend_from_slice(json);
    body.extend_from_slice(tail);
    body
}

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

#[test]
fn round_trips_the_metadata_and_the_png() {
    let png = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
    let decoded = decode_viewer_selection(&encode_viewer_selection(&meta(), Some(&png))).unwrap();
    assert_eq!(decoded.meta, meta());
    assert_eq!(decoded.png.as_deref(), Some(&png[..]));
}

#[test]
fn reports_no_png_when_none_was_sent() {
    let decoded = decode_viewer_selection(&encode_viewer_selection(&meta(), None)).unwrap();
    assert_eq!(decoded.meta, meta());
    assert_eq!(decoded.png, None);
}

#[test]
fn refuses_a_body_that_is_too_short_claims_too_much_json_or_is_not_json() {
    assert!(decode_viewer_selection(&[0, 0]).is_none());
    assert!(decode_viewer_selection(&[0, 0, 1, 0, 123]).is_none());
    assert!(decode_viewer_selection(&[0, 0, 0, 3, 0xff, 0xfe, 0xfd]).is_none());
    assert!(decode_viewer_selection(&[0, 0, 0, 3, 120, 120, 120]).is_none());
}

#[test]
fn writes_a_four_byte_big_endian_length_then_compact_json_then_the_png() {
    let body = encode_viewer_selection(&meta(), Some(&[7, 8]));
    let json = serde_json::to_vec(&meta()).unwrap();
    assert_eq!(body, framed(&json, &[7, 8]));
    assert_eq!(body[..4], u32::try_from(json.len()).unwrap().to_be_bytes());
}

#[test]
fn refuses_an_empty_body_and_a_body_with_a_length_and_no_json() {
    assert!(decode_viewer_selection(&[]).is_none());
    assert!(decode_viewer_selection(&[0, 0, 0, 0]).is_none());
    assert!(decode_viewer_selection(&[0, 0, 0, 1]).is_none());
}

#[test]
fn takes_any_json_value_as_metadata_and_leaves_the_check_to_the_caller() {
    for (text, expected) in [
        ("1", json!(1)),
        ("null", Value::Null),
        ("[1,2]", json!([1, 2])),
    ] {
        let decoded = decode_viewer_selection(&framed(text.as_bytes(), &[])).unwrap();
        assert_eq!(decoded.meta, expected, "{text}");
        assert_eq!(decoded.png, None, "{text}");
    }
}

#[test]
fn treats_every_byte_after_the_json_as_the_png() {
    let decoded = decode_viewer_selection(&framed(b"{}", &[0, 0, 0, 0, 255])).unwrap();
    assert_eq!(decoded.meta, json!({}));
    assert_eq!(decoded.png.as_deref(), Some(&[0, 0, 0, 0, 255][..]));
}

#[test]
fn ignores_a_byte_order_mark_before_the_json_like_a_text_decoder() {
    let mut json = vec![0xef, 0xbb, 0xbf];
    json.extend_from_slice(b"{\"a\":1}");
    let decoded = decode_viewer_selection(&framed(&json, &[])).unwrap();
    assert_eq!(decoded.meta, json!({ "a": 1 }));
}

#[test]
fn refuses_json_with_trailing_text_and_json_cut_short_by_the_length() {
    assert!(decode_viewer_selection(&framed(b"{} x", &[])).is_none());
    assert!(decode_viewer_selection(&[0, 0, 0, 2, b'{', b'}', b'{', b'}']).is_some());
    assert!(decode_viewer_selection(&[0, 0, 0, 1, b'{', b'}']).is_none());
}

#[test]
fn reads_a_body_the_ts_encoder_wrote_and_writes_the_same_bytes_as_the_ts_encoder() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/viewer-selection-body.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let meta = fixture["meta"].clone();
    let png: Vec<u8> = fixture["png"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
        .collect();
    let with_png = from_hex(fixture["withPng"].as_str().unwrap());
    let without_png = from_hex(fixture["withoutPng"].as_str().unwrap());

    let decoded = decode_viewer_selection(&with_png).unwrap();
    assert_eq!(decoded.meta, meta);
    assert_eq!(decoded.png.as_deref(), Some(&png[..]));
    let decoded = decode_viewer_selection(&without_png).unwrap();
    assert_eq!(decoded.meta, meta);
    assert_eq!(decoded.png, None);

    assert_eq!(encode_viewer_selection(&meta, Some(&png)), with_png);
    assert_eq!(encode_viewer_selection(&meta, None), without_png);
}
