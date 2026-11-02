#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_rpc::{Incoming, classify, normalize_params};
use serde_json::json;

#[test]
fn a_string_or_number_id_with_a_method_is_a_request() {
    assert!(matches!(
        classify(json!({"id": 1, "method": "a"})),
        Incoming::Request { .. }
    ));
    assert!(matches!(
        classify(json!({"id": "x", "method": "a"})),
        Incoming::Request { .. }
    ));
}

#[test]
fn a_method_without_an_id_is_a_notification_and_a_null_id_is_invalid() {
    assert!(matches!(
        classify(json!({"method": "a"})),
        Incoming::Notification { .. }
    ));
    assert_eq!(
        classify(json!({"id": null, "method": "a"})),
        Incoming::Invalid
    );
    assert_eq!(
        classify(json!({"id": [1], "method": "a"})),
        Incoming::Invalid
    );
}

#[test]
fn a_result_or_error_is_a_response_and_other_shapes_are_invalid() {
    assert!(matches!(
        classify(json!({"id": 1, "result": null})),
        Incoming::Response { outcome: Ok(_), .. }
    ));
    assert!(matches!(
        classify(json!({"id": 1, "error": {"code": 1}})),
        Incoming::Response {
            outcome: Err(_),
            ..
        }
    ));
    assert_eq!(classify(json!({"id": 1})), Incoming::Invalid);
    assert_eq!(classify(json!([1])), Incoming::Invalid);
}

#[test]
fn params_reach_a_handler_as_the_ts_reader_gives_them() {
    assert_eq!(normalize_params(None), json!({}));
    assert_eq!(normalize_params(Some(json!(null))), json!(null));
    assert_eq!(normalize_params(Some(json!({"a": 1}))), json!({"a": 1}));
    assert_eq!(normalize_params(Some(json!([]))), json!({}));
    assert_eq!(
        normalize_params(Some(json!([{"a": 1}, 2]))),
        json!({"a": 1})
    );
}
