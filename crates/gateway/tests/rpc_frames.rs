#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use ostia_gateway::rpc_frames::{rpc_error, rpc_result};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/gateway-rpc-frames.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn writes_a_result_frame_with_the_version_id_and_result_in_that_order() {
    assert_eq!(
        rpc_result(&json!(1), &json!({"ok": true})),
        r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#
    );
    assert_eq!(
        rpc_result(&json!("abc"), &Value::Null),
        r#"{"jsonrpc":"2.0","id":"abc","result":null}"#
    );
}

#[test]
fn writes_an_error_frame_without_data_when_none_is_given() {
    assert_eq!(
        rpc_error(&json!(1), -32602, "bad-params", None),
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad-params"}}"#
    );
}

#[test]
fn writes_the_data_after_the_message_and_keeps_a_null_data() {
    assert_eq!(
        rpc_error(
            &json!("x"),
            -32003,
            "needs-elevation",
            Some(&json!({"cap": "notify"}))
        ),
        r#"{"jsonrpc":"2.0","id":"x","error":{"code":-32003,"message":"needs-elevation","data":{"cap":"notify"}}}"#
    );
    assert_eq!(
        rpc_error(&json!(2), -32603, "e", Some(&Value::Null)),
        r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"e","data":null}}"#
    );
}

#[test]
fn writes_a_null_id_in_an_error_frame_for_a_request_that_had_none() {
    assert_eq!(
        rpc_error(&Value::Null, -32700, "parse error", None),
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}"#
    );
}

#[test]
fn writes_the_same_bytes_as_the_ts_frames() {
    let fixture = fixture();
    for row in fixture["results"].as_array().unwrap() {
        assert_eq!(
            rpc_result(&row["id"], &row["result"]),
            row["frame"].as_str().unwrap(),
            "{row}"
        );
    }
    for row in fixture["errors"].as_array().unwrap() {
        assert_eq!(
            rpc_error(
                &row["id"],
                row["code"].as_i64().unwrap(),
                row["message"].as_str().unwrap(),
                row.get("data")
            ),
            row["frame"].as_str().unwrap(),
            "{row}"
        );
    }
    assert_eq!(
        rpc_error(&Value::Null, -32600, "invalid", None),
        fixture["errorNoId"].as_str().unwrap()
    );
}
